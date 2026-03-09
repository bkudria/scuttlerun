# Warren — Multi-Turn Claude Session Driver

## Overview

Warren is a Python CLI tool that uses the Claude Agent SDK to drive multi-turn Claude sessions programmatically. It enables headless, scriptable, fully-observable interactions with Claude — including support for interactive tools like `AskUserQuestion` — by simulating a synthetic user powered by an LLM.

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
| Language | Python | Matches Agent SDK's async patterns; rich ecosystem |
| Scope | General-purpose session driver | Not coupled to eval; eval is built on top |
| Interface | CLI-first | `warren run session.yml` as primary invocation |
| Interactivity | LLM-driven synthetic user | Full simulation via a second LLM call |
| Synthetic user model | Haiku default + override | Fast and cheap for routine responses; configurable |
| Turn model | Reactive multi-turn | LLM-driven policy decides follow-ups based on context |
| Permissions | Auto-approve all | Headless/testing context; not production |
| Transcript format | JSONL | One event per line; matches Claude Code transcripts; jq-queryable |
| Dependencies | Pragmatic | click, pydantic, rich, etc. as appropriate |
| User persona | Scenario-defined context | Each session config defines user context/persona |
| Project location | ~/code/warren | Standalone repo with its own pyproject.toml |

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
│  Loads session.yml → SessionConfig (pydantic model)     │
│  Creates Agent SDK query with streaming input            │
│  Manages turn lifecycle and transcript recording         │
└──────┬──────────────┬──────────────────┬────────────────┘
       │              │                  │
       ▼              ▼                  ▼
┌─────────────┐ ┌──────────────┐ ┌──────────────────────┐
│ Agent SDK   │ │  Synthetic   │ │  Transcript          │
│ (streaming  │ │  User        │ │  Recorder            │
│  input mode)│ │              │ │                      │
│             │ │  canUseTool  │ │  JSONL writer        │
│  query()    │ │  callback +  │ │  One event per line  │
│  with async │ │  turn policy │ │  Structured events   │
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
- Initialize the Agent SDK `query()` with streaming input mode
- Feed the initial prompt via the async generator
- After each agent turn completes, consult the Synthetic User to decide next action
- Record every event to the transcript
- Enforce turn limits and budget constraints
- Handle errors and timeouts gracefully

#### 2. Synthetic User

An LLM-powered simulation of a human user. Two roles:

**a) AskUserQuestion responder** — When the agent calls `AskUserQuestion`, Warren intercepts it via the `canUseTool` callback and:
1. Sends the question, options, full conversation context, and user persona to the oracle LLM
2. The oracle selects an option (or provides free-text) consistent with the persona
3. Returns the answer in the format the Agent SDK expects (`PermissionResultAllow` with `updated_input` containing `answers`)

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

#### 4. Transcript Recorder

