# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release sections below are generated automatically by release-please from Conventional Commit messages.

## [0.1.0](https://github.com/bkudria/scuttlerun/compare/v0.0.1...v0.1.0) (2026-05-15)

### Features

- add interrupted terminal session status ([5ddac0d](https://github.com/bkudria/scuttlerun/commit/5ddac0d7eb945702fb11ef34aec6ee658ba9dfcd))
- **cli:** fail early with an actionable error when ANTHROPIC_API_KEY is unset ([cc22d56](https://github.com/bkudria/scuttlerun/commit/cc22d569f77c52281ca1651663860d4c30120053))
- **cli:** friendly error formatting for ZodError and ENOENT ([cc9046a](https://github.com/bkudria/scuttlerun/commit/cc9046a9603453ce1827705ebca6de32a4b975b9))
- **cli:** handle SIGINT/SIGTERM with graceful shutdown and exit 130 ([4aee2a8](https://github.com/bkudria/scuttlerun/commit/4aee2a86932c878121c171947e08d480035aeaf5))
- **transcript:** expose cache token totals in footer ([62b01b8](https://github.com/bkudria/scuttlerun/commit/62b01b831b09ac0270e674d1ae9f920271253fe9))

### Bug Fixes

- **oracle:** exponential backoff, verbose logging, friendly retry-exhausted error ([af158f6](https://github.com/bkudria/scuttlerun/commit/af158f66ef0145b7667b3cdafae3efc8fb3120e8))
- **pricing:** fall back to configured default model rate ([5fc80c3](https://github.com/bkudria/scuttlerun/commit/5fc80c3175be0e16a5f6c28982911348082c6e88))
- **project:** validate scaffold inputs before any filesystem mutation ([34af215](https://github.com/bkudria/scuttlerun/commit/34af215d6391a171f49c31dd343ffadf19681331))
- **runner:** close SDK query even when footer emission throws ([014c49a](https://github.com/bkudria/scuttlerun/commit/014c49a1944da9b77ee3a97dc112e25f8bd5ce8b))
- **runner:** finalise transcript on exception path ([fd7da09](https://github.com/bkudria/scuttlerun/commit/fd7da09dbbb701608e78516d3aa412caddc30a6c))
- **runner:** suppress oracle_turn entry on cap-driven termination ([36c119d](https://github.com/bkudria/scuttlerun/commit/36c119d82c1c8b1b2e6fd5307bc75dca1f6e4b8a))
