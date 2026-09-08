<!--
Ordered TDD slices. Only `- [ ]` checkboxes are tracked by the apply phase.
-->

Five slices, each its own PR. The order is the plan's (§4, Wave 3) and it is a dependency
order: the rules have to exist and be watched failing before anything moves, or the move is
what proves them and nothing does.

## 1. The rings, before a single file moves

- [x] 1.1 **The totality test first, watched red.** `tools/tool-devsync/src/workspace-targets.test.ts`
      grows a case walking every `project.json` under `apps/`, `libs/` and `tools/`: exactly one
      `scope:`, one `ring:`, one `runtime:`. On `main` **two** projects carry a ring
      (`observability`, `runtime-portable`) and twenty-three do not, so it fails naming them —
      record the list, because that list is this slice's work.
- [x] 1.2 A `ring:` tag on every project. `tools/*` are `ring:adapter` (they call adapters and
      nothing calls them); `domain`, `contracts`, `validation` are `ring:domain`; the apps and
      the remaining libs are `ring:adapter`. Nothing is `ring:application` yet — there is no
      application project until slice 2.
- [x] 1.3 The `depConstraints` of plan §2 in `eslint.config.js`, with the `**/*.test.ts` and
      `**/testing/**` override. Negatives 6, 13 and 15 of §3.5 watched here — 4 and 5 name
      `@wbs/core`, which does not exist until slice 2, and are watched there rather than
      simulated against a project that is not the one the rule is about.
- [x] 1.4 `bunx nx run-many -t lint typecheck test` — the whole workspace, because a rule that
      changes what may import what is exactly the kind that passes per project and fails as a
      set (2026-08-30's import-sort incident).

## 2. `libs/core`: the ports, the services, the use cases

- [x] 2.1 The project: `project.json` with `ring:application` + `runtime:isomorphic`, its
      `tsconfig`s, and `typecheck` running `tsc --build --force` on the **source** project
      (R5 #16/#17 — a solution config compiles nothing). Watched failing on a deliberate
      `const deliberatelyWrong: number = 'not a number'`.
- [x] 2.2a **What has no adapter in its signature, moved first**: `WriteStamp`, `Clock` and
      the three runtime ports (`PasswordHasher`, `TokenCodec`, `Digest`). Twenty be-01 files
      import them from `@wbs/core` now; `repository/index.ts` re-exports `WriteStamp` for the
      ninety that name it there, which is an adapter naming its application's type and the
      right direction either way.
- [ ] 2.2b **The store ports, and the two signatures that block them.**
      `EventLogStore.recordEventIn(tx)` takes drizzle's transaction handle and
      `SavedPlanStore.holdingOf(db)`/`bodyOf(db)` take a `Drizzle`; a port carrying either
      cannot live in a ring that may not import drizzle. Neither is a move — each is a design
      question with a caller that depends on the answer (the optimizer's atomic
      result-plus-event write; the quota read inside the save's own transaction). Split the
      adapter-only half off each before moving the rest of `repository/index.ts` to
      `core/ports/*`, one file per port.
- [ ] 2.2c `service/*.ts` that hold no adapter move whole, `unit-of-work.ts` with them.
      `Logger` and its no-op move from `@wbs/observability` to `@wbs/contracts`, which is what
      lets core hold no adapter at all. `bun run test:unit` green, same count.
- [ ] 2.3 `no-restricted-imports` and `no-restricted-globals` in `libs/core/src` and
      `libs/domain/src`. Negatives 1, 2, 3 and 9 of §3.5, watched.
- [ ] 2.4 The four use-case entrypoints — `runCommandBatch`, `savePlan`, `replay`,
      `retentionSweep` — as the callers a source and a runtime are composed for.

## 3. `libs/store-sqlite` and `libs/store-memory`

- [ ] 3.1 `git mv` the drizzle adapters, `schema.ts`, `db.ts` (with the coordinator) and
      `scheduleInputHash`'s new home into `libs/store-sqlite`; the `bun:sqlite` ban and the
      drizzle rules move with them and are **re-aimed** — `eslint.config.js` must end with no
      `apps/be-01/src/repository` path left in it (negative 7, watched).
- [ ] 3.2 `apps/be-01/drizzle/` and the three `migrate-*-cli.ts` **stay**: the swap invokes
      them by path and the Dockerfile copies them. The runner takes the folder as an argument,
      which it already does.
- [ ] 3.3 `git mv` the in-memory fixtures into `libs/store-memory`, with
      `NOT_OFFERED_BY_MEMORY` and its allowlist test.

## 4. `libs/conformance`, and the proof the ports are ports

- [ ] 4.1 `git mv` `testing/kits/` into `libs/conformance` (`ring:application`,
      `runtime:bun` — it imports `bun:test`, which core's own ban keeps out of core). Every
      source's `test` target runs it.
- [ ] 4.2 `composeServices({ source, runtime, shared })` in `libs/core/src/compose.ts`, and
      `compose.test.ts`: core over `@wbs/store-memory` with `runtime-portable`'s `Digest` and
      timers, running a command batch, a saved-plan save with a refused actor, one replay, one
      retention sweep — **no HTTP, no SQLite, no Bun**. This is the slice that turns "the
      source is a port" from a claim about names into a composition that exists.
- [ ] 4.3 The remaining negatives of §3.5 — 8, 10, 11, 12, 14, 16 — each watched.

## 5. The gate, and the docs

- [ ] 5.1 `test:unit` driven by **target** rather than by the list of project names in
      `package.json`, so a new project joins the fast tier by existing.
- [ ] 5.2 The whole-workspace gate on a frozen tree, recorded in `verify.md` with its command,
      duration and counts. `bun run e2e` on shifted ports — this change moves no fe-01 file,
      but it moves what be-01 serves from.
- [ ] 5.3 `LLM_README.md`, ADR 0014 and ADR 0015 to `accepted`, and the plan's §4 cross-
      reference. `docs/refactoring/tasks.md`'s Wave 3 row.
