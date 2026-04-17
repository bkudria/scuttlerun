# scuttlerun — Multi-Turn Claude Session Driver

## Overview

scuttlerun is a TypeScript CLI tool that uses the Claude Agent SDK to drive multi-turn Claude sessions programmatically. It enables headless, scriptable, fully-observable interactions with Claude — including support for interactive tools like `AskUserQuestion` — by simulating a synthetic user powered by an LLM.

scuttlerun is **general-purpose**. Any use case requiring programmatic, multi-turn, observable Claude sessions is in scope — evaluations, automated testing, CI/CD pipelines, batch processing with interactive steps, reproducible demos, and more.

### Motivating Problem

Claude Code's `claude -p` mode is one-shot and non-interactive. When an agent calls `AskUserQuestion`, the process hangs forever waiting for input that never comes. This makes it impossible to run any scenario that involves clarifying questions, multi-step dialogues, or interactive tool use. scuttlerun solves this by providing a full session driver with a synthetic user that can respond to any interactive prompt.

### Non-Goals

scuttlerun is a **session driver**, not an eval framework. It runs one session and produces one transcript. The following are explicitly out of scope:

- **Batch orchestration** — Running multiple sessions in parallel. Callers use `xargs`, `parallel`, or their own loops.
- **Grading** — Scoring transcripts against checks. Callers implement their own grading logic (which may itself use scuttlerun to drive a grading session).
- **Aggregation** — Computing pass rates, benchmarks. Pure data processing done by callers.

This boundary exists because eval logic is inherently opinionated — different callers have different grading criteria and reporting needs. scuttlerun provides the raw material (transcripts); callers decide what to do with it.

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | TypeScript | More complete SDK (hooks, session control, no workarounds); native async/await |
| Scope | General-purpose session driver | Not coupled to eval; eval is built on top |
| Interface | CLI-first | `scuttlerun session.yaml` as primary invocation |
| AskUserQuestion | `canUseTool` callback | Official SDK mechanism for intercepting AskUserQuestion; PreToolUse hooks do not work for this |
| Interactivity | LLM-driven synthetic user | Full simulation via a second LLM call |
| Synthetic user model | Haiku default + override | Fast and cheap for routine responses; configurable |
| Turn model | Reactive multi-turn | LLM-driven policy decides follow-ups based on context |
| Permissions | `bypassPermissions` default | Guarantees headless operation; configurable per session |
| Output | Streaming transcript to stdout + SDK session file | Human-readable transcript streamed live; SDK session file preserved for programmatic queries |
| Dependencies | Pragmatic | commander, zod, yaml, etc. as appropriate |
| User persona | Scenario-defined context | Each session config defines user context/persona |
| Project location | ~/code/scuttlerun | Standalone repo with its own package.json |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      scuttlerun CLI                     │
│  scuttlerun session.yaml                                │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│                   Session Runner                        │
│                                                         │
│  Loads session.yaml → SessionConfig (zod schema)       │
│  Creates temp project dir, starts Agent SDK query       │
│  Streams transcript to stdout                           │
└──────┬──────────────┬───────────────────────────────────┘
       │              │
       ▼              ▼
┌─────────────┐ ┌──────────────┐
│ Agent SDK   │ │  Synthetic   │
│ (streaming  │ │  User        │
│  input mode)│ │              │
│             │ │ canUseTool + │
│  query()    │ │  turn policy │
│  with async │ │              │
│  generator  │ │              │
└─────────────┘ └──────┬───────┘
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
- Always create a temporary project directory in `$TMPDIR` (if `project:` is configured, scaffold it with skills, CLAUDE.md, settings)
- Initialize the Agent SDK `query()` with an `AsyncIterable<SDKUserMessage>` prompt
- Feed the initial prompt via the async generator, then await turn decisions
- Use Promise/resolver coordination: on `ResultMessage`, consult the Synthetic User, then resolve the generator's Promise to yield a follow-up or return to end the session
- Stream transcript to stdout (user messages, assistant text, thinking, tool calls, oracle decisions)
- Enforce turn limits and budget constraints
- Handle errors and timeouts gracefully
- Clean up SDK child process after session ends (project directory is preserved)

