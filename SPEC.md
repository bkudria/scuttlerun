# Warren — Multi-Turn Claude Session Driver

## Overview

Warren is a TypeScript CLI tool that uses the Claude Agent SDK to drive multi-turn Claude sessions programmatically. It enables headless, scriptable, fully-observable interactions with Claude — including support for interactive tools like `AskUserQuestion` — by simulating a synthetic user powered by an LLM.

Warren is **general-purpose**. Any use case requiring programmatic, multi-turn, observable Claude sessions is in scope — evaluations, automated testing, CI/CD pipelines, batch processing with interactive steps, reproducible demos, and more.

### Motivating Problem

Claude Code's `claude -p` mode is one-shot and non-interactive. When an agent calls `AskUserQuestion`, the process hangs forever waiting for input that never comes. This makes it impossible to run any scenario that involves clarifying questions, multi-step dialogues, or interactive tool use. Warren solves this by providing a full session driver with a synthetic user that can respond to any interactive prompt.

### Non-Goals

Warren is a **session driver**, not an eval framework. It runs one session and produces one transcript. The following are explicitly out of scope:

- **Batch orchestration** — Running multiple sessions in parallel. Callers use `xargs`, `parallel`, or their own loops.
- **Comparison** — Running the same prompt under different configs and comparing outputs. Callers generate the configs, invoke warren for each, and diff the transcripts.
- **Grading** — Scoring transcripts against assertions or rubrics. Callers implement their own grading logic (which may itself use warren to drive a grading session).
- **Aggregation** — Computing pass rates, deltas, benchmarks. Pure data processing done by callers.

This boundary exists because eval logic is inherently opinionated — different callers have different grading criteria, comparison structures, and reporting needs. Warren provides the raw material (transcripts); callers decide what to do with it.

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | TypeScript | More complete SDK (hooks, session control, no workarounds); native async/await |
| Scope | General-purpose session driver | Not coupled to eval; eval is built on top |
| Interface | CLI-first | `warren run session.yml` as primary invocation |
| Interactivity | LLM-driven synthetic user | Full simulation via a second LLM call |
| Synthetic user model | Haiku default + override | Fast and cheap for routine responses; configurable |
| Turn model | Reactive multi-turn | LLM-driven policy decides follow-ups based on context |
| Permissions | `bypassPermissions` default | Guarantees headless operation; configurable per session |
| Output | SDK session + warren events sidecar | SDK records conversation for free; warren only writes oracle decisions |
| Dependencies | Pragmatic | commander, zod, yaml, etc. as appropriate |
| User persona | Scenario-defined context | Each session config defines user context/persona |
| Project location | ~/code/warren | Standalone repo with its own package.json |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      warren CLI                          │
│  warren run session.yml [--output transcript.jsonl]      │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│                   Session Runner                         │
│                                                          │
│  Loads session.yml → SessionConfig (zod schema)         │
│  Creates Agent SDK query with streaming input            │
│  Manages turn lifecycle and transcript recording         │
└──────┬──────────────┬──────────────────┬────────────────┘
       │              │                  │
       ▼              ▼                  ▼
┌─────────────┐ ┌──────────────┐ ┌──────────────────────┐
│ Agent SDK   │ │  Synthetic   │ │  Event Recorder      │
│ (streaming  │ │  User        │ │                      │
│  input mode)│ │              │ │  Warren events       │
│             │ │  PreToolUse  │ │  sidecar (JSONL)     │
│  query()    │ │  hook +      │ │  Oracle decisions    │
│  with async │ │  turn policy │ │  + session metadata  │
│  generator  │ │              │ │                      │
└─────────────┘ └──────┬───────┘ └──────────────────────┘
                       │
                       ▼
              ┌──────────────────┐
              │  LLM Oracle      │
              │  (Haiku default) │
              │                  │
              │  Answers questions│
              │  Decides follow- │
              │  ups / end of    │
              │  session         │
              └──────────────────┘
