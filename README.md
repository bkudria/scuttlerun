# scuttlerun

[![npm version](https://img.shields.io/npm/v/scuttlerun.svg)](https://www.npmjs.com/package/scuttlerun)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **Unreleased.** scuttlerun is under active development and its API, config format, and behavior may change without notice.
>
> **CLI-only.** scuttlerun is intended to be used as a command-line tool. There is no supported programmatic API; modules under `dist/` are implementation details and may change without notice.

A TypeScript CLI that drives multi-turn Claude sessions programmatically using the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk). scuttlerun simulates a synthetic user powered by an LLM oracle, enabling headless, scriptable, fully-observable interactions with Claude — including interactive tools like `AskUserQuestion`.

## Installation

From npm (recommended):

```bash
npm install -g scuttlerun
# or run without installing:
npx scuttlerun@latest <session.yaml>
```

From source:

```bash
git clone https://github.com/bkudria/scuttlerun.git
cd scuttlerun
npm install
npm run build
npm link          # makes `scuttlerun` available globally
```

## Configuration

scuttlerun requires an Anthropic API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Get one at [console.anthropic.com](https://console.anthropic.com/).

## Quick Start

```bash
scuttlerun examples/simple.yaml

# Run with overrides
scuttlerun examples/multi-turn.yaml --timeout 120 --model claude-sonnet-4-6
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
| `model` | string | `claude-haiku-4-5` |
| `max_turns` | number | `50` |
| `max_budget_usd` | number | — |
| `effort` | `low` \| `medium` \| `high` \| `xhigh` \| `max` | `high` |
| `tools` | string[] | `[Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Skill]` |
| `additional_tools` | string[] | — (appended to `tools` after defaults apply; deduped first-wins) |
| `disallowed_tools` | string[] | — |
| `permission_mode` | string | `bypassPermissions` |

#### `user` (synthetic user)

| Field | Type | Default |
|-------|------|---------|
| `user.persona` | string | — |
| `user.oracle_model` | string | `claude-haiku-4-5` |
| `user.max_turns` | number | `0` |

#### `project` (managed project scaffolding)

When present, scuttlerun populates the project temp directory.

| Field | Type | Default |
|-------|------|---------|
| `project.claude_md` | string | — |
| `project.skills` | string[] | — |
| `project.settings` | object | — |
| `project.files` | Record\<string, string\> | — |
| `project.git_init` | boolean | `false` |

`project.files` keys are relative paths written inside the temp project dir; values are the file contents. Useful for materializing fixtures, test data, or example source files alongside scaffolded CLAUDE.md/skills/settings.

#### `sdk` (Agent SDK passthrough)

| Field | Type | Default |
|-------|------|---------|
| `sdk.system_prompt` | string \| `{preset: "claude_code", append?: string}` | `{preset: "claude_code"}` |
| `sdk.thinking` | `{type: "adaptive"}` \| `{type: "enabled"}` \| `{type: "disabled"}` | — |
| `sdk.mcp_servers` | object | — |
| `sdk.agents` | object | — |
| `sdk.plugins` | `{type: "local", path: string}[]` | — |
| `sdk.env` | Record\<string, string\> | — |
| `sdk.setting_sources` | string[] | `["project"]` if `project:` present, else `[]` |

#### `sandbox` (OS-level isolation)

Enabled by default. Restricts the agent's filesystem and network access. When the sandbox is enabled, `$HOME` is redirected to `<projectDir>/.home` so tools (npm, pip, cargo) write caches inside the sandbox rather than your real home directory.

| Field | Type | Default |
|-------|------|---------|
| `sandbox.enabled` | boolean | `true` |
| `sandbox.network.allowed_domains` | string[] | `[]` (no network access) |
| `sandbox.network.allow_local_binding` | boolean | `false` |
| `sandbox.filesystem.deny_read` | string[] | `[~/.ssh, ~/.aws, ~/.config/gcloud]` |
| `sandbox.filesystem.allow_write` | string[] | `[]` (cwd and `/tmp` are always writable) |
| `sandbox.filesystem.deny_write` | string[] | `[.env]` |

### Config Merging

Multiple YAML files are deep-merged (objects merge, arrays/scalars replace):

```bash
scuttlerun base.yaml scenario-override.yaml
```

## Usage

```
scuttlerun <session.yaml> [override.yaml...] [options]
scuttlerun --version
scuttlerun --help
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
| `-n, --dry-run` | Validate and display resolved config |

### Exit Codes

Shared taxonomy across scuttlerun/pincenez/craboodle. Codes 3 and 4 are craboodle-only; scuttlerun does not emit them.

| Code | Meaning |
|------|---------|
| 0 | Session completed normally |
| 1 | Configuration error |
| 2 | Runtime error (SDK failure, process crash, unhandled exception) |
| 5 | Budget exceeded |
| 6 | Timeout |
| 7 | Max turns exceeded |
| 130 | Interrupted (SIGINT) |

## How It Works

scuttlerun wraps the Claude Agent SDK's `query()` with an async generator for multi-turn input. Two key mechanisms:

1. **`canUseTool` callback** — Intercepts `AskUserQuestion` calls. An LLM oracle (Haiku by default) answers questions consistent with the configured persona.

2. **Turn policy** — After each agent turn, the oracle decides whether the synthetic user should send a follow-up (`reactive` mode) or end the session (`single` mode).

## Output

scuttlerun streams a YAML transcript to stdout as the session runs:

```yaml
session: a1b2c3d4-e5f6-7890-abcd-ef1234567890
config: /path/to/session.yaml
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

- **[simple.yaml](examples/simple.yaml)** — Single-turn, no follow-ups
- **[interactive.yaml](examples/interactive.yaml)** — AskUserQuestion handling
- **[multi-turn.yaml](examples/multi-turn.yaml)** — Reactive multi-turn with a persona
- **[skill-use.yaml](examples/skill-use.yaml)** — Managed project with skill symlinks

## Development

```bash
npm install
npm run build        # TypeScript compilation
npm run typecheck    # Type-check without emit (faster than build)
npm test             # Run all tests (vitest)
npm run test:watch   # Watch mode
npm run dev -- examples/simple.yaml   # Run via tsx
```

## See Also

- [docs/goals.md](docs/goals.md) — Project motivation, vision, and non-goals
- [docs/spec.md](docs/spec.md) — Full specification and design decisions