**Session initialization:** The SDK emits a `SystemMessage` (subtype: `"init"`) at the start of each query turn, carrying the `session_id`. scuttlerun captures the first one and emits the preamble YAML mapping (`session:`, `config:`, `project:`, `transcript:`) before the `conversation:` sequence begins. Note: subsequent turns also emit `init` messages (same `session_id`); they are ignored.

**Turn completion signal:** The SDK emits a `ResultMessage` when a query turn completes. This message carries `stop_reason`, `session_id`, `usage`, `total_cost_usd`, `num_turns`, `is_error`, and `subtype`:
- `"success"` — normal completion; triggers the turn policy
- `"error_max_turns"` — agent hit `maxTurns` limit; maps to exit code 3
- `"error_max_budget_usd"` — agent exceeded budget; maps to exit code 4
- `"error_during_execution"` — runtime error; maps to exit code 2

**Multi-turn coordination:** The async generator and the message consumer (`for await` loop) coordinate via a shared Promise. After each `ResultMessage` with `subtype === "success"`, the consumer consults the turn policy and resolves the Promise — the generator either yields the next `SDKUserMessage` or returns.

**Conversation buffer:** scuttlerun maintains an in-memory array of conversation entries, appending each `SDKAssistantMessage` and `SDKUserMessage` as they stream through the `for await` loop. When building oracle context (for AskUserQuestion or turn-policy prompts), assistant messages are filtered to keep only `TextBlock` content — `ToolUseBlock`, `ThinkingBlock`, and other block types are stripped. Assistant messages with no remaining text blocks after filtering are omitted entirely. The buffer is truncated to the last 10 user/assistant pairs before inclusion in oracle prompts.

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

**Nested sessions:** The Agent SDK spawns a Claude Code child process. scuttlerun must call `delete process.env.CLAUDECODE` before calling `query()`, to avoid "nested session" errors when scuttlerun itself runs inside Claude Code.

**Timeout implementation:** scuttlerun creates an `AbortController` and passes it via the SDK's `abortController` option. A `setTimeout` triggers `controller.abort()` after `--timeout` seconds. On abort, the SDK iterator throws, scuttlerun finalizes the transcript with a `writeFooter()` call (partial stats based on what completed before abort), and exits with code 5.

**Implementation note:** The `for await` loop over the SDK's async iterable does not respond to `AbortController` signals mid-iteration. scuttlerun uses a manual async iterator with `Promise.race` — each `iterator.next()` call is raced against a Promise that resolves when the abort signal fires. This ensures the timeout fires within one iteration rather than waiting for the next SDK message.

**Cleanup:** On session completion (normal or error), scuttlerun calls `query.close()` to terminate the SDK's child process. The project temp directory is never deleted — it is preserved for inspection. The `finally` block ensures the SDK child process is cleaned up even on unhandled errors.

**Agent stderr:** The SDK accepts a `stderr: (data: string) => void` callback. scuttlerun wires this callback only when `--verbose` is set, forwarding each chunk directly to scuttlerun's own stderr; the transcript YAML on stdout does not include agent stderr. Without `--verbose`, agent stderr is silently discarded. Stderr is low-value diagnostic data — losing it on a non-verbose run is acceptable.

#### 2. Synthetic User

An LLM-powered simulation of a human user. Two roles:

**a) AskUserQuestion responder** — When the agent calls `AskUserQuestion`, scuttlerun intercepts it via the `canUseTool` callback and:
1. Extracts the question data (`input.questions` array with options, multiSelect flags)
2. Sends the questions, conversation context, and user persona to the oracle LLM
3. The oracle selects an option (or provides free-text) consistent with the persona
4. Returns `{ behavior: "allow", updatedInput: { questions, answers } }` to the SDK

**b) Turn policy** — After each agent `ResultMessage` (when `subtype === "success"`), scuttlerun consults the oracle to decide:
- **Continue**: Send a follow-up message (oracle generates it)
- **End**: The session is complete; no more messages

The turn policy receives the full conversation so far plus the user persona, and returns a decision.

#### 3. LLM Oracle

