import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionConfig } from './config.js';
import { Oracle, AskUserQuestionInputSchema } from './oracle.js';
import { SyntheticUser } from './synthetic-user.js';
import { scaffoldProject, createProjectDir, resolveSkillPath } from './project.js';
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

export const DEFAULT_SESSION_TIMEOUT_SECONDS = 300;

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
          else exitCode = EXIT_RUNTIME_ERROR;
        }
      }
    }

    // Check for timeout
    if (timedOut) {
      exitCode = EXIT_TIMEOUT;
    } else if (signaled) {
      exitCode = EXIT_SIGINT;
    } else if (oracleFailed) {
      exitCode = EXIT_RUNTIME_ERROR;
    }
  } catch {
    if (timedOut) exitCode = EXIT_TIMEOUT;
    else if (signaled) exitCode = EXIT_SIGINT;
    else exitCode = EXIT_RUNTIME_ERROR;
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
        path: resolveSkillPath(p, configDir),
      })),
      ...sdkPlugins.map((p) => ({
        ...p,
        path: resolveSkillPath(p.path, configDir),
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

export const SAFE_ENV_VARS: ReadonlySet<string> = new Set([
  // Required for the agent subprocess to make API calls
  'ANTHROPIC_API_KEY',
  // Long-lived OAuth bearer issued by `claude setup-token`
  'CLAUDE_CODE_OAUTH_TOKEN',
  // Paths and execution
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  // Temp directories
  'TMPDIR',
  'TEMP',
  'TMP',
  // Locale and encoding
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_COLLATE',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_MONETARY',
  'LC_NUMERIC',
  'LC_TIME',
  // Terminal
  'TERM',
  'COLORTERM',
  'TERM_PROGRAM',
  'FORCE_COLOR',
  'NO_COLOR',
  // Editor
  'EDITOR',
  'VISUAL',
  // Node.js runtime
  'NODE_PATH',
  'NODE_ENV',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'NODE_NO_WARNINGS',
  'UV_THREADPOOL_SIZE',
  // SSL/TLS certificates
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  // XDG base directories
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'XDG_STATE_HOME',
  // macOS
  'COMMAND_MODE',
  '__CF_USER_TEXT_ENCODING',
  // SDK identification
  'CLAUDE_AGENT_SDK_CLIENT_APP',
]);

export const SAFE_ENV_PREFIXES: readonly string[] = ['LC_', 'npm_config_'];

export function buildSandboxEnv(
  processEnv: Record<string, string | undefined>,
  userEnv: Record<string, string> | undefined,
  sandboxHome: string,
): Record<string, string> {
  const filtered: Record<string, string> = {};

  for (const [key, value] of Object.entries(processEnv)) {
    if (value === undefined) continue;
    if (SAFE_ENV_VARS.has(key) || SAFE_ENV_PREFIXES.some((p) => key.startsWith(p))) {
      filtered[key] = value;
    }
  }

  if (userEnv) {
    Object.assign(filtered, userEnv);
  }

  // HOME is always the sandbox home, regardless of process.env or userEnv
  filtered.HOME = sandboxHome;

  return filtered;
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
