import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface LinkOauthCredentialResult {
  linked: boolean;
  source?: string;
  link?: string;
}

export function linkOauthCredentialIntoSandbox(opts: {
  realHome: string;
  sandboxHome: string;
  env: Record<string, string | undefined>;
}): LinkOauthCredentialResult {
  const key = opts.env.ANTHROPIC_API_KEY;
  if (key && key.trim() !== '') return { linked: false };

  const source = join(opts.realHome, '.claude', '.credentials.json');
  if (!existsSync(source)) return { linked: false };

  const link = join(opts.sandboxHome, '.claude', '.credentials.json');
  mkdirSync(join(opts.sandboxHome, '.claude'), { recursive: true });

  const existing = lstatSync(link, { throwIfNoEntry: false });
  if (existing) {
    if (existing.isSymbolicLink() && readlinkSync(link) === source) {
      return { linked: true, source, link };
    }
    throw new Error(
      `Cannot expose OAuth credentials: ${link} already exists and does not point to ${source}`,
    );
  }

  symlinkSync(source, link);
  return { linked: true, source, link };
}

/**
 * Produce a session-start warning when a sandboxed session has no credential
 * the agent subprocess can use, so the opaque "Not logged in" failure from the
 * Agent SDK becomes actionable.
 *
 * When the sandbox is enabled the agent runs under a redirected HOME and a
 * filtered env; the only credentials it can see are an allowlisted env var
 * (ANTHROPIC_API_KEY, or CLAUDE_SDK_OAUTH_TOKEN mapped onto
 * CLAUDE_CODE_OAUTH_TOKEN by applyAuthMode) or a `.credentials.json`
 * symlinked in by `linkOauthCredentialIntoSandbox`. A subscription `claude
 * /login` on macOS stores its credential in the Keychain, which the sandbox
 * cannot reach — so a logged-in operator with neither env var set and no
 * credentials file ends up with an unauthenticated session. This helper lets
 * the runner flag that up front instead of failing silently.
 *
 * Returns the warning string when the sandbox will have no usable credential;
 * returns undefined otherwise. Scoped to sandbox sessions: without the sandbox
 * the subprocess inherits the real HOME and can read the Keychain directly, so
 * scuttlerun cannot tell whether the operator is authenticated and stays quiet.
 */
export function sandboxCredentialWarning(opts: {
  sandboxEnabled: boolean;
  credentialLinked: boolean;
  env: Record<string, string | undefined>;
}): string | undefined {
  if (!opts.sandboxEnabled) return undefined;
  if (opts.credentialLinked) return undefined;
  const hasApiKey = (opts.env.ANTHROPIC_API_KEY ?? '').trim() !== '';
  const hasOauthToken = (opts.env.CLAUDE_SDK_OAUTH_TOKEN ?? '').trim() !== '';
  if (hasApiKey || hasOauthToken) return undefined;
  return (
    '[scuttlerun] WARNING: sandbox is enabled but no credential is available to the agent ' +
    '(no ANTHROPIC_API_KEY, no CLAUDE_SDK_OAUTH_TOKEN, and no ~/.claude/.credentials.json ' +
    'to link). On macOS a subscription `claude /login` stores credentials in the Keychain, ' +
    'which is not visible inside the sandbox. Run `claude setup-token` and export ' +
    'CLAUDE_SDK_OAUTH_TOKEN, or set sandbox.enabled: false.'
  );
}

export const SAFE_ENV_VARS: ReadonlySet<string> = new Set([
  // Required for the agent subprocess to make API calls
  'ANTHROPIC_API_KEY',
  // Tool-scoped OAuth bearer (e.g. from `claude setup-token`); applyAuthMode
  // maps it onto CLAUDE_CODE_OAUTH_TOKEN for the subprocess. The inherited
  // CLAUDE_CODE_OAUTH_TOKEN is deliberately NOT allowlisted — it would
  // override the /login credential.
  'CLAUDE_SDK_OAUTH_TOKEN',
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
