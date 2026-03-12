#!/usr/bin/env node

import { Command } from "commander";
import { parse as parseYaml } from "yaml";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { parseSessionConfig, mergeRawConfigs, type SessionConfig } from "./config.js";
import { runSession } from "./runner.js";

interface CliOverrides {
  model?: string;
  oracleModel?: string;
  prompt?: string;
  maxTurns?: number;
  tools?: string;
  effort?: string;
  timeout?: number;
  verbose?: boolean;
  quiet?: boolean;
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
  if (overrides.effort) {
    config = { ...config, effort: overrides.effort as SessionConfig["effort"] };
  }
  if (overrides.tools) {
    config = { ...config, tools: overrides.tools.split(",").map((t) => t.trim()) };
  }
  if (overrides.oracleModel) {
    config = {
      ...config,
      user: { ...config.user, oracle_model: overrides.oracleModel },
    };
  }

  return config;
}

const RUN_HELP_TEXT = `
Session Config (YAML):
  Only 'prompt' is required. All other fields have defaults.
  Complete reference with all fields and defaults:

    version: "1"

    # --- Required ---
    prompt: |                           # The task for the agent
      Write a haiku about the ocean and save it to ocean.txt

    # --- Agent ---
    model: claude-sonnet-4-6            # Agent model (default: system default)
    max_turns: 50                       # Max agent turns (default: 50)
    max_budget_usd: 1.00                # Max spend in USD (optional)
    system_prompt: |                    # Custom system prompt (optional)
      You are a helpful assistant.
    effort: high                        # low | medium | high | max (default: high)

    # --- Tools ---
    tools:                              # Tools the agent can use (default: below)
      - Read                            #   Read, Write, Edit, Bash,
      - Write                           #   Glob, Grep, AskUserQuestion
      - Edit
      - Bash
      - Glob
      - Grep
      - AskUserQuestion                 # Handled by the synthetic user
    disallowed_tools:                   # Always deny these tools (optional)
      - Agent

    # --- Permissions ---
    permission_mode: bypassPermissions  # default | acceptEdits | bypassPermissions
                                        #   | plan | dontAsk (default: bypassPermissions)

    # --- Project Scaffolding ---
    # When present, configures the temp project directory.
    # Warren always creates a temp dir in $TMPDIR as the agent's cwd.
    project:
      claude_md: |                      # Written to <tempdir>/CLAUDE.md
        Use clear, accessible language.
      skills:                           # Symlinked into <tempdir>/.claude/skills/
        - ~/.claude/skills/my-skill     #   Supports ~ and relative paths
      settings: {}                      # Written to <tempdir>/.claude/settings.json
      git_init: false                   # Run 'git init' in temp dir (default: false)

    # --- Synthetic User ---
    user:
      persona: |                        # Persona guiding oracle responses (optional)
        You are a beginner programmer who prefers simple code.
      oracle_model: claude-haiku-4-5    # Model for synthetic user (default: claude-haiku-4-5)
      turn_policy: single               # single | reactive (default: single)
                                        #   single:   one prompt, no follow-ups
                                        #   reactive: oracle decides follow-ups
      max_user_turns: 5                 # Max follow-up messages (default: 5)

    # --- Agent SDK Passthrough ---
    sdk:
      thinking:                         # Thinking config (optional)
        type: adaptive                  #   adaptive | enabled | disabled
      mcp_servers: {}                   # MCP server definitions (optional)
      agents: {}                        # Subagent definitions (optional)
      env: {}                           # Environment variables (optional)
      setting_sources:                  # Settings to load (optional)
        - project                       #   Auto-set to [project] when project: present

Config Merging:
  Multiple YAML files are deep-merged (objects merge, arrays/scalars replace):
    warren run base.yml override.yml
  Later files win. CLI flags override everything.

Examples:
  # Minimal single-turn session
  warren run session.yml

  # Override model and timeout
  warren run session.yml --model claude-sonnet-4-6 --timeout 120

  # Merge a base config with a scenario override
  warren run base.yml scenario.yml

  # Quick one-off with prompt override
  warren run session.yml --prompt "Write hello world in Python"

  # Restrict tools
  warren run session.yml --tools Read,Glob,Grep

Output:
  Warren streams a transcript to stdout including user messages, assistant
  responses, tool calls, thinking blocks, and oracle decisions.

  Before the transcript: config file paths, project dir, and SDK transcript path.
  After the transcript: a summary with paths and stats (turns, tool calls, etc.).

  The SDK session file (full conversation JSONL) is preserved at
  ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl

  The project temp dir in $TMPDIR is preserved after the session ends.

Exit Codes:
  0   Session completed normally
  1   Configuration error (invalid YAML, missing fields)
  2   Session error (SDK failure, process crash)
  3   Max turns exceeded
  4   Budget exceeded
  5   Timeout`;