Writes a JSONL file with one event per line. Events are structured objects with:
- Timestamp
- Event type (see [Transcript Schema](#transcript-schema))
- Event data

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

# --- Working Directory ---
cwd: /tmp/warren-sandbox            # Working directory for the session

# --- Permission Mode ---
permission_mode: acceptEdits        # Auto-accept file edits (default)

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
  setting_sources: []               # Empty = no CLAUDE.md files loaded
  thinking:                         # Optional thinking configuration
    type: adaptive
  mcp_servers: {}                   # Optional MCP servers
  agents: {}                        # Optional subagent definitions
  env: {}                           # Optional environment variables

# --- Output ---
output:
  transcript: transcript.jsonl      # Transcript file path (default: stdout)
  result: result.txt                # Final result text (optional)
```

### Config Validation

Session configs are validated via Pydantic models. Required fields:
- `prompt` (string)

Everything else has sensible defaults:
- `model`: system default
- `max_turns`: 50
- `tools`: `["Read", "Write", "Edit", "Bash", "Glob", "Grep"]`
- `permission_mode`: `"acceptEdits"`
- `user.turn_policy`: `"single"` (no follow-ups unless configured)
- `user.oracle_model`: `"claude-haiku-4-5"`

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
  --output, -o PATH        Override transcript output path
  --result PATH            Override result output path
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

### AskUserQuestion Handling

When the agent calls `AskUserQuestion`, the `canUseTool` callback fires. Warren:

1. **Extracts the question data**: `questions` array with options, multiSelect flags
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
4. **Returns to the Agent SDK** via `PermissionResultAllow` with:
   ```python
   PermissionResultAllow(updated_input={
       "questions": original_questions,
       "answers": oracle_response["answers"]
   })
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
3. **If "continue"**: Yields the follow-up message to the async generator, triggering another agent turn
4. **If "end"**: Closes the async generator, ending the session

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

## Transcript Schema (JSONL)

Each line is a JSON object with a common envelope:

```json
{
  "timestamp": "2026-03-08T12:00:00.000Z",
  "type": "event_type",
  "data": { ... }
}
```

### Event Types

| Type | Description | Data Fields |
|------|-------------|-------------|
| `session_start` | Session initialized | `session_id`, `config` (sanitized), `warren_version` |
| `agent_message` | Assistant response | `content` (full content blocks), `stop_reason`, `usage` |
| `user_message` | User/synthetic user message | `content`, `source` ("initial" \| "synthetic_user" \| "tool_result") |
| `tool_call` | Agent called a tool | `tool_name`, `tool_input`, `tool_use_id` |
| `tool_result` | Tool execution result | `tool_use_id`, `content`, `is_error` |
| `ask_user_question` | AskUserQuestion intercepted | `questions`, `oracle_response`, `oracle_model`, `oracle_usage` |
| `turn_policy` | Synthetic user decision | `decision`, `message`, `reasoning`, `oracle_model`, `oracle_usage` |
| `permission_request` | Tool permission handled | `tool_name`, `action` ("auto_approved") |
| `error` | Error occurred | `error_type`, `message`, `recoverable` |
| `session_end` | Session completed | `stop_reason`, `total_turns`, `total_usage`, `duration_ms` |

### Usage Tracking

The `session_end` event includes aggregated usage:

```json
{
  "total_usage": {
    "agent": {
      "input_tokens": 12345,
      "output_tokens": 6789,
      "cache_read_tokens": 50000,
      "cache_creation_tokens": 10000
    },
    "oracle": {
      "input_tokens": 2000,
      "output_tokens": 500,
      "calls": 3
    }
  }
}
```

---

## Downstream Usage

Warren produces structured JSONL transcripts. What happens next is entirely the caller's concern. Warren's design supports this by ensuring transcripts are:

- **Self-contained** — The `session_start` event records the full config; the `session_end` event records aggregated usage and timing. A transcript is interpretable without external context.
- **Queryable** — JSONL + structured event types work with jq, grep, and the session-transcripts skill out of the box.
- **Composable** — Config merging lets callers generate many session configs from a base template, invoke `warren run` for each, and process the resulting transcripts however they see fit.

Example caller patterns (implemented *outside* warren):

```bash
# A/B comparison: same prompt, different configs
warren run base.yml variant-a.yml -o a/transcript.jsonl
warren run base.yml variant-b.yml -o b/transcript.jsonl
# caller diffs or grades the two transcripts

# Batch processing
for config in scenarios/*.yml; do
    warren run base.yml "$config" -o "results/$(basename $config .yml).jsonl"
done
# caller aggregates results

# Interactive scenario
warren run interactive-session.yml -o transcript.jsonl
# transcript contains AskUserQuestion/oracle events for inspection
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
| API key missing/invalid | Exit 2 with auth error |
| Session timeout | Write `session_end` with `stop_reason: "timeout"`, exit 5 |

---

## Dependencies

### Required

| Package | Purpose |
|---------|---------|
| `claude-agent-sdk` | Core Agent SDK for driving Claude sessions |
| `anthropic` | Direct API access for the oracle LLM (Haiku calls) |
| `pydantic` | Session config validation and structured models |
| `click` | CLI framework |
| `pyyaml` | YAML parsing for session configs |

### Optional / Development

| Package | Purpose |
|---------|---------|
| `rich` | Pretty terminal output (progress, tables, errors) |
| `pytest` | Testing |
| `pytest-asyncio` | Async test support |

---

## Project Structure

```
warren/
├── pyproject.toml              # Package config, dependencies, entry points
├── SPEC.md                     # This file
├── README.md                   # Usage documentation
├── src/
│   └── warren/
│       ├── __init__.py
│       ├── cli.py              # Click CLI entry point
│       ├── config.py           # Pydantic models for session config
│       ├── runner.py           # Session runner (core orchestrator)
│       ├── synthetic_user.py   # Synthetic user (AskUserQuestion + turn policy)
│       ├── oracle.py           # LLM oracle wrapper (Haiku calls)
│       ├── transcript.py       # JSONL transcript recorder
│       └── events.py           # Event type definitions
├── tests/
│   ├── test_config.py          # Config parsing and validation
│   ├── test_synthetic_user.py  # Synthetic user logic
│   ├── test_oracle.py          # Oracle LLM wrapper
│   └── test_runner.py          # Integration tests
└── examples/
    ├── simple.yml              # Minimal session config
    ├── interactive.yml         # Session with AskUserQuestion handling
    └── multi-turn.yml          # Reactive multi-turn session
```

### Entry Point

```toml
[project.scripts]
warren = "warren.cli:main"
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

### JSONL vs. Structured JSON

**Chosen: JSONL.** Trade-offs:

- **Pro**: Streamable — can write events as they happen (no buffering the whole session)
- **Pro**: Matches Claude Code's native transcript format
- **Pro**: Easy to query with jq, grep, existing session-transcripts tooling
- **Con**: Harder to load as a single document (need to parse line by line)
- **Con**: No built-in schema validation for the whole file

The `session_end` event contains aggregated summary data, so consumers that just want the final result can read the last line.

### Auto-Approve All vs. Configurable Permissions

**Chosen: Auto-approve all.** Trade-offs:

- **Pro**: Simplest model for headless/eval use
- **Pro**: No permission prompts blocking execution
- **Con**: Can't test permission-related behaviors
- **Con**: Less safe for non-eval use cases

This is appropriate for the primary use case (eval/testing). The Agent SDK's `permission_mode` is still passed through, so callers can set `"default"` if they want permission handling for other scenarios.