```

### Components

#### 1. Session Runner

The core orchestrator. Responsibilities:

- Parse and validate the session YAML config
- If `project:` is configured, scaffold a temporary project directory (symlink skills, write CLAUDE.md/settings)
- Initialize the Agent SDK `query()` with an `AsyncIterable<SDKUserMessage>` prompt
- Feed the initial prompt via the async generator, then await turn decisions
- Use Promise/resolver coordination: on `ResultMessage`, consult the Synthetic User, then resolve the generator's Promise to yield a follow-up or return to end the session
- Record every event to the transcript
- Enforce turn limits and budget constraints
- Handle errors and timeouts gracefully
- Clean up scaffolded temp directory after session ends (or on error)

**Turn completion signal:** The SDK emits a `ResultMessage` when a query completes. This message carries `stop_reason`, `session_id`, `usage`, `total_cost_usd`, `num_turns`, `is_error`, and `subtype` (e.g., `"success"`, `"error_max_turns"`). The runner uses this as the trigger for turn policy decisions and as the source for the `session_end` transcript event.

**Multi-turn coordination:** The async generator and the message consumer (`for await` loop) coordinate via a shared Promise. After each `ResultMessage`, the consumer decides the next action and resolves the Promise — the generator either yields the next user message or returns.

#### 2. Synthetic User

An LLM-powered simulation of a human user. Two roles:

**a) AskUserQuestion responder** — When the agent calls `AskUserQuestion`, Warren intercepts it via a `PreToolUse` hook and:
1. Sends the question, options, full conversation context, and user persona to the oracle LLM
2. The oracle selects an option (or provides free-text) consistent with the persona
3. Returns via the hook output with `permissionDecision: "allow"` and `updatedInput` containing the answers

**b) Turn policy** — After each agent response (when `stop_reason == "end_turn"`), Warren consults the oracle to decide:
- **Continue**: Send a follow-up message (oracle generates it)
- **End**: The session is complete; no more messages

The turn policy receives the full conversation so far plus the user persona, and returns a decision.

#### 3. LLM Oracle

A thin wrapper around the Anthropic Messages API (not the Agent SDK) that:
- Uses `claude-haiku-4-5` by default (configurable)
- Has a focused system prompt depending on the role (question answering vs. turn policy)
- Returns structured output (JSON) for reliable parsing
- Is stateless — each call gets the full relevant context

#### 4. Event Recorder

Warren relies on the Agent SDK's built-in session persistence for the full conversation record (written automatically to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`). Warren writes a lightweight **events sidecar** (JSONL) containing only warren-specific decisions: oracle responses, turn policy decisions, and session metadata. This avoids reimplementing conversation serialization and leverages existing session-transcripts tooling.

---

## Session Configuration (YAML)

The primary input to Warren is a session YAML file:

```yaml
# session.yml — Warren session configuration
version: "1"

# --- Agent Configuration ---
prompt: |
  Write a haiku about the ocean and save it to ocean.txt
model: claude-haiku-4-5             # Agent model (default: system default)
max_turns: 20                       # Max agent turns (default: 50)
max_budget_usd: 1.00                # Max spend for this session (optional)
system_prompt: |                    # Optional system prompt override
  You are a helpful assistant.

# --- Tools ---
tools:                              # Tools the agent may use (maps to SDK `tools` param)
  - Read
  - Write
  - Bash
  - Glob
  - Grep
  - AskUserQuestion                 # Warren handles this via synthetic user

# --- Project Configuration ---
# When present, warren scaffolds a temporary project directory that becomes
# the agent's cwd. Controls what CLAUDE.md, skills, and settings the agent sees.
# When absent, use `cwd` to point at an existing directory (raw mode).
project:
  claude_md: |                      # Optional: written to <tempdir>/CLAUDE.md
    Use clear, accessible language.
  skills:                           # Optional: symlinked into <tempdir>/.claude/skills/
    - ~/.claude/skills/haiku-writer
  settings: {}                      # Optional: written to <tempdir>/.claude/settings.json

# --- Working Directory ---
# Raw mode: when `project:` is absent, this is the agent's cwd.
# Managed mode: when `project:` is present, this is ignored (temp dir is used).
cwd: /tmp/warren-sandbox

# --- Permission Mode ---
permission_mode: bypassPermissions  # Auto-approve all (default for headless use)

# --- Synthetic User Configuration ---
user:
  persona: |
    You are a beginner programmer who wants a haiku about the ocean.
    You prefer simple, accessible language over complex metaphors.
    If asked to choose a topic, pick "ocean" or "sea".
  oracle_model: claude-haiku-4-5    # Model for synthetic user (default: claude-haiku-4-5)
  turn_policy: reactive             # "reactive" (LLM decides) or "single" (no follow-ups)
  max_user_turns: 5                 # Max follow-up messages from synthetic user

# --- Agent SDK Options ---
sdk:
  # setting_sources: auto-set to ["project"] when project: is present;
  #                  defaults to [] when project: is absent
  # persist_session: true by default — SDK session file is the conversation record
  thinking:                         # Optional thinking configuration
    type: adaptive
  mcp_servers: {}                   # Optional MCP servers
  agents: {}                        # Optional subagent definitions
  env: {}                           # Optional environment variables

# --- Output ---
output:
  events: warren-events.jsonl       # Warren events sidecar path (default: <cwd>/warren-events.jsonl)
  result: result.txt                # Final result text (optional)
```

