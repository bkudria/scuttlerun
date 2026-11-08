import {
  query,
  type SDKResultMessage,
  type SDKStartupFailureReason,
} from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { linkOauthCredentialIntoSandbox, sandboxCredentialWarning } from './sandbox.js';
import { buildAuthEnv, detectSubscriptionCredentials } from './auth.js';
import { unresolvedSlashCommandWarning } from './slash-command.js';
import {
  lostThisSessionsTranscript,
  startupFailureHint,
  transcriptLostWarning,
} from './sdk-diagnostics.js';
import { type SessionConfig, DEFAULT_SESSION_TIMEOUT_SECONDS } from './config.js';
import { Oracle, AskUserQuestionInputSchema } from './oracle.js';
import { SyntheticUser } from './synthetic-user.js';
import { scaffoldProject, createProjectDir } from './project.js';
import { buildSdkOptions } from './sdk-options.js';
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

  // Resolve credential preference up front, before any session work. This
  // throws for api-key mode without ANTHROPIC_API_KEY, which the CLI reports
  // as a config error. parentAuthEnv is the auth-shaped view of process.env
  // used by the oracle and the non-sandboxed agent (both run with the real
  // HOME, so Keychain-held subscription credentials count as present).
  const parentAuthEnv = buildAuthEnv(config.auth);
  // The sandboxed agent runs under a redirected HOME and cannot reach the
  // macOS Keychain, so only env-token or credentials-file subscriptions count
  // when deciding whether to withhold the API key from the sandbox.
  const agentPrefersSubscription =
    config.auth === 'subscription' ||
    (config.auth === 'auto' &&
      Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) &&
      detectSubscriptionCredentials(process.env, process.platform, { includeKeychain: false }));

  // Clean old project directories in the background; best-effort, not on the critical path.
  cleanOldProjects(WORKSPACE_CLEANUP_AGE_DAYS, { verbose }).catch(() => {});

  let sessionId: string | undefined;
  let queryHandle: ReturnType<typeof query> | undefined;

  // Always create a project directory
  let projectDir: string;
  let claudeDir: string | undefined;
  if (config.project) {
    const configDir = options.configDir || process.cwd();
    ({ projectPath: projectDir, claudeDir } = await scaffoldProject(config.project, configDir));
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
    // The symlink and warning must see the credentials as the agent will:
    // when the auth mode withholds the API key, the credentials file is the
    // subscription the sandbox authenticates with, so it must still be linked.
    const sandboxEffectiveEnv = agentPrefersSubscription
      ? { ...process.env, ANTHROPIC_API_KEY: undefined }
      : process.env;
    const credResult = linkOauthCredentialIntoSandbox({
      realHome: homedir(),
      sandboxHome,
      env: sandboxEffectiveEnv,
    });
    if (verbose && credResult.linked) {
      process.stderr.write(
        `[scuttlerun] Exposed OAuth credential: ${credResult.source} → ${credResult.link}\n`,
      );
    }
    const credWarning = sandboxCredentialWarning({
      sandboxEnabled: true,
      credentialLinked: credResult.linked,
      env: sandboxEffectiveEnv,
    });
    if (credWarning) {
      process.stderr.write(`${credWarning}\n`);
    }
  }

  // Create oracle — it runs in this process (never sandboxed), with the
  // auth-shaped parent env
  const oracle = new Oracle(config.user.oracle_model, { verbose, sdkEnv: parentAuthEnv });

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
  let transcriptIncomplete = false;
  let sdkSessionPath: string | undefined;
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
      claudeDir,
      abortController,
      verbose,
      parentAuthEnv,
      agentPrefersSubscription,
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

        const slashWarning = unresolvedSlashCommandWarning(
          config.prompt,
          message.slash_commands ?? [],
        );
        if (slashWarning) process.stderr.write(slashWarning);

        syntheticUser = new SyntheticUser(oracle, config.user, config.prompt);

        // Write YAML header and first user message
        sdkSessionPath = buildSdkSessionPath(cwd, sessionId, sandboxHome, claudeDir);
        writeHeader({
          session: sessionId,
          configPaths: options.configPaths || [],
          projectDir,
          transcriptPath: sdkSessionPath,
        });
        writeUser(config.prompt);

        // Add initial prompt to conversation buffer
        syntheticUser.addUserMessage(config.prompt);
      } else if (message.type === 'system' && message.subtype === 'session_writes_lost') {
        if (lostThisSessionsTranscript(message, sessionId)) {
          transcriptIncomplete = true;
          process.stderr.write(transcriptLostWarning(message, sdkSessionPath));
        }
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
          resolveNextAction?.({ type: 'end' });
          exitCode = exitCodeForUnfinishedResult(message, config.sandbox.enabled);
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
        costIncomplete: !resultArrived || oracle.hasUnknownCost(),
        transcriptIncomplete,
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

// Covers error subtypes, and a success result that arrives before init (no
// synthetic user to consult), which can only end the session as a failure.
function exitCodeForUnfinishedResult(message: SDKResultMessage, sandboxEnabled: boolean): number {
  if (message.subtype === 'error_max_turns') return EXIT_MAX_TURNS;
  if (message.subtype === 'error_max_budget_usd') return EXIT_BUDGET_EXCEEDED;
  if ((message as { terminal_reason?: string }).terminal_reason === 'max_turns') {
    // The turn cap was reached mid-execution: a tool/skill call was accepted
    // as the Nth tool use, then the next model turn could not start. The SDK
    // reports error_during_execution but attributes the cause via
    // terminal_reason = max_turns, so the same logical condition as
    // error_max_turns yields the same exit code regardless of where in the
    // tool-call lifecycle the cap fired (spec rule
    // AgentTurnHitsTurnCapDuringExecution).
    return EXIT_MAX_TURNS;
  }
  // Surface the SDK's error detail as a diagnostic annotation paired with the
  // runtime-error exit code (spec rule AgentTurnFailsAtRuntime). Informational
  // only; downstream tools should not parse it.
  const sdkErrors = (message as { errors?: string[] }).errors;
  if (sdkErrors && sdkErrors.length > 0) {
    process.stderr.write(`[scuttlerun] ${sdkErrors.join('\n')}\n`);
  }
  const hint = startupFailureHint(
    (message as { startup_failure_reason?: SDKStartupFailureReason }).startup_failure_reason,
    sandboxEnabled,
  );
  if (hint) process.stderr.write(hint);
  return EXIT_RUNTIME_ERROR;
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

function buildSdkSessionPath(
  cwd: string,
  sessionId: string,
  sandboxHome?: string,
  claudeDir?: string,
): string {
  const home = sandboxHome || process.env.HOME;
  if (!home && !claudeDir) {
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
  return `${claudeDir ?? `${home}/.claude`}/projects/${encodedCwd}/${sessionId}.jsonl`;
}
