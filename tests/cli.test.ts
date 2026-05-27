import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildConfig, getCliVersion } from '../src/cli.js';

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
      model: 'claude-sonnet-4-6',
      prompt: 'overridden prompt',
      maxTurns: 30,
      effort: 'max',
      tools: 'Read,Grep,Glob',
      oracleModel: 'claude-sonnet-4-6',
    });
    expect(config.model).toBe('claude-sonnet-4-6');
    expect(config.prompt).toBe('overridden prompt');
    expect(config.max_turns).toBe(30);
    expect(config.effort).toBe('max');
    expect(config.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(config.user.oracle_model).toBe('claude-sonnet-4-6');
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
});

describe('getCliVersion', () => {
  it('returns the version declared in package.json', () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string };
    expect(getCliVersion()).toBe(pkg.version);
  });
});
