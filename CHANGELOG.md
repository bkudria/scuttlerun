# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-04-27

### Added

- Initial release.
- TypeScript CLI driving multi-turn Claude sessions programmatically via the Claude Agent SDK.
- Synthetic user powered by an LLM oracle (Haiku by default) that handles `AskUserQuestion` calls and turn-policy decisions.
- YAML-driven session config with deep-merging of multiple files; CLI flag overrides for model, prompt, tools, effort, timeout, max turns, and verbose logging.
- Streaming YAML transcript on stdout, plus preserved SDK session JSONL for full-fidelity replay.
- OS-level sandbox (filesystem + network restrictions) enabled by default, with `$HOME` redirected inside the project temp dir.
- Managed project scaffolding (`project.claude_md`, `project.skills`, `project.settings`, `project.files`, `project.git_init`).
- Exit-code taxonomy (0 success, 1 config error, 2 runtime, 5 budget, 6 timeout, 7 max-turns, 130 SIGINT) and budget/timeout enforcement with pricing-aware oracle usage tracking.
