# Ideas

Candidate future directions — under consideration, not commitments.
[GOALS.md](GOALS.md) describes what is built and why; this file holds what
might come next, plus decisions taken against ideas so they are not
re-investigated. Most entries come from a hand-driven probe of Claude Code
2.1.318 (sonnet-5-5, auto mode) on 2026-11-04: an agent drove a second Claude
Code TUI from a detached tmux session while the probe project's hooks logged
47 events across question dialogs, hook denials and rewrites, bang prompts,
skill-frontmatter hooks and plan mode; craboodle evals of the fabrica plugin
ran the same day against what the transcript does and does not show. Entries
are not ordered by priority.

## Decided, not yet built

- **Hook events become transcript entries, on by default.** Decided
  2026-11-04. The SDK's `includeHookEvents` option emits `hook_started` and
  `hook_response` system messages; the runner passes neither it nor `hooks`,
  so settings-defined hooks are invisible to the judge, and pincenez's grader
  prompt tells it hooks never appear. A fabrica check for a line a hook adds
  as context graded 0 of 3 while the raw JSONL held it three times;
  craboodle's hook-and-settings example cannot pass today. Shape: set
  `includeHookEvents: true` unconditionally (no `observe:` knob), handle the
  `system/hook_response` branch in the message loop (hook_started adds nothing
  a grader needs), and write `- hook: {event, name, outcome, exit_code,
  stdout, stderr}` under one cap shared with tool results. Spike first that
  settings shell hooks surface stdout, including PostToolUse
  additionalContext, under bypassPermissions — the docs say hook_response may
  appear only for background hooks. `hook_name` arrives as `Event:matcher`.
  Lands after the self-describing legend below, so the new entry kind is a
  one-repo change; until then craboodle's example gets its interim fix. No
  in-process observer hooks: they would duplicate `tool:` entries.
