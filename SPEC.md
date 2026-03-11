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
| AskUserQuestion | `canUseTool` callback | Official SDK mechanism for intercepting AskUserQuestion; PreToolUse hooks do not work for this |
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
│             │ │ canUseTool + │ │  sidecar (JSONL)     │
│  query()    │ │  turn policy │ │  Oracle decisions    │
│  with async │ │              │ │  + session metadata  │
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
- Clean up SDK child process and scaffolded temp directory after session ends (or on error)

**Session initialization:** The SDK emits a `SystemMessage` (subtype: `"init"`) at the start of each query turn, carrying the `session_id`. Warren captures the first one to populate the `session_start` event. Note: subsequent turns also emit `init` messages (same `session_id`).

**Turn completion signal:** The SDK emits a `ResultMessage` when a query turn completes. This message carries `stop_reason`, `session_id`, `usage`, `total_cost_usd`, `num_turns`, `is_error`, and `subtype`:
- `"success"` — normal completion; triggers the turn policy
- `"error_max_turns"` — agent hit `maxTurns` limit; maps to exit code 3
- `"error_max_budget_usd"` — agent exceeded budget; maps to exit code 4
- `"error_during_execution"` — runtime error; maps to exit code 2

**Multi-turn coordination:** The async generator and the message consumer (`for await` loop) coordinate via a shared Promise. After each `ResultMessage` with `subtype === "success"`, the consumer consults the turn policy and resolves the Promise — the generator either yields the next `SDKUserMessage` or returns.

**Conversation buffer:** Warren maintains an in-memory array of conversation entries, appending each `SDKAssistantMessage` and `SDKUserMessage` as they stream through the `for await` loop. When building oracle context (for AskUserQuestion or turn-policy prompts), assistant messages are filtered to keep only `TextBlock` content — `ToolUseBlock`, `ThinkingBlock`, and other block types are stripped. Assistant messages with no remaining text blocks after filtering are omitted entirely. The buffer is truncated to the last 10 user/assistant pairs before inclusion in oracle prompts.

**SDKUserMessage structure:** When yielding messages from the async generator, each message must conform to:
```typescript
{
  type: "user",
  session_id: string,            // Use the session_id captured from the init SystemMessage
  message: {
    role: "user",
    content: [{ type: "text", text: string }],
  },
  parent_tool_use_id: null,      // null for top-level turns
}
```

**Nested sessions:** The Agent SDK spawns a Claude Code child process. Warren must call `delete process.env.CLAUDECODE` before calling `query()`, to avoid "nested session" errors when warren itself runs inside Claude Code.

**Timeout implementation:** Warren creates an `AbortController` and passes it via the SDK's `abortController` option. A `setTimeout` triggers `controller.abort()` after `--timeout` seconds. On abort, warren writes a `session_end` event with `stop_reason: "timeout"` and exits with code 5.

**Cleanup:** On session completion (normal or error), warren calls `query.close()` to terminate the SDK's child process, then removes the scaffolded temp directory (if applicable). The `finally` block ensures cleanup runs even on unhandled errors.

**Agent stderr:** The SDK accepts a `stderr: (data: string) => void` callback. Warren accumulates all stderr output in an in-memory buffer and writes a single `agent_stderr` event at session end. Stderr is low-value diagnostic data — losing it on a crash is acceptable. For live stderr during development, `--verbose` tees it to warren's own stderr.

#### 2. Synthetic User

An LLM-powered simulation of a human user. Two roles:

**a) AskUserQuestion responder** — When the agent calls `AskUserQuestion`, Warren intercepts it via the `canUseTool` callback and:
1. Extracts the question data (`input.questions` array with options, multiSelect flags)
2. Sends the questions, conversation context, and user persona to the oracle LLM
3. The oracle selects an option (or provides free-text) consistent with the persona
4. Returns `{ behavior: "allow", updatedInput: { questions, answers } }` to the SDK

**b) Turn policy** — After each agent `ResultMessage` (when `subtype === "success"`), Warren consults the oracle to decide:
- **Continue**: Send a follow-up message (oracle generates it)
- **End**: The session is complete; no more messages

The turn policy receives the full conversation so far plus the user persona, and returns a decision.

#### 3. LLM Oracle

A thin wrapper around the Anthropic Messages API (not the Agent SDK) that:
- Uses `claude-haiku-4-5` by default (configurable)
- Has a focused system prompt depending on the role (question answering vs. turn policy)
- Uses `client.messages.parse()` from `@anthropic-ai/sdk` with Zod schemas for type-safe structured output — the SDK validates responses against the schema automatically and returns typed `parsed_output`
- Is stateless — each call gets the full relevant context

