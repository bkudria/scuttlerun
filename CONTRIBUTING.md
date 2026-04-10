# Contributing to scuttlerun

Thanks for your interest in contributing! scuttlerun is currently unreleased and under active development — APIs and config formats may change without notice.

## Development Setup

```bash
git clone https://github.com/bkudria/scuttlerun.git
cd scuttlerun
npm install
npm run build
```

## Running Tests

```bash
npm test                                       # Run all tests (vitest)
npm run test:watch                             # Watch mode
npm run test:coverage                          # With coverage report
npx vitest run tests/config.test.ts            # Single test file
npx vitest run tests/config.test.ts -t "name"  # Single test by name
```

## Linting and Build

```bash
npm run lint         # eslint
npm run build        # tsc → dist/
```

## Test-Driven Development

scuttlerun follows TDD. Write a failing test first, then the minimum code to make it pass. Tests live in `tests/` with 1:1 mapping to source files.

## Pull Requests

1. Fork the repo and create a topic branch from `main`.
2. Make your changes with tests covering new behavior.
3. Ensure `npm run lint`, `npm test`, and `npm run build` all pass.
4. Open a pull request describing what you changed and why.

## Further Reading

- [SPEC.md](SPEC.md) — full technical specification and design decisions
- [GOALS.md](GOALS.md) — project motivation, vision, and non-goals
- [CLAUDE.md](CLAUDE.md) — architecture overview and key technical details
