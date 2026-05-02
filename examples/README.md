# scuttlerun examples

Each YAML in this directory is a complete session config you can run with:

```bash
scuttlerun examples/<name>.yaml
```

If you've cloned the repo and want to run without installing globally:

```bash
npm run dev -- examples/<name>.yaml
```

Pass `--dry-run` (or `-n`) to validate and print the resolved config without running the session.

## Feature coverage

| Example                              | Persona | AskUserQuestion | Multi-turn |      Project       |  Custom sandbox  |
| ------------------------------------ | :-----: | :-------------: | :--------: | :----------------: | :--------------: |
| [tour.yaml](tour.yaml)               |    ✓    |        ✓        |     ✓      | claude_md + skills |        —         |
| [simple.yaml](simple.yaml)           |    —    |        —        |     —      |         —          |        —         |
| [interactive.yaml](interactive.yaml) |    ✓    |        ✓        |     —      |         —          |        —         |
| [multi-turn.yaml](multi-turn.yaml)   |    ✓    |        —        |     ✓      |         —          | network override |
| [skill-use.yaml](skill-use.yaml)     |    ✓    |        —        |     ✓      |       skills       |        —         |
| [claude-md.yaml](claude-md.yaml)     |    —    |        —        |     —      |     claude_md      |        —         |

## Tour

[`tour.yaml`](tour.yaml) — the flagship example. The agent asks the user one clarifying question (AskUserQuestion), writes a haiku using the `haiku-writer` skill, and revises based on critique from the synthetic-user persona over multiple turns. A project-wide rule is injected via `claude_md`. Run this first if you want to see every scuttlerun feature working together.

## Single-feature examples

[`simple.yaml`](simple.yaml) — single-turn baseline. The agent receives a prompt, completes one task, and the session ends. No persona, no AskUserQuestion, no follow-ups.

[`interactive.yaml`](interactive.yaml) — AskUserQuestion handling. The agent asks the synthetic user a clarifying question; the synthetic-user oracle answers consistent with the configured persona.

[`multi-turn.yaml`](multi-turn.yaml) — reactive multi-turn. After each agent turn, the synthetic user (a senior-developer persona) decides whether to follow up. Demonstrates `user.max_turns` and a `sandbox.network.allowed_domains` override.

[`skill-use.yaml`](skill-use.yaml) — managed project with skill symlinks. Demonstrates `project.skills` injection — the agent gets access to a local skill (`./haiku-writer`) inside the temp project directory.

[`claude-md.yaml`](claude-md.yaml) — project-wide rules via `CLAUDE.md` injection. The agent picks up TDD discipline rules from a `project.claude_md` block.

## See also

- Main [README](../README.md) — installation, config reference, exit codes
- [scuttlerun.allium](../scuttlerun.allium) — full specification (Allium)
- [docs/goals.md](../docs/goals.md) — project motivation and non-goals