#### 4. Event Recorder

Warren relies on the Agent SDK's built-in session persistence for the full conversation record (written automatically to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`). Warren writes a lightweight **events sidecar** (JSONL) containing only warren-specific decisions: oracle responses, turn policy decisions, agent stderr, and session metadata. This avoids reimplementing conversation serialization and leverages existing session-transcripts tooling.

**Flushing:** Oracle and lifecycle events (`session_start`, `ask_user_question`, `turn_policy`, `error`, `session_end`) are written and fsynced to disk immediately. These are high-value events worth preserving across crashes; a typical session produces fewer than 20. `agent_stderr` events are buffered and written without fsync (see Agent stderr above).

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
effort: high                        # Thinking effort: low, medium, high, max (default: high)
                                    # Note: `effort` and `sdk.thinking` are orthogonal.
                                    # `effort` maps to SDK `effort` (controls depth/token spend).
                                    # `sdk.thinking` maps to SDK `thinking` (controls mechanism).
                                    # Both are forwarded independently to the Agent SDK.

# --- Tools ---
tools:                              # Tools available to the agent (maps to SDK `tools` option)
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - AskUserQuestion                 # Warren handles this via synthetic user
disallowed_tools:                   # Tools to always deny, even under bypassPermissions (maps to SDK `disallowedTools`)
  - Agent                           # Example: block subagent spawning

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
  git_init: false                   # Optional: run `git init` in scaffolded dir (default: false)

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
  max_user_turns: 5                 # Max follow-up messages (not counting initial prompt)

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
  events: warren-events.jsonl       # Warren events sidecar path (default: <invocation-dir>/warren-events.jsonl)
```

### Config Validation

Session configs are validated via Zod schemas. Required fields:
- `prompt` (string)

Everything else has sensible defaults:
- `model`: system default
- `max_turns`: 50
- `effort`: `"high"`
- `tools`: `["Read", "Write", "Edit", "Bash", "Glob", "Grep", "AskUserQuestion"]`
- `permission_mode`: `"bypassPermissions"` (with `allowDangerouslySkipPermissions: true`)
- `user.turn_policy`: `"single"` (no follow-ups unless configured)
- `user.oracle_model`: `"claude-haiku-4-5"`
- `sdk.setting_sources`: `["project"]` when `project:` is present, `[]` otherwise (explicit `sdk.setting_sources` in YAML always overrides the auto-set)

Project-specific validation:
- `project.skills`: each path must exist and contain a `SKILL.md` file
- `project.claude_md`: optional string
- `project.settings`: optional object (written as JSON to `.claude/settings.json`)
- `project.git_init`: optional boolean (default: `false`)

### Project Scaffolding

When `project:` is present, warren scaffolds a temporary project directory:

- **Temp directory**: created via `fs.mkdtemp` in `os.tmpdir()` with prefix `warren-project-`
- **Skill paths**: tilde (`~`) is expanded; relative paths are resolved from the config file's directory
- **Symlinks**: each skill directory is symlinked (not copied) into `<tempdir>/.claude/skills/<name>/`
- **Git init**: when `project.git_init: true`, warren runs `git init` in the scaffolded directory. Default is `false`. Some agent behaviors (e.g., `Bash` with git commands) may require a git repo; callers should enable this when needed.
- **Cleanup**: temp directory is removed after session ends, including on errors (via `finally` block)
- **SIGKILL**: if warren is killed with SIGKILL, the temp directory is orphaned. This is unavoidable; callers can clean up `/tmp/warren-project-*` manually.
- **`--keep-project`**: CLI flag to preserve the scaffolded directory for debugging. Path is printed to stderr.

### Config Merging

Multiple YAML files can be merged for composability:

```bash
warren run base-config.yml scenario-override.yml
```

Later files override earlier ones (deep merge on objects, replace on scalars/arrays). For example, `tools: [Grep]` in an override replaces the entire base tools list — it does not append. This enables patterns like:
- `base.yml` defines shared settings (model, tools, permissions)
- `scenario.yml` overrides prompt, user persona, output paths

### YAML-to-SDK Option Mapping

Most YAML fields map directly to SDK options (e.g., `model` → `model`, `max_turns` → `maxTurns`). The following have non-obvious semantics:

| YAML Field | SDK Option | Notes |
|------------|-----------|-------|
| `tools` | `tools` | Restricts which tools are *available* — the agent cannot see unlisted tools. This is NOT `allowedTools` (which pre-approves tools but doesn't restrict). |
| `disallowed_tools` | `disallowedTools` | Always deny these tools, even under `bypassPermissions`. Overrides everything. |
| `permission_mode` | `permissionMode` + `allowDangerouslySkipPermissions` | When `permission_mode: bypassPermissions`, warren also sets `allowDangerouslySkipPermissions: true`. |
| `sdk.setting_sources` | `settingSources` | Controls which filesystem settings to load. `["project"]` means "load CLAUDE.md from cwd." Auto-set to `["project"]` when `project:` is present (cwd is the scaffolded temp dir). |
| `sdk.thinking` | `thinking` | Discriminated union: `{ type: "adaptive" }`, `{ type: "enabled", budgetTokens?: number }`, or `{ type: "disabled" }`. |
| `effort` | `effort` | Top-level in both YAML and SDK. Orthogonal to `thinking`. |

---

## CLI Interface

```
warren — Multi-turn Claude session driver

