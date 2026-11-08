import { describe, it, expect, vi, afterEach } from 'vitest';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { SessionConfig } from '../src/config.js';
import { DEFAULT_SESSION_TIMEOUT_SECONDS } from '../src/config.js';
import { buildSdkOptions, type BuildSdkOptionsCtx } from '../src/sdk-options.js';

const projectDir = '/tmp/scuttlerun-project-test123';

function minConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    prompt: 'Write a haiku',
    model: 'claude-haiku-4-5',
    max_turns: 50,
    timeout: DEFAULT_SESSION_TIMEOUT_SECONDS,
    effort: 'high',
    tools: ['Read', 'Write', 'AskUserQuestion', 'Skill'],
    permission_mode: 'bypassPermissions',
    auth: 'auto',
    user: {
      oracle_model: 'claude-haiku-4-5',
      max_turns: 0,
    },
    sdk: { system_prompt: { preset: 'claude_code' as const }, setting_sources: [] },
    sandbox: {
      enabled: true,
      network: {
        allowed_domains: [],
        allow_local_binding: false,
      },
      filesystem: {
        deny_read: ['~/.ssh', '~/.aws', '~/.config/gcloud'],
        allow_write: [],
        deny_write: ['.env'],
      },
    },
    ...overrides,
  };
}

const noSandbox = {
  enabled: false,
  network: { allowed_domains: [], allow_local_binding: false },
  filesystem: { deny_read: [], allow_write: [], deny_write: [] },
};

function sandboxedCtx(overrides: Partial<BuildSdkOptionsCtx> = {}): BuildSdkOptionsCtx {
  return {
    cwd: projectDir,
    sandboxHome: `${projectDir}/.home`,
    claudeDir: undefined,
    abortController: new AbortController(),
    verbose: false,
    parentAuthEnv: { ...process.env, CLAUDECODE: undefined },
    agentPrefersSubscription: false,
    ...overrides,
  };
}

function unsandboxedCtx(overrides: Partial<BuildSdkOptionsCtx> = {}): BuildSdkOptionsCtx {
  return sandboxedCtx({ sandboxHome: undefined, ...overrides });
}

