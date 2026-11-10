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
building result entries. Entries are not ordered by priority.

## Decided, not yet built

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
  transcript states which CLI version its facts held for. The 0.3.317 bump
  shows the cost of not knowing: its bundled CLI (2.1.310 → 2.1.317) stopped
  answering a repeated Read with an "unchanged" stub and returns the whole
  file, so sessions that re-read files spend more, and a craboodle comparison
  spanning the bump cannot tell from its transcripts which CLI produced which
  side. The init's `capabilities` list follows from the version, so recording
  the version is enough.
- **Hook entries do not name their source.** `hook:` carries the SDK's
  `hook_name`, which is `Event:matcher` only. A settings hook and a plugin
  hook on the same event and matcher write identical names (a spike loading
  both saw two `PreToolUse:Bash` responses), and the message carries a
  `hook_id` but neither the command nor where it was registered. Matters
  only when a check must tell two hooks apart; until then, distinct output
  text is the workaround. Spike before any shape: whether a later SDK adds
  source fields to `hook_response`.
- **Held hook responses vanish on a failed start.** SessionStart responses
  arrive before init and are held for the preamble; a run that ends before
  init writes only the footer, so they are never written. If a SessionStart
  hook's output is what explains a failed start, it is lost from stdout.
  Shape, if that case appears: print held responses to stderr after the
  existing failure line. Unverified whether a failing SessionStart hook can
  stop startup at all.
- **Plan approval through the synthetic user.** Under
  `permission_mode: plan`, ExitPlanMode reaches canUseTool and is allowed
  with no oracle involvement; only its result entry shows the approval text.
  The TUI offers approve-with-auto, approve-manually and
  reject-with-feedback; the probe saw rejection arrive as PreToolUse only,
  with the feedback as a user turn and an unprompted re-plan, and approval
  fire PostToolUse ({plan, isAgent, filePath, hasTaskTool}) and flip plan →
  default. Shape: route through the existing
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
- **Hook output head and tail like results.** Hook entries keep the first
  4000 characters of each stream, while result entries keep 2000 from each
  end. A command's closing lines often say how it ended, so align hook
  entries with results if a check turns out to need a hook's last lines.
- **Subagent origin on tool and result entries.** A subagent's tool calls
  and their results are written like the main thread's, with nothing marking
  the subagent. The messages carry `parent_tool_use_id` and `agent_id`. Add
  them to the entries only when a check must tell main-thread calls from a
  subagent's.
- **Subagent text reaches the oracle.** A subagent's assistant and thinking
  blocks arrive in the parent stream like its tool calls, so they are written
  as `assistant:` and `thinking:` entries and the assistant text joins the
  oracle's conversation context as if the main agent had said it. A turn
  policy decision can then rest on a subagent's words. Shape, if that
  misleads the oracle: skip messages with `parent_tool_use_id` set when
  building the oracle context, and consider marking their entries.
- **Backgrounded Bash outcomes.** A Bash command run with
  `run_in_background`, or moved to the background when it outran its
  timeout, returns a placeholder result ("Command running in background with
  ID: …", `is_error: false`), so its result entry says nothing about how the
  command ended. The SDK reports the end later as a `system`
  `task_notification` carrying `tool_use_id`, `status` (completed, failed or
  stopped) and `summary`; the session loop ignores it. Shape: when its
  `tool_use_id` names a recorded call, write a second result entry with that
  id, `is_error` true for `failed`, and the summary as `text`. Unverified
  whether a headless session reaches the notification before its result
  ends the turn.

## Synthetic user

- **Personas that skip or dismiss questions.** The oracle must return one
  answer per AskUserQuestion question, so no persona can play a user who
  skips setup questions or closes the card. The agent sees only the
  `answers` text: under CLI 2.1.317, an allow with empty answers makes the
  CLI itself tell the model "The user did not answer the questions.", while a
  canUseTool deny reads "User declined to answer questions". A per-question
  skip has no CLI wording to borrow and needs a spike. SDK 0.3.312 added
  `annotations[question].unanswered` (`skipped`, `replied_in_chat`,
  `dismissed`), to be sent only when `system/init.capabilities` lists
  `ask_user_question_unanswered_v1`; the model never sees it, and it lands
  only in `tool_use_result`, of which result entries keep only the
  questions. Shape: an optional per-question decline in the oracle schema,
  steered by the persona with no YAML knob; empty answers for a whole-card
  dismiss; the annotation when the capability is present; an `unanswered` map
  in the `oracle: ask` entry for graders. `replied_in_chat` is out, since
  scuttlerun can only send user input after a result. Demand unproven; an
  oracle that skips when the persona would not adds noise to existing evals.

## Isolation and sandbox

- **Network isolation stops at sandboxed commands.** README's
  `allowed_domains` row says `[]` means "no network access", and the spec's
  SandboxNetwork guidance says no domains are reachable. The SDK enforces the
  allowlist for sandboxed commands only ("in-process tools such as WebFetch
  are not gated"), and WebSearch runs server-side. Correct the docs the way
  #97 corrected file-tool reach, and name the levers that do gate those
  tools: `sdk.disallowed_tools`, or deny rules in `project.settings`.
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
- **Plan files outside the sandbox.** ExitPlanMode writes the plan to
  `$CLAUDE_CONFIG_DIR/plans/<slug>.md`, or to `~/.claude/plans/` when neither
  the sandbox's HOME nor `project.claude_dir` redirects the config dir. A
  plan-mode scenario with `sandbox.enabled: false` and no `claude_dir`
  therefore writes into the operator's real config dir. Document it, or set
  `CLAUDE_CONFIG_DIR` into the project for every run.

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

- **Build before `npm publish`.** The release workflow's publish job runs
  `npm publish` right after `npm ci`, so `dist/` exists only once
  `prepublishOnly` builds it. npm checks `bin` before that script runs: the
  0.5.0 publish logged "No bin file found at dist/cli.js" and that
  `bin[scuttlerun]` "was invalid and removed". The published tarball kept `bin`
  and an executable `dist/cli.js` (checked by downloading it), so the warning
  is noise today, but it would hide a real loss of the command if npm began
  enforcing it. Shape: an `npm run build` step before `npm publish` in
  `release-please.yml`.
- **Message-handler tests in runner.test.ts.** The older handler tests
  drive `runSession` through a mocked `query()`. Moving them to
  `tests/session-loop.test.ts`, calling `handleMessage` directly, makes them
  pure and keeps the 1:1 test mapping.
- **Lint's default-project cap is full.** `eslint.config.js` lets 20 test
  files fall back to the default TypeScript project, and `tests/` now holds
  20; the next test file fails lint. Shape: raise the cap, or give the tests
  a tsconfig that typescript-eslint's project service finds on its own.

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
  cited as the cost of a rejected design), one tape with
  `Wait /Enter to select/` then `Screenshot` is the cheapest durable
  artifact for a PR, like the existing demo tapes; non-deterministic and
  costs API calls, so at most one per cited fact.
