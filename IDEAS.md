# Ideas

Candidate future directions — under consideration, not commitments.
[GOALS.md](GOALS.md) describes what is built and why; this file holds what
might come next, plus decisions taken against ideas so they are not
re-investigated. Most entries come from a hand-driven probe of Claude Code
2.1.318 (sonnet-5-5, auto mode) on 2026-11-04: an agent drove a second Claude
Code TUI from a detached tmux session while the probe project's hooks logged
47 events across question dialogs, hook denials and rewrites, bang prompts,
skill-frontmatter hooks and plan mode; craboodle evals of the fabrica plugin
ran the same day against what the transcript does and does not show. The
Synthetic user, Isolation and sandbox, Cost and diagnostics, and Spec sections
come from reviewing the Agent SDK 0.3.310 → 0.3.317 bump (#89) on 2026-11-07.
The hook-entry follow-ups come from building hook entries (#103) on
2026-11-07; the Code health entry comes from the 0.5.0 publish (#105). The
result-entry follow-ups and the plan-file and Bash edit diff findings come
from a headless spike of CLI 2.1.317 (haiku-4-5) on 2026-11-08 and from
building result entries. The first run of carapace, the hook-probe fixture
beside the three tools, on CLI 2.1.332 (claude-sonnet-5-5) on 2026-11-26
re-settled the TUI facts several entries lean on; its findings file is the
source for the 2.1.332 statements here. Entries are not ordered by
priority.

## Decided, not yet built

- **Non-Goals section: no tmux or PTY driver.** Decided 2026-11-04. README's
  See Also promises non-goals that GOALS.md does not have. Write them:
  scuttlerun observes the SDK stream, headless and sandboxed; a tmux-driven
  runner mode is out — it contradicts Lean on the SDK and fewer concepts,
  needs a second synthetic-user path (send-keys instead of updatedInput),
  makes the transcript contract bimodal, and cannot run in the sandbox
  (allowUnsandboxedCommands is hard-coded false, and the macOS profile denies
  openpty and tmux's socket). The facts only a TUI shows — the trust dialog,
  rendered dialog and hook-error text, `!` prompts (whose command fires no
  hook), plan-dialog labels, long-body rendering — are per-release Claude
  Code facts: settled once per version by carapace, then
  implemented as hooks and measured headless. State the boundary in
  version-free terms; per-check substitutes (post-hook question text, result
  entries, tool_result text for the hook-error line) belong in the
  claude-code-evals skill, not here. If a future eval must see what the user
  would be shown, try the SDK surface first (the dialog-kind spike, permission
  recording); a scrut interactive case outside the sandbox is the rare
  per-version fallback.

## Transcript

- **A synthetic user that refuses permission requests.** The synthetic user
  allows every permission request Claude Code makes and records it as a
  `permission:` entry (`by: synthetic_user`), so a non-bypass mode changes
  what the transcript shows but not what the agent may do. A persona that
  refuses has no lever. Options: deny with a recorded reason (makes
  `default` behave like `dontAsk`, and changes every existing non-bypass
  scenario); ask the oracle with a third schema (one more concept, one Haiku
  call per request). Under CLI 2.1.317 requests reach canUseTool only where
  the TUI would prompt: Write and Edit under `default`, ExitPlanMode under
  `plan`, and under `auto` only calls the classifier cannot decide, which a
  spike of four risky commands never produced. Demand unproven.
- **Hook entries do not name their source.** `hook:` carries the SDK's
  `hook_name`, which is `Event:matcher` only. A settings hook and a plugin
  hook on the same event and matcher write identical names (a spike loading
  both saw two `PreToolUse:Bash` responses), and the message carries a
  `hook_id` but neither the command nor where it was registered. Matters
  only when a check must tell two hooks apart; until then, distinct output
  text is the workaround. Spike before any shape: whether a later SDK adds
  source fields to `hook_response`; 0.3.322's has none.
- **Plan approval through the synthetic user.** Under
  `permission_mode: plan`, ExitPlanMode reaches canUseTool and is allowed
  with no oracle involvement; its `permission:` entry shows the request was
  allowed and its result entry the approval text, and a `mode:` entry the
  move to `default`.
  The TUI offers "Yes, and use auto mode", "Yes, manually approve edits" and
  "Tell Claude what to change" (with a shift+tab approve-with-feedback).
  Under CLI 2.1.332 rejection arrives as an error tool_result, not a user
  turn: "The user doesn't want to proceed with this tool use. … To tell you
  how to proceed, the user said:\n<feedback>"; no PostToolUse,
  PostToolUseFailure or UserPromptSubmit fires, and the agent re-planned
  unprompted. Approval fires PostToolUse ({plan, isAgent, filePath}) already
  in the new mode, `default` or `auto`. (The 2.1.318 probe saw the feedback
  as a user turn and a `hasTaskTool` key.) Shape: route through the
  existing ask_user schema (Approve / Reject with feedback) rather than a
  third; approve → allow with `updatedPermissions: setMode` mirroring the
  TUI flavours; reject → a canUseTool deny whose message is the feedback,
  which matches what the TUI now sends; write `oracle: plan` entries.
  Demand unproven: fabrica settled on an AskUserQuestion headed Approve; a
  never-approving persona loops until max_turns.
- **Dialog-surface spike.** The SDK has an unwired headless dialog protocol
  (`onUserDialog`, `supportedDialogKinds`, `onElicitation`); kinds not
  declared fail closed to the no-dialog behaviour with no trace. The types
  name only `refusal_fallback_prompt` and `mcp_prompt`, and the probe showed
  the question and plan dialogs are permission flows (PreToolUse/PostToolUse
  pairs), not dialog requests; under CLI 2.1.332 each also fires
  PermissionRequest and a `permission_prompt` Notification. Spike only: log
  which dialogKind values the current release emits and record the answer in
  CLAUDE.md; no routing, since the kind union is open and fails closed, and a
  fourth oracle schema family strains fewer concepts.
- **A PreToolUse hook may answer AskUserQuestion.** CLAUDE.md records a
  spike in which a PreToolUse hook could not answer it, which is why the
  synthetic user answers through canUseTool. In the 2.1.332 TUI, a
  PreToolUse `allow` whose `updatedInput` carries `answers` skipped the card
  and the agent got the same "Your questions have been answered" text a
  person's answer produces; the hooks docs say AskUserQuestion needs
  `updatedInput` paired with `allow`. Re-spike headless under the SDK before
  relying on it; nothing changes unless a check needs a hook-answered
  question.
- **Hook output head and tail like results.** Hook entries keep the first
  4000 characters of each stream, while result entries keep 2000 from each
  end. A command's closing lines often say how it ended, so align hook
  entries with results if a check turns out to need a hook's last lines.

## Synthetic user

- **Personas that skip or dismiss questions.** The oracle must return one
  answer per AskUserQuestion question, so no persona can play a user who
  skips setup questions or closes the card. The agent sees only the
  `answers` text: under CLI 2.1.317, an allow with empty answers makes the
  CLI itself tell the model "The user did not answer the questions.", while a
  canUseTool deny reads "User declined to answer questions". The 2.1.332
  TUI settles what a person's skip and close look like: a question skipped
  on the card's Submit tab is simply missing from `answers` (`annotations`
  stays `{}`) and the agent gets the usual "Your questions have been
  answered:" text listing only the rest, so a per-question skip needs no
  wording of its own; Esc on the card sends the generic rejection
  tool_result ("… STOP what you are doing and wait for the user to tell you
  how to proceed.", is_error) and no hook fires after it, Stop included.
  SDK 0.3.312 added
  `annotations[question].unanswered` (`skipped`, `replied_in_chat`,
  `dismissed`), to be sent only when `system/init.capabilities` lists
  `ask_user_question_unanswered_v1`; the model never sees it, and it lands
  only in `tool_use_result`, of which result entries keep only the
  questions. Shape: an optional per-question decline in the oracle schema,
  steered by the persona with no YAML knob, sent as an omitted answer; a
  canUseTool deny for a whole-card dismiss, the nearest headless match to
  the TUI's rejection; the annotation when the capability is present; an
  `unanswered` map
  in the `oracle: ask` entry for graders. `replied_in_chat` is out, since
  scuttlerun can only send user input after a result. Demand unproven; an
  oracle that skips when the persona would not adds noise to existing evals.

## Isolation and sandbox

- **Document read-side file-tool confinement.** #97 documents
  `blockWritesOutsideWorkingDirectories`; the matching
  `permissions.blockReadsOutsideWorkingDirectories` refuses Read, Grep, Glob
  and LSP outside the working directories in every mode, and 0.3.316 added
  `blockReadsExemptPaths`, honoured only from `--settings` or host-sent
  settings (so scuttlerun would pass it through `Options.settings`). Open:
  skills are symlinked from the operator's source and a link is judged by
  where it leads, so blocking reads may break skill loading unless each
  source is exempted; and sandboxed Bash still reads anything outside
  `deny_read`, so read confinement for the file tools alone is no boundary.
  Document after checking skill loading, or defer.
- **Oracle env and cwd.** #95 isolated the oracle from settings files, MCP
  configuration, skills, plugins and auto-memory. Two inputs remain: it
  inherits the auth-shaped parent env, so the operator's `ANTHROPIC_*`,
  `CLAUDE_CODE_*` and `MAX_THINKING_TOKENS`-style variables still configure
  it, and it runs in the launch directory. Options: an allowlisted env for
  the oracle (auth variables plus the basics) at the cost of one more env
  shape to maintain, or keep the inheritance the spec now documents. Move to
  a neutral cwd only if something cwd-dependent is shown to reach a
  `tools: []`, `skills: []` query.
- **Bash edit diffs reach hooks, not the transcript.** Since CLI 2.1.317
  the Bash tool can attach a diff of the files a command changed
  (`bashEditDiffEnabled`), gated on what looks like server-side config. A
  headless spike of CLI 2.1.317 under bypassPermissions with default
  settings saw no diff. With `bashEditDiffEnabled: true` in a git project,
  the diff appeared only in the structured result
  (`tool_use_result.bashEditDiff`) and in the PostToolUse hook's
  `tool_response`; the text the model sees was unchanged. Result entries
  render that text, so transcripts are unaffected; the remaining exposure is
  a PostToolUse hook that reads `tool_response`, whose input may change per
  account with no version change. Still unverified: whether the binary reads
  `bashEditDiffEnabled === false` from user settings even when
  `setting_sources` excludes `user`. Shape, if hook inputs turn out to vary
  across accounts: pin `bashEditDiffEnabled` through `Options.settings`.
  That is the flag tier, so it overrides a scenario's `project.settings`,
  and the pin must be documented as such.

## Cost and diagnostics

- **Zero-cost agent error results.** The SDK warns that crash and
  startup-error results "may carry zeroed values". #96 treats such an oracle
  result as unknown spend and sets `cost_incomplete`; the agent path sets it
  only when no result arrived, so a crashed agent turn reports a
  confirmed-looking figure. Shape: the oracle's rule, a non-success result
  with `total_cost_usd` 0 sets `cost_incomplete`.
- **Oracle token counts from `modelUsage`.** Oracle cost comes from
  `total_cost_usd`, which covers every call in the query, but oracle tokens
  come from the result's `usage`, which the SDK marks "MAIN AGENT LOOP ONLY …
  Prefer modelUsage". For a `tools: []` one-shot the two should agree;
  summing `modelUsage` would make that hold by construction. Low value until
  an oracle query makes auxiliary calls.

## Spec

- **Failures before init.** #98 added `pending -> failed` for an error result
  that arrives before init, but SessionFailsFromUncaughtException still
  requires `status = running`, though the runner also fails the session on an
  exception before init. Relax the guard as AgentTurnFailsAtRuntime was. The
  header comment of tests/session-state-machine.test.ts also omits the
  spec's `running -> interrupted` edge.

## Code health

- **Message-handler tests in runner.test.ts.** The older handler tests
  drive `runSession` through a mocked `query()`. Moving them to
  `tests/session-loop.test.ts`, calling `handleMessage` directly, makes them
  pure and keeps the 1:1 test mapping.

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
- **Printing held hook responses after a failed start** (2026-11-26).
  SessionStart responses arrive before init and are held for the preamble,
  so a run that ends before init never writes them. Printing them to stderr
  was the shape if a SessionStart hook's output ever explained a failed
  start, but a failing SessionStart hook cannot fail one: the hooks docs say
  its exit 2 "Shows stderr to user only" and the session proceeds, and
  carapace saw startup go ahead on CLI 2.1.332 for exit 2 and exit 1.
- **Waiting for background commands** (2026-11-15). A result that arrives
  while a background subagent runs waits for the turn Claude Code starts
  when the subagent finishes; a background Bash command does not hold the
  session. A command may run until it is stopped (a dev server started with
  `run_in_background`), so waiting for it would end every such session at
  its timeout, and a cap on the wait would add a config key and still spend
  the cap on each of them. A command that ends before the session does
  still gets its outcome as a second result entry.

## Hook-probe fixture

Built as carapace, beside the three tools (2026-11-26): a probe project that
logs every hook event, a launcher for a clean nested `claude` with a
throwaway config directory, flag files that make the probe deny, ask or
rewrite, a per-release checklist and a findings file per CLI version. Its
own IDEAS.md now holds the scrut-interactive and vhs entries that were
recorded here.
