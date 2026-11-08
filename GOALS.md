# Goals

## Why scuttlerun Exists

scuttlerun exists because Claude Code's `-p` mode is one-shot and cannot handle interactive patterns — AskUserQuestion calls, multi-turn follow-ups, or any session that requires back-and-forth. The original need was testing and evaluating skills, prompts, sub-agents, and plugins, which inherently involve these interactive patterns.

## Session Driver, Not Eval Framework

scuttlerun is a **session driver**: it runs sessions and produces transcripts. It is not an evaluation framework. This is primarily about **reusability** — a pure session driver is useful for evals, but also for demos, CI testing, regression checks, and anything else that needs programmatic multi-turn Claude sessions. Eval concerns (scoring, grading) are separate tools that compose with scuttlerun's output. One tool, one job.

## Minimalism and Good Defaults

scuttlerun includes only what is essential to driving sessions. This manifests as:

- **Lean on the SDK** — Don't reimplement what the Agent SDK already provides. scuttlerun is a thin orchestration layer, not a framework.
- **Fewer concepts** — Fewer moving parts means fewer failure modes and less to learn.
- **Convention over configuration** — Good defaults that work for most cases. Configure only when the default doesn't fit.

## Declarative, Accessible Configuration

Sessions are defined in YAML files, not code. YAML is **declarative and versionable** — a single file captures the full intent of a session — and **accessible** to anyone, not just programmers. Config merging (base + override files) keeps configs DRY and enables scenario variants (same base task with different models, personas, or constraints) without boilerplate.

A YAML file describes **intent, not reproduction**. Given LLM non-determinism, exact reproducibility is impossible. The YAML captures what you wanted to happen; the transcript captures what actually did.

## Headless, Isolated Operation

scuttlerun is fully headless — no human intervention required during a session. This is equally about **enabling automation** (batch runs, CI) and **protecting the host system** (the agent works in a fresh temp directory, and by default its shell commands run in an OS sandbox that keeps their writes off your real filesystem; the file tools sit outside that boundary, as below).

Project directories are preserved after each session so artifacts remain available for inspection. At the start of each session, scuttlerun garbage-collects its own project directories in `$TMPDIR` that are older than 7 days (matching the `scuttlerun-project-` prefix); recent artifacts are never touched.

The sandbox (redirecting `$HOME`, constraining what the agent's shell commands can reach on the network and filesystem) exists for **safety** — preventing the agent from affecting the real system. Because it is a safety boundary, an enabled sandbox that cannot run fails the session rather than silently running the agent unsandboxed, and scuttlerun names the fix: install the sandbox's dependencies or turn the sandbox off explicitly. Its boundary is the OS sandbox around shell commands; the file tools sit outside it, and confining their writes is left to an opt-in Claude Code setting rather than imposed by default, because that setting also refuses edits to Claude settings files — exactly the behaviour some evaluations exist to observe. The docs say plainly where each boundary stops, so the isolation is never assumed to be wider than it is.

Isolation runs the other way for the oracle: it loads none of the host's Claude Code configuration files or account-synced extras (settings, hooks, plugins, MCP servers, skills, auto-memory), so the operator's own setup cannot steer the synthetic user or add cost to its calls. The environment it inherits for credentials and any administrator-managed settings are the exceptions.

## Controlled Environment for Testing

Project scaffolding (CLAUDE.md, skill symlinks, settings.json, a seeded Claude config directory) creates a **controlled environment** for testing and evaluating Claude Code configurations — skills, prompts, sub-agents, plugins, and any other project-level setup. Each session gets a fresh, isolated project directory with exactly the context the agent should see.

## LLM-Driven Synthetic User

scuttlerun uses an LLM oracle (Haiku by default) to simulate user responses rather than scripted answers. This is driven by three concerns:

1. **Config simplicity** — A persona description plus an LLM handles the full range of possible interactions with minimal config. Scripting answers for every possible question would be unwieldy.
2. **Robustness** — Scripted answers break when questions change even slightly. An LLM adapts naturally to variations in phrasing or unexpected questions. If the oracle itself returns a malformed answer set (e.g., one answer per option instead of one per question), scuttlerun re-prompts it with corrective feedback rather than aborting the session on the first slip.
3. **Design clarity** — One mechanism (LLM oracle) avoids ambiguity about which path handles a given question.

Personas are a **steering mechanism** — a knob to guide the oracle toward relevant responses for a given scenario. Haiku is the default oracle model because it's the cheapest and fastest model that reliably handles the task.

## Reactive Multi-Turn Sessions

The reactive turn policy (where the oracle decides whether to continue or end the session) serves three goals:

1. **Realistic sessions** — Real users follow up, ask clarifying questions, and push back. scuttlerun simulates that.
2. **Thoroughness** — Multi-turn ensures the task is actually completed, not just started.
3. **Flexibility** — Different scenarios need different session shapes. The oracle adapts session length to the task rather than imposing a fixed structure.

## Readable, Structured Output

scuttlerun streams YAML to stdout — both human-readable and machine-parseable, no separate formats needed. Each transcript explains itself: its header carries a legend of what each entry records and what it leaves out, so a grader reads the format from the output rather than carrying a copy that drifts whenever the format grows. Hooks are recorded because they are configuration under test whose effect the agent's own entries cannot show: a hook that blocks a call, adds context or prints a status changes the session without the agent saying so. The transcript links to the full SDK session event log (JSONL) for deeper inspection when needed. Footer costs are the Agent SDK's own estimates rather than a price list scuttlerun maintains, and the oracle's cost counts every query it made, retries included. When some spend goes unreported — a session ends before its in-flight turn reports a final cost, or an oracle query ends without reporting one — the footer flags the cost as incomplete rather than silently conflating an unknown spend with a confirmed zero. Likewise, when Claude Code reports that a full disk or quota kept it from saving the session log, the footer flags the transcript as incomplete, so a reader never mistakes a truncated log for the whole conversation.
