# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is scuttlerun

scuttlerun is a TypeScript CLI that drives multi-turn Claude sessions programmatically using the Claude Agent SDK. It simulates a synthetic user (powered by an LLM oracle) to handle `AskUserQuestion` calls and multi-turn follow-ups, producing fully observable session transcripts.

Usage docs: `README.md`.

### Downstream consumers

scuttlerun is the session-driver end of a three-tool pipeline. Two downstream tools pair with it:

- **[pincenez](https://github.com/bkudria/pincenez)** grades scuttlerun transcripts (or any text) against YAML checks files using an LLM judge.
- **[craboodle](https://github.com/bkudria/craboodle)** is the typical orchestrator — it invokes scuttlerun + pincenez across a directory of eval scenarios.

scuttlerun is intentionally usable standalone; the pipeline framing should not leak into the CLI surface or config schema.

## Authoritative artifacts

`scuttlerun.allium`, `src/`, `tests/`, and `GOALS.md` are co-equal peer artifacts of the same system — the behavioural contract, the mechanism, the verification, and the design intent. The four must reflect each other. Changing any one obliges checking and updating the others; conflicts between them are reconciled, not decided unilaterally.

- `scuttlerun.allium` — what the system must do (Allium spec; authoritative contract)
- `src/` — how it does it (TypeScript implementation)
- `tests/` — proof it does what the spec says (vitest suite under `tests/`)
- `GOALS.md` — why the system exists in this shape (design intent and principles)

## Commands

```bash
npm run build        # TypeScript → dist/ (tsc)
npm test             # Run all tests (vitest)
npm run test:watch   # Watch mode
npx vitest run tests/config.test.ts           # Single test file
npx vitest run tests/config.test.ts -t "name" # Single test by name
npm run dev -- examples/simple.yaml             # Run via tsx (no build step)
```

## Architecture

**Data flow:** CLI (`cli.ts`) → parses YAML + merges configs → `runner.ts` sets up the session and runs the `for await` loop → `session-loop.ts` dispatches the SDK messages scuttlerun records (init, hook responses, permission denials and mode changes, lost session writes, background task changes and outcomes, assistant blocks, tool results, results) to one handler each, against a shared session state, and owns the async input generator and the `canUseTool` callback, which allows every permission request except a question the synthetic user cannot answer and records each as a `permission:` entry → Agent SDK `query()` with async generator for multi-turn input → `synthetic-user.ts` handles AskUserQuestion (via `canUseTool` callback) and turn policy decisions → `oracle.ts` runs a one-shot Agent SDK `query()` (no tools, JSON-schema structured output, validated with Zod) → `transcript.ts` streams formatted output to stdout.

**Key coordination pattern:** The runner uses an async generator + Promise/resolver to coordinate multi-turn input. The generator and resolver live in `session-loop.ts`: `inputMessages` stores the resolver on the session state, and `handleResult` calls it. After each SDK `ResultMessage`, the synthetic user's turn policy decides whether to yield another message or return (ending the session). This pattern exists because `streamInput()` fails with `ERR_STREAM_WRITE_AFTER_END`. A success result that arrives while the latest `background_tasks_changed` lists a non-ambient `local_agent` task (`state.subagentsRunning`) consults no turn policy: the result of the turn the CLI starts when the subagent finishes does. Once a result ends the session (`state.ended`), the CLI can keep running (e.g. finishing a background command): `handleMessage` then records and decides nothing, and the runner gives the CLI `CLI_EXIT_GRACE_MS` to exit by itself before closing it.

**Output:** scuttlerun streams a human-readable transcript to stdout (preamble → messages → summary). The SDK session file (full conversation JSONL) is preserved automatically. The project temp dir is always created and preserved at session end; on the next session start, scuttlerun garbage-collects its own `scuttlerun-project-*` directories in `$TMPDIR` that are older than 7 days.

**Transcript tool-field and result contract:** the YAML transcript is intentionally lossy. For each known tool the entry carries a small fixed set of identifying fields — e.g. `path` for `Read`/`Write`/`Edit`, `command` for `Bash`. Content-bearing fields like `content`, `old_string`, and `new_string` are **dropped** before serialization in `src/transcript.ts:writeTool` — downstream pincenez checks that need to assert on what was written must consult the SDK JSONL, not the YAML transcript. The full contract lives in `scuttlerun.allium`'s `@guarantee TranscriptToolFieldContract`. Every transcript states it in its header `legend:` (`TRANSCRIPT_LEGEND` in `src/transcript.ts`, also printed by `--dry-run`), generated from the same `TOOL_FIELD_RULES` table that drives `writeTool`; downstream graders read the legend instead of keeping a copy. Every tool entry carries `id`, its position among the transcript's tool entries; a result entry repeats the id of the call it reports. A subagent's tool and result entries also carry `subagent_of`, which `session-loop.ts` resolves from the SDK message's `parent_tool_use_id` through `state.toolCalls` to the Agent call's id, or `unknown` when that call has no entry. Result entries are written for every error and for every result of the tools in `RESULT_RECORDED_TOOLS` (`src/transcript.ts`), which also generates the legend's wording for them. Permission and mode entries follow `@guarantee PermissionEntryContract`. Changing the captured fields, the recorded results, the permission entries or the legend's wording means updating `@guarantee TranscriptToolFieldContract`, `@guarantee ToolResultEntryContract`, `@guarantee PermissionEntryContract` and `@guarantee SelfDescribingTranscript` in lockstep, along with `HELP_TEXT` (a test ties its recorded-result list to `RESULT_RECORDED_TOOLS`) and README's description of result entries, which nothing checks; nothing needs changing downstream.

## Agent SDK Reference

When working with Agent SDK code (`@anthropic-ai/claude-agent-sdk`), load the `/claude-api` skill and consult the Agent SDK docs at https://platform.claude.com/docs/en/agent-sdk/typescript before making changes. The SDK API surface has non-obvious constraints (see Key Technical Details below).

## Key Technical Details

- **ESM project** (`"type": "module"`) — all imports use `.js` extensions
- **Zod v4** — `z.record()` requires 2 args: `z.record(z.string(), z.unknown())`. `.default({})` on objects does NOT apply inner field defaults — `parseSessionConfig()` re-parses nested objects separately
- **Config merging** happens on raw YAML objects _before_ Zod schema defaults are applied (critical for correct override behavior)
- **`canUseTool` callback** is the correct mechanism for AskUserQuestion handling: a spike found a PreToolUse hook cannot answer AskUserQuestion. Settings- and plugin-defined hooks do fire under the TypeScript SDK, and `includeHookEvents` streams their responses, which become `hook:` entries
- Must override `CLAUDECODE` in the SDK's `env` option (e.g. `env: { ...process.env, CLAUDECODE: undefined }`) before `query()` to avoid nested session errors. `buildAuthEnv` in `src/auth.ts` does this for the default branch; the sandbox branch achieves the same effect by exclusion from the `SAFE_ENV_VARS` allowlist. Avoid `delete process.env.CLAUDECODE` in production code — that mutates the parent process's env; the spread-with-override pattern is local to the SDK call.
- Oracle runs through the Agent SDK (one-shot `query()` with `tools: []` and `outputFormat: json_schema`), same as the agent session — so a Claude subscription covers oracle calls too. The JSON schemas are hand-written (structured outputs accept `anyOf` but not the `oneOf` Zod emits for discriminated unions) and must mirror the Zod schemas that validate the parsed output
- **Credential preference (`auth`)** — the SDK subprocess prefers `ANTHROPIC_API_KEY` over Claude Code OAuth, so `src/auth.ts` shapes subprocess envs to invert that: `auto` (default) withholds the API-key vars when subscription credentials are detected (`CLAUDE_SDK_OAUTH_TOKEN`, credentials file, or macOS Keychain); `subscription` withholds unconditionally; `api-key` requires the key (config error otherwise) and withholds both OAuth token vars. An inherited `CLAUDE_CODE_OAUTH_TOKEN` is always stripped (the runtime would let it override a `/login` credential) and never counts in detection; `CLAUDE_SDK_OAUTH_TOKEN` is the explicit token path, mapped onto `CLAUDE_CODE_OAUTH_TOKEN` in the subprocess env. A run whose only credential is `CLAUDE_CODE_OAUTH_TOKEN` is a config error. The sandboxed agent's detection excludes the macOS Keychain (unreachable under the redirected HOME); the oracle and non-sandboxed agent include it. `sdk.env` (explicit env replacement) is exempt from auth shaping
- **Tool results** (observed under CLI 2.1.317) arrive as `type: 'user'` messages whose content is an array of `tool_result` blocks. `is_error` is absent on most successes (Bash sets `false`). On errors, `tool_use_result` is the string `"Error: " + content`; subagent results have no `tool_use_result`. Result entries render the block's `content`, never `tool_use_result`, except AskUserQuestion's questions, which come from `tool_use_result` because that holds the post-hook text. `bashEditDiff`, when enabled, appears only in `tool_use_result` and the PostToolUse `tool_response`. A foreground subagent's tool_use and tool_result messages both carry the `parent_tool_use_id` of the Agent call that started it; calls made by agents a `Workflow` starts are not streamed at all, so they get no entries and only the session log's `subagents/workflows/` journal has them. A Bash call's PreToolUse and PostToolUse (or PostToolUseFailure) hook responses stream before its `tool_result` message, so their entries sit between the tool entry and its result entry; a PreToolUse hook that blocks with exit 2 yields `is_error: true` and the text `PreToolUse:<Tool> hook error: [<command>]: <stderr>`
- **Background tasks** (observed under CLI 2.1.317 and 2.1.322): the CLI may run an Agent call in the background though its input does not ask for it (haiku-5-5 did on both, sonnet-5-5 did not); its tool_result then reads "Async agent launched successfully". A task's lifecycle arrives as `system` messages: `task_started` (`tool_use_id`, `is_backgrounded`), `task_progress`, `task_updated` (names only `task_id`; `patch.is_backgrounded` when a foreground task is moved), `task_notification` (`tool_use_id`, `status` of `completed`, `failed` or `stopped`, and `summary`: a subagent's final report, or `Background command "<description>" completed (exit code 0)`), and `background_tasks_changed`, the full live set, which replaces the last. Foreground tasks get `task_started` and `task_notification` too. When a background task settles the CLI starts a turn with no user message: a second `system/init`, the agent's reply, another result. A background subagent's messages can arrive before or after the result of the turn that started it, and it streams its text and thinking blocks with `parent_tool_use_id` set, which a foreground one does not. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` in the agent's env runs everything in the foreground
- **Permissions** (observed under CLI 2.1.317): `auto` runs headless. `canUseTool` is called only where the TUI would prompt — Write under `default` (with a `setMode acceptEdits` suggestion), ExitPlanMode under `plan` (`requiresUserInteraction: true`), and under `auto` only calls the classifier cannot decide — and its options carry the call's `toolUseID`. A deny rule's refusal skips `canUseTool`: a `system/permission_denied` message (`decision_reason_type: rule`) streams after the tool_use and before its error tool_result, and the result's `permission_denials` lists the call. Approving a plan streams a `system/status` with `permissionMode: default`. Under `bypassPermissions` `canUseTool` is never called
- Timeout uses `AbortController` (passed to SDK via `sdkOptions.abortController`) + `queryHandle.interrupt()` + a `timedOut` flag checked at the top of the `for await` loop (the `for await` doesn't respond to abort signals mid-iteration, so the flag break + SDK-driven iterator end are what actually stop the loop)

## Testing

Tests are in `tests/` with 1:1 mapping to source files. Uses vitest. The project follows TDD — bottom-up order: config → transcript → oracle → project → synthetic-user → sdk-options → session-loop → runner → cli.
