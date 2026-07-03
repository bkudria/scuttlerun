# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release sections below are generated automatically by release-please from Conventional Commit messages.

## [0.4.0](https://github.com/bkudria/scuttlerun/compare/v0.3.0...v0.4.0) (2026-07-03)


### Features

* **auth:** never use CLAUDE_CODE_OAUTH_TOKEN; add CLAUDE_SDK_OAUTH_TOKEN ([#73](https://github.com/bkudria/scuttlerun/issues/73)) ([73d1195](https://github.com/bkudria/scuttlerun/commit/73d1195f75638c4a9b50a33625f89eac8edb9772))
* **auth:** prefer Claude subscription credentials over the API key ([#69](https://github.com/bkudria/scuttlerun/issues/69)) ([68bd7ea](https://github.com/bkudria/scuttlerun/commit/68bd7ea100cfeab6b245e1907b6031d523c898f9))
* **cli:** surface project.plugins in --dry-run output ([#43](https://github.com/bkudria/scuttlerun/issues/43)) ([0bd1d95](https://github.com/bkudria/scuttlerun/commit/0bd1d957988ec74999daa8a3fde2334746786d4c))
* **config:** accept timeout as a config field with CLI override ([#47](https://github.com/bkudria/scuttlerun/issues/47)) ([5d903ab](https://github.com/bkudria/scuttlerun/commit/5d903ab6d6ab2edbc5088a0ee7dad5aa411fc88a))
* **config:** add project.plugins path-list scaffold ([#32](https://github.com/bkudria/scuttlerun/issues/32)) ([1418138](https://github.com/bkudria/scuttlerun/commit/14181386b5af1322cece507897ae4a80b68c2e97))
* **config:** include Agent in default tools list ([#31](https://github.com/bkudria/scuttlerun/issues/31)) ([3e174d4](https://github.com/bkudria/scuttlerun/commit/3e174d44ed8ae6898060d6f8fc1e48e52774cc0c))
* **runner:** emit diagnostic stderr on timeout (exit 6) ([#42](https://github.com/bkudria/scuttlerun/issues/42)) ([6e9a511](https://github.com/bkudria/scuttlerun/commit/6e9a5111ca7211b1d941a4e19507f23b15509b0a))
* **runner:** warn on an unregistered leading slash command ([#48](https://github.com/bkudria/scuttlerun/issues/48)) ([8ea0201](https://github.com/bkudria/scuttlerun/commit/8ea0201ce9db270bd9c35f47e4f13063727639af))
* **transcript:** flag incomplete agent cost in the footer ([#65](https://github.com/bkudria/scuttlerun/issues/65)) ([13bd83d](https://github.com/bkudria/scuttlerun/commit/13bd83d510281a5bb45edf6f6c7d0a6b58c33ffa))


### Bug Fixes

* **cli:** drop ANTHROPIC_API_KEY precondition to allow OAuth fallback ([#37](https://github.com/bkudria/scuttlerun/issues/37)) ([a3ddbf6](https://github.com/bkudria/scuttlerun/commit/a3ddbf6d78a0092bb3d35a9af49f566b18891964))
* **oracle:** key AskUserQuestion answers by input question text ([#45](https://github.com/bkudria/scuttlerun/issues/45)) ([97724fd](https://github.com/bkudria/scuttlerun/commit/97724fdc81118163e46f1f45904cf5581d483fec))
* **oracle:** retry answer-count mismatch with corrective feedback ([#52](https://github.com/bkudria/scuttlerun/issues/52)) ([3895c2c](https://github.com/bkudria/scuttlerun/commit/3895c2cc1b6c0324bc1daa80a714a895b96ab69e))
* **pricing:** correct Opus rates to $5/$25 and add Opus 4.8 ([#53](https://github.com/bkudria/scuttlerun/issues/53)) ([98334a1](https://github.com/bkudria/scuttlerun/commit/98334a159e875b1271c97bf66f696a74ee78cda7))
* **runner:** expose OAuth credential in sandboxed sessions ([#40](https://github.com/bkudria/scuttlerun/issues/40)) ([ea93bd7](https://github.com/bkudria/scuttlerun/commit/ea93bd7ffb9ba2b9373c1988df8e752e8e57dc0f))
* **runner:** map a mid-execution turn cap to EXIT_MAX_TURNS ([#60](https://github.com/bkudria/scuttlerun/issues/60)) ([f383332](https://github.com/bkudria/scuttlerun/commit/f383332e7c46b5c56f7672ead6da58e5d43e107d))
* **runner:** match SDK PermissionResult schema in canUseTool ([#39](https://github.com/bkudria/scuttlerun/issues/39)) ([147615d](https://github.com/bkudria/scuttlerun/commit/147615dcd07ca72b7c94a36d3d7e65da12f85c23))
* **runner:** surface runtime-error detail to stderr ([#59](https://github.com/bkudria/scuttlerun/issues/59)) ([fe4cca8](https://github.com/bkudria/scuttlerun/commit/fe4cca816bc8af71c0a1909be4c12a86f1e56d80))

## [0.3.0](https://github.com/bkudria/scuttlerun/compare/v0.2.1...v0.3.0) (2026-05-23)


### Features

* **synthetic-user:** warn once on oracle context truncation ([#29](https://github.com/bkudria/scuttlerun/issues/29)) ([16c9f81](https://github.com/bkudria/scuttlerun/commit/16c9f81f02e68a6f2e74f50396348aa0835d95a5))

## [0.2.1](https://github.com/bkudria/scuttlerun/compare/v0.2.0...v0.2.1) (2026-05-17)


### Bug Fixes

* **cli:** read version from package.json instead of hardcoded literal ([7fa039a](https://github.com/bkudria/scuttlerun/commit/7fa039a33be91a62e3a4565e2b1a393263a01534))
* **oracle:** write retry status to process.stderr instead of console.error ([ca42196](https://github.com/bkudria/scuttlerun/commit/ca4219660f259b6c00aadd733089dcce8422c07e))

## [0.2.0](https://github.com/bkudria/scuttlerun/compare/v0.1.0...v0.2.0) (2026-05-15)


### Features

* add interrupted terminal session status ([5ddac0d](https://github.com/bkudria/scuttlerun/commit/5ddac0d7eb945702fb11ef34aec6ee658ba9dfcd))
* **cli:** fail early with an actionable error when ANTHROPIC_API_KEY is unset ([cc22d56](https://github.com/bkudria/scuttlerun/commit/cc22d569f77c52281ca1651663860d4c30120053))
* **cli:** friendly error formatting for ZodError and ENOENT ([cc9046a](https://github.com/bkudria/scuttlerun/commit/cc9046a9603453ce1827705ebca6de32a4b975b9))
* **cli:** handle SIGINT/SIGTERM with graceful shutdown and exit 130 ([4aee2a8](https://github.com/bkudria/scuttlerun/commit/4aee2a86932c878121c171947e08d480035aeaf5))
* **transcript:** expose cache token totals in footer ([62b01b8](https://github.com/bkudria/scuttlerun/commit/62b01b831b09ac0270e674d1ae9f920271253fe9))


### Bug Fixes

* **oracle:** exponential backoff, verbose logging, friendly retry-exhausted error ([af158f6](https://github.com/bkudria/scuttlerun/commit/af158f66ef0145b7667b3cdafae3efc8fb3120e8))
* **pricing:** fall back to configured default model rate ([5fc80c3](https://github.com/bkudria/scuttlerun/commit/5fc80c3175be0e16a5f6c28982911348082c6e88))
* **project:** validate scaffold inputs before any filesystem mutation ([34af215](https://github.com/bkudria/scuttlerun/commit/34af215d6391a171f49c31dd343ffadf19681331))
* **release:** publish on Node 24 with bundled npm 11.x ([963796b](https://github.com/bkudria/scuttlerun/commit/963796b8082441fa2546577ec5ef82ba813e7431))
* **runner:** close SDK query even when footer emission throws ([014c49a](https://github.com/bkudria/scuttlerun/commit/014c49a1944da9b77ee3a97dc112e25f8bd5ce8b))
* **runner:** finalise transcript on exception path ([fd7da09](https://github.com/bkudria/scuttlerun/commit/fd7da09dbbb701608e78516d3aa412caddc30a6c))
* **runner:** suppress oracle_turn entry on cap-driven termination ([36c119d](https://github.com/bkudria/scuttlerun/commit/36c119d82c1c8b1b2e6fd5307bc75dca1f6e4b8a))

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
