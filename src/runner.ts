import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { linkOauthCredentialIntoSandbox, sandboxCredentialWarning } from './sandbox.js';
import { buildAuthEnv, detectSubscriptionCredentials } from './auth.js';
import { type SessionConfig, DEFAULT_SESSION_TIMEOUT_SECONDS } from './config.js';
import { Oracle } from './oracle.js';
import { scaffoldProject, createProjectDir } from './project.js';
import { buildSdkOptions } from './sdk-options.js';
import { cleanOldProjects, WORKSPACE_CLEANUP_AGE_DAYS } from './cleanup.js';
import { EXIT_RUNTIME_ERROR, EXIT_TIMEOUT, EXIT_SIGINT } from './exit-codes.js';
import { writeFooter } from './transcript.js';
import { canUseTool, handleMessage, inputMessages, newSessionState } from './session-loop.js';

// How long the CLI may keep running once the session has ended, so it can
// exit by itself and run its SessionEnd hooks, before it is closed.
export const CLI_EXIT_GRACE_MS = 10_000;

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
  let exitGraceHandle: ReturnType<typeof setTimeout> | undefined;
  let cutOffAfterEnd = false;

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
  const state = newSessionState({
    config,
    configPaths: options.configPaths || [],
    projectDir,
    sandboxHome,
    claudeDir,
    oracle,
  });
  const startTime = Date.now();

  try {
    const sdkOptions = buildSdkOptions(config, options, {
      cwd,
      sandboxHome,
      claudeDir,
      abortController,
      verbose,
      parentAuthEnv,
      agentPrefersSubscription,
    });

    sdkOptions.canUseTool = canUseTool(state, abortController);

    // Start timeout
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      abortController.abort();
      queryHandle?.interrupt().catch(() => {});
    }, timeoutSeconds * 1000);

    // Launch the query
    queryHandle = query({
      prompt: inputMessages(state),
      options: sdkOptions,
    });

    for await (const message of queryHandle) {
      if (timedOut) break;
      if (signaled) break;
      await handleMessage(message, state);
      if (state.ended && !exitGraceHandle) {
        clearTimeout(timeoutHandle);
        exitGraceHandle = setTimeout(() => {
          cutOffAfterEnd = true;
          queryHandle?.close();
        }, CLI_EXIT_GRACE_MS);
      }
    }

    // Check for timeout
    if (timedOut) {
      process.stderr.write(`[scuttlerun] timed out after ${timeoutSeconds}s\n`);
      state.exitCode = EXIT_TIMEOUT;
    } else if (signaled && state.ended) {
      cutOffAfterEnd = true;
    } else if (signaled) {
      state.exitCode = EXIT_SIGINT;
    } else if (state.oracleFailed) {
      state.exitCode = EXIT_RUNTIME_ERROR;
    }
  } catch (err) {
    if (timedOut) {
      process.stderr.write(`[scuttlerun] timed out after ${timeoutSeconds}s\n`);
      state.exitCode = EXIT_TIMEOUT;
    } else if (signaled && !state.ended) state.exitCode = EXIT_SIGINT;
    else if (!state.ended) {
      state.exitCode = EXIT_RUNTIME_ERROR;
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
        turns: state.resultNumTurns,
        toolCalls: state.toolCallCount,
        durationMs: duration,
        totalCostUsd: state.resultTotalCostUsd + oracleUsage.cost_usd,
        costIncomplete: !state.resultArrived || cutOffAfterEnd || oracle.hasUnknownCost(),
        transcriptIncomplete: state.transcriptIncomplete,
        oracleCostUsd: oracleUsage.cost_usd,
        timedOut,
        filesWritten: Array.from(state.filesWritten),
        filesEdited: Array.from(state.filesEdited),
        filesRead: Array.from(state.filesRead),
        oracleUsage,
      });
    } finally {
      /* v8 ignore next -- timeoutHandle is always set; defensive guard */
      if (timeoutHandle) clearTimeout(timeoutHandle);
      clearTimeout(exitGraceHandle);
      if (queryHandle) queryHandle.close();
      if (options.signal && onExternalAbort) {
        options.signal.removeEventListener('abort', onExternalAbort);
      }
    }
  }

  return { exitCode: state.exitCode, sessionId: state.sessionId };
}
