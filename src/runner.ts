import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  buildSandboxEnv,
  linkOauthCredentialIntoSandbox,
  sandboxCredentialWarning,
} from './sandbox.js';
import { unregisteredSlashCommand } from './slash-command.js';
import { type SessionConfig, DEFAULT_SESSION_TIMEOUT_SECONDS } from './config.js';
import { Oracle, AskUserQuestionInputSchema } from './oracle.js';
import { SyntheticUser } from './synthetic-user.js';
import { scaffoldProject, createProjectDir, resolveConfigPath } from './project.js';
import { cleanOldProjects, WORKSPACE_CLEANUP_AGE_DAYS } from './cleanup.js';
import {
  EXIT_SUCCESS,
  EXIT_RUNTIME_ERROR,
  EXIT_BUDGET_EXCEEDED,
  EXIT_TIMEOUT,
  EXIT_MAX_TURNS,
  EXIT_SIGINT,
} from './exit-codes.js';
import {
  writeHeader,
  writeUser,
  writeThinking,
  writeAssistant,
  writeTool,
  writeOracleAsk,
  writeOracleTurn,
  writeOracleError,
  writeFooter,
} from './transcript.js';

export interface RunResult {
  exitCode: number;
  sessionId?: string;
}

export interface RunOptions {
  timeoutSeconds?: number;
  verbose?: boolean;
  configDir?: string;
  configPaths?: string[];
  signal?: AbortSignal;
}

