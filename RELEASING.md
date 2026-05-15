# Releasing

scuttlerun uses [release-please](https://github.com/googleapis/release-please) to automate version bumps, changelog generation, git tagging, and npm publishing. Releases are driven entirely by Conventional Commit messages on `main` — no manual version bumps, no hand-edited `CHANGELOG.md` entries.

## How a release happens

1. **Commits land on `main`.** Every PR uses [Conventional Commits](https://www.conventionalcommits.org/) (enforced by commitlint via the Husky `commit-msg` hook).
2. **release-please opens (or updates) a release PR.** On every push to `main`, [`.github/workflows/release-please.yml`](.github/workflows/release-please.yml) runs. It scans commits since the last release and maintains a single open PR titled `chore(main): release <version>`.
3. **The release PR proposes a version bump and CHANGELOG update.** release-please derives the next version from the unreleased commits (see mapping below) and prepends a new dated release section to `CHANGELOG.md`. It also bumps `package.json`'s `version` and updates `.release-please-manifest.json`.
4. **A maintainer merges the release PR.** That merge is the release trigger:
   - release-please creates the git tag (e.g. `v0.2.0`) and a GitHub Release.
   - The `publish` job in the same workflow runs `npm publish --access public`. Authentication is via npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) — no long-lived token. With OIDC, npm automatically generates [provenance attestations](https://docs.npmjs.com/generating-provenance-statements).

No other action is required. Do not push tags by hand. Do not edit `CHANGELOG.md` directly.

## Commit type → version bump

release-please follows SemVer:

| Commit shape                                                          | Bump                                                                                   |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `fix:` …, `perf:` …                                                   | patch (`0.1.0` → `0.1.1`)                                                              |
| `feat:` …                                                             | minor (`0.1.0` → `0.2.0`)                                                              |
| `feat!:` …, `fix!:` …, or any commit with a `BREAKING CHANGE:` footer | major (`0.1.0` → `1.0.0`)                                                              |
| `docs:`, `chore:`, `refactor:`, `test:`, `build:`, `ci:`, `style:`    | no release; included in CHANGELOG only if release-please is configured to surface them |

While the project is `0.x`, breaking changes bump the minor (`0.1.0` → `0.2.0`); SemVer treats `0.x` as unstable.

## Configuration

- [`release-please-config.json`](release-please-config.json) — single-package Node project, changelog at `CHANGELOG.md`, tags without component prefix.
- [`.release-please-manifest.json`](.release-please-manifest.json) — current released version (source of truth for release-please).
- [`.github/workflows/release-please.yml`](.github/workflows/release-please.yml) — the workflow itself; the `publish` job depends on the `release_created` output and authenticates to npm via OIDC trusted publishing (no `NPM_TOKEN`).

## Prerequisites for publishing

The `publish` job needs:

- A configured **trusted publisher** on the `scuttlerun` package's npm settings page, pointing at this repo and the `release-please.yml` workflow.
- `id-token: write` permission on the workflow (already set) so the OIDC handshake can issue a short-lived publish credential and sign provenance.
- npm CLI ≥ 11.5.1 and Node.js ≥ 22.14.0 in the runner (the workflow upgrades npm in-job).

Trusted publishing has one limitation: it cannot perform the _very first_ publish of a package. The initial `0.0.1` placeholder release was published manually from a maintainer's machine to claim the npm name; every release from `0.1.0` onward uses OIDC.

If a publish fails, fix the underlying issue and re-run the failed `publish` job; do not delete the tag.
