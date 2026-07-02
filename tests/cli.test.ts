import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildConfig, buildDryRunSummary, getCliVersion } from '../src/cli.js';

describe('buildConfig', () => {
  it('parses a YAML file into a SessionConfig', async () => {
    const yaml = `
prompt: Write a haiku
model: claude-haiku-4-5
max_turns: 10
`;
    const config = await buildConfig([yaml], {});
    expect(config.prompt).toBe('Write a haiku');
    expect(config.model).toBe('claude-haiku-4-5');
    expect(config.max_turns).toBe(10);
  });

  it('merges multiple YAML strings', async () => {
    const base = `
prompt: base prompt
max_turns: 10
tools:
  - Read
  - Write
`;
    const override = `
prompt: override prompt
max_turns: 20
`;
    const config = await buildConfig([base, override], {});
    expect(config.prompt).toBe('override prompt');
    expect(config.max_turns).toBe(20);
    // tools should come from base (override didn't specify)
    expect(config.tools).toEqual(['Read', 'Write']);
  });

  it('applies CLI overrides', async () => {
    const yaml = `
prompt: original
model: claude-haiku-4-5
max_turns: 10
`;
    const config = await buildConfig([yaml], {
      model: 'claude-sonnet-5',
      prompt: 'overridden prompt',
      maxTurns: 30,
      effort: 'max',
      tools: 'Read,Grep,Glob',
      oracleModel: 'claude-sonnet-5',
    });
    expect(config.model).toBe('claude-sonnet-5');
    expect(config.prompt).toBe('overridden prompt');
    expect(config.max_turns).toBe(30);
    expect(config.effort).toBe('max');
    expect(config.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(config.user.oracle_model).toBe('claude-sonnet-5');
  });

  it('applies max_budget_usd CLI override', async () => {
    const yaml = `
prompt: hi
max_budget_usd: 1.0
`;
    const config = await buildConfig([yaml], { maxBudgetUsd: 5.5 });
    expect(config.max_budget_usd).toBe(5.5);
  });

  it('sets max_budget_usd via CLI even when YAML omits it', async () => {
    const yaml = `prompt: hi\n`;
    const config = await buildConfig([yaml], { maxBudgetUsd: 2.5 });
    expect(config.max_budget_usd).toBe(2.5);
  });

  it('applies the timeout CLI override over the config value', async () => {
    const yaml = `prompt: hi\ntimeout: 100\n`;
    const config = await buildConfig([yaml], { timeout: 250 });
    expect(config.timeout).toBe(250);
  });

  it('lets a scenario timeout override the base timeout via merge', async () => {
    const base = `prompt: hi\ntimeout: 300\n`;
    const scenario = `timeout: 600\n`;
    const config = await buildConfig([base, scenario], {});
    expect(config.timeout).toBe(600);
  });

  it('applies the --auth CLI override over the config value', async () => {
    const yaml = `prompt: hi\nauth: subscription\n`;
    const config = await buildConfig([yaml], { auth: 'api-key' });
    expect(config.auth).toBe('api-key');
  });

  it('keeps the YAML auth value when no --auth override is given', async () => {
    const yaml = `prompt: hi\nauth: subscription\n`;
    const config = await buildConfig([yaml], {});
    expect(config.auth).toBe('subscription');
  });

  it('rejects an invalid --auth override with an error naming the valid modes', async () => {
    const yaml = `prompt: hi\n`;
    await expect(buildConfig([yaml], { auth: 'oauth' })).rejects.toThrow(
      /auto, subscription, or api-key/,
    );
  });
});

describe('buildDryRunSummary', () => {
  it('includes project.plugins alongside other project fields when all are set', async () => {
    const yaml = `
prompt: hi
project:
  claude_md: |
    # Hello
  skills:
    - skill-a
  plugins:
    - ./plugin-a
    - ./plugin-b
`;
    const config = await buildConfig([yaml], {});
    const summary = buildDryRunSummary(config) as { project?: Record<string, unknown> };
    expect(summary.project).toBeDefined();
    expect(summary.project?.plugins).toEqual(['./plugin-a', './plugin-b']);
    expect(summary.project?.skills).toEqual(['skill-a']);
    expect(summary.project?.claude_md).toBe('# Hello\n');
  });

  it('emits the project block even when plugins is the only project field set', async () => {
    const yaml = `
prompt: hi
project:
  plugins:
    - ./plugin-a
`;
    const config = await buildConfig([yaml], {});
    const summary = buildDryRunSummary(config) as { project?: Record<string, unknown> };
    expect(summary.project).toBeDefined();
    expect(summary.project?.plugins).toEqual(['./plugin-a']);
  });

  it('includes the resolved timeout', async () => {
    const yaml = `prompt: hi\ntimeout: 450\n`;
    const config = await buildConfig([yaml], {});
    const summary = buildDryRunSummary(config) as { timeout?: number };
    expect(summary.timeout).toBe(450);
  });

  it('includes the resolved auth mode', async () => {
    const yaml = `prompt: hi\nauth: subscription\n`;
    const config = await buildConfig([yaml], {});
    const summary = buildDryRunSummary(config) as { auth?: string };
    expect(summary.auth).toBe('subscription');
  });
});

describe('getCliVersion', () => {
  it('returns the version declared in package.json', () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string };
    expect(getCliVersion()).toBe(pkg.version);
  });
});
