<!--
INTENT. Hard cap: 400 words excluding these comments.
-->

## Why

be-01's application code no longer imports a framework or a driver — Wave 1 made its routes
data, Wave 2 made its stores and its runtime ports — but it still **lives** in `apps/be-01`,
where the Elysia mount, the boot script and the drizzle adapters are its neighbours. Nothing
stops the next service from importing one of them, because nothing can see the direction:
**two projects in the workspace carry a `ring:` tag and twenty-three do not.** A dependency
rule the linter cannot find is a rule that never fires, which is the failure R5 was written
for and the one this repository has shipped twenty-one times.

The move is also what makes the ports worth having. `libs/core` over `@wbs/store-memory` with
`runtime-portable`'s adapters is a graph with no Bun, no SQLite and no HTTP in it — and until
that composition exists in a project the boundary can be asserted about, "the source is a
port" is a claim about names.

## What Changes

- **Rings on every project**, and a totality test that fails on a project carrying zero or two
  of `scope:`/`ring:`/`runtime:`. Written and watched failing first, before a single file moves.
- New projects: `libs/core` (`ring:application`), `libs/store-sqlite` and `libs/store-memory`
  (`ring:adapter`), `libs/conformance` (`ring:application`, `runtime:bun`).
- `git mv` in three commits — ports and services, then the SQLite adapters, then the kits —
  with `bun run test:unit` green after each. The ports barrel becomes one file per port at the
  move; `Logger` and its no-op move to `@wbs/contracts`.
- `depConstraints` on the rings, `no-restricted-imports` and `no-restricted-globals` in core
  and domain, with the `**/*.test.ts` and `**/testing/**` override — and §3.5's sixteen
  negatives, each watched on its own line.
- `composeServices({ source, runtime, shared })` and `compose.test.ts`: core over the memory
  source with `runtime-portable`'s adapters running a batch, a save, a replay and a retention
  sweep without HTTP.

## Non-goals

- Renaming projects or moving directories (`apps/wbs/…`, `wbs-be-01`). That is
  `repo-namespacing`, D18/D19, and its own change.
- Moving `apps/be-01/drizzle/` or the three `migrate-*-cli.ts` entrypoints: the swap invokes
  them by path and the Dockerfile copies them.
- Building the browser mode (D17), a Postgres source, or a second HTTP adapter.

## Constraints

- No behaviour change: the same tests pass before and after each `git mv` commit.
- The whole-workspace gate is the verdict, not per-project runs (2026-08-30's import-sort
  incident).