### Config Validation

Session configs are validated via Zod schemas. Required fields:
- `prompt` (string)

Everything else has sensible defaults:
- `model`: system default
- `max_turns`: 50
- `tools`: `["Read", "Write", "Edit", "Bash", "Glob", "Grep"]`
- `permission_mode`: `"bypassPermissions"` (with `allowDangerouslySkipPermissions: true`)
- `user.turn_policy`: `"single"` (no follow-ups unless configured)
- `user.oracle_model`: `"claude-haiku-4-5"`
- `sdk.setting_sources`: `["project"]` when `project:` is present, `[]` otherwise

Project-specific validation:
- `project.skills`: each path must exist and contain a `SKILL.md` file
- `project.claude_md`: optional string
- `project.settings`: optional object (written as JSON to `.claude/settings.json`)

### Config Merging

Multiple YAML files can be merged for composability:

```bash
warren run base-config.yml scenario-override.yml
```

Later files override earlier ones (deep merge on dicts, replace on scalars/lists). This enables patterns like:
- `base.yml` defines shared settings (model, tools, permissions)
- `scenario.yml` overrides prompt, user persona, output paths

---

## CLI Interface

```
warren — Multi-turn Claude session driver

Usage:
  warren run <session.yml> [<override.yml>...] [options]
  warren validate <session.yml>
  warren version

Run options:
  --output, -o PATH        Override warren events output path
  --result PATH            Override result text output path
  --model MODEL            Override agent model
  --oracle-model MODEL     Override synthetic user model
  --prompt TEXT             Override prompt (for quick one-offs)
  --cwd PATH               Override working directory
  --max-turns N            Override max agent turns
  --timeout SECONDS        Overall session timeout (default: 300)
  --verbose, -v            Verbose logging to stderr
  --quiet, -q              Suppress progress output
  --dry-run                Parse config and show what would run, without running
```

### Quick Invocation

For simple one-off sessions without a YAML file:

```bash
warren run --prompt "Explain what this code does" --cwd ./my-project --tools Read,Glob,Grep
```

This creates an ephemeral config with the specified options and runs it.

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Session completed normally (`end_turn`) |
| 1 | Configuration error (invalid YAML, missing required fields) |
| 2 | Session error (SDK connection failure, process crash) |
| 3 | Session hit max_turns without completing |
| 4 | Session exceeded budget |
| 5 | Session timed out |

---

## Synthetic User: Detailed Design

### Hook Routing

Warren registers a single `PreToolUse` hook with `matcher: "AskUserQuestion"`. This hook only fires for `AskUserQuestion` calls — all other tools (Read, Write, Bash, etc.) fall through to the configured `permission_mode` without any custom handling.

### AskUserQuestion Handling

When the agent calls `AskUserQuestion`, the `PreToolUse` hook fires. Warren:

1. **Extracts the question data**: `tool_input.questions` array with options, multiSelect flags
2. **Builds an oracle prompt** containing:
   - The user persona from session config
   - The conversation so far (summarized if long)
   - The specific questions and options
   - Instruction to respond in structured JSON
