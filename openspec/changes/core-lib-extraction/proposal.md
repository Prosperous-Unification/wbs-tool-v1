<!--
INTENT. Hard cap: 400 words excluding these comments.
-->

## Why

Core scaffolding and project rings have landed, but the service graph still names SQLite
types, runtime adapters and a batch graph constructed before admission. The current
SQLite composition does not establish that another source can run the same commands:
a staged memory source needs the actual scope of each batch. Extracting and enforcing
these boundaries makes the existing ports usable by a second composition.

## What Changes

- Source-independent ports and value types; SQLite-only transaction helpers stay adapters.
- Services built from the admitted scope, public graph after settlement, fresh repair scope.
- One composition over explicit source/runtime capabilities, including independent history.
- Core services and endpoint bindings, SQLite and staged-memory sources, and conformance
  kits in separate projects, with production dependency rules watched failing.
- Browser-executed batch/save/replay/retention proof with no backend, SQLite or Bun runtime.
- Recursive project checks and a fast test tier selected by targets rather than names.

## Non-goals

- Renaming projects or moving directories (`apps/wbs/…`, `wbs-be-01`). That is
  `repo-namespacing`, D18/D19, and its own change.
- Moving `apps/be-01/drizzle/` or the three `migrate-*-cli.ts` entrypoints: the swap invokes
  them by path and the Dockerfile copies them.
- Building browser UI mode, a Postgres source, or a second HTTP adapter.
- Replacing solver supervision or implementing every deferred source conformance case.

## Constraints

- Preserve observable behavior and tests across moves; document required scope corrections.
- Scheduler boundary completion precedes moving scheduling consumers. The separate
  scheduler-runtime-port change owns the engine-unavailable contract.
- The whole-workspace gate is the verdict, not per-project runs (2026-08-30's import-sort
  incident).

## Capabilities

### New Capabilities

- `core-lib-extraction`: portable composition and enforced source/runtime boundaries.

## Domain Terms

Existing Source, Scope, Unit of work, Port, Composition root and Conformance kit.

## Decisions Recorded

[ADR0014](../../../docs/adr/0014-ports-live-in-a-framework-free-core-lib.md),
[ADR0015](../../../docs/adr/0015-a-command-batch-is-a-unit-of-work-the-source-implements.md),
[ADR0018](../../../docs/adr/0018-adapter-transactions-stay-outside-core-ports.md).

## Impact

be-01, core, contracts, domain, auth, runtime-portable, source libraries, conformance,
Nx targets and their existing callers/tests. No migration SQL or deploy identity changes.