describe('buildSdkOptions', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("expands ~ in sandbox filesystem paths against the operator's home, not the sandbox HOME", () => {
    const options = buildSdkOptions(
      minConfig({
        sandbox: {
          enabled: true,
          network: { allowed_domains: [], allow_local_binding: false },
          filesystem: {
            deny_read: ['~/.ssh', '~', '/etc/secret'],
            allow_write: ['~/out'],
            deny_write: ['~/.gitconfig', '.env', '~other/x'],
          },
        },
      }),
      {},
      sandboxedCtx(),
    );

    const { filesystem } = options.sandbox as { filesystem: Record<string, string[]> };
    expect(filesystem.denyRead).toEqual([join(homedir(), '.ssh'), homedir(), '/etc/secret']);
    expect(filesystem.allowWrite).toEqual([projectDir, '/tmp', join(homedir(), 'out')]);
    expect(filesystem.denyWrite).toEqual([join(homedir(), '.gitconfig'), '.env', '~other/x']);
  });

  describe('CLAUDE_CONFIG_DIR for a seeded claude_dir', () => {
    const projectPath = '/tmp/scuttlerun-project-scaffold123';
    const claudeDir = `${projectPath}/.home/.claude`;

    it('exports CLAUDE_CONFIG_DIR for a seeded claude_dir in the sandbox env', () => {
      const options = buildSdkOptions(
        minConfig(),
        {},
        sandboxedCtx({ cwd: projectPath, sandboxHome: `${projectPath}/.home`, claudeDir }),
      );

      const env = options.env as Record<string, string>;
      expect(env.HOME).toBe(`${projectPath}/.home`);
      expect(env.CLAUDE_CONFIG_DIR).toBe(claudeDir);
    });

    it('exports CLAUDE_CONFIG_DIR over an explicit sdk.env when the sandbox is disabled', () => {
      const options = buildSdkOptions(
        minConfig({
          sandbox: noSandbox,
          sdk: {
            system_prompt: { preset: 'claude_code' as const },
            env: { FOO: 'bar', CLAUDE_CONFIG_DIR: '/elsewhere' },
            setting_sources: [],
          },
        }),
        {},
        unsandboxedCtx({ cwd: projectPath, claudeDir }),
      );

      expect(options.env).toEqual({ FOO: 'bar', CLAUDE_CONFIG_DIR: claudeDir });
    });

    it('exports CLAUDE_CONFIG_DIR in the inherited env when the sandbox is disabled', () => {
      const options = buildSdkOptions(
        minConfig({ sandbox: noSandbox }),
        {},
        unsandboxedCtx({ cwd: projectPath, claudeDir }),
      );

      const env = options.env as Record<string, string | undefined>;
      expect(env.CLAUDE_CONFIG_DIR).toBe(claudeDir);
      expect(env.PATH).toBe(process.env.PATH);
    });
  });

  it('passes verbose stderr callback that writes to stderr', () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const options = buildSdkOptions(minConfig(), {}, sandboxedCtx({ verbose: true }));

    // Invoke the captured stderr callback to cover the function body
    const stderrFn = options.stderr as (data: string) => void;
    expect(stderrFn).toBeTypeOf('function');
    stderrFn('test stderr data');
    expect(stderrWrite).toHaveBeenCalledWith('test stderr data');
  });

  it('sets sdk.env when sandbox is disabled but sdk.env is provided', () => {
    const options = buildSdkOptions(
      minConfig({
        sandbox: noSandbox,
        sdk: {
          system_prompt: { preset: 'claude_code' as const },
          env: { FOO: 'bar' },
          setting_sources: [],
        },
      }),
      {},
      unsandboxedCtx(),
    );

    expect(options.env).toEqual({ FOO: 'bar' });
  });

  it('passes optional SDK config fields when set', () => {
    const options = buildSdkOptions(
      minConfig({
        max_budget_usd: 5.0,
        disallowed_tools: ['Agent'],
        sdk: {
          system_prompt: 'Be concise',
          thinking: { type: 'adaptive' },
          mcp_servers: { test: { command: 'node', args: ['server.js'] } },
          agents: { helper: { description: 'helper agent', prompt: 'be helpful' } },
          setting_sources: ['project'],
        },
      }),
      {},
      sandboxedCtx(),
    );

    expect(options.maxBudgetUsd).toBe(5.0);
    expect(options.systemPrompt).toEqual(['Be concise', SYSTEM_PROMPT_DYNAMIC_BOUNDARY]);
    expect(options.disallowedTools).toEqual(['Agent']);
    expect(options.thinking).toEqual({ type: 'adaptive' });
    expect(options.mcpServers).toEqual({ test: { command: 'node', args: ['server.js'] } });
    expect(options.agents).toEqual({
      helper: { description: 'helper agent', prompt: 'be helpful' },
    });
  });

  it('wraps custom string systemPrompt in [string, SYSTEM_PROMPT_DYNAMIC_BOUNDARY] for prompt caching', () => {
    const options = buildSdkOptions(
      minConfig({
        sdk: {
          system_prompt: 'Be concise',
          setting_sources: [],
        },
      }),
      {},
      sandboxedCtx(),
    );

    expect(options.systemPrompt).toEqual(['Be concise', SYSTEM_PROMPT_DYNAMIC_BOUNDARY]);
  });

  describe('plugins', () => {
    it('resolves sdk.plugins paths against the config dir', () => {
      vi.stubEnv('HOME', '/home/operator');

      const options = buildSdkOptions(
        minConfig({
          sdk: {
            system_prompt: { preset: 'claude_code' as const },
            plugins: [{ type: 'local', path: '~/my-plugin' }],
            setting_sources: [],
          },
        }),
        { configDir: '/tmp/cfg' },
        sandboxedCtx(),
      );

      expect(options.plugins).toEqual([{ type: 'local', path: '/home/operator/my-plugin' }]);
    });

    it('falls back to process.cwd() for plugin resolution when configDir is omitted', () => {
      const options = buildSdkOptions(
        minConfig({
          sdk: {
            system_prompt: { preset: 'claude_code' as const },
            plugins: [{ type: 'local', path: './rel' }],
            setting_sources: [],
          },
        }),
        // no configDir — forces options.configDir || process.cwd() to take the right side
        {},
        sandboxedCtx(),
      );

      expect(options.plugins).toEqual([{ type: 'local', path: resolve(process.cwd(), 'rel') }]);
    });

    it('translates project.plugins entries into sdk.plugins', () => {
      vi.stubEnv('HOME', '/home/operator');

      const options = buildSdkOptions(
        minConfig({
          project: {
            plugins: ['~/code/plugin-a', './rel-plugin'],
          },
        }),
        { configDir: '/tmp/cfg' },
        sandboxedCtx(),
      );

      expect(options.plugins).toEqual([
        { type: 'local', path: '/home/operator/code/plugin-a' },
        { type: 'local', path: '/tmp/cfg/rel-plugin' },
      ]);
    });

    it('merges project.plugins with sdk.plugins, deduping by resolved path (first-wins)', () => {
      const options = buildSdkOptions(
        minConfig({
          project: {
            // project.plugins entries come first → canonical
            plugins: ['/abs/plugin-a', '/abs/plugin-b'],
          },
          sdk: {
            system_prompt: { preset: 'claude_code' as const },
            // /abs/plugin-a duplicates project entry → dropped
            // /abs/plugin-c is unique → preserved
            plugins: [
              { type: 'local', path: '/abs/plugin-a' },
              { type: 'local', path: '/abs/plugin-c' },
            ],
            setting_sources: [],
          },
        }),
        { configDir: '/tmp/cfg' },
        sandboxedCtx(),
      );

      expect(options.plugins).toEqual([
        { type: 'local', path: '/abs/plugin-a' },
        { type: 'local', path: '/abs/plugin-b' },
        { type: 'local', path: '/abs/plugin-c' },
      ]);
    });
  });

  it('passes claude_code preset as default systemPrompt', () => {
    const options = buildSdkOptions(minConfig(), {}, sandboxedCtx());

    expect(options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
    });
  });

  it('passes preset with append when configured', () => {
    const options = buildSdkOptions(
      minConfig({
        sdk: {
          system_prompt: { preset: 'claude_code' as const, append: 'Be brief.' },
          setting_sources: [],
        },
      }),
      {},
      sandboxedCtx(),
    );

    expect(options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Be brief.',
    });
  });

  it('filters sandbox env to only safe vars from process.env', () => {
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'FAKE_SECRET');
    vi.stubEnv('GITHUB_TOKEN', 'ghp_fake');

    const options = buildSdkOptions(minConfig(), {}, sandboxedCtx());

    const env = options.env as Record<string, string>;
    expect(env).toBeDefined();
    expect(env.HOME).toBe(`${projectDir}/.home`);
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    // Safe vars from process.env should be present
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('includes sdk.env vars in sandbox filtered env', () => {
    const options = buildSdkOptions(
      minConfig({
        sdk: {
          system_prompt: { preset: 'claude_code' as const },
          env: { CUSTOM_VAR: 'custom' },
          setting_sources: [],
        },
      }),
      {},
      sandboxedCtx(),
    );

    const env = options.env as Record<string, string>;
    expect(env).toBeDefined();
    expect(env.CUSTOM_VAR).toBe('custom');
    expect(env.HOME).toBe(`${projectDir}/.home`);
  });
});