3. **Calls the oracle LLM** with structured output to get:
   ```json
   {
     "answers": {
       "How should I format the output?": "Summary",
       "Which sections?": "Introduction, Conclusion"
     },
     "reasoning": "The user persona prefers simple output..."
   }
   ```
4. **Returns to the Agent SDK** via the hook output:
   ```typescript
   {
     permissionDecision: "allow",
     updatedInput: {
       questions: originalQuestions,
       answers: oracleResponse.answers
     }
   }
   ```

### Turn Policy (Reactive Multi-Turn)

After each agent response where `stop_reason == "end_turn"`, Warren:

1. **Builds a turn-policy prompt** containing:
   - The user persona
   - The full conversation so far
   - The original task/prompt
   - Instruction: "Should the user send a follow-up, or is the task complete?"
2. **Calls the oracle LLM** with structured output:
   ```json
   {
     "decision": "continue",
     "message": "Can you also add a title to the file?",
     "reasoning": "The user wanted a haiku but the file has no title..."
   }
   ```
   Or:
   ```json
   {
     "decision": "end",
     "reasoning": "The agent completed the task as requested."
   }
   ```
3. **If "continue"**: Resolves the generator's Promise with the follow-up message, triggering another agent turn
4. **If "end"**: Resolves with `null`, causing the generator to return and ending the session

### Oracle System Prompts

**For AskUserQuestion answering:**
```
You are simulating a user in a Claude Code session. You must answer
the agent's clarifying questions consistent with the following persona:

{persona}

Given the conversation so far and the questions below, select the most
appropriate answers. Respond in JSON with an "answers" object mapping
each question to a selected option label (or free text if no option fits).
```

**For turn policy:**
```
You are simulating a user in a Claude Code session. Your persona:

{persona}

The original task was: {original_prompt}

Review the conversation so far. Decide whether the user would:
1. Send a follow-up message (task incomplete, needs refinement, or user
   would naturally ask for more)
2. End the session (task is done, or no useful follow-up)

If continuing, write the follow-up message the user would send.
Respond in JSON with "decision" ("continue" or "end") and optionally
"message" (the follow-up text).
```

### Single-Turn Mode

When `user.turn_policy: single`, Warren skips the turn policy entirely. One prompt in, agent runs to completion, session ends. This is the simplest mode — equivalent to `claude -p` but with AskUserQuestion handling.

---

## Output Artifacts

Warren produces two artifacts per session:

### 1. SDK Session File (conversation record)

Written automatically by the Agent SDK to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. Contains the full conversation: assistant messages, user messages, tool calls, tool results, thinking blocks, etc. in Claude Code's native JSONL format.

Queryable with standard jq filters against the native JSONL format.

### 2. Warren Events File (sidecar)

Written by warren to the path specified by `--output` (default: `<cwd>/warren-events.jsonl`). Contains only warren-specific events — decisions the oracle made, not the conversation itself.

Each line is a JSON object with a common envelope:

```json
{
  "timestamp": "2026-03-08T12:00:00.000Z",
  "type": "event_type",
  "session_id": "abc123-...",
  "data": { ... }
}
```

#### Event Types

| Type | Description | Data Fields |
|------|-------------|-------------|
| `session_start` | Session initialized | `config` (sanitized), `warren_version`, `sdk_session_path`, `scaffolded_project_path` (if managed) |
| `ask_user_question` | AskUserQuestion intercepted by oracle | `questions`, `oracle_response`, `oracle_model`, `oracle_usage` |
| `turn_policy` | Synthetic user turn decision | `decision`, `message`, `reasoning`, `oracle_model`, `oracle_usage` |
| `error` | Warren-level error | `error_type`, `message`, `recoverable` |
| `session_end` | Session completed (from SDK `ResultMessage`) | `stop_reason`, `subtype`, `is_error`, `total_turns`, `total_cost_usd`, `duration_ms`, `result`, `oracle_usage_total` |

#### Oracle Usage Tracking

The `session_end` event includes aggregated oracle usage:

```json
{
  "oracle_usage_total": {
    "input_tokens": 2000,
    "output_tokens": 500,
    "calls": 3
  }
}
```