A thin wrapper around the Anthropic Messages API (not the Agent SDK) that:
- Uses `claude-haiku-4-5` by default (configurable)
- Has a focused system prompt depending on the role (question answering vs. turn policy)
- Uses `client.messages.parse()` from `@anthropic-ai/sdk` with Zod schemas for type-safe structured output — the SDK validates responses against the schema automatically and returns typed `parsed_output`
- Is stateless — each call gets the full relevant context

#### 4. Transcript Output

scuttlerun streams a single YAML document to stdout as the session runs. The shape is:

- **Preamble mapping** (emitted once, after the SDK init message): `session:` (session_id), `config:` (one path or an array of paths), `project:` (temp dir), `transcript:` (SDK session JSONL path).
- **`conversation:` sequence** (streamed entries, one per agent event):
  - `user:` — initial prompt and synthetic-user follow-ups.
  - `thinking:` — extended-thinking blocks.
  - `assistant:` — agent text response.
  - `tool:` — tool invocation; the shape depends on the tool (`path:` for Read/Write/Edit, `command:` for Bash, `pattern:` for Glob/Grep, `input:` for other tools).
  - `oracle: ask_user` — oracle-answered AskUserQuestion, with `answers:` and `reasoning:`.
  - `oracle: turn` — oracle turn-policy decision, with `decision:` plus optional `message:` and `reasoning:`.
- **Footer mapping** (emitted after the `conversation:` sequence): `turns:`, `tool_calls:`, `duration_s:`, optional `cost_usd:`, `files_written:`, `files_edited:`, `files_read:`, `oracle_usage:`.

The output is valid YAML parseable with `yq` or any YAML library. Multi-line string values use block-literal style (`|`). scuttlerun relies on the Agent SDK's built-in session persistence for the full native conversation record (written automatically to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`). That file is queryable with standard jq filters.

---

## Session Configuration (YAML)

The primary input to scuttlerun is a session YAML file:

```yaml
# session.yaml — scuttlerun session configuration
version: "1"

# --- Agent Configuration ---
prompt: |
  Write a haiku about the ocean and save it to ocean.txt
model: claude-haiku-4-5             # Agent model (default: system default)
max_turns: 20                       # Max agent turns (default: 50)
max_budget_usd: 1.00                # Max spend for this session (optional)
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
  - AskUserQuestion                 # scuttlerun handles this via synthetic user
disallowed_tools:                   # Tools to always deny, even under bypassPermissions (maps to SDK `disallowedTools`)
  - Agent                           # Example: block subagent spawning

# --- Project Configuration ---
# When present, scuttlerun scaffolds a temporary project directory that becomes
# the agent's cwd. Controls what CLAUDE.md, skills, and settings the agent sees.
# When absent, use `cwd` to point at an existing directory (raw mode).
project:
  claude_md: |                      # Optional: written to <tempdir>/CLAUDE.md
    Use clear, accessible language.
  skills:                           # Optional: symlinked into <tempdir>/.claude/skills/
    - ~/.claude/skills/haiku-writer
  settings: {}                      # Optional: written to <tempdir>/.claude/settings.json
  git_init: false                   # Optional: run `git init` in scaffolded dir (default: false)

# --- Permission Mode ---
permission_mode: bypassPermissions  # Auto-approve all (default for headless use)

# --- Synthetic User Configuration ---
user:
  persona: |
    You are a beginner programmer who wants a haiku about the ocean.
    You prefer simple, accessible language over complex metaphors.
    If asked to choose a topic, pick "ocean" or "sea".
  oracle_model: claude-haiku-4-5    # Model for synthetic user (default: claude-haiku-4-5)
  max_turns: 5                      # Max follow-up turns (0 = no follow-ups, 1+ = oracle decides)

# --- Agent SDK Options ---
sdk:
  system_prompt:                    # System prompt (default: claude_code preset)
    preset: claude_code             #   Uses Claude Code's full system prompt
    append: |                       #   Append extra instructions (optional)
      Additional instructions here.
  # Or override with a custom string:
  # system_prompt: "You are a helpful assistant."
  # setting_sources: auto-set to ["project"] when project: is present;
  #                  defaults to [] when project: is absent
  # persist_session: true by default — SDK session file is the conversation record
  thinking:                         # Optional thinking configuration
    type: adaptive
  mcp_servers: {}                   # Optional MCP servers
  agents: {}                        # Optional subagent definitions
  plugins:                          # Optional plugins to load
    - type: local                   #   Currently only 'local' is supported
      path: ~/code/my-plugin        #   Absolute, ~-relative, or config-relative path
  env: {}                           # Optional environment variables

```