- **Non-Goals section: no tmux or PTY driver.** Decided 2026-11-04. README's
  See Also promises non-goals that GOALS.md does not have. Write them:
  scuttlerun observes the SDK stream, headless and sandboxed; a tmux-driven
  runner mode is out — it contradicts Lean on the SDK and fewer concepts,
  needs a second synthetic-user path (send-keys instead of updatedInput),
  makes the transcript contract bimodal, and cannot run in the sandbox
  (allowUnsandboxedCommands is hard-coded false, and the macOS profile denies
  openpty and tmux's socket). The facts only a TUI shows — the trust dialog,
  rendered dialog and hook-error text, `!` prompts (which fire no hook at
  all), plan-dialog labels, long-body rendering — are per-release Claude Code
  facts: settled once per version by the hook-probe fixture below, then
  implemented as hooks and measured headless. State the boundary in
  version-free terms; per-check substitutes (post-hook question text, result
  entries, tool_result text for the hook-error line) belong in the
  claude-code-evals skill, not here. If a future eval must see what the user
  would be shown, try the SDK surface first (the dialog-kind spike, permission
  recording); a scrut interactive case outside the sandbox is the rare
  per-version fallback.

## Transcript

- **Self-describing transcript legend.** The field contract lives in
  scuttlerun.allium's TranscriptToolFieldContract, hand-mirrored in pincenez's
  prompt builder (shared by grader and lint) plus hard-coded claims there that
  hooks and slash commands do not appear, and all three CLAUDE.md files order
  the lockstep. Each new entry kind below would cost three repos. Shape:
  scuttlerun writes a short `legend:` block into the header after
  `transcript:`, generated from one table in src that the allium guarantee and
  tests also pin, naming each entry kind and the fields it keeps, drops or
  caps; `--dry-run` carries it and craboodle forwards it as lint context by
  the precedent of `--available-tools`; pincenez drops its mirror and the
  hook/slash prose, keeping only "honour the output's own contract section"
  and its plain-text non-goal. Costs a dozen header lines per judge call; lint
  run standalone keeps a weaker generic fallback; three test suites change at
  once; the legend text must be stable or lint verdicts drift. Lands first.
- **Permission decisions, denials and mode transitions recorded; `auto`
  accepted.** canUseTool returns allow for every non-question tool and
  ignores the SDK's third argument (signal, suggestions, blockedPath,
  decisionReason); `result.permission_denials`, the SDK's authoritative
  record, is never read; `system/permission_denied` and
  `status.permissionMode` messages are dropped. The probe's permission_mode
  trail (auto → plan → default) was the signal that told "Yes, manually
  approve edits" from "Yes, and use auto mode" from rejection. Shape:
  `- permission:` entries on denials, `- mode:` on each transition,
  `permission_denials:` in the footer; add `auto` to the permission_mode enum
  (the SDK has it; the probe's child ran in it and scuttlerun rejects it).
  Behaviour-neutral. Open: under a non-bypass mode the synthetic user
  auto-allows every non-question tool, so `default` is indistinguishable from
  bypass and the Headless guarantee contradicts the OtherToolsPassThrough
  invariant; `permissionPrompts: 'none'` cannot be the fix because it also
  disables AskUserQuestion. Options: keep auto-allowing and record it (chosen
  for now); deny with a recorded reason (breaks the invariant and a runner
  test, no consumer); ask the oracle with a third schema (one more concept,
  one more call per prompt). Revisit when a scenario actually runs under a
  non-bypass mode. Pays off only in default, plan and dontAsk, since bypass
  shadows canUseTool (every run in that day's suite logged
  CLAUDE_SDK_CAN_USE_TOOL_SHADOWED).
- **Header provenance.** The SDK init message carries `claude_code_version`
  and `model`; the runner reads neither. Write both into the header so a
  transcript states which CLI version its facts held for.
- **Bounded tool results.** The runner loop has no `user` branch, so
  tool_result blocks and the structured `tool_use_result` are dropped; the
  probe read "The user did not answer the questions." (the outcome of allow
  plus updatedInput skipping the dialog) only from the child's JSONL, and the
  hook-deny reason as the model sees it ("PreToolUse:AskUserQuestion hook
  error: …") only from the screen. Shape: `- result: {tool, is_error, text}`
  keyed by tool_use_id, under the single cap the hook entries use. Width,
  open and leaning to the middle: error results only; error results plus the
  decision-bearing tools, AskUserQuestion's `tool_use_result` (the post-hook
  question text, so a check about "the question the human saw" grades against
  the right text when a hook rewrote it) and ExitPlanMode's response; or a
  full per-tool cap table including Bash heads. Bash, Read, Grep and Glob
  stay in the JSONL by design (FullConversationInJsonl). Strains
  "intentionally lossy": a cap is required or outputs balloon past
  craboodle's 10 MB stdout buffer; judge cost rises with size; the judge now
  sees error text the agent recovered from, so some negative checks need a
  note.
- **Plan approval through the synthetic user.** Under `permission_mode:
  plan`, ExitPlanMode reaches canUseTool and is silently allowed with no
  oracle involvement and no entry. The TUI offers approve-with-auto,
  approve-manually and reject-with-feedback; the probe saw rejection arrive
  as PreToolUse only, with the feedback as a user turn and an unprompted
  re-plan, and approval fire PostToolUse ({plan, isAgent, filePath,
  hasTaskTool}) and flip plan → default. Shape: route through the existing
  ask_user schema (Approve / Reject with feedback) rather than a third;
  approve → allow with `updatedPermissions: setMode` mirroring the TUI
  flavours; reject → the feedback as the next user turn, since a canUseTool
  deny delivers it as a tool_result error and re-planning may differ; write
  `oracle: plan` entries. Spike the arrival first. Demand unproven: fabrica
  settled on an AskUserQuestion headed Approve; a never-approving persona
  loops until max_turns.
- **Dialog-surface spike.** The SDK has an unwired headless dialog protocol
  (`onUserDialog`, `supportedDialogKinds`, `onElicitation`); kinds not
  declared fail closed to the no-dialog behaviour with no trace. The types
  name only `refusal_fallback_prompt` and `mcp_prompt`, and the probe showed
  the question and plan dialogs are permission flows (PreToolUse/PostToolUse
  pairs), not dialog requests. Spike only: log which dialogKind values the
  current release emits and record the answer in CLAUDE.md; no routing, since
  the kind union is open and fails closed, and a fourth oracle schema family
  strains fewer concepts.
- **Retire the stale hook caveat.** CLAUDE.md's note that PreToolUse hooks do
  not work came from a spike about answering AskUserQuestion from a hook, not
  about hooks firing; reword it to that finding. Settings-defined hooks fire
  under the TypeScript SDK (fabrica's suite registers three through
  `project.settings` and every scenario passed with them active); scope the
  statement to that SDK. The matching "may not fire in all Agent SDK modes"
  text in craboodle's example and the claude-code-evals reference is tracked
  in craboodle's IDEAS.md.

## Decided against

- **`excluded_commands` sandbox passthrough** (2026-11-04). The SDK exposes
  `sandbox.excludedCommands` (patterns that always run outside the sandbox, "a
  convenience, not a security boundary"); scuttlerun hard-codes
  allowUnsandboxedCommands false and exposes only enabled, network and
  filesystem. Every PTY tool that would use it (tmux, script, expect, scrut
  interactive) runs arbitrary shell, so excluding it is as exposed as
  `sandbox.enabled: false` per scenario, which config merging already scopes
  to one file. No narrow case exists.
- **A `scaffold` subcommand** (2026-11-04). Every session already scaffolds
  and preserves the fixture, with the seeded config dir at
  `<project>/.home/.claude` and the path in the transcript header; a one-turn
  session (`prompt: 'Reply done.'`, `tools: []`, `user.max_turns: 0`) yields
  exactly that directory for a TUI probe to launch `claude` in. Document that
  instead; `--dry-run` deliberately creates nothing.

## Hook-probe fixture

The probe that produced most of this file is a scratch project. Its intended
home is its own directory under ~/code beside the three tools
(version-coupled, tool-specific content that is neither a skill nor a
craboodle demo); it is recorded here until that exists. It is the per-release
counterpart of the Non-Goals decision above: TUI-only facts are settled by
it, then exercised headlessly.

- **Promote the scratch probe to a fixture.** Keep: a `.claude/settings.json`
  registering one logger on every hook event (the five used plus
  PermissionRequest, PermissionDenied, Notification, SubagentStart,
  SubagentStop, PreCompact, SessionEnd); a probe script emitting one JSON line
  per event with TOKEN|KEY|SECRET|OAUTH filtering from the first run (the
  first dry run wrote an OAuth token into the log), the CLAUDE* environment
  recorded once at SessionStart with key-set deltas afterwards (it was 22 KB
  of a 100 KB log with four distinct values), the transcript tail only on
  PreToolUse and PostToolUse where it carried signal, stdin guarded with
  `[ -t 0 ]` so a manual dry run cannot hang; flag-file toggles (`deny-next`,
  `rewrite-next`, `ask-next`) so one script serves every experiment without
  restarting; a summary jq script (one row per event: label, tool, prompt,
  question, answers, response keys, permission_mode) replacing the thirteen
  inline filters written by hand; a findings template with a header of Claude
  Code version, model and permission mode, each finding marked documented or
  observed; the existing 47-event log as a golden sample. One README rule:
  hook-syntax questions are answered by running the probe's skill-frontmatter
  step, not by mining the claude binary (a `strings` detour produced a 1.1 MB
  dump and settled nothing). Runs unchanged under the tmux driver and as a
  scuttlerun scenario via `project.files` and `project.settings.hooks`.
  Bit-rots without a runner.
- **Clean nested-claude launch recipe.** The hand-driven start stripped eight
  CLAUDE* variables chosen from a dump with no rationale and still leaked two;
  the trust dialog defaulted to "No, exit" and cost a separate Down+Enter;
  mode and effort were inherited from the real settings. Shape: a throwaway
  CLAUDE_CONFIG_DIR seeded with a `.claude.json` carrying
  `projects[<cwd>].hasTrustDialogAccepted: true` (verified: the key relocates
  with the config dir), a settings.json with exactly the requested permission
  mode and hooks, explicit `--model`, `--permission-mode` and effort,
  autoupdater and non-essential traffic off, session persistence on (the
  child's JSONL is primary evidence; the session-transcripts CLI reads it with
  CLAUDE_CONFIG_DIR pointed at the fixture), auth via the OAuth token as
  scuttlerun does. Always unset CLAUDECODE. Env posture, open and leaning to
  the second: `env -i` with an allowlist (most reproducible, but it must carry
  TERM, TERM_PROGRAM, COLORTERM and LANG or captures lose attributes); strip
  CLAUDE* by prefix and re-add CLAUDE_CONFIG_DIR and the token (verified to
  leave zero CLAUDE* variables, keeps the terminal environment); unset only
  the documented markers (least drift, leaves the undocumented messaging
  variables in place). The wait-channel hooks for the tmux driver's idle and
  attention signals are injected here via `--settings`; they are an observer
  effect a hook probe must subtract by command, and whether `--settings`
  hooks merge with or replace project hooks needs one verification.
- **Docs first.** Three of the probe's facts were already documented: the
  skill-frontmatter `hooks:` shape and its session-long persistence
  (`once: true` drops it after one run), the allow-skips-the-prompt versus
  ask-shows-modified-input semantics of updatedInput (which explains the
  redone step), and Stop's `last_assistant_message`. The fixture README's
  pre-step: fetch the relevant sections of the hooks, permissions and env-vars
  docs (the hooks page is about 286k characters, so targeted sections), list
  what they leave open, and drive the TUI only for the remainder; cite the
  doc next to each finding. Docs lag or lead the binary, so version-specific
  behaviour still needs the probe; `!` prompts and dialog rendering remain
  genuinely undocumented.
- **Scrut interactive documents for understood probes.** The hand-written
  driver's verbs are a subset of scrut 0.5.0's interactive mode (WAIT on a
  pattern with a timeout, WRITE, SEND_KEYS with DOWN/ENTER/ESC, ASSERT,
  if_match for optional dialogs such as trust, terminal output printed on
  failure). Once a probe is understood, turn its checklist into a scrut
  document that launches `claude` with the recipe above, waits on dialog
  chrome or a per-step token (never model prose; WAIT matches all output since
  session start, so each step needs text unique to it), answers dialogs with
  SEND_KEYS and ends with `/exit`; re-run per Claude Code version and
  regenerate findings from the hook log. The tmux driver stays for the
  exploratory first pass where the next step depends on the screen. Needs a
  real PTY: from a shell or the main session's Bash, backgrounded, never
  inside the sandbox; `scrut update` cannot maintain interactive cases, so the
  document is hand-edited. Prior art that adds nothing for text TUIs: expect,
  Microsoft tui-test, amux.
- **vhs: recording only** (decided against as a probe, 2026-11-04). vhs
  outputs gif, webm, mp4 and PNG, so an agent gets pixels, not text, and it
  needs ttyd, ffmpeg and a headless browser; scrut and capture-pane cover
  probing. Where a design decision cites how a dialog renders (the
  hook-rewritten long-body question was captured as a 45-line text screen and
  cited as the cost of a rejected design), one tape with `Wait /Enter to
  select/` then `Screenshot` is the cheapest durable artifact for a PR, like
  the existing demo tapes; non-deterministic and costs API calls, so at most
  one per cited fact.
