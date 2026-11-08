import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { applyAuthMode } from './auth.js';
import type { SessionConfig } from './config.js';
import { resolveConfigPath } from './project.js';
import type { RunOptions } from './runner.js';
import { buildSandboxEnv } from './sandbox.js';

export interface BuildSdkOptionsCtx {
  cwd: string;
  sandboxHome: string | undefined;
  claudeDir: string | undefined;
  abortController: AbortController;
  verbose: boolean;
  parentAuthEnv: Record<string, string | undefined>;
  agentPrefersSubscription: boolean;
}

export function buildSdkOptions(
  config: SessionConfig,
  options: RunOptions,
  ctx: BuildSdkOptionsCtx,
): Record<string, unknown> {
  const {
    cwd,
    sandboxHome,
    claudeDir,
    abortController,
    verbose,
    parentAuthEnv,
    agentPrefersSubscription,
  } = ctx;
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
  // through an allowlist to prevent leaking secrets (API keys, tokens, etc.),
  // then apply the auth mode so the preferred credential wins inside the
  // sandbox. An explicit sdk.env replaces the environment verbatim and is
  // exempt from auth shaping — the operator asked for exactly that env.
  if (sandboxHome) {
    sdkOptions.env = applyAuthMode(
      config.auth,
      buildSandboxEnv(
        process.env as Record<string, string | undefined>,
        config.sdk.env,
        sandboxHome,
      ),
      agentPrefersSubscription,
    );
  } else if (config.sdk.env) {
    sdkOptions.env = config.sdk.env;
  } else {
    // Auth-shaped parent env; CLAUDECODE is already unset (SDK rejects nested sessions)
    sdkOptions.env = parentAuthEnv;
  }
  // A seeded config dir is the agent's config dir in every branch, like HOME
  // in the sandbox: the operator asked for that tree, not for the real one.
  if (claudeDir) {
    sdkOptions.env = {
      ...(sdkOptions.env as Record<string, unknown>),
      CLAUDE_CONFIG_DIR: claudeDir,
    };
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
        allowWrite: [cwd, '/tmp', ...config.sandbox.filesystem.allow_write.map(expandHome)],
        denyRead: config.sandbox.filesystem.deny_read.map(expandHome),
        denyWrite: config.sandbox.filesystem.deny_write.map(expandHome),
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

// Claude Code would expand `~` against the sandbox's redirected HOME, where
// the operator's credentials and files are not.
function expandHome(path: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}
