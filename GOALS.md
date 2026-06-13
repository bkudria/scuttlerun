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

scuttlerun is fully headless — no human intervention required during a session. This is equally about **enabling automation** (batch runs, CI) and **protecting the host system** (the agent operates in an isolated temp directory, not your real filesystem).

Project directories are preserved after each session so artifacts remain available for inspection. At the start of each session, scuttlerun garbage-collects its own project directories in `$TMPDIR` that are older than 7 days (matching the `scuttlerun-project-` prefix); recent artifacts are never touched.

The sandbox (redirecting `$HOME`, constraining network/filesystem access) exists for **safety** — preventing the agent from affecting the real system.

## Controlled Environment for Testing

Project scaffolding (CLAUDE.md, skill symlinks, settings.json) creates a **controlled environment** for testing and evaluating Claude Code configurations — skills, prompts, sub-agents, plugins, and any other project-level setup. Each session gets a fresh, isolated project directory with exactly the context the agent should see.

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

scuttlerun streams YAML to stdout — both human-readable and machine-parseable, no separate formats needed. The transcript links to the full SDK session event log (JSONL) for deeper inspection when needed. When a session ends before its in-flight turn reports a final cost, the footer flags the agent cost as incomplete rather than silently conflating an unknown spend with a confirmed zero.