### Config Validation

Session configs are validated via Zod v4 schemas. Required fields:
- `prompt` (string)

Everything else has sensible defaults:
- `model`: system default
- `max_turns`: 50
- `effort`: `"high"`
- `tools`: `["Read", "Write", "Edit", "Bash", "Glob", "Grep", "AskUserQuestion"]`
- `permission_mode`: `"bypassPermissions"` (with `allowDangerouslySkipPermissions: true`)
- `user.max_turns`: `0` (no follow-ups unless configured)
- `user.oracle_model`: `"claude-haiku-4-5"`
- `sdk.setting_sources`: `["project"]` when `project:` is present, `[]` otherwise (explicit `sdk.setting_sources` in YAML always overrides the auto-set)

**Zod v4 note:** The top-level schema uses `.optional()` for nested objects (`user`, `sdk`) rather than `.default({})`, because Zod v4's `.default({})` does not trigger inner field defaults. Instead, `parseSessionConfig()` re-parses each nested object through its own schema to apply inner defaults correctly.

Project-specific validation:
- `project.skills`: each path must exist and contain a `SKILL.md` file
- `project.claude_md`: optional string
- `project.settings`: optional object (written as JSON to `.claude/settings.json`)
- `project.git_init`: optional boolean (default: `false`)

### Project Directory

scuttlerun always creates a temporary project directory in `$TMPDIR` with prefix `scuttlerun-project-`. This directory becomes the agent's working directory (`cwd`).

- **Always created**: even when `project:` is absent, an empty temp directory is created
- **Scaffolding**: when `project:` is present, scuttlerun populates the temp directory with CLAUDE.md, skill symlinks, settings, and optionally runs `git init`
- **Skill paths**: tilde (`~`) is expanded; relative paths are resolved from the config file's directory
- **Symlinks**: each skill directory is symlinked (not copied) into `<tempdir>/.claude/skills/<name>/`
- **Git init**: when `project.git_init: true`, scuttlerun runs `git init` in the directory. Default is `false`.
- **Preserved after the session**: the project directory is not deleted when the session ends. Its path is printed in the preamble and summary.
- **7-day background cleanup**: at the start of each session, scuttlerun removes `$TMPDIR/scuttlerun-project-*` entries whose mtime is older than 7 days. This is a scuttlerun-internal garbage collector — it never touches dirs from the current or recent sessions and never touches non-scuttlerun entries. Failures are silently ignored.
- **Manual cleanup**: callers can force-clean sooner with `rm -rf /tmp/scuttlerun-project-*`. The threshold is not currently configurable.

### Config Merging

Multiple YAML files can be merged for composability:

```bash
scuttlerun base-config.yaml scenario-override.yaml
```

Later files override earlier ones (deep merge on objects, replace on scalars/arrays). For example, `tools: [Grep]` in an override replaces the entire base tools list — it does not append. This enables patterns like:
- `base.yaml` defines shared settings (model, tools, permissions)
- `scenario.yaml` overrides prompt, user persona, output paths

**Implementation note:** Merging happens on raw YAML objects *before* applying Zod schema defaults. This is critical — if defaults were applied first, an override YAML missing a field would get the default value, which would then replace the base's value during merge. The `mergeRawConfigs()` function merges raw objects, and `parseSessionConfig()` is called once on the merged result.

### YAML-to-SDK Option Mapping

Most YAML fields map directly to SDK options (e.g., `model` → `model`, `max_turns` → `maxTurns`). The following have non-obvious semantics:

