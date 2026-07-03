import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const AUTH_MODES = ['auto', 'subscription', 'api-key'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

type Env = Record<string, string | undefined>;

export function parseAuthMode(value: string): AuthMode {
  if ((AUTH_MODES as readonly string[]).includes(value)) {
    return value as AuthMode;
  }
  throw new Error(`invalid --auth mode "${value}" (expected auto, subscription, or api-key)`);
}

/**
 * Best-effort check for Claude subscription (Claude Code OAuth) credentials:
 * an explicit CLAUDE_SDK_OAUTH_TOKEN, the Claude Code credentials file, or
 * the macOS Keychain entry Claude Code writes on login. Pass
 * `includeKeychain: false` when probing for the sandboxed agent — the sandbox
 * runs under a redirected HOME and cannot reach the Keychain, so a
 * Keychain-only login must not count as usable there.
 * CLAUDE_CODE_OAUTH_TOKEN deliberately does not count — scuttlerun never
 * forwards it (see buildAuthEnv), so it is not usable evidence.
 */
export function detectSubscriptionCredentials(
  env: Env = process.env,
  platform: string = process.platform,
  opts: { includeKeychain?: boolean } = {},
): boolean {
  if (env.CLAUDE_SDK_OAUTH_TOKEN?.trim()) {
    return true;
  }

  const configDir = env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const credentialsPath = join(configDir, '.credentials.json');
  if (existsSync(credentialsPath)) {
    try {
      const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));
      if (credentials.claudeAiOauth != null) {
        return true;
      }
    } catch {
      // Unreadable or unparseable file — fall through to the next source.
    }
  }

  if (platform === 'darwin' && (opts.includeKeychain ?? true)) {
    try {
      execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], {
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Build the env for an SDK subprocess running with the parent's environment
 * (the oracle, and the agent when the sandbox is disabled). The Claude Code
 * runtime prefers ANTHROPIC_API_KEY over stored OAuth credentials, so
 * preferring the subscription means withholding the API-key variables.
 * CLAUDECODE is always unset to avoid nested-session failures.
 *
 * An inherited CLAUDE_CODE_OAUTH_TOKEN is always stripped: the Claude Code
 * runtime lets that variable override a /login credential, and an export
 * meant for other tooling must not silently hijack scuttlerun runs. To hand
 * scuttlerun a token explicitly, set CLAUDE_SDK_OAUTH_TOKEN — it is mapped
 * onto CLAUDE_CODE_OAUTH_TOKEN (the only name the runtime reads) and wins
 * over /login credentials.
 */
export function buildAuthEnv(
  mode: AuthMode,
  env: Env = process.env,
  platform: string = process.platform,
): Env {
  const sdkToken = env.CLAUDE_SDK_OAUTH_TOKEN?.trim();
  const base: Env = {
    ...env,
    CLAUDECODE: undefined,
    CLAUDE_SDK_OAUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: sdkToken || undefined,
  };

  if (mode === 'api-key') {
    if (!env.ANTHROPIC_API_KEY?.trim()) {
      throw new Error('auth mode api-key requires ANTHROPIC_API_KEY to be set');
    }
    return { ...base, CLAUDE_CODE_OAUTH_TOKEN: undefined };
  }

  const hasApiCredentials = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);

  if (
    env.CLAUDE_CODE_OAUTH_TOKEN?.trim() &&
    !sdkToken &&
    !hasApiCredentials &&
    !detectSubscriptionCredentials(env, platform)
  ) {
    throw new Error(
      'CLAUDE_CODE_OAUTH_TOKEN is set but scuttlerun does not use it, and no other ' +
        'credential is available. Set CLAUDE_SDK_OAUTH_TOKEN, log in with `claude /login`, ' +
        'or set ANTHROPIC_API_KEY.',
    );
  }

  const preferSubscription =
    mode === 'subscription' || (hasApiCredentials && detectSubscriptionCredentials(env, platform));

  if (preferSubscription) {
    return { ...base, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined };
  }

  return base;
}

/**
 * Apply the auth mode to an already-constructed subprocess env (the sandbox
 * allowlist output). Returns a new object; the input is not mutated.
 * `subscriptionDetected` is the caller's detection result — for the sandbox
 * it must exclude the Keychain, which the sandbox cannot reach.
 */
export function applyAuthMode(
  mode: AuthMode,
  env: Record<string, string>,
  subscriptionDetected: boolean,
): Record<string, string> {
  const result = { ...env };
  const sdkToken = result.CLAUDE_SDK_OAUTH_TOKEN?.trim();
  delete result.CLAUDE_SDK_OAUTH_TOKEN;

  if (mode === 'api-key') {
    delete result.CLAUDE_CODE_OAUTH_TOKEN;
    return result;
  }

  // Only sdk.env can put CLAUDE_CODE_OAUTH_TOKEN here — the sandbox allowlist
  // drops the inherited one — so an existing value is explicit per-run config
  // and wins over the ambient CLAUDE_SDK_OAUTH_TOKEN.
  if (sdkToken && !result.CLAUDE_CODE_OAUTH_TOKEN) {
    result.CLAUDE_CODE_OAUTH_TOKEN = sdkToken;
  }

  if (mode === 'subscription' || subscriptionDetected) {
    delete result.ANTHROPIC_API_KEY;
    delete result.ANTHROPIC_AUTH_TOKEN;
  }

  return result;
}
