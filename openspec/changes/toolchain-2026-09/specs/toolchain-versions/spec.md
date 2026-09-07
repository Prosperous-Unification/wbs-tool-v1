## ADDED Requirements

### Requirement: The Bun version has one source

The repository MUST name its Bun version in exactly one file, `.bun-version`, and every consumer of a Bun version — the CI workflow and every `FROM oven/bun:` image line — MUST equal it.

#### Scenario: a Dockerfile moves on its own

- **WHEN** one Dockerfile's `oven/bun:` tag differs from `.bun-version`
- **THEN** the test tier fails naming that file and both versions

#### Scenario: CI reads the file

- **WHEN** the CI workflow sets up Bun
- **THEN** it does so from `.bun-version`, not from a literal in the workflow

### Requirement: The dagger engine tag follows the SDK

`tool-dagger` MUST derive its engine image tag from the installed `@dagger.io/dagger` version, and the runbook's stated CLI version MUST be the same string.

#### Scenario: the SDK is bumped without the engine

- **WHEN** `@dagger.io/dagger`'s version and the engine tag a test computes from the runbook disagree
- **THEN** the test tier fails naming both

### Requirement: TypeScript's two roles are pinned to the intended majors

The `tsc` binary on the workspace path MUST be TypeScript 7, and the package that answers `require('typescript')` MUST be the TypeScript 6 API package.

#### Scenario: the alias is swapped

- **WHEN** `typescript` resolves to a major other than 6, or `tsc --version` reports a major other than 7
- **THEN** the test tier fails naming which role moved

### Requirement: ESLint's React pin equals the installed React

`eslint.config.js` MUST state the installed React version explicitly, and it MUST equal `react`'s installed version.

#### Scenario: React is bumped and the pin is not

- **WHEN** `react`'s version and the pin in `eslint.config.js` differ
- **THEN** the test tier fails naming both