async function main() {
  const program = new Command();

  program
    .name("warren")
    .description(
      "Multi-turn Claude session driver.\n" +
      "Runs headless Claude sessions with a synthetic user powered by an LLM oracle.\n" +
      "Handles AskUserQuestion, multi-turn follow-ups, and project scaffolding.",
    )
    .version("0.1.0");

  program.addHelpText("after", "\nRun 'warren run --help' for full documentation.");

  const runCmd = program
    .command("run")
    .description("Run a warren session from a YAML config file")
    .argument("<session.yml>", "Session config file (YAML). Only 'prompt' is required.")
    .argument("[override.yml...]", "Additional YAML files to deep-merge (last wins)")
    .option("--model <model>", "Agent model (e.g. claude-sonnet-4-6, claude-haiku-4-5)")
    .option("--oracle-model <model>", "Synthetic user oracle model (default: claude-haiku-4-5)")
    .option("--prompt <text>", "Override the prompt from the YAML config")
    .option("--max-turns <n>", "Max agent turns (default: 50)", parseInt)
    .option("--tools <tools>", "Tools list, comma-separated (e.g. Read,Write,Grep)")
    .option("--effort <level>", "Thinking effort: low, medium, high, max (default: high)")
    .option("--timeout <seconds>", "Session timeout in seconds", parseInt, 300)
    .option("-v, --verbose", "Verbose logging to stderr (includes agent stderr)")
    .option("-q, --quiet", "Suppress progress output")
    .action(async (sessionFile: string, overrideFiles: string[], opts) => {
      try {
        // Read all YAML files
        const allFiles = [sessionFile, ...overrideFiles];
        const yamlContents: string[] = [];
        const configPaths: string[] = [];
        let configDir = process.cwd();

        for (const file of allFiles) {
          const resolved = resolve(file);
          configDir = dirname(resolved);
          configPaths.push(resolved);
          const content = await readFile(resolved, "utf8");
          yamlContents.push(content);
        }

        const config = await buildConfig(yamlContents, {
          model: opts.model,
          oracleModel: opts.oracleModel,
          prompt: opts.prompt,
          maxTurns: opts.maxTurns,
          tools: opts.tools,
          effort: opts.effort,
        });

        const result = await runSession(config, {
          timeoutSeconds: opts.timeout,
          verbose: opts.verbose,
          quiet: opts.quiet,
          configDir,
          configPaths,
        });

        process.exit(result.exitCode);
      } catch (err) {
        process.stderr.write(
          `[warren] Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    });

  runCmd.addHelpText("after", RUN_HELP_TEXT);

  program
    .command("version")
    .description("Show warren version")
    .action(() => {
      console.log("warren 0.1.0");
    });

  await program.parseAsync(process.argv);
}

// Only run CLI when executed directly
const isDirectExecution =
  process.argv[1] &&
  (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url.endsWith("/dist/cli.js"));

if (isDirectExecution) {
  main();
}