Agent token usage is available from the SDK's `ResultMessage` and the native session file.

---

## Downstream Usage

Warren produces two artifacts: the SDK session file (full conversation) and a warren events sidecar (oracle decisions). What happens next is entirely the caller's concern.

- **SDK session files** are standard Claude Code JSONL — queryable with jq for conversation, tool calls, errors, etc.
- **Warren events** are lightweight JSONL containing only oracle/turn-policy decisions — easy to query with `jq`.
- **Config merging** lets callers generate many session configs from a base template, invoke `warren run` for each, and process the results however they see fit.

Example caller patterns (implemented *outside* warren):

```bash
# Run a session
warren run session.yml -o results/events.jsonl --cwd /tmp/sandbox
# SDK session file: ~/.claude/projects/-tmp-sandbox/<session-id>.jsonl
# Warren events: results/events.jsonl

# Inspect oracle decisions
jq 'select(.type=="ask_user_question")' results/events.jsonl

# Batch processing
for config in scenarios/*.yml; do
    warren run base.yml "$config" -o "results/$(basename $config .yml).jsonl"
done
```

---

## Error Handling

### Recoverable Errors

| Error | Recovery |
|-------|----------|
| Oracle LLM call fails | Retry once; if still fails, use a fallback (select first option for AskUserQuestion, "end" for turn policy) |
| Agent SDK connection drops | Retry with exponential backoff (max 3 attempts) |
| Tool execution fails | Let the agent handle it (tool errors are normal agent flow) |
| AskUserQuestion in subagent | Log warning; Agent SDK doesn't support this — deny gracefully |

### Fatal Errors

