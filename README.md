# scuttlerun

[![npm version](https://img.shields.io/npm/v/scuttlerun.svg)](https://www.npmjs.com/package/scuttlerun)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **0.x.** scuttlerun is in active development; minor versions may include breaking changes until 1.0.
>
> **CLI-only.** scuttlerun is intended to be used as a command-line tool. There is no supported programmatic API; modules under `dist/` are implementation details and may change without notice.

A TypeScript CLI that drives multi-turn Claude sessions programmatically using the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk). scuttlerun simulates a synthetic user powered by an LLM oracle, enabling headless, scriptable, fully-observable interactions with Claude — including interactive tools like `AskUserQuestion`.

## Why scuttlerun?

The closest alternatives each leave a gap that scuttlerun fills:

- **`claude -p` / Claude Code one-shot mode** — single-turn only; cannot answer `AskUserQuestion`, cannot follow up, cannot drive a back-and-forth conversation.
- **Raw [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk)** — gives you the loop, but no synthetic user, no YAML-driven session config, no built-in transcript format, no project scaffolding, no sandboxing defaults.

scuttlerun is a thin orchestration layer on top of the Agent SDK that adds those pieces. It is a **session driver, not an eval framework** — it produces transcripts; scoring/grading composes downstream (see [GOALS.md](GOALS.md) for the full positioning).

## Where scuttlerun fits

scuttlerun is one tool in a small UNIX-style pipeline for evaluating Claude sessions:

- **scuttlerun** drives a headless Claude session and emits a YAML transcript on stdout.
- **[pincenez](https://github.com/bkudria/pincenez)** takes that transcript (or any text) plus a checks file and emits structured YAML verdicts.
- **[craboodle](https://github.com/bkudria/craboodle)** orchestrates many scuttlerun + pincenez invocations across a directory of eval scenarios, averaging across repetitions.

scuttlerun composes by pipe — `scuttlerun session.yaml | pincenez checks.yaml` — but is independently useful for any task that needs a scripted, observable Claude session, with or without downstream grading.

![Demo: scuttlerun running an interactive session, with the synthetic user answering an AskUserQuestion call](assets/demo.gif)

> Source: [`assets/demo.tape`](assets/demo.tape) (re-record with `vhs assets/demo.tape`).

## Installation

**Prerequisites:** Node.js 20 or later (LTS recommended; CI tests on 20, 22, 24).

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

## Requirements

scuttlerun authenticates via the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk), which accepts the same credentials as Claude Code — an `ANTHROPIC_API_KEY`, a subscription login, or an OAuth token. Both the agent session and the synthetic-user oracle run through the Agent SDK, so a Claude subscription covers the whole run.

### Credential preference (`auth`)

When both a Claude subscription and an `ANTHROPIC_API_KEY` are available, scuttlerun prefers the subscription: it withholds the API-key variables from the SDK subprocesses so the run doesn't bill per-token. Control this with the `auth` config key or `--auth` flag:

| Mode             | Behavior                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `auto` (default) | Prefer the subscription when one is detected; otherwise use the API key                      |
| `subscription`   | Always withhold API-key variables; requires a Claude Code login or `CLAUDE_CODE_OAUTH_TOKEN` |
| `api-key`        | Require `ANTHROPIC_API_KEY` (exit 1 if unset) and ignore any `CLAUDE_CODE_OAUTH_TOKEN`       |

Subscription detection checks `CLAUDE_CODE_OAUTH_TOKEN`, the Claude Code credentials file (`~/.claude/.credentials.json`, honoring `CLAUDE_CONFIG_DIR`), and — for the non-sandboxed agent and the oracle — the macOS Keychain. Cost figures in the transcript footer are unchanged: they remain the SDK's notional API-rate numbers, so `max_budget_usd` still works as a usage limiter on subscription runs.

### Authenticating with a Claude subscription (OAuth)

To run scuttlerun against a Claude Pro/Max/Team/Enterprise subscription without an API key, generate a long-lived OAuth token and put it in your environment:

```bash
claude setup-token                  # walks through OAuth, prints a token
export CLAUDE_CODE_OAUTH_TOKEN=<token>
```

scuttlerun forwards `CLAUDE_CODE_OAUTH_TOKEN` to the agent in both sandboxed and non-sandboxed runs, so this is the recommended path for headless and CI use.

**macOS note:** a regular `claude /login` stores your subscription credential in the macOS Keychain, which the default [sandbox](#sandbox-os-level-isolation) cannot read — so a logged-in Mac with no `CLAUDE_CODE_OAUTH_TOKEN` set fails with `Not logged in`. Use the token above, or set `sandbox.enabled: false`. (`auto` mode accounts for this: a Keychain-only login never causes the API key to be withheld from the sandboxed agent.) On Linux/Windows, `/login` writes `~/.claude/.credentials.json`, which the sandbox links in automatically — including when an API key is set but the subscription is preferred.

## Quick Start

```bash
scuttlerun examples/simple.yaml

# Run with overrides
scuttlerun examples/multi-turn.yaml --timeout 120 --model claude-sonnet-5
```

## Session Config

Sessions are defined in YAML. Only `prompt` is required — everything else has defaults.

```yaml
version: '1'
prompt: |
  Write a haiku about the ocean and save it to ocean.txt
```

### Config Reference

| Field              | Type                                            | Default                                                                |
| ------------------ | ----------------------------------------------- | ---------------------------------------------------------------------- |
| `version`          | string                                          | `"1"` (config schema version; only `"1"` is currently accepted)        |
| `prompt`           | string                                          | _(required)_                                                           |
| `model`            | string                                          | `claude-haiku-4-5`                                                     |
| `max_turns`        | number                                          | `50`                                                                   |
| `max_budget_usd`   | number                                          | —                                                                      |
| `timeout`          | number                                          | `300` (session wall-clock seconds; `--timeout` overrides)              |
| `effort`           | `low` \| `medium` \| `high` \| `xhigh` \| `max` | `high`                                                                 |
| `tools`            | string[]                                        | `[Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, Skill, Agent]` |
| `additional_tools` | string[]                                        | — (appended to `tools` after defaults apply; deduped first-wins)       |
| `disallowed_tools` | string[]                                        | —                                                                      |
| `permission_mode`  | string                                          | `bypassPermissions`                                                    |
| `auth`             | `auto` \| `subscription` \| `api-key`           | `auto` (see [Credential preference](#credential-preference-auth))      |

#### `user` (synthetic user)

| Field               | Type   | Default            |
| ------------------- | ------ | ------------------ |
| `user.persona`      | string | —                  |
| `user.oracle_model` | string | `claude-haiku-4-5` |
| `user.max_turns`    | number | `0`                |

#### `project` (managed project scaffolding)

When present, scuttlerun populates the project temp directory.

| Field               | Type                     | Default |
| ------------------- | ------------------------ | ------- |
| `project.claude_md` | string                   | —       |
| `project.skills`    | string[]                 | —       |
| `project.plugins`   | string[]                 | —       |
| `project.settings`  | object                   | —       |
| `project.files`     | Record\<string, string\> | —       |
| `project.git_init`  | boolean                  | `false` |

`project.files` keys are relative paths written inside the temp project dir; values are the file contents. Useful for materializing fixtures, test data, or example source files alongside scaffolded CLAUDE.md/skills/settings.

`project.plugins` is the preferred surface for loading local plugins. Each entry is a path to a plugin directory; at runtime entries are translated to `sdk.plugins` form (`{type: "local", path: <resolved>}`) and merged with any explicit `sdk.plugins`. Duplicates are dropped by resolved path on a first-wins basis, so `project.plugins` entries take precedence over `sdk.plugins` entries pointing at the same directory. `sdk.plugins` remains as an escape hatch for raw SDK passthrough.

**Slash-command prompts** (e.g. `prompt: /plugin:skill …`) are forwarded to the agent verbatim — scuttlerun does not expand them. A slash command only resolves when the skill or plugin that defines it is loaded into the session (via `project.skills`, `project.plugins`, or `sdk.plugins`); loading registers it among the session's available commands. If the prompt begins with a slash command that isn't registered, scuttlerun prints a warning to stderr at session start, because the agent would otherwise receive it as literal text and typically do nothing. Note the namespace difference: a bare skill loaded via `project.skills` registers under its own name (`/skill`), while a plugin loaded via `project.plugins` registers its skills plugin-qualified (`/plugin:skill`).

#### `sdk` (Agent SDK passthrough)

| Field                 | Type                                                                | Default                                        |
| --------------------- | ------------------------------------------------------------------- | ---------------------------------------------- |
| `sdk.system_prompt`   | string \| `{preset: "claude_code", append?: string}`                | `{preset: "claude_code"}`                      |
| `sdk.thinking`        | `{type: "adaptive"}` \| `{type: "enabled"}` \| `{type: "disabled"}` | —                                              |
| `sdk.mcp_servers`     | object                                                              | —                                              |
| `sdk.agents`          | object                                                              | —                                              |
| `sdk.plugins`         | `{type: "local", path: string}[]`                                   | — (escape hatch; prefer `project.plugins`)     |
| `sdk.env`             | Record\<string, string\>                                            | —                                              |
| `sdk.setting_sources` | string[]                                                            | `["project"]` if `project:` present, else `[]` |

#### `sandbox` (OS-level isolation)

Enabled by default. Restricts the agent's filesystem and network access. When the sandbox is enabled, `$HOME` is redirected to `<projectDir>/.home` so tools (npm, pip, cargo) write caches inside the sandbox rather than your real home directory.

For OAuth-based auth (Claude Code subscription login), there's a single carve-out: when no `ANTHROPIC_API_KEY` is set and `~/.claude/.credentials.json` exists (the Linux/Windows login location), scuttlerun symlinks that one file into the sandbox so the Agent SDK can find it. Nothing else under `~/.claude/` (skills, plugins, commands, agents, settings, session history) is exposed. On macOS the login credential lives in the Keychain rather than that file, so the carve-out finds nothing — set `CLAUDE_CODE_OAUTH_TOKEN` (see [Requirements](#requirements)) or disable the sandbox. scuttlerun prints a warning at session start when a sandboxed run has no credential it can reach.

| Field                                 | Type     | Default                                   |
| ------------------------------------- | -------- | ----------------------------------------- |
| `sandbox.enabled`                     | boolean  | `true`                                    |
| `sandbox.network.allowed_domains`     | string[] | `[]` (no network access)                  |
| `sandbox.network.allow_local_binding` | boolean  | `false`                                   |
| `sandbox.filesystem.deny_read`        | string[] | `[~/.ssh, ~/.aws, ~/.config/gcloud]`      |
| `sandbox.filesystem.allow_write`      | string[] | `[]` (cwd and `/tmp` are always writable) |
| `sandbox.filesystem.deny_write`       | string[] | `[.env]`                                  |

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

| Option                   | Description                          |
| ------------------------ | ------------------------------------ |
| `--model <model>`        | Override agent model                 |
| `--oracle-model <model>` | Override synthetic user model        |
| `--prompt <text>`        | Override prompt                      |
| `--max-turns <n>`        | Override max agent turns             |
| `--max-budget-usd <usd>` | Override max session cost in USD     |
| `--tools <tools>`        | Override tools (comma-separated)     |
| `--effort <level>`       | Override effort level                |
| `--timeout <seconds>`    | Session timeout (default: 300)       |
| `-v, --verbose`          | Verbose logging to stderr            |
| `-n, --dry-run`          | Validate and display resolved config |

## Exit Codes

This table is the canonical reference for the scuttlerun/pincenez/craboodle exit-code taxonomy. Each tool emits a subset; pincenez and craboodle link here for the full set. Each tool's [`src/exit-codes.ts`](src/exit-codes.ts) defines only the codes that tool itself emits — see also [pincenez/src/exit-codes.ts](https://github.com/bkudria/pincenez/blob/main/src/exit-codes.ts) and [craboodle/src/exit-codes.ts](https://github.com/bkudria/craboodle/blob/main/src/exit-codes.ts).

| Code | Meaning                                                         | Emitted by                      |
| ---- | --------------------------------------------------------------- | ------------------------------- |
| 0    | Success                                                         | scuttlerun, pincenez, craboodle |
| 1    | Configuration / input error                                     | scuttlerun, pincenez, craboodle |
| 2    | Runtime error (SDK failure, process crash, unhandled exception) | scuttlerun, pincenez, craboodle |
| 3    | Threshold failure (`min_pass_rate` ratchet)                     | craboodle                       |
| 4    | Infrastructure / dependency error                               | craboodle                       |
| 5    | Budget exceeded                                                 | scuttlerun, craboodle           |
| 6    | Timeout                                                         | scuttlerun                      |
| 7    | Max turns exceeded                                              | scuttlerun                      |
| 130  | Interrupted (SIGINT)                                            | scuttlerun, pincenez, craboodle |

> **Budget exhaustion** normally exits `5`, but when it arrives mid-run as a "Reached maximum budget" SDK error (rather than the dedicated `error_max_budget_usd` result) scuttlerun classifies it as a runtime failure and exits `2` — the message is surfaced on stderr as `[scuttlerun] …`.

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

**Tool-call entries are observations, not reproductions.** Each tool entry carries the tool name plus a small, fixed set of identifying fields — `path` for `Read`/`Write`/`Edit`, `command` for `Bash`, `pattern` for `Glob`/`Grep`, and similar minimal handles for `Task*`/`TodoWrite`. Content-bearing fields (the bytes a `Write` wrote, the strings an `Edit` replaced) are **intentionally dropped from the YAML transcript** and are not available to downstream graders that consume the transcript text alone. Unknown tool names emit their full `input` mapping. The complete contract is `@guarantee TranscriptToolFieldContract` in [`scuttlerun.allium`](scuttlerun.allium); the SDK JSONL below is the source of truth for full tool inputs.

**Project directory** — Always created in `$TMPDIR` as `scuttlerun-project-<id>/`, preserved after the session ends so you can inspect agent-created files. On the next run, scuttlerun garbage-collects its own `scuttlerun-project-*` directories that are older than 7 days; nothing else in `$TMPDIR` is touched.

**SDK session file** — Full conversation record in Claude Code's native JSONL format at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. Queryable with `jq`. This is the authoritative record of full tool inputs and outputs; the YAML transcript is a lossy summary.

## Privacy

scuttlerun is a thin client around Anthropic APIs. Be aware:

- **What is sent to Anthropic.** Prompts, tool inputs and outputs, conversation history, your configured persona, and oracle decisions are sent to Anthropic via the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk) (agent turns) and the [Messages API](https://docs.claude.com/en/api/messages) (synthetic-user oracle). This includes any file contents the agent reads or writes during a session. Anthropic's handling of that data is governed by their [Usage Policy](https://www.anthropic.com/legal/usage-policy) and [Privacy Policy](https://www.anthropic.com/legal/privacy).
- **What scuttlerun itself collects.** Nothing. scuttlerun has no telemetry, analytics, crash reporting, or "phone home". The only network calls it makes are to Anthropic.
- **What stays local.** The YAML transcript on stdout, the project temp directory under `$TMPDIR/scuttlerun-project-*`, and the SDK session JSONL under `~/.claude/projects/...` are all written to your machine only. Nothing in those locations is uploaded.
- **Secrets.** Your Anthropic credentials are read by the Agent SDK and never appear in transcripts. The default sandbox denies the agent read access to `~/.ssh`, `~/.aws`, and `~/.config/gcloud`, and denies write access to `.env`.

## Examples

See [`examples/`](examples/) for complete session configs (and [`examples/README.md`](examples/README.md) for an index with a feature-coverage table):

- **[tour.yaml](examples/tour.yaml)** — Flagship: persona + AskUserQuestion + multi-turn + project scaffolding in one config
- **[simple.yaml](examples/simple.yaml)** — Single-turn, no follow-ups
- **[interactive.yaml](examples/interactive.yaml)** — AskUserQuestion handling
- **[multi-turn.yaml](examples/multi-turn.yaml)** — Reactive multi-turn with a persona
- **[skill-use.yaml](examples/skill-use.yaml)** — Managed project with skill symlinks
- **[claude-md.yaml](examples/claude-md.yaml)** — Inject a project-wide CLAUDE.md

## Development

```bash
npm install
npm run build        # TypeScript compilation
npm run typecheck    # Type-check without emit (faster than build)
npm test             # Run all tests (vitest)
npm run test:watch   # Watch mode
npm run dev -- examples/simple.yaml   # Run via tsx
```

## Contributing

- [CONTRIBUTING.md](CONTRIBUTING.md) — Development setup, tests, commit conventions, PR workflow
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — Community guidelines
- [SECURITY.md](SECURITY.md) — Reporting a vulnerability
- [SUPPORT.md](SUPPORT.md) — Where to ask questions and report bugs
- [CHANGELOG.md](CHANGELOG.md) — Release history
- [RELEASING.md](RELEASING.md) — How releases are cut (Conventional Commits → release-please → npm publish)

## See Also

- [GOALS.md](GOALS.md) — Project motivation, vision, and non-goals
- [scuttlerun.allium](scuttlerun.allium) — Full specification (Allium)

## License

[MIT](LICENSE)