export async function runSession(
  config: SessionConfig,
  options: RunOptions = {},
): Promise<RunResult> {
  const { timeoutSeconds = DEFAULT_SESSION_TIMEOUT_SECONDS, verbose = false } = options;

  // Clean old project directories in the background; best-effort, not on the critical path.
  cleanOldProjects(WORKSPACE_CLEANUP_AGE_DAYS, { verbose }).catch(() => {});

  let sessionId: string | undefined;
  let queryHandle: ReturnType<typeof query> | undefined;

  // Always create a project directory
  let projectDir: string;
  if (config.project) {
    const configDir = options.configDir || process.cwd();
    const result = await scaffoldProject(config.project, configDir);
    projectDir = result.projectPath;
    if (verbose) {
      process.stderr.write(`[scuttlerun] Scaffolded project at ${projectDir}\n`);
    }
  } else {
    projectDir = await createProjectDir();
  }

  const cwd = projectDir;

  // When sandbox is enabled, redirect HOME into the project dir so tools
  // (npm, pip, cargo, etc.) write caches there instead of ~/
  const sandboxHome = config.sandbox.enabled ? join(cwd, '.home') : undefined;
  if (sandboxHome) {
    mkdirSync(sandboxHome, { recursive: true });
    const credResult = linkOauthCredentialIntoSandbox({
      realHome: homedir(),
      sandboxHome,
      env: process.env,
    });
    if (verbose && credResult.linked) {
      process.stderr.write(
        `[scuttlerun] Exposed OAuth credential: ${credResult.source} → ${credResult.link}\n`,
      );
    }
    const credWarning = sandboxCredentialWarning({
      sandboxEnabled: true,
      credentialLinked: credResult.linked,
      env: process.env,
    });
    if (credWarning) {
      process.stderr.write(`${credWarning}\n`);
    }
  }

  // Create oracle
  const oracle = new Oracle(config.user.oracle_model, { verbose });

  // Set up timeout
  const abortController = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let signaled = false;

  // Forward an externally-supplied AbortSignal (e.g. SIGINT from cli.ts) into
  // our internal abortController so the SDK and oracle stop in flight.
  let onExternalAbort: (() => void) | undefined;
  if (options.signal) {
    onExternalAbort = () => {
      signaled = true;
      abortController.abort();
      queryHandle?.interrupt().catch(() => {});
    };
    options.signal.addEventListener('abort', onExternalAbort);
  }

  // Track stats
  let toolCallCount = 0;
  let exitCode: number = EXIT_SUCCESS;
  let oracleFailed = false;
  const startTime = Date.now();
  let resultNumTurns = 0;
  let resultTotalCostUsd = 0;
  // Tracks whether the in-flight turn produced an SDK result. Reset when a
  // continuation turn is dispatched, so a crash after an earlier turn's result
  // still marks the agent cost incomplete. The SDK only reports a dollar total
  // on the result message, so without one the turn's spend is unknown.
  let resultArrived = false;
  const filesWritten = new Set<string>();
  const filesEdited = new Set<string>();
  const filesRead = new Set<string>();

  try {
    // Build the async generator for multi-turn input
    type SyntheticAction = { type: 'continue'; message: string } | { type: 'end' };
    let resolveNextAction: ((action: SyntheticAction) => void) | undefined;

    async function* inputGenerator() {
      // Yield initial prompt
      yield {
        type: 'user' as const,
        session_id: '',
        message: {
          role: 'user' as const,
          content: [{ type: 'text' as const, text: config.prompt }],
        },
        parent_tool_use_id: null,
      };

      // Multi-turn loop
      while (true) {
        const action = await new Promise<SyntheticAction>((resolve) => {
          resolveNextAction = resolve;
        });
        if (action.type === 'end') {
          return;
        }
        yield {
          type: 'user' as const,
          session_id: '',
          message: {
            role: 'user' as const,
            content: [{ type: 'text' as const, text: action.message }],
          },
          parent_tool_use_id: null,
        };
      }
    }

    const sdkOptions = buildSdkOptions(config, options, {
      cwd,
      sandboxHome,
      abortController,
      verbose,
    });

    // Create a lazy SyntheticUser — initialized once we have a session ID
    let syntheticUser: SyntheticUser | undefined;

    // canUseTool callback. The Agent SDK's PermissionResult schema requires
    // `updatedInput` on the allow branch and `message` on the deny branch;
    // returning a bare `{ behavior }` triggers a ZodError for every tool call.
    sdkOptions.canUseTool = async (toolName: string, input: Record<string, unknown>) => {
      if (toolName === 'AskUserQuestion' && syntheticUser) {
        const parsed = AskUserQuestionInputSchema.safeParse(input);
        if (!parsed.success) {
          return { behavior: 'deny', message: 'AskUserQuestion input failed schema validation' };
        }
        try {
          const result = await syntheticUser.handleAskUserQuestion(parsed.data);
          writeOracleAsk(result.oracleResponse.answers, result.oracleResponse.reasoning);
          return {
            behavior: result.behavior,
            updatedInput: result.updatedInput,
          };
        } catch (err) {
          oracleFailed = true;
          writeOracleError(err instanceof Error ? err.message : String(err));
          abortController.abort();
          return { behavior: 'deny', message: 'Synthetic-user oracle aborted with an error' };
        }
      }
      return { behavior: 'allow', updatedInput: input };
    };

    // Start timeout
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      abortController.abort();
      queryHandle?.interrupt().catch(() => {});
    }, timeoutSeconds * 1000);

    // Launch the query
    queryHandle = query({
      prompt: inputGenerator(),
      options: sdkOptions,
    });

    for await (const message of queryHandle) {
      if (timedOut) break;
      if (signaled) break;

      if (message.type === 'system' && message.subtype === 'init' && !sessionId) {
        sessionId = message.session_id;

        // Warn when the prompt is a slash command this session cannot resolve:
        // scuttlerun forwards the prompt verbatim, so an unregistered command
        // reaches the agent as literal text and typically runs zero turns.
        // Loading the defining skill/plugin registers it in slash_commands.
        const unresolvedCommand = unregisteredSlashCommand(
          config.prompt,
          message.slash_commands ?? [],
        );
        if (unresolvedCommand) {
          const registered = (message.slash_commands ?? []).slice().sort();
          process.stderr.write(
            `[scuttlerun] WARNING: prompt begins with slash command "/${unresolvedCommand}" ` +
              `which is not registered in this session, so the agent will receive it as literal ` +
              `text and likely do nothing. Load the defining skill/plugin via project.skills, ` +
              `project.plugins, or sdk.plugins. Registered slash commands: ` +
              `${registered.join(', ') || '(none)'}\n`,
          );
        }

        syntheticUser = new SyntheticUser(oracle, config.user, config.prompt);

        // Write YAML header and first user message
        const sdkSessionPath = buildSdkSessionPath(cwd, sessionId, sandboxHome);
        writeHeader({
          session: sessionId,
          configPaths: options.configPaths || [],
          projectDir,
          transcriptPath: sdkSessionPath,
        });
        writeUser(config.prompt);

        // Add initial prompt to conversation buffer
        syntheticUser.addUserMessage(config.prompt);
      } else if (message.type === 'assistant') {
        const content = message.message?.content;
        if (content && Array.isArray(content)) {
          const textParts: string[] = [];
          for (const block of content) {
            if (block.type === 'thinking' && block.thinking) {
              writeThinking(block.thinking);
            } else if (block.type === 'text' && block.text) {
              writeAssistant(block.text);
              textParts.push(block.text);
            } else if (block.type === 'tool_use' && block.name) {
              writeTool(block.name, block.input);
              toolCallCount++;
              recordToolFile(block.name, block.input, {
                written: filesWritten,
                edited: filesEdited,
                read: filesRead,
              });
            }
          }
          if (textParts.length > 0 && syntheticUser) {
            syntheticUser.addAssistantMessage(textParts.join('\n'));
          }
        }
      } else if (message.type === 'result') {
        const subtype = message.subtype;
        resultArrived = true;

        // Extract stats from result
        resultNumTurns = message.num_turns || 0;
        resultTotalCostUsd = message.total_cost_usd || 0;

        if (subtype === 'success' && syntheticUser) {
          // Consult turn policy
          const decision = await syntheticUser.decideTurn();

          // Write oracle turn policy decision only when the oracle was
          // actually consulted. Cap-driven short-circuits (max_turns=0
          // or userTurnCount>=cap) leave reasoning undefined and emit
          // no transcript entry, per spec rule TurnPolicyEndsByCap.
          if (decision.reasoning !== undefined) {
            writeOracleTurn(decision.decision, decision.message, decision.reasoning);
          }

          if (decision.decision === 'continue' && decision.message) {
            syntheticUser.addUserMessage(decision.message);
            writeUser(decision.message);
            // A new turn is now in flight; its result has not arrived yet.
            resultArrived = false;
            resolveNextAction?.({ type: 'continue', message: decision.message });
          } else {
            resolveNextAction?.({ type: 'end' });
            exitCode = EXIT_SUCCESS;
          }
        } else {
          // Error subtypes
          resolveNextAction?.({ type: 'end' });
          if (subtype === 'error_max_turns') exitCode = EXIT_MAX_TURNS;
          else if (subtype === 'error_max_budget_usd') exitCode = EXIT_BUDGET_EXCEEDED;
          else if ((message as { terminal_reason?: string }).terminal_reason === 'max_turns') {
            // The turn cap was reached mid-execution: a tool/skill call was
            // accepted as the Nth tool use, then the next model turn could not
            // start. The SDK reports error_during_execution but attributes the
            // cause via terminal_reason = max_turns, so the same logical
            // condition as error_max_turns yields the same exit code regardless
            // of where in the tool-call lifecycle the cap fired (spec rule
            // AgentTurnHitsTurnCapDuringExecution).
            exitCode = EXIT_MAX_TURNS;
          } else {
            exitCode = EXIT_RUNTIME_ERROR;
            // Surface the SDK's error detail as a diagnostic annotation paired
            // with the runtime-error exit code (spec rule AgentTurnFailsAtRuntime).
            // Informational only; downstream tools should not parse it.
            const sdkErrors = (message as { errors?: string[] }).errors;
            if (sdkErrors && sdkErrors.length > 0) {
              process.stderr.write(`[scuttlerun] ${sdkErrors.join('\n')}\n`);
            }
          }
        }
      }
    }

    // Check for timeout
    if (timedOut) {
      process.stderr.write(`[scuttlerun] timed out after ${timeoutSeconds}s\n`);
      exitCode = EXIT_TIMEOUT;
    } else if (signaled) {
      exitCode = EXIT_SIGINT;
    } else if (oracleFailed) {
      exitCode = EXIT_RUNTIME_ERROR;
    }
  } catch (err) {
    if (timedOut) {
      process.stderr.write(`[scuttlerun] timed out after ${timeoutSeconds}s\n`);
      exitCode = EXIT_TIMEOUT;
    } else if (signaled) exitCode = EXIT_SIGINT;
    else {
      exitCode = EXIT_RUNTIME_ERROR;
      // Surface the exception that escaped the message loop as a diagnostic
      // annotation paired with the runtime-error exit code (spec rule
      // SessionFailsFromUncaughtException). Informational only.
      process.stderr.write(`[scuttlerun] ${err instanceof Error ? err.message : String(err)}\n`);
    }
  } finally {
    // Always finalise the transcript on every termination path
    // (happy, timeout, exception) — see spec rule SessionFinalises and
    // invariant WorkspacePreservedAcrossOutcomes. The inner finally
    // guarantees AgentSdkClosed even if writeFooter throws.
    try {
      const duration = Date.now() - startTime;
      const oracleUsage = oracle.getTotalUsage();
      writeFooter({
        turns: resultNumTurns,
        toolCalls: toolCallCount,
        durationMs: duration,
        totalCostUsd: resultTotalCostUsd + oracleUsage.cost_usd,
        costIncomplete: !resultArrived,
        oracleCostUsd: oracleUsage.cost_usd,
        timedOut,
        filesWritten: Array.from(filesWritten),
        filesEdited: Array.from(filesEdited),
        filesRead: Array.from(filesRead),
        oracleUsage,
      });
    } finally {
      /* v8 ignore next -- timeoutHandle is always set; defensive guard */
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (queryHandle) queryHandle.close();
      if (options.signal && onExternalAbort) {
        options.signal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  return { exitCode, sessionId };
}

// BetaToolUseBlock.input is typed `unknown` by the SDK because tool input shapes
// are user-defined. We only read file_path for the built-in Read/Write/Edit tools.
function recordToolFile(
  name: string,
  input: unknown,
  files: { written: Set<string>; edited: Set<string>; read: Set<string> },
): void {
  const inp = input as Record<string, unknown>;
  if (typeof inp.file_path !== 'string') return;
  if (name === 'Write') files.written.add(inp.file_path);
  if (name === 'Edit') files.edited.add(inp.file_path);
  if (name === 'Read') files.read.add(inp.file_path);
}

interface BuildSdkOptionsCtx {
  cwd: string;
  sandboxHome: string | undefined;
  abortController: AbortController;
  verbose: boolean;
}

function buildSdkOptions(
  config: SessionConfig,
  options: RunOptions,
  ctx: BuildSdkOptionsCtx,
): Record<string, unknown> {
  const { cwd, sandboxHome, abortController, verbose } = ctx;
  const sdkOptions: Record<string, unknown> = {
    cwd,
    permissionMode: config.permission_mode,
    allowDangerouslySkipPermissions: config.permission_mode === 'bypassPermissions',
    tools: config.tools,
    maxTurns: config.max_turns,
    abortController,
    effort: config.effort,
    settingSources: config.sdk.setting_sources,
    model: config.model,
  };

  if (config.max_budget_usd) sdkOptions.maxBudgetUsd = config.max_budget_usd;
  const sp = config.sdk.system_prompt;
  if (typeof sp === 'string') {
    sdkOptions.systemPrompt = [sp, SYSTEM_PROMPT_DYNAMIC_BOUNDARY];
  } else {
    sdkOptions.systemPrompt = {
      type: 'preset' as const,
      preset: sp.preset,
      ...(sp.append && { append: sp.append }),
    };
  }
  if (config.disallowed_tools) sdkOptions.disallowedTools = config.disallowed_tools;
  if (config.sdk.thinking) sdkOptions.thinking = config.sdk.thinking;
  if (config.sdk.mcp_servers) sdkOptions.mcpServers = config.sdk.mcp_servers;
  if (config.sdk.agents) sdkOptions.agents = config.sdk.agents;

  const projectPlugins = config.project?.plugins ?? [];
  const sdkPlugins = config.sdk.plugins ?? [];
  if (projectPlugins.length > 0 || sdkPlugins.length > 0) {
    const configDir = options.configDir || process.cwd();
    const resolved = [
      ...projectPlugins.map((p) => ({
        type: 'local' as const,
        path: resolveConfigPath(p, configDir),
      })),
      ...sdkPlugins.map((p) => ({
        ...p,
        path: resolveConfigPath(p.path, configDir),
      })),
    ];
    const seen = new Set<string>();
    sdkOptions.plugins = resolved.filter((p) => {
      if (seen.has(p.path)) return false;
      seen.add(p.path);
      return true;
    });
  }

  // Subprocess environment: when sandbox is enabled, filter process.env
  // through an allowlist to prevent leaking secrets (API keys, tokens, etc.)
  if (sandboxHome) {
    sdkOptions.env = buildSandboxEnv(
      process.env as Record<string, string | undefined>,
      config.sdk.env,
      sandboxHome,
    );
  } else if (config.sdk.env) {
    sdkOptions.env = config.sdk.env;
  } else {
    // Inherit parent env minus CLAUDECODE, which the SDK rejects as a nested session
    sdkOptions.env = { ...process.env, CLAUDECODE: undefined };
  }

  if (config.sandbox.enabled) {
    sdkOptions.sandbox = {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: {
        allowedDomains: config.sandbox.network.allowed_domains,
        allowLocalBinding: config.sandbox.network.allow_local_binding,
      },
      filesystem: {
        allowWrite: [cwd, '/tmp', ...config.sandbox.filesystem.allow_write],
        denyRead: config.sandbox.filesystem.deny_read,
        denyWrite: config.sandbox.filesystem.deny_write,
      },
    };
  }

  if (verbose) {
    sdkOptions.stderr = (data: string) => {
      process.stderr.write(data);
    };
  }

  return sdkOptions;
}

function buildSdkSessionPath(cwd: string, sessionId: string, sandboxHome?: string): string {
  const home = sandboxHome || process.env.HOME;
  if (!home) {
    throw new Error(
      'Cannot locate SDK session file: HOME is not set. scuttlerun requires HOME to be set when sandbox is disabled.',
    );
  }
  let resolved: string;
  try {
    resolved = realpathSync(cwd);
  } catch {
    resolved = cwd;
  }
  const encodedCwd = resolved.replace(/[/_]/g, '-');
  return `${home}/.claude/projects/${encodedCwd}/${sessionId}.jsonl`;
}
