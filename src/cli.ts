#!/usr/bin/env node

import { Command } from 'commander';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSessionConfig, mergeRawConfigs, type SessionConfig } from './config.js';
import { runSession, DEFAULT_SESSION_TIMEOUT_SECONDS } from './runner.js';
import { formatCliError } from './errors.js';
import { EXIT_SUCCESS, EXIT_CONFIG_ERROR, EXIT_SIGINT } from './exit-codes.js';
import { HELP_TEXT } from './help-text.js';

/**
 * Read the CLI version from package.json so --version stays in sync with
 * the manifest across releases. Exported for testing.
 */
export function getCliVersion(): string {
  const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return pkg.version;
}

interface CliOverrides {
  model?: string;
  oracleModel?: string;
  prompt?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  tools?: string;
  effort?: string;
  timeout?: number;
  verbose?: boolean;
}

/**
 * Build a SessionConfig from YAML content strings and CLI overrides.
 * Exported for testing.
 */
export async function buildConfig(
  yamlContents: string[],
  overrides: CliOverrides,
): Promise<SessionConfig> {
  // Parse YAML strings into raw objects, merge, then apply schema defaults
  const raws = yamlContents.map((content) => (parseYaml(content) || {}) as Record<string, unknown>);
  const merged = raws.length === 1 ? raws[0] : mergeRawConfigs(...raws);
  let config = parseSessionConfig(merged);

  // Apply CLI overrides
  if (overrides.prompt) config = { ...config, prompt: overrides.prompt };
  if (overrides.model) config = { ...config, model: overrides.model };
  if (overrides.maxTurns) config = { ...config, max_turns: overrides.maxTurns };
  if (overrides.maxBudgetUsd !== undefined) {
    config = { ...config, max_budget_usd: overrides.maxBudgetUsd };
  }
  if (overrides.effort) {
    config = { ...config, effort: overrides.effort as SessionConfig['effort'] };
  }
  if (overrides.tools) {
    config = { ...config, tools: overrides.tools.split(',').map((t) => t.trim()) };
  }
  if (overrides.oracleModel) {
    config = {
      ...config,
      user: { ...config.user, oracle_model: overrides.oracleModel },
    };
  }

  return config;
}

/**
 * Build the YAML-serializable summary object that `--dry-run` prints.
 * Pure function (no IO) so it can be unit-tested. Exported for testing.
 */
export function buildDryRunSummary(config: SessionConfig): Record<string, unknown> {
  const proj = config.project;
  const hasProject =
    proj &&
    (proj.claude_md ||
      (proj.skills && proj.skills.length > 0) ||
      (proj.plugins && proj.plugins.length > 0) ||
      proj.files ||
      proj.git_init);

  return {
    model: config.model,
    tools: config.tools,
    effort: config.effort,
    max_turns: config.max_turns,
    permission_mode: config.permission_mode,
    user: {
      oracle_model: config.user.oracle_model,
      max_turns: config.user.max_turns,
      ...(config.user.persona ? { persona: config.user.persona } : {}),
    },
    ...(hasProject && proj
      ? {
          project: {
            ...(proj.claude_md ? { claude_md: proj.claude_md } : {}),
            ...(proj.skills && proj.skills.length > 0 ? { skills: proj.skills } : {}),
            ...(proj.plugins && proj.plugins.length > 0 ? { plugins: proj.plugins } : {}),
            ...(proj.settings ? { settings: proj.settings } : {}),
            ...(proj.files ? { files: proj.files } : {}),
            ...(proj.git_init ? { git_init: proj.git_init } : {}),
          },
        }
      : {}),
    ...(config.sdk.plugins ? { sdk: { plugins: config.sdk.plugins } } : {}),
    prompt: config.prompt,
  };
}

async function main() {
  const program = new Command();

  program
    .name('scuttlerun')
    .description(
      'Multi-turn Claude session driver.\n' +
        'Runs headless Claude sessions with a synthetic user powered by an LLM oracle.\n' +
        'Handles AskUserQuestion, multi-turn follow-ups, and project scaffolding.',
    )
    .version(getCliVersion())
    .argument('<session.yaml>', "Session config file (YAML). Only 'prompt' is required.")
    .argument('[override.yaml...]', 'Additional YAML files to deep-merge (last wins)')
    .option('--model <model>', 'Agent model (default: claude-haiku-4-5)')
    .option('--oracle-model <model>', 'Synthetic user oracle model (default: claude-haiku-4-5)')
    .option('--prompt <text>', 'Override the prompt from the YAML config')
    .option('--max-turns <n>', 'Max agent turns (default: 50)', (v: string) => parseInt(v, 10))
    .option('--max-budget-usd <usd>', 'Max session cost in USD (no default)', (v: string) =>
      parseFloat(v),
    )
    .option('--tools <tools>', 'Tools list, comma-separated (e.g. Read,Write,Grep)')
    .option('--effort <level>', 'Thinking effort: low, medium, high, xhigh, max (default: high)')
    .option(
      '--timeout <seconds>',
      'Session timeout in seconds',
      (v: string) => parseInt(v, 10),
      DEFAULT_SESSION_TIMEOUT_SECONDS,
    )
    .option(
      '-v, --verbose',
      'Verbose logging to stderr (includes agent stderr; note: -V is --version)',
    )
    .option('-n, --dry-run', 'Validate and display the resolved config without running')
    .action(async (sessionFile: string, overrideFiles: string[], opts) => {
      try {
        // Read all YAML files
        const allFiles = [sessionFile, ...overrideFiles];
        const yamlContents: string[] = [];
        const configPaths: string[] = [];
        let configDir = process.cwd();

        for (const file of allFiles) {
          const resolved = resolve(file);
          // Use the first file's directory for resolving relative paths (e.g. skill paths)
          if (configPaths.length === 0) configDir = dirname(resolved);
          configPaths.push(resolved);
          const content = await readFile(resolved, 'utf8');
          yamlContents.push(content);
        }

        const config = await buildConfig(yamlContents, {
          model: opts.model,
          oracleModel: opts.oracleModel,
          prompt: opts.prompt,
          maxTurns: opts.maxTurns,
          maxBudgetUsd: opts.maxBudgetUsd,
          tools: opts.tools,
          effort: opts.effort,
        });

        if (opts.dryRun) {
          process.stdout.write(stringifyYaml(buildDryRunSummary(config)));
          process.exit(EXIT_SUCCESS);
        }

        const signalController = new AbortController();
        let signalCount = 0;
        const handleSignal = () => {
          signalCount++;
          if (signalCount === 1) signalController.abort();
          else process.exit(EXIT_SIGINT);
        };
        process.on('SIGINT', handleSignal);
        process.on('SIGTERM', handleSignal);

        try {
          const result = await runSession(config, {
            timeoutSeconds: opts.timeout,
            verbose: opts.verbose,
            configDir,
            configPaths,
            signal: signalController.signal,
          });

          process.exit(result.exitCode);
        } finally {
          process.off('SIGINT', handleSignal);
          process.off('SIGTERM', handleSignal);
        }
      } catch (err) {
        process.stderr.write(formatCliError(err) + '\n');
        process.exit(EXIT_CONFIG_ERROR);
      }
    });

  program.addHelpText('after', HELP_TEXT);

  // Show help when no arguments are provided
  if (process.argv.length <= 2) {
    program.help();
  }

  await program.parseAsync(process.argv);
}

// Only run CLI when executed directly
const isDirectExecution =
  process.argv[1] &&
  (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith('/dist/cli.js'));

if (isDirectExecution) {
  main();
}