Usage:
  warren run <session.yml> [<override.yml>...] [options]
  warren version

Run options:
  --output, -o PATH        Override warren events output path
  --model MODEL            Override agent model
  --oracle-model MODEL     Override synthetic user model
  --prompt TEXT             Override prompt (for quick one-offs)
  --cwd PATH               Override working directory
  --max-turns N            Override max agent turns
  --tools TOOLS            Override tools (comma-separated, e.g. Read,Glob,Grep)
  --effort LEVEL           Override effort (low, medium, high, max)
  --timeout SECONDS        Overall session timeout (default: 300)
  --verbose, -v            Verbose logging to stderr
  --quiet, -q              Suppress progress output
  --keep-project           Don't delete scaffolded project dir (for debugging)
```

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

### canUseTool Routing

Warren passes a `canUseTool` callback in the SDK `query()` options. The full SDK signature is:

```typescript
canUseTool: async (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal,
    toolUseID: string,       // Correlates with tool call in SDK session file
    agentID?: string,        // Identifies main agent vs subagent
    suggestions?: PermissionUpdate[],
    blockedPath?: string,
    decisionReason?: string,
  }
) => Promise<PermissionResult>
```

This callback fires whenever the agent requests permission to use a tool, including `AskUserQuestion`. For AskUserQuestion calls, Warren intercepts and provides synthetic answers; for all other tools, it returns `{ behavior: "allow" }` (the actual permission enforcement is handled by the configured `permissionMode`). Warren records the SDK's `toolUseID` value as `tool_use_id` (snake_case) in the `ask_user_question` event for correlation with the SDK session file.

**SDK note:** `canUseTool` fires for AskUserQuestion regardless of `permissionMode`. Even with `bypassPermissions`, the callback executes and provides the answers. This is the officially documented mechanism for programmatic AskUserQuestion handling (see [Agent SDK docs](https://platform.claude.com/docs/en/agent-sdk/user-input#handle-clarifying-questions)).

**Why not PreToolUse hooks?** Spike testing confirmed that `PreToolUse` hooks with `updatedInput` do **not** work for AskUserQuestion — the tool returns `is_error: true` because the hook's `updatedInput` doesn't bypass the internal prompting mechanism. The `canUseTool` callback is the correct approach.

**Note:** `AskUserQuestion` must be in the `tools` list for the agent to use it. If a caller overrides `tools:` without including `AskUserQuestion`, the agent cannot call it and the callback never fires — effectively disabling synthetic user interaction.

### AskUserQuestion Handling

When the agent calls `AskUserQuestion`, the `canUseTool` callback fires. Warren:

1. **Extracts the question data** from the `input` argument:
   ```typescript
   // AskUserQuestion input schema (confirmed via spike)
   {
     questions: [{
       question: string,       // "What programming language do you prefer?"
       header: string,         // Short label, max 12 chars
       options: [{
         label: string,        // "Python"
         description: string,  // "A versatile language..."
       }],                     // 2-4 options
       multiSelect: boolean,   // Whether multiple selections allowed
     }]                        // 1-4 questions
   }
   ```
2. **Builds an oracle prompt** containing:
   - The user persona from session config
   - The conversation so far (initial prompt + last 10 user/assistant pairs, with tool call/result content stripped — only user messages and assistant text blocks are included; truncated for long sessions)
   - The specific questions and options
3. **Calls the oracle** (see LLM Oracle) to get:
   ```json
   {
     "answers": {
       "How should I format the output?": "Summary",
       "Which sections?": "Introduction, Conclusion"
     },
     "reasoning": "The user persona prefers simple output..."
   }
   ```
4. **Returns to the Agent SDK** via the `canUseTool` return value:
   ```typescript
   return {
     behavior: "allow",
     updatedInput: {
       questions: input.questions,  // Pass through original questions
       answers: oracleResponse.answers
     }
   };
   ```
   For multi-select questions, multiple labels are joined with `", "`. Free-text answers are used directly as the value.

The SDK produces a successful tool result: `"User has answered your questions: \"<question>\"=\"<answer>\". You can now continue with the user's answers in mind."`

### Turn Policy (Reactive Multi-Turn)

After each `ResultMessage` where `subtype === "success"`, Warren consults the turn policy. Other subtypes (`"error_max_turns"`, `"error_during_execution"`, `"error_max_budget_usd"`) cause the session to end immediately with the appropriate exit code. Warren:

1. **Builds a turn-policy prompt** containing:
   - The user persona
   - The conversation so far (initial prompt + last 10 user/assistant pairs, with tool call/result content stripped — only user messages and assistant text blocks are included; truncated for long sessions)
   - The original task/prompt
   - Instruction: "Should the user send a follow-up, or is the task complete?"
2. **Calls the oracle** (see LLM Oracle):
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
appropriate answers. For each question, provide a selected option label
(or free text if no option fits) and brief reasoning.
```

