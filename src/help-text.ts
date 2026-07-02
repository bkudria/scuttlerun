export const HELP_TEXT = `
Session Config (YAML):
  Only 'prompt' is required. All other fields have defaults.
  Complete reference with all fields and defaults:

    version: "1"

    # --- Required ---
    prompt: |                           # The task for the agent
      Write a haiku about the ocean and save it to ocean.txt

    # --- Agent ---
    model: claude-sonnet-5              # Agent model (default: claude-haiku-4-5)
    max_turns: 50                       # Max agent turns (default: 50)
    max_budget_usd: 1.00                # Max spend in USD (optional)
    effort: high                        # low | medium | high | xhigh | max (default: high)

    # --- Tools ---
    tools:                              # Tools the agent can use (default: below)
      - Read                            #   Read, Write, Edit, Bash,
      - Write                           #   Glob, Grep, AskUserQuestion,
      - Edit                            #   Skill, Agent
      - Bash
      - Glob
      - Grep
      - AskUserQuestion                 # Handled by the synthetic user
      - Skill                           # Invoke Claude Code skills
      - Agent                           # Delegate to sub-agents (sdk.agents)
    additional_tools: []                # Appended to tools after defaults (optional)
                                        #   Deduped first-wins; useful for adding
                                        #   to defaults without restating them
    disallowed_tools:                   # Always deny these tools (optional)
      - Agent                           #   (shown: disable a default tool)

    # --- Permissions ---
    permission_mode: bypassPermissions  # default | acceptEdits | bypassPermissions
                                        #   | plan | dontAsk (default: bypassPermissions)

    # --- Credentials ---
    auth: auto                          # auto | subscription | api-key (default: auto)
                                        #   auto: prefer a Claude subscription (Claude Code
                                        #   login or CLAUDE_CODE_OAUTH_TOKEN) when present,
                                        #   otherwise use ANTHROPIC_API_KEY

    # --- Project Scaffolding ---
    # When present, configures the temp project directory.
    # scuttlerun always creates a temp dir in $TMPDIR as the agent's cwd.
    project:
      claude_md: |                      # Written to <tempdir>/CLAUDE.md
        Use clear, descriptive variable names.
      skills:                           # Symlinked into <tempdir>/.claude/skills/
        - ~/.claude/skills/my-skill     #   Supports ~ and relative paths
      plugins:                          # Preferred surface for loading plugins
        - ~/code/my-plugin              #   Translated at runtime to
                                        #   sdk.plugins: [{type: local, path: ...}]
                                        #   Supports ~ and relative paths
                                        #   Merged with sdk.plugins; dedupe first-wins
                                        #   by resolved path
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
      plugins:                          # Raw SDK plugin entries (escape hatch)
        - type: local                   #   Prefer project.plugins above for
          path: ~/code/my-plugin        #   the common local-plugin case
                                        #   Merged with project.plugins; dedupe
                                        #   first-wins by resolved path
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
  scuttlerun session.yaml --model claude-sonnet-5 --timeout 120

  # Merge a base config with a scenario override
  scuttlerun base.yaml scenario.yaml

  # Quick one-off with prompt override
  scuttlerun session.yaml --prompt "Write hello world in Python"

  # Restrict tools
  scuttlerun session.yaml --tools Read,Glob,Grep

  # Validate config without running
  scuttlerun session.yaml --dry-run

  # Bill to the API key even when a Claude subscription is logged in
  scuttlerun session.yaml --auth api-key

Output:
  scuttlerun streams a transcript to stdout including user messages, assistant
  responses, tool calls, thinking blocks, and oracle decisions.

  Before the transcript: config file paths, project dir, and SDK transcript path.
  After the transcript: a summary with paths and stats (turns, tool calls, etc.).

  The SDK session file (full conversation JSONL) is preserved at
  ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl

  The project temp dir in $TMPDIR is preserved after the session ends.

Exit Codes:
  Codes 3 and 4 are reserved for upstream tooling and not emitted by scuttlerun.

  0    Session completed normally
  1    Configuration error (invalid YAML, missing fields)
  2    Runtime error (SDK failure, process crash, unhandled exception)
  5    Budget exceeded
  6    Timeout
  7    Max turns exceeded
  130  Interrupted (SIGINT)

  Budget exhaustion normally exits 5, but a mid-run "Reached maximum
  budget" SDK error surfaces as code 2 instead.`;
