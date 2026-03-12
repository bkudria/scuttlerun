# Warren

> **Unreleased.** Warren is under active development and its API, config format, and behavior may change without notice.

A TypeScript CLI that drives multi-turn Claude sessions programmatically using the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk). Warren simulates a synthetic user powered by an LLM oracle, enabling headless, scriptable, fully-observable interactions with Claude — including interactive tools like `AskUserQuestion`.

## Install

```bash
git clone <repo-url> && cd warren
npm install
npm run build
npm link          # makes `warren` available globally
```

## Quick Start

```bash
warren run examples/simple.yml

# Run with overrides
warren run examples/multi-turn.yml --timeout 120 --model claude-sonnet-4-6
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
| `cwd` | string | — |
| `permission_mode` | string | `bypassPermissions` |

#### `user` (synthetic user)

| Field | Type | Default |
|-------|------|---------|
| `user.persona` | string | — |
| `user.oracle_model` | string | `claude-haiku-4-5` |
| `user.turn_policy` | `single` \| `reactive` | `single` |
| `user.max_user_turns` | number | `5` |

#### `project` (managed project scaffolding)

When present, warren creates a temp directory as the agent's working directory.

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

#### `output`

| Field | Type | Default |
|-------|------|---------|
| `output.events` | string | `warren-events.jsonl` |

### Config Merging

Multiple YAML files are deep-merged (objects merge, arrays/scalars replace):

```bash
warren run base.yml scenario-override.yml
```

## CLI

```
warren run <session.yml> [override.yml...] [options]
warren version
```

| Option | Description |
|--------|-------------|
| `-o, --output <path>` | Override events output path |
| `--model <model>` | Override agent model |
| `--oracle-model <model>` | Override synthetic user model |
| `--prompt <text>` | Override prompt |
| `--cwd <path>` | Override working directory |
| `--max-turns <n>` | Override max agent turns |
| `--tools <tools>` | Override tools (comma-separated) |
| `--effort <level>` | Override effort level |
| `--timeout <seconds>` | Session timeout (default: 300) |
| `-v, --verbose` | Verbose logging to stderr |
| `-q, --quiet` | Suppress progress output |
| `--keep-project` | Don't delete scaffolded project dir |

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

Warren wraps the Claude Agent SDK's `query()` with an async generator for multi-turn input. Two key mechanisms:

1. **`canUseTool` callback** — Intercepts `AskUserQuestion` calls. An LLM oracle (Haiku by default) answers questions consistent with the configured persona.

2. **Turn policy** — After each agent turn, the oracle decides whether the synthetic user should send a follow-up (`reactive` mode) or end the session (`single` mode).

## Output

Warren produces two artifacts per session:

**SDK session file** — Full conversation record, written automatically by the Agent SDK to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.

**Warren events sidecar** — Lightweight JSONL with oracle decisions and session metadata. Each line:

```json
{"timestamp": "...", "type": "event_type", "session_id": "...", "data": {...}}
```

| Event | Description |
|-------|-------------|
| `session_start` | Config, version, SDK session path |
| `ask_user_question` | Oracle's answers to agent questions |
| `turn_policy` | Continue/end decision with reasoning |
| `agent_stderr` | Batched stderr from SDK child process |
| `error` | Warren-level errors |
| `session_end` | Stop reason, duration, oracle usage totals |

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
