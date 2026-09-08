# Verification — `store-port-and-unit-of-work`

Nothing below is a claim until it carries observed output. A row with an empty **Observed**
cell is a check that has not been watched failing and therefore is not done (R5).

## Wave 0 collision gate

Re-run 2026-09-08 against `main` @ `d2e14214`, over the file set the change declares
(`apps/be-01/src/repository/**`, `db.ts`, `services.ts`, `service/plan-commands.ts`,
`service/write-lock.ts`, `apps/be-01/src/testing/**`, `libs/domain`'s
`canonical-schedule-input.ts`).

| Source                                                      | Finding                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open PRs (#302, #307, #308, #311, #314, #315)               | **No intersection.** None touches `apps/be-01/src/**` or `libs/domain`; #307 is fe-01 tests, #308 and #311 are `docs/state/*`, #302/#315 edit `.github/workflows/ci.yml`.                                                                                                                                                                       |
| Branches (last 20 by commit date)                           | **No intersection.** The `wip/salvage-ws-auth-*` pair is gw-01 + fe-01; `refactor/planned-project` has no content diff against `main` (squash-merged as `cbad68af`).                                                                                                                                                                            |
| `openspec/changes/dual-optimized-scheduler` (20 unchecked)  | **Collides** on `SCHEDULER_CONTRACT_VERSION` in `libs/domain` (1.5) and the `beginOptimizationDrain`/`finishOptimizationDrain` repository seams (3.9b). → the `Scheduler` port and `scheduleInputHash`'s move are **out of this change** (proposal, non-goals). The drain functions are gated here as ordinary mutating methods when they land. |
| `openspec/changes/plan-json-import` (19 unchecked, unbuilt) | **Collides** on the transaction boundary (2.2/2.3 drive `transactions.begin`). It is Dany's and unimplemented; whichever lands second rebases onto `UnitOfWork.run`.                                                                                                                                                                            |
| `openspec/changes/retired-schema-cleanup` (5 unchecked)     | **Coordinate.** Its 4.2 migrates `insertSubtree` (`work-item.ts:860`), a method this change gates. Sequence, do not overlap.                                                                                                                                                                                                                    |
| `openspec/changes/saved-plans`, `gantt-calendar-markers`    | Frozen content this change must preserve: `saved-plan-capture.db.test.ts`, `saved-plan-created-by-id.db.test.ts`, the `plan-commands` exclusion, and the marker store port.                                                                                                                                                                     |
| `docs/refactoring/collisions.md` ownership                  | R2/R6 own the directory repositories and fixtures; `services.ts` is a shared composition needing an explicit handoff. All peer sessions were idle at the time of this gate.                                                                                                                                                                     |

## Failure-proof table

| Check                                                          | Fault injected                                                                      | Test that observed it                                                      | Observed                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A route write started during a batch is not rolled back (d)    | the gate removed from `StepRepository.add`                                          |                                                                            |                                                                                                                                                                                                                                                            |
| Every public transactional write takes a turn (i)              | `OPEN` in place of the coordinator for one store                                    |                                                                            |                                                                                                                                                                                                                                                            |
| A scope store does not wait for its own batch's turn (h)       | the SQLite fixture's `admitted` stores built over the coordinator instead of `OPEN` | `sqlite-unit-of-work.db.test.ts` (the whole kit)                           | **Hung**: `(a) makes none of a refused batch observable ... this test timed out after 3000ms`, and the run had to be killed. A deadlock's shape from outside is a timeout, which is why the fault is named in the comment rather than left to be inferred. |
| The post-rollback repair reaches surviving state (k)           | a repair that throws                                                                | kit `(k) lets a failing repair surface as itself, with no second rollback` | Passes: the repair's own error reaches the caller and the next batch commits. The **public journal** and **discarded memory scope** faults wait for slice 5's memory source.                                                                               |
| A committed event still leaves when the next batch refuses (l) | a shared ambient announcement slot                                                  |                                                                            |                                                                                                                                                                                                                                                            |
| A saved plan takes no turn and survives both outcomes (j)      | history tables put back inside the swapped clone                                    |                                                                            |                                                                                                                                                                                                                                                            |
| `Scope` cannot enlist a saved plan                             | a `scope.stores.savedPlans` reference                                               | `tsc`                                                                      |                                                                                                                                                                                                                                                            |
| A stub with no allowlist line                                  | a stubbed memory method left off the allowlist                                      |                                                                            |                                                                                                                                                                                                                                                            |
| A runtime port with no adapter                                 | a service constructed without its port                                              | `tsc`                                                                      |                                                                                                                                                                                                                                                            |

## Slice 1 — the gate and the two graphs

| Command                                                                               | When       | Result                                                                                                                                                    |
| ------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bunx tsc --build --force apps/be-01/tsconfig.json` (source, spec and tools projects) | 2026-09-08 | clean                                                                                                                                                     |
| `bun test` in `apps/be-01`                                                            | 2026-09-08 | **1996 pass, 1 skip, 0 fail**, 19,985 assertions, 114s                                                                                                    |
| the same on the parent commit, for the baseline                                       | 2026-09-08 | 1994 pass, 1 skip, **1 fail** (this change's own negative, written first) — the **2 errors** the run reports are pre-existing and identical on both sides |
| `bunx nx run be-01:lint --skip-nx-cache`                                              | 2026-09-08 | clean, 24.7s                                                                                                                                              |

The whole-workspace gate is slice 6's, on a frozen tree. Nothing outside `apps/be-01`
changed in this slice.

## Slice 6 — the runtime a process happens to be

| Command                                                         | When       | Result                                                 |
| --------------------------------------------------------------- | ---------- | ------------------------------------------------------ |
| `bun test` in `apps/be-01`                                      | 2026-09-08 | **2035 pass, 2 skip, 0 fail**, 20,062 assertions, 120s |
| `bun run test:unit`                                             | 2026-09-08 | 7 tasks green                                          |
| `bunx nx run be-01:lint --skip-nx-cache`, `tsc --build --force` | 2026-09-08 | clean                                                  |

`Digest` is asynchronous because a browser's `crypto.subtle.digest` is. That is not a
detail: it made the saved plan's **read** path async as well as its write path, and both had
to move together — a port whose two callers disagree about whether hashing can be awaited is
a port only one runtime can implement.

## Slice 5 — the conformance kits

| Command                                                                           | When       | Result                                                 |
| --------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------ |
| `bun test` in `apps/be-01`                                                        | 2026-09-08 | **2035 pass, 2 skip, 0 fail**, 20,062 assertions, 118s |
| `bunx tsc --build --force apps/be-01/tsconfig.json`, `bunx eslint apps/be-01/src` | 2026-09-08 | clean                                                  |

Two checks that could not fail, both caught while writing this slice and both recorded because
the shape recurs:

1. `report.unknown` was computed where `sourceConformance` **returns**, which is before
   `bun:test` has run a single `describe` body — so it read every allowlist entry as unknown,
   including ones matched moments later. It is a function now, read when it is called.
2. That assertion then stood **behind** the skipped-vs-allowlist equality, which fails on the
   same fault first. A check standing behind a check that catches the same fault is a check
   that cannot fail; it is asserted first now, and was then watched failing on its own line.

## Slice 4 — what a broken reference means

| Check                                                       | Fault injected                                                                                                    | Test                                                                                                  | Observed                                                                                                                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| a foreign key that is not the step's is thrown, not refused | the step re-read in `writingStep` bypassed (`rows.length > 0 && false`), so every foreign key reads as the step's | `estimate.db.test.ts` › `answers unknown_step for a step that has gone, and throws for anything else` | **Failed**: `Expected promise that rejects · Received promise that resolved` — an absent **work item** answered to the caller as an absent step |

| Command                                                                           | When       | Result                                           |
| --------------------------------------------------------------------------------- | ---------- | ------------------------------------------------ |
| `bun test` in `apps/be-01`                                                        | 2026-09-08 | **2009 pass, 1 skip, 0 fail**, 20,013 assertions |
| `bunx tsc --build --force apps/be-01/tsconfig.json`, `bunx eslint apps/be-01/src` | 2026-09-08 | clean                                            |

## Slice 3b — the event log, the store composition, and the history outside the batch

| Command                                             | When       | Result                                                 |
| --------------------------------------------------- | ---------- | ------------------------------------------------------ |
| `bun test` in `apps/be-01`                          | 2026-09-08 | **2008 pass, 1 skip, 0 fail**, 20,011 assertions, 115s |
| `bunx tsc --build --force apps/be-01/tsconfig.json` | 2026-09-08 | clean                                                  |
| `bunx eslint apps/be-01/src`                        | 2026-09-08 | clean                                                  |

## Slice 3 — the announcement collector

| Command                                             | When       | Result                                                 |
| --------------------------------------------------- | ---------- | ------------------------------------------------------ |
| `bun test` in `apps/be-01`                          | 2026-09-08 | **2006 pass, 1 skip, 0 fail**, 20,009 assertions, 114s |
| `bun run test:unit` (be-01 + every lib)             | 2026-09-08 | 7 tasks, all passing, 2.3s                             |
| `bunx nx run be-01:lint --skip-nx-cache`            | 2026-09-08 | clean                                                  |
| `bunx tsc --build --force apps/be-01/tsconfig.json` | 2026-09-08 | clean                                                  |

The window (l) is about needed building before it could be observed: the route has to be
suspended **between its store write and its own publish**, with the batch suspended mid-`applyAll`
so its hold is open across that publish. The first version of the case suspended inside the
_inner_ broadcaster — after the ownership decision — and passed with the ambient slot injected.
A case that samples the wrong side of the decision is a check that cannot fail.

## Slice 2 — the unit of work

| Command                                             | When       | Result                                                                       |
| --------------------------------------------------- | ---------- | ---------------------------------------------------------------------------- |
| `bunx tsc --build --force apps/be-01/tsconfig.json` | 2026-09-08 | clean                                                                        |
| `bun test` in `apps/be-01`                          | 2026-09-08 | **2002 pass, 1 skip, 0 fail**, 20,003 assertions, 116s (six kit cases added) |
| `bunx eslint apps/be-01/src`                        | 2026-09-08 | clean                                                                        |

Two failures found by the suite rather than by the compiler, both worth the record: the
`countingUnitOfWork` fixture's scope throws by name when something asks it for a store, and
`walk`'s first version reached for `scope.stores.journal` — so `answers 409 stale_undo naming
what moved` and `leaves an undo whose step has gone refusing as stale` both went **500**
instead of quietly writing somewhere nothing reads.

### One check that could not fail, deleted before it shipped

Case (i)'s first form asserted that no store had **written yet** two microtask turns into the
hold. Injected — one store built over `OPEN` — it stayed **green**: an ungated write is a few
microtasks late rather than synchronous, so the sample was taken before the fault could show
and the check was a statement about scheduling, not about admission. It is a survival
assertion now: the writes are started during the hold and read back after the batch has been
**refused**, so a store that took no turn wrote inside the rolled-back transaction and is
gone. That form failed on the injected fault at the line it names.