| Error | Behavior |
|-------|----------|
| Invalid session config | Exit 1 with validation error |
| Invalid skill path in `project.skills` | Exit 1 (path doesn't exist or missing SKILL.md) |
| API key missing/invalid | Exit 2 with auth error |
| Session timeout | Write `session_end` with `stop_reason: "timeout"`, exit 5 |

---

## Dependencies

### Required

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/claude-agent-sdk` | Core Agent SDK for driving Claude sessions |
| `@anthropic-ai/sdk` | Direct API access for the oracle LLM (Haiku calls) |
| `zod` | Session config validation and structured schemas |
| `commander` | CLI framework |
| `yaml` | YAML parsing for session configs |

### Optional / Development

| Package | Purpose |
|---------|---------|
| `vitest` | Testing |
| `tsx` | TypeScript execution for development |

---

## Project Structure

```
warren/
├── package.json               # Package config, dependencies, scripts
├── tsconfig.json              # TypeScript configuration
├── SPEC.md                    # This file
├── README.md                  # Usage documentation
├── src/
│   ├── cli.ts                 # Commander CLI entry point
│   ├── config.ts              # Zod schemas for session config
│   ├── runner.ts              # Session runner (core orchestrator)
│   ├── synthetic-user.ts      # Synthetic user (AskUserQuestion + turn policy)
│   ├── oracle.ts              # LLM oracle wrapper (Haiku calls)
│   ├── events.ts              # Event recorder and type definitions
│   └── project.ts             # Project directory scaffolding
├── tests/
│   ├── config.test.ts         # Config parsing and validation
│   ├── synthetic-user.test.ts # Synthetic user logic
│   ├── oracle.test.ts         # Oracle LLM wrapper
│   ├── project.test.ts        # Project scaffolding
│   └── runner.test.ts         # Integration tests
└── examples/
    ├── simple.yml             # Minimal session config
    ├── interactive.yml        # Session with AskUserQuestion handling
    ├── skill-eval.yml         # Skill evaluation with managed project
    └── multi-turn.yml         # Reactive multi-turn session
```

### Entry Point

```json
{
  "bin": {
    "warren": "./dist/cli.js"
  }
}
```

---

## Future Considerations

These are explicitly **out of scope for v1** but noted for future work:

### Parallel Session Execution
Run multiple sessions concurrently. The current design is single-session; callers orchestrate batches externally.

### Session Resumption
The Agent SDK supports session resumption via `session_id`. Warren could support `--resume <session-id>` for continuing interrupted sessions.

### Custom Tool Injection
Allow session configs to define custom MCP tools inline (useful for scenarios that need mock APIs).

### Conversation Branching
Fork a session at a specific turn to explore different paths (useful for A/B testing responses).

### Token Budget Optimization
Context summarization for the oracle LLM when conversations get long, rather than sending the full transcript every time.

### Agent SDK V2 Migration
The TypeScript SDK has a preview V2 API (`unstable_v2_createSession()` / `unstable_v2_resumeSession()`) with explicit `send()`/`stream()` cycles. When V2 stabilizes, it would replace the async generator + Promise coordination with a simpler per-turn call pattern.

---

## Trade-offs

### Agent SDK vs. Raw Messages API

**Chosen: Agent SDK.** Trade-offs:

- **Pro**: Built-in tool execution (Read, Write, Bash, etc.) without reimplementing
- **Pro**: `canUseTool` callback is exactly the hook needed for AskUserQuestion
- **Pro**: Session management, context handling, and agent loop handled by SDK
- **Con**: Requires the Claude Code CLI to be installed (Agent SDK wraps it)
- **Con**: Less control over the raw message loop than building from scratch
- **Con**: SDK is still evolving; API surface may change

The built-in tool execution alone justifies the SDK choice — reimplementing file operations, shell execution, and the agent loop would be substantial.

### LLM-Driven Synthetic User vs. Scripted Responses

**Chosen: LLM-driven.** Trade-offs:

- **Pro**: Handles unexpected questions naturally (no need to predict every possible question)
- **Pro**: Can simulate realistic user behavior with nuance
- **Pro**: Simpler scenario configs (just describe the persona, don't enumerate responses)
- **Con**: Non-deterministic — same scenario may produce different answers across runs
- **Con**: Additional API cost for oracle calls (mitigated by using Haiku)
- **Con**: Harder to debug when the oracle gives unexpected answers

Mitigation for non-determinism: transcript records oracle responses, so every run is fully reproducible for debugging. For strict determinism, users can examine the transcript and write assertions about oracle behavior.

### Reactive Multi-Turn vs. Scripted Multi-Turn

**Chosen: Reactive (LLM-driven turn policy).** Trade-offs:

- **Pro**: Simulates realistic user behavior — follows up when it makes sense
- **Pro**: No need to pre-script a conversation flow
- **Pro**: Discovers emergent behaviors (the agent may do something unexpected that a real user would respond to)
- **Con**: Session length is less predictable (mitigated by `max_user_turns`)
- **Con**: Oracle turn-policy calls add latency and cost
- **Con**: Harder to write deterministic assertions about conversation flow

For eval scenarios that need deterministic conversation flows, `turn_policy: single` provides that escape hatch.

### SDK Session + Sidecar vs. Self-Contained Transcript

**Chosen: SDK session file + warren events sidecar.** Trade-offs:

- **Pro**: Zero implementation cost for conversation recording — SDK does it automatically
- **Pro**: SDK session files are in Claude Code's native format, queryable with standard jq
- **Pro**: Warren's events sidecar is lightweight — only oracle/turn-policy decisions
- **Pro**: Existing tooling for Claude Code sessions works out of the box
- **Con**: Two files per session instead of one
- **Con**: Consumer needs to correlate session ID between the sidecar and the SDK session file

The `session_start` event in the sidecar includes `sdk_session_path` for easy correlation.

### `bypassPermissions` vs. Configurable Permissions

**Chosen: `bypassPermissions` default.** Trade-offs:

- **Pro**: Guarantees no tool call ever blocks on a permission prompt — essential for headless use
- **Pro**: Simplest model; only the `PreToolUse` hook for AskUserQuestion adds custom behavior
- **Con**: Requires `allowDangerouslySkipPermissions: true` (intentionally friction-ful)
- **Con**: Can't test permission-related behaviors
- **Con**: Less safe for non-testing use cases

The `permission_mode` field is still configurable in session YAML, so callers can set `"default"` or `"acceptEdits"` for other scenarios. But the default is `bypassPermissions` because warren's primary purpose is headless session driving.