| YAML Field | SDK Option | Notes |
|------------|-----------|-------|
| `tools` | `tools` | Restricts which tools are *available* — the agent cannot see unlisted tools. This is NOT `allowedTools` (which pre-approves tools but doesn't restrict). |
| `disallowed_tools` | `disallowedTools` | Always deny these tools, even under `bypassPermissions`. Overrides everything. |
| `permission_mode` | `permissionMode` + `allowDangerouslySkipPermissions` | When `permission_mode: bypassPermissions`, scuttlerun also sets `allowDangerouslySkipPermissions: true`. |
| `sdk.setting_sources` | `settingSources` | Controls which filesystem settings to load. `["project"]` means "load CLAUDE.md from cwd." Auto-set to `["project"]` when `project:` is present (cwd is the scaffolded temp dir). |
| `sdk.thinking` | `thinking` | Discriminated union: `{ type: "adaptive" }`, `{ type: "enabled", budgetTokens?: number }`, or `{ type: "disabled" }`. |
| `sdk.plugins` | `plugins` | Array of `{ type: "local", path: string }`. Paths are resolved (tilde-expanded, relative from config dir) before passing to the SDK. Loads plugins with their skills, agents, hooks, and MCP servers. |
| `effort` | `effort` | Top-level in both YAML and SDK. Orthogonal to `thinking`. |

---

## CLI Interface

```
scuttlerun — Multi-turn Claude session driver

Usage:
  scuttlerun <session.yaml> [<override.yaml>...] [options]
  scuttlerun --version
  scuttlerun --help

Options:
  --model MODEL            Override agent model
  --oracle-model MODEL     Override synthetic user model
  --prompt TEXT             Override prompt (for quick one-offs)
  --max-turns N            Override max agent turns
  --tools TOOLS            Override tools (comma-separated, e.g. Read,Glob,Grep)
  --effort LEVEL           Override effort (low, medium, high, max)
  --timeout SECONDS        Overall session timeout (default: 300)
  --verbose, -v            Verbose logging to stderr
  --dry-run, -n            Validate and display resolved config without running
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

scuttlerun passes a `canUseTool` callback in the SDK `query()` options. The full SDK signature is:

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

This callback fires whenever the agent requests permission to use a tool, including `AskUserQuestion`. For AskUserQuestion calls, scuttlerun intercepts and provides synthetic answers; for all other tools, it returns `{ behavior: "allow" }` (the actual permission enforcement is handled by the configured `permissionMode`). The oracle's answers are emitted to the transcript as an `oracle: ask_user` entry with `answers:` and `reasoning:` fields; the SDK's native JSONL session file records the underlying `toolUseID` for correlation.

**SDK note:** `canUseTool` fires for AskUserQuestion regardless of `permissionMode`. Even with `bypassPermissions`, the callback executes and provides the answers. This is the officially documented mechanism for programmatic AskUserQuestion handling (see [Agent SDK docs](https://platform.claude.com/docs/en/agent-sdk/user-input#handle-clarifying-questions)).

**Why not PreToolUse hooks?** Spike testing confirmed that `PreToolUse` hooks with `updatedInput` do **not** work for AskUserQuestion — the tool returns `is_error: true` because the hook's `updatedInput` doesn't bypass the internal prompting mechanism. The `canUseTool` callback is the correct approach.

**Note:** `AskUserQuestion` must be in the `tools` list for the agent to use it. If a caller overrides `tools:` without including `AskUserQuestion`, the agent cannot call it and the callback never fires — effectively disabling synthetic user interaction.

### AskUserQuestion Handling

When the agent calls `AskUserQuestion`, the `canUseTool` callback fires. scuttlerun:

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

After each `ResultMessage` where `subtype === "success"`, scuttlerun consults the turn policy. Other subtypes (`"error_max_turns"`, `"error_during_execution"`, `"error_max_budget_usd"`) cause the session to end immediately with the appropriate exit code. scuttlerun:

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

When `user.max_turns: 0` (the default), scuttlerun skips the oracle turn decision entirely. One prompt in, agent runs to completion, session ends. This is the simplest mode — equivalent to `claude -p` but with AskUserQuestion handling.

---

## Output

scuttlerun produces two output artifacts per session:

### 1. Streaming Transcript (stdout)

scuttlerun streams a single YAML document to stdout as the session runs. The document is machine-parseable (valid YAML, consumable with `yq` or any YAML library) and human-readable. The shape is:

```yaml
---
session: a1b2c3d4-e5f6-7890-abcd-ef1234567890
config: /abs/path/to/session.yaml
project: /tmp/scuttlerun-project-xK3f9m
transcript: ~/.claude/projects/-tmp-.../a1b2c3.jsonl
conversation:
  - user: |
      Write a haiku about the ocean and save it to ocean.txt

  - thinking: |
      I'll follow the 5-7-5 syllable pattern.

  - assistant: |
      I'll write a haiku about the ocean and save it to a file.

  - tool: Write
    path: /tmp/scuttlerun-project-xK3f9m/ocean.txt

  - assistant: |
      Done! I saved the haiku to ocean.txt.

turns: 2
tool_calls: 1
duration_s: 12.3
cost_usd: 0.05
```

Oracle decisions appear as dedicated entries rather than inline annotations:

```yaml
  - oracle: ask_user
    answers:
      "What language?": Python
    reasoning: The persona prefers Python.

  - oracle: turn
    decision: continue
    message: Can you add tests?
    reasoning: The prompt implied wanting verification.
```

Tool entries vary by tool: `tool: Read|Write|Edit` carries `path:`, `tool: Bash` carries `command:`, `tool: Glob|Grep` carries `pattern:`, any other tool carries a generic `input:`. The footer mapping (`turns:`, `tool_calls:`, `duration_s:`, and the optional `cost_usd:`, `files_written:`, `files_edited:`, `files_read:`, `oracle_usage:`) is emitted once after the final `conversation:` entry. Multi-line string values use YAML block-literal style (`|`).

### 2. SDK Session File (conversation record)

Written automatically by the Agent SDK to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. Contains the full conversation in Claude Code's native JSONL format. The `<encoded-cwd>` is the agent's working directory (the temp dir) with `/` replaced by `-`.

Queryable with standard jq filters against the native JSONL format.

---

## Downstream Usage

scuttlerun streams a human-readable transcript to stdout and preserves the SDK session file for programmatic queries. What happens next is entirely the caller's concern.

- **Transcript (stdout)** is human-readable — pipe to a file, grep for patterns, or inspect visually
- **SDK session files** are standard Claude Code JSONL — queryable with jq for conversation, tool calls, errors, etc.
- **Project directories** are preserved in `$TMPDIR` — inspect agent-created files after the session
- **Config merging** lets callers generate many session configs from a base template, invoke `scuttlerun` for each, and process the results however they see fit.

Example caller patterns (implemented *outside* scuttlerun):

```bash
# Run a session, capture transcript
scuttlerun session.yaml > results/transcript.txt

# Batch processing
for config in scenarios/*.yaml; do
    scuttlerun base.yaml "$config" > "results/$(basename $config .yaml).txt"
done

# Query the SDK session file for tool calls
jq 'select(.type=="assistant") | .message.content[] | select(.type=="tool_use")' \
  ~/.claude/projects/-tmp-scuttlerun-project-abc123/<session-id>.jsonl
```

---

## Error Handling

### Recoverable Errors

| Error | Recovery |
|-------|----------|
| Oracle LLM call fails | Retry once; if still fails, write the failure to scuttlerun's stderr and end the session (exit 2). The transcript on stdout stops at whatever was streamed before the failure. |
| Oracle returns refusal (`stop_reason: "refusal"`) | Write refusal detail to scuttlerun's stderr and end the session (exit 2). Rare — the oracle prompts are benign. |
| Agent SDK connection drops | No retry. The thrown error sets exit code 2 and ends the session. See Future Considerations for automatic retry. |
| Tool execution fails | Let the agent handle it (tool errors are normal agent flow) |
| AskUserQuestion in subagent | Answered by the oracle exactly like main-agent AUQ. scuttlerun's `canUseTool` callback does not discriminate by `agentID`, so subagent-origin AUQ calls are indistinguishable from main-agent calls in the transcript. |

### Fatal Errors

| Error | Behavior |
|-------|----------|
| Invalid session config | Exit 1 with validation error |
| Invalid skill path in `project.skills` | Exit 1 (path doesn't exist or missing SKILL.md) |
| API key missing/invalid | Exit 2 with auth error |
| Session timeout | Emit the footer mapping (partial stats) and exit 5. No distinguished timeout marker is written to the transcript; exit code 5 is the signal. |

---

## Dependencies

### Required

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/claude-agent-sdk` | Core Agent SDK for driving Claude sessions |
| `@anthropic-ai/sdk` | Direct API access for the oracle LLM (Haiku calls) |
| `zod` (v4) | Session config validation and structured schemas. v4 required — `@anthropic-ai/claude-agent-sdk` peer-depends on zod v4. Notable v4 API differences: `z.record()` requires two args (`z.record(z.string(), z.unknown())`); `.default({})` on objects does not trigger inner field defaults. |
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
scuttlerun/
├── package.json               # Package config, dependencies, scripts
├── tsconfig.json              # TypeScript configuration
├── vitest.config.ts           # Vitest test configuration
├── SPEC.md                    # This file
├── README.md                  # Usage documentation
├── src/
│   ├── cli.ts                 # Commander CLI entry point
│   ├── config.ts              # Zod schemas for session config
│   ├── runner.ts              # Session runner (core orchestrator)
│   ├── synthetic-user.ts      # Synthetic user (AskUserQuestion + turn policy)
│   ├── oracle.ts              # LLM oracle wrapper (Haiku calls)
│   ├── transcript.ts          # Streaming transcript formatter (stdout)
│   └── project.ts             # Project directory scaffolding
├── tests/
│   ├── cli.test.ts            # CLI config building and YAML merging
│   ├── config.test.ts         # Config parsing and validation
│   ├── oracle.test.ts         # Oracle LLM wrapper
│   ├── project.test.ts        # Project scaffolding
│   ├── runner.test.ts         # Session runner (core orchestration)
│   ├── synthetic-user.test.ts # Synthetic user logic
│   └── transcript.test.ts    # Transcript formatting
└── examples/
    ├── simple.yaml             # Minimal session config
    ├── interactive.yaml        # Session with AskUserQuestion handling
    ├── skill-eval.yaml         # Skill evaluation with managed project
    └── multi-turn.yaml         # Reactive multi-turn session
```

### Entry Point

```json
{
  "bin": {
    "scuttlerun": "./dist/cli.js"
  }
}
```

---

## Future Considerations

These are explicitly **out of scope for v1** but noted for future work:

### Parallel Session Execution
Run multiple sessions concurrently. The current design is single-session; callers orchestrate batches externally.

### Session Resumption
The Agent SDK supports session resumption via `session_id`. scuttlerun could support `--resume <session-id>` for continuing interrupted sessions.

### Custom Tool Injection
Allow session configs to define custom MCP tools inline (useful for scenarios that need mock APIs).

### Conversation Branching
Fork a session at a specific turn to explore different paths.

### Token Budget Optimization
Context summarization for the oracle LLM when conversations get long, rather than sending the full transcript every time.

### Agent SDK V2 Migration
The TypeScript SDK has a preview V2 API (`unstable_v2_createSession()` / `unstable_v2_resumeSession()`) with explicit `send()`/`stream()` cycles. When V2 stabilizes, it would replace the async generator + Promise coordination with a simpler per-turn call pattern.

### Automatic SDK Retry on Transient Connection Drops
Wrap the SDK `query()` call with exponential backoff retry (e.g. max 3 attempts). Non-trivial because `query()` returns an async iterator — a mid-iteration failure cannot be resumed in place, so retrying would restart the whole session (re-billing and losing any partial transcript output). Deferred until the semantics are clear (re-run from scratch vs. resume via `session_id`).

### Subagent-origin AskUserQuestion Discrimination
Thread the `canUseTool` `options` parameter (which carries `agentID` and `toolUseID`) through scuttlerun, then differentiate subagent-origin AUQ calls from main-agent calls. This would let the oracle apply a different persona/turn policy to subagents, or deny them outright with a warning. Currently both are treated identically.

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

Mitigation for non-determinism: transcript records oracle responses, so every run is fully reproducible for debugging. For strict determinism, users can examine the transcript and write checks about oracle behavior.

### Reactive Multi-Turn vs. Scripted Multi-Turn

**Chosen: Reactive (LLM-driven turn policy).** Trade-offs:

- **Pro**: Simulates realistic user behavior — follows up when it makes sense
- **Pro**: No need to pre-script a conversation flow
- **Pro**: Discovers emergent behaviors (the agent may do something unexpected that a real user would respond to)
- **Con**: Session length is less predictable (mitigated by `max_turns`)
- **Con**: Oracle turn calls add latency and cost
- **Con**: Harder to write deterministic checks about conversation flow

For eval scenarios that need deterministic conversation flows, `user.max_turns: 0` provides that escape hatch.

### Streaming Transcript + SDK Session File vs. Events Sidecar

**Chosen: Streaming transcript to stdout + SDK session file.** Trade-offs:

- **Pro**: Human-readable output — easy to inspect, pipe to files, or grep
- **Pro**: Streaming — see results as they happen, useful for monitoring
- **Pro**: Oracle decisions visible inline — no separate file correlation needed
- **Pro**: SDK session files are in Claude Code's native format, queryable with standard jq
- **Pro**: Single stdout stream — simple to capture (`> file.txt`)
- **Con**: Transcript is not structured (not easily machine-parseable)
- **Con**: Callers needing structured data must query the SDK session file with jq

### `bypassPermissions` vs. Configurable Permissions

**Chosen: `bypassPermissions` default.** Trade-offs:

- **Pro**: Guarantees no tool call ever blocks on a permission prompt — essential for headless use
- **Pro**: Simplest model; only the `canUseTool` callback for AskUserQuestion adds custom behavior
- **Con**: Requires `allowDangerouslySkipPermissions: true` (intentionally friction-ful)
- **Con**: Can't test permission-related behaviors
- **Con**: Less safe for non-testing use cases

The `permission_mode` field is still configurable in session YAML, so callers can set `"default"` or `"acceptEdits"` for other scenarios. But the default is `bypassPermissions` because scuttlerun's primary purpose is headless session driving.

---

## Security Considerations

### Trust Model

**YAML config files are a trust boundary.** A session config has the same power as a shell script: it can specify arbitrary tools, environment variables, MCP server commands, system prompts, and project files. Only run configs you trust, just as you would only run shell scripts you trust.

The primary threat scuttlerun defends against is an **agent that deviates from its prompt** (due to prompt injection via files it reads, MCP server responses, or adversarial content in the working directory). The config itself is assumed trusted.

### Default Permissions

`bypassPermissions` is the default `permission_mode`, giving the agent unrestricted access to all configured tools — including Bash for arbitrary shell execution. This is intentional for headless operation (permission prompts would hang forever). The sandbox provides the actual security boundary.

### Sandbox Mitigations

When `sandbox.enabled: true` (the default):

- **Filesystem**: Write access restricted to the project temp dir and `/tmp`. Read access denied for `~/.ssh`, `~/.aws`, `~/.config/gcloud` by default. Configurable via `sandbox.filesystem`.
- **Network**: No network access by default. Domains must be explicitly allowed via `sandbox.network.allowed_domains`.
- **Environment variables**: `process.env` is filtered through an allowlist of known-safe vars (PATH, LANG, TMPDIR, ANTHROPIC_API_KEY, etc.). Secrets like `AWS_SECRET_ACCESS_KEY` or `GITHUB_TOKEN` are not passed to the agent. Users can explicitly add vars via `sdk.env`.
- **HOME isolation**: HOME is redirected to `<projectDir>/.home` so tools write caches inside the sandbox.

### Known Limitations

- **Indirect prompt injection**: Agent output (which may include adversarial text from files) is forwarded to the LLM oracle as conversation context. A crafted file could influence oracle decisions (question answers, turn policy). Impact is limited: the oracle uses structured output schemas, and its decisions only affect session flow.
- **MCP servers and agents**: `sdk.mcp_servers` and `sdk.agents` are validated against the Agent SDK's type definitions but can still configure arbitrary subprocess commands. The sandbox network/filesystem restrictions apply to the agent, not to MCP server processes.
- **Config-supplied project files**: `project.files` can write arbitrary content within the project directory. Combined with `git_init`, care should be taken not to create files in `.git/hooks/`.
