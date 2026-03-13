# scuttlerun

> **Unreleased.** scuttlerun is under active development and its API, config format, and behavior may change without notice.

A TypeScript CLI that drives multi-turn Claude sessions programmatically using the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk). scuttlerun simulates a synthetic user powered by an LLM oracle, enabling headless, scriptable, fully-observable interactions with Claude — including interactive tools like `AskUserQuestion`.

## Install

```bash
git clone <repo-url> && cd scuttlerun
npm install
npm run build
npm link          # makes `scuttlerun` available globally
```

## Quick Start

```bash
scuttlerun run examples/simple.yml

# Run with overrides
scuttlerun run examples/multi-turn.yml --timeout 120 --model claude-sonnet-4-6
```

## Session Config

Sessions are defined in YAML. Only `prompt` is required — everything else has defaults.

```yaml
version: "1"
prompt: |
  Write a haiku about the ocean and save it to ocean.txt
```

### Config Reference

| Field | Type | Default |
|-------|------|---------|
| `prompt` | string | *(required)* |
| `model` | string | system default |
| `max_turns` | number | `50` |
| `max_budget_usd` | number | — |
| `system_prompt` | string | — |
| `effort` | `low` \| `medium` \| `high` \| `max` | `high` |
| `tools` | string[] | `[Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion]` |
| `disallowed_tools` | string[] | — |
| `permission_mode` | string | `bypassPermissions` |

#### `user` (synthetic user)

| Field | Type | Default |
|-------|------|---------|
| `user.persona` | string | — |
| `user.oracle_model` | string | `claude-haiku-4-5` |
| `user.turn_policy` | `single` \| `reactive` | `single` |
| `user.max_user_turns` | number | `5` |

#### `project` (managed project scaffolding)

When present, scuttlerun populates the project temp directory.

| Field | Type | Default |
|-------|------|---------|
| `project.claude_md` | string | — |
| `project.skills` | string[] | — |
| `project.settings` | object | — |
| `project.git_init` | boolean | `false` |

#### `sdk` (Agent SDK passthrough)

| Field | Type | Default |
|-------|------|---------|
| `sdk.thinking` | `{type: "adaptive"}` \| `{type: "enabled"}` \| `{type: "disabled"}` | — |
| `sdk.mcp_servers` | object | — |
| `sdk.agents` | object | — |
| `sdk.env` | Record\<string, string\> | — |
| `sdk.setting_sources` | string[] | `["project"]` if `project:` present, else `[]` |

### Config Merging

Multiple YAML files are deep-merged (objects merge, arrays/scalars replace):

```bash
scuttlerun run base.yml scenario-override.yml
```

## CLI

```
scuttlerun run <session.yml> [override.yml...] [options]
scuttlerun version
```

| Option | Description |
|--------|-------------|
| `--model <model>` | Override agent model |
| `--oracle-model <model>` | Override synthetic user model |
| `--prompt <text>` | Override prompt |
| `--max-turns <n>` | Override max agent turns |
| `--tools <tools>` | Override tools (comma-separated) |
| `--effort <level>` | Override effort level |
| `--timeout <seconds>` | Session timeout (default: 300) |
| `-v, --verbose` | Verbose logging to stderr |
| `-q, --quiet` | Suppress progress output |

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Session completed normally |
| 1 | Configuration error |
| 2 | Session error |
| 3 | Max turns exceeded |
| 4 | Budget exceeded |
| 5 | Timeout |

## How It Works

scuttlerun wraps the Claude Agent SDK's `query()` with an async generator for multi-turn input. Two key mechanisms:

1. **`canUseTool` callback** — Intercepts `AskUserQuestion` calls. An LLM oracle (Haiku by default) answers questions consistent with the configured persona.

2. **Turn policy** — After each agent turn, the oracle decides whether the synthetic user should send a follow-up (`reactive` mode) or end the session (`single` mode).

## Output

scuttlerun streams a YAML transcript to stdout as the session runs:

```yaml
session: a1b2c3d4-e5f6-7890-abcd-ef1234567890
config: /path/to/session.yml
project: /tmp/scuttlerun-project-xK3f9m
transcript: ~/.claude/projects/-tmp-.../a1b2c3.jsonl

conversation:
  - user: |
      Write a haiku about the ocean and save it to ocean.txt

  - assistant: |
      I'll write a haiku about the ocean.

  - tool: Write
    path: ocean.txt

  - assistant: |
      Done! I saved the haiku to ocean.txt.

turns: 2
tool_calls: 1
duration_s: 12.3
```

The output is valid YAML and machine-parseable (e.g. with `yq`).

**Project directory** — Always created in `$TMPDIR`, preserved after the session ends. Inspect agent-created files there.

**SDK session file** — Full conversation record in Claude Code's native JSONL format at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. Queryable with `jq`.

## Examples

See [`examples/`](examples/) for complete session configs:

- **[simple.yml](examples/simple.yml)** — Single-turn, no follow-ups
- **[interactive.yml](examples/interactive.yml)** — AskUserQuestion handling
- **[multi-turn.yml](examples/multi-turn.yml)** — Reactive multi-turn with a persona
- **[skill-eval.yml](examples/skill-eval.yml)** — Managed project with skill symlinks

## Development

```bash
npm install
npm run build        # TypeScript compilation
npm test             # Run all tests (vitest)
npm run test:watch   # Watch mode
npm run dev -- run examples/simple.yml   # Run via tsx
```

## See Also

- [SPEC.md](SPEC.md) — Full specification and design decisions