The JSON schema for this call enforces:
```json
{
  "answers": { "<question>": "<selected option label or free text>" },
  "reasoning": "<brief explanation>"
}
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
```

The JSON schema for this call enforces:
```json
{
  "decision": "continue | end",
  "message": "<follow-up text, required when decision is continue>",
  "reasoning": "<brief explanation>"
}
```

### Single-Turn Mode

When `user.turn_policy: single`, Warren skips the turn policy entirely. One prompt in, agent runs to completion, session ends. This is the simplest mode — equivalent to `claude -p` but with AskUserQuestion handling.

---

## Output Artifacts

Warren produces two artifacts per session:

### 1. SDK Session File (conversation record)

Written automatically by the Agent SDK to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. Contains the full conversation: assistant messages, user messages, tool calls, tool results, thinking blocks, etc. in Claude Code's native JSONL format. The `<encoded-cwd>` is the agent's working directory with `/` replaced by `-`.

**Note (managed mode):** When `project:` is present, the agent's cwd is the scaffolded temp directory (e.g., `/tmp/warren-project-abc123`), so the session file path is derived from the temp dir. After cleanup, the session file remains at its encoded path. The `session_start` event's `sdk_session_path` field provides the exact path for correlation.

Queryable with standard jq filters against the native JSONL format.

### 2. Warren Events File (sidecar)

Written by warren to the path specified by `--output` (default: `<invocation-dir>/warren-events.jsonl`, where invocation-dir is `process.cwd()` — not the agent's `cwd`). Contains only warren-specific events — decisions the oracle made, not the conversation itself.

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
| `ask_user_question` | AskUserQuestion intercepted by oracle | `tool_use_id`, `questions`, `oracle_response`, `oracle_model`, `oracle_usage` |
| `turn_policy` | Synthetic user turn decision | `decision`, `message`, `reasoning`, `oracle_model`, `oracle_usage` |
| `agent_stderr` | Batched stderr output from SDK child process | `text` (accumulated lines, newline-separated) |
| `error` | Warren-level error | `error_type`, `message`, `recoverable` |
| `session_end` | Session completed (from SDK `ResultMessage`) | `stop_reason`, `subtype`, `is_error`, `total_turns`, `total_cost_usd`, `duration_ms` (from SDK), `oracle_usage_total` |

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
| Oracle LLM call fails | Retry once; if still fails, write `error` event and end session (exit 2) |
| Oracle returns refusal (`stop_reason: "refusal"`) | Write `error` event with refusal detail and end session (exit 2). Rare — the oracle prompts are benign. |
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
- **Pro**: `canUseTool` callback is the official mechanism for intercepting AskUserQuestion
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
- **Pro**: Simplest model; only the `canUseTool` callback for AskUserQuestion adds custom behavior
- **Con**: Requires `allowDangerouslySkipPermissions: true` (intentionally friction-ful)
- **Con**: Can't test permission-related behaviors
- **Con**: Less safe for non-testing use cases

The `permission_mode` field is still configurable in session YAML, so callers can set `"default"` or `"acceptEdits"` for other scenarios. But the default is `bypassPermissions` because warren's primary purpose is headless session driving.
