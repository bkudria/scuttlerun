#!/usr/bin/env node

import { Command } from "commander";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
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

const HELP_TEXT = `
Session Config (YAML):
  Only 'prompt' is required. All other fields have defaults.
  Complete reference with all fields and defaults:

    version: "1"

    # --- Required ---
    prompt: |                           # The task for the agent
      Write a haiku about the ocean and save it to ocean.txt

    # --- Agent ---
    model: claude-sonnet-4-6            # Agent model (default: claude-haiku-4-5)
    max_turns: 50                       # Max agent turns (default: 50)
    max_budget_usd: 1.00                # Max spend in USD (optional)
    effort: high                        # low | medium | high | max (default: high)

    # --- Tools ---
    tools:                              # Tools the agent can use (default: below)
      - Read                            #   Read, Write, Edit, Bash,
      - Write                           #   Glob, Grep, AskUserQuestion,
      - Edit                            #   Skill
      - Bash
      - Glob
      - Grep
      - AskUserQuestion                 # Handled by the synthetic user
      - Skill                           # Invoke Claude Code skills
    disallowed_tools:                   # Always deny these tools (optional)
      - Agent

    # --- Permissions ---
    permission_mode: bypassPermissions  # default | acceptEdits | bypassPermissions
                                        #   | plan | dontAsk (default: bypassPermissions)

    # --- Project Scaffolding ---
    # When present, configures the temp project directory.
    # scuttlerun always creates a temp dir in $TMPDIR as the agent's cwd.
    project:
      claude_md: |                      # Written to <tempdir>/CLAUDE.md
        Use clear, descriptive variable names.
      skills:                           # Symlinked into <tempdir>/.claude/skills/
        - ~/.claude/skills/my-skill     #   Supports ~ and relative paths
      settings: {}                      # Written to <tempdir>/.claude/settings.json
      files:                            # Written to <tempdir>/<path> (key=path, value=content)
        app.py: |
          print("hello")
      git_init: false                   # Run 'git init' in temp dir (default: false)

    # --- Sandbox ---
    # Always enabled by default. The agent runs inside an OS-level sandbox
    # that restricts filesystem and network access.
    sandbox:
      enabled: true                       # (default: true)
      network:
        allowed_domains: []               # Domains the agent can reach (default: [])
                                          #   No network access by default
        allow_local_binding: false        # Bind to local ports (default: false)
      filesystem:
        deny_read:                        # Paths denied for reading (default: below)
          - ~/.ssh
          - ~/.aws
          - ~/.config/gcloud
        allow_write: []                   # Extra writable paths (default: [])
                                          #   cwd and /tmp are always writable
        deny_write:                       # Paths denied for writing (default: below)
          - .env

    # When sandbox is enabled, HOME is redirected to <projectDir>/.home
    # so tools (npm, pip, cargo, etc.) write caches inside the sandbox.

    # --- Synthetic User ---
    user:
      persona: |                        # Persona guiding oracle responses (optional)
        You are a beginner programmer who prefers simple code.
      oracle_model: claude-haiku-4-5    # Model for synthetic user (default: claude-haiku-4-5)
      max_turns: 0                      # Max follow-up turns (default: 0)
                                        #   0: no follow-ups
                                        #   1+: oracle decides, capped at max_turns

    # --- Agent SDK Passthrough ---
    sdk:
      system_prompt:                    # System prompt (default: claude_code preset)
        preset: claude_code             #   Uses Claude Code's full system prompt
        append: |                       #   Append extra instructions (optional)
          Additional instructions here.
      # Or override with a custom string:
      # system_prompt: "You are a helpful assistant."
      thinking:                         # Thinking config (optional)
        type: adaptive                  #   adaptive | enabled | disabled
      mcp_servers: {}                   # MCP server definitions (optional)
      agents: {}                        # Subagent definitions (optional)
      plugins:                          # Plugins to load (optional)
        - type: local                   #   Local plugin directory
          path: ~/code/my-plugin        #   Supports ~ and relative paths
      env: {}                           # Environment variables (optional)
      setting_sources:                  # Settings to load (optional)
        - project                       #   Auto-set to [project] when project: present

Config Merging:
  Multiple YAML files are deep-merged (objects merge, arrays/scalars replace):
    scuttlerun base.yaml override.yaml
  Later files win. CLI flags override everything.

Examples:
  # Minimal single-turn session
  scuttlerun session.yaml

  # Override model and timeout
  scuttlerun session.yaml --model claude-sonnet-4-6 --timeout 120

  # Merge a base config with a scenario override
  scuttlerun base.yaml scenario.yaml

  # Quick one-off with prompt override
  scuttlerun session.yaml --prompt "Write hello world in Python"

  # Restrict tools
  scuttlerun session.yaml --tools Read,Glob,Grep

  # Validate config without running
  scuttlerun session.yaml --dry-run

Output:
  scuttlerun streams a transcript to stdout including user messages, assistant
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
    .name("scuttlerun")
    .description(
      "Multi-turn Claude session driver.\n" +
      "Runs headless Claude sessions with a synthetic user powered by an LLM oracle.\n" +
      "Handles AskUserQuestion, multi-turn follow-ups, and project scaffolding.",
    )
    .version("0.1.0")
    .argument("<session.yaml>", "Session config file (YAML). Only 'prompt' is required.")
    .argument("[override.yaml...]", "Additional YAML files to deep-merge (last wins)")
    .option("--model <model>", "Agent model (default: claude-haiku-4-5)")
    .option("--oracle-model <model>", "Synthetic user oracle model (default: claude-haiku-4-5)")
    .option("--prompt <text>", "Override the prompt from the YAML config")
    .option("--max-turns <n>", "Max agent turns (default: 50)", (v: string) => parseInt(v, 10))
    .option("--tools <tools>", "Tools list, comma-separated (e.g. Read,Write,Grep)")
    .option("--effort <level>", "Thinking effort: low, medium, high, max (default: high)")
    .option("--timeout <seconds>", "Session timeout in seconds", (v: string) => parseInt(v, 10), 300)
    .option("-v, --verbose", "Verbose logging to stderr (includes agent stderr)")
    .option("-n, --dry-run", "Validate and display the resolved config without running")
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

        if (opts.dryRun) {
          // Output resolved config summary as YAML
          const proj = config.project;
          const hasProject = proj && (proj.claude_md || (proj.skills && proj.skills.length > 0) || proj.files || proj.git_init);

          const summary: Record<string, unknown> = {
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
                    ...(proj.settings ? { settings: proj.settings } : {}),
                    ...(proj.files ? { files: proj.files } : {}),
                    ...(proj.git_init ? { git_init: proj.git_init } : {}),
                  },
                }
              : {}),
            ...(config.sdk.plugins ? { sdk: { plugins: config.sdk.plugins } } : {}),
            prompt: config.prompt,
          };

          process.stdout.write(stringifyYaml(summary));
          process.exit(0);
        }

        const result = await runSession(config, {
          timeoutSeconds: opts.timeout,
          verbose: opts.verbose,
          configDir,
          configPaths,
        });

        process.exit(result.exitCode);
      } catch (err) {
        process.stderr.write(
          `[scuttlerun] Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }
    });

  program.addHelpText("after", HELP_TEXT);

  // Show help when no arguments are provided
  if (process.argv.length <= 2) {
    program.help();
  }

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
