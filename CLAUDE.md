# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is scuttlerun

scuttlerun is a TypeScript CLI that drives multi-turn Claude sessions programmatically using the Claude Agent SDK. It simulates a synthetic user (powered by an LLM oracle) to handle `AskUserQuestion` calls and multi-turn follow-ups, producing fully observable session transcripts.

Full specification: `SPEC.md`. Usage docs: `README.md`.

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

**Data flow:** CLI (`cli.ts`) → parses YAML + merges configs → `runner.ts` orchestrates the session → Agent SDK `query()` with async generator for multi-turn input → `synthetic-user.ts` handles AskUserQuestion (via `canUseTool` callback) and turn policy decisions → `oracle.ts` calls Haiku via Anthropic Messages API with structured output (Zod schemas) → `transcript.ts` streams formatted output to stdout.

**Key coordination pattern:** The runner uses an async generator + Promise/resolver to coordinate multi-turn input. After each SDK `ResultMessage`, the synthetic user's turn policy decides whether to yield another message or return (ending the session). This pattern exists because `streamInput()` fails with `ERR_STREAM_WRITE_AFTER_END`.

**Output:** scuttlerun streams a human-readable transcript to stdout (preamble → messages → summary). The SDK session file (full conversation JSONL) is preserved automatically. The project temp dir is always created and preserved at session end; on the next session start, scuttlerun garbage-collects its own `scuttlerun-project-*` directories in `$TMPDIR` that are older than 7 days.

## Agent SDK Reference

When working with Agent SDK code (`@anthropic-ai/claude-code-sdk`), load the `/claude-api` skill and consult the Agent SDK docs at https://platform.claude.com/docs/en/agent-sdk/typescript before making changes. The SDK API surface has non-obvious constraints (see Key Technical Details below).

## Key Technical Details

- **ESM project** (`"type": "module"`) — all imports use `.js` extensions
- **Zod v4** — `z.record()` requires 2 args: `z.record(z.string(), z.unknown())`. `.default({})` on objects does NOT apply inner field defaults — `parseSessionConfig()` re-parses nested objects separately
- **Config merging** happens on raw YAML objects *before* Zod schema defaults are applied (critical for correct override behavior)
- **`canUseTool` callback** is the correct mechanism for AskUserQuestion handling (PreToolUse hooks don't work — confirmed by spikes)
- Must `delete process.env.CLAUDECODE` before `query()` to avoid nested session errors
- Oracle uses `client.messages.parse()` with `output_format` for guaranteed structured JSON output
- Timeout uses `AbortController` + `Promise.race` against the async iterator (the `for await` loop doesn't respond to abort signals mid-iteration)

## Testing

Tests are in `tests/` with 1:1 mapping to source files. Uses vitest. The project follows TDD — bottom-up order: config → transcript → oracle → project → synthetic-user → runner → cli.
