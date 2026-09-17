# Verification

## Section 1 focused evidence

| Scope                              | Command                                                                                                                                                                                       | Result                                                                                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Uncached production batch baseline | `bun test libs/core/src/service/working-plan.test.ts`                                                                                                                                         | Pass: 1 test, 14 assertions. Covers create→estimate, estimate→child hand-down, dependency→delete survivor, directory cascade→patch, and distinct UnitOfWork-supplied store graphs. |
| Memory source contract             | `bun test libs/store-memory/src/testing/source-conformance.test.ts --test-name-pattern 'runs every offered existing case'`                                                                    | Pass: terminal certification, 1 test, 1,040 assertions.                                                                                                                            |
| SQLite source contract             | `bun test libs/store-sqlite/src/testing/source-conformance.db.test.ts --test-name-pattern 'SQLite terminal certification runs every exact offered case'`                                      | Pass: terminal certification, 1 test, 1,409 assertions.                                                                                                                            |
| SQLite malformed state             | `bun test libs/store-sqlite/src/targeted-readers.db.test.ts`                                                                                                                                  | Pass: broken step and malformed actual/progress/measure values all throw.                                                                                                          |
| Port and adapter types             | `NX_DAEMON=false bunx nx run-many -t typecheck -p core store-memory store-sqlite conformance --parallel=2 --output-style=stream`                                                              | Pass: 4 targets, 0 cache hits. Nx used its documented no-socket fallback in the sandbox.                                                                                           |
| Owning tests and types             | `NX_SOCKET_DIR=/tmp/nx-live-plan-section1 NX_DAEMON=false bunx nx run-many -t test typecheck -p core store-sqlite store-memory conformance --parallel=2 --output-style=stream`                | Pass: all 8 targets; SQLite 724 tests and 8,320 assertions.                                                                                                                        |
| Owning lint                        | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-section1 NX_DAEMON=false bunx nx run-many -t lint -p core store-sqlite store-memory conformance --parallel=2 --output-style=static` | Pass: all 4 targets.                                                                                                                                                               |
| Strict packet                      | `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate live-plan-snapshot --strict --json`                                                                                            | Pass: 1 item, 0 failed.                                                                                                                                                            |
| Changed-file format                | `bunx prettier --check <34 changed files>`                                                                                                                                                    | Pass: every matched file uses Prettier style.                                                                                                                                      |
| Diff whitespace                    | `git diff --check`                                                                                                                                                                            | Pass.                                                                                                                                                                              |

## R5 fault observations

| Check                            | Injected fault                                                                                                         | Observed failure                                                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Targeted labelled work-item read | Returned `tagIds: []` from memory `listByIds`.                                                                         | Memory terminal certification failed `workItems.listByIds:labels-scope`; expected `tag-a`, received an empty tag set.                                                  |
| Incident dependency read         | Removed the endpoint predicate from memory `listByWorkItems`.                                                          | Memory terminal certification failed `dependencies.listByWorkItems:incident-scope`; the missing-id read returned `edge-targeted`.                                      |
| Project isolation                | Removed the project predicate from memory `listByIds`.                                                                 | Memory terminal certification failed with `work-b-one` returned for project A; dependency endpoint validation also stopped rejecting the malformed cross-project edge. |
| Malformed SQLite values          | Replaced an estimate step reference and stored invalid actual, progress, and measure values with constraints disabled. | The targeted readers rejected the broken step, day value, state, and measure value. The test passed only when all four throws occurred.                                |

The source-level negatives above established the targeted-reader contracts. The production-path
label, edge and project-predicate variants are recorded below now that the patch slice can advance
loaded retained collections through those readers.

`bunx nx format:check --all` was unavailable as evidence: this stacked worktree's Nx wrapper
invoked the main checkout's Prettier as `prettier --list-different -- "."`, which exited 1 without
naming an unformatted file. The direct changed-file Prettier check above is green. The host gate
remains future final-section acceptance work under Task 3.3.

## Task 2.1 working-plan lifecycle

The runner creates a lazy WorkingPlan for every project batch and closes it in `finally`. During
this staged slice, command services still compose over the admitted `scope.stores`: Tasks 2.3–2.7
must first make every successful mutation advance retained collections, and Task 3.1 owns the
switch to `workingPlan.stores`. Directory batches, undo/redo, rollback repair, ordinary routes and
post-commit announcements therefore retain their established nonworking graphs.

| Scope                        | Command                                                                                                                               | Result                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Lifecycle and retained reads | `bun test libs/core/src/service/working-plan.test.ts`                                                                                 | Pass: 3 tests, 18 assertions.                        |
| Complete core suite          | `NX_DAEMON=false bunx nx run core:test --output-style=static`                                                                         | Pass: 426 tests, 1,493 assertions.                   |
| SQLite runner/coordinator    | `bun test libs/store-sqlite/src/write-coordinator.db.test.ts`                                                                         | Pass: 2 tests, 9 assertions.                         |
| Owning lint and typechecks   | `NX_DAEMON=false bunx nx run-many -t lint typecheck -p core store-memory store-sqlite conformance --parallel=2 --output-style=static` | Pass: all 8 targets.                                 |
| Accountless compile witness  | `libs/core/src/service/working-plan.types.test.ts`, compiled by `core:typecheck`                                                      | Pass: `stores.users` remains an expected type error. |
| Strict packet                | `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate live-plan-snapshot --strict --json`                                    | Pass: 1 item, 0 failed.                              |

### Task 2.1 R5 fault observation

| Check                       | Injected fault                                                                       | Observed failure                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Closed batch-owned callback | Disabled the `isClosed` branch in the retained read guard, then invoked the callback | `throws after its batch closes` failed: the promise resolved with the committed row instead of rejecting. |

## Task 2.2 detached before-images

The command regression composes one actual memory-source batch over its admitted WorkingPlan only
for this proof; production command composition remains on `scope.stores` until Task 3.1. Before the
first of two patches reads the row, the test mutates a previously returned retained answer. The two
patches name distinct names and tag sets, and one undo restores the database row from before the
batch. The direct retained-read case separately mutates all four label arrays and a nested external
reference, then verifies a second answer remains detached.

| Scope                         | Command                                                                                                                               | Result                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Exact before-image regression | `bun test libs/core/src/service/plan-commands.test.ts libs/core/src/service/working-plan.test.ts`                                     | Pass: 4 tests, 22 assertions.                                               |
| Owning tests                  | `NX_DAEMON=false bunx nx run-many -t test -p core store-memory store-sqlite conformance --parallel=2 --output-style=static`           | Pass: core 427, memory 95, SQLite 724 and conformance 33 tests; 0 failures. |
| Owning lint and typechecks    | `NX_DAEMON=false bunx nx run-many -t lint typecheck -p core store-memory store-sqlite conformance --parallel=2 --output-style=static` | Pass: all 8 targets.                                                        |
| Changed-file format           | `bunx prettier --check <Task 2.2 core and packet files>`                                                                              | Pass: every matched file uses Prettier style.                               |
| Diff whitespace               | `git diff --check`                                                                                                                    | Pass.                                                                       |
| Strict packet                 | `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate live-plan-snapshot --strict --json`                                    | Pass: 1 item, 0 failed.                                                     |

### Task 2.2 R5 fault observation

| Check                   | Injected fault                                           | Observed failure                                                                                                                             |
| ----------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Detached cached answers | Returned retained cache records directly without cloning | `two patches undo to the value before the batch` failed: undo restored `Mutated cached name` and the second tag instead of the original row. |

## Tasks 1.2 and 1.3 production refresh integration

A successful patch now refreshes every already-loaded retained collection for that work-item ID
through the authoritative targeted readers. Work-item and satellite rows must belong to the
requested project/identity set; dependency rows must belong to the project and touch at least one
requested endpoint. The runner proof mounts this partial working graph only for the patch scenario.
Task 3.1 still owns the general production switch after Tasks 2.3–2.7 complete every mutation's
affected-ID rules.

| Scope                       | Command                                                                                                                                                                                                             | Result                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Exact refresh regressions   | `bun test libs/core/src/use-cases/admission.test.ts libs/core/src/service/plan-commands.test.ts libs/core/src/service/working-plan.test.ts`                                                                         | Pass: 13 tests, 51 assertions. Includes modeled admission before any transactional mutation-port selection. |
| Memory source certification | `bun test libs/store-memory/src/testing/source-conformance.test.ts --test-name-pattern 'runs every offered existing case'`                                                                                          | Pass: terminal certification, 1 test, 1,040 assertions.                                                     |
| SQLite source certification | `bun test libs/store-sqlite/src/testing/source-conformance.db.test.ts --test-name-pattern 'SQLite terminal certification runs every exact offered case'`                                                            | Pass: terminal certification, 1 test, 1,409 assertions.                                                     |
| SQLite malformed state      | `bun test libs/store-sqlite/src/targeted-readers.db.test.ts`                                                                                                                                                        | Pass: 1 test, 4 assertions.                                                                                 |
| Owning tests                | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-next NX_DAEMON=false bunx nx run-many -t test -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache`           | Pass: all 4 targets; core 488, memory 107, SQLite 736 and conformance 33 tests; 0 failures.                 |
| Owning lint and typechecks  | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-next NX_DAEMON=false bunx nx run-many -t lint typecheck -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache` | Pass: all 8 targets, 0 cache hits.                                                                          |
| Strict packet               | `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate live-plan-snapshot --strict --json`                                                                                                                  | Pass: 1 item, 0 failed.                                                                                     |
| All OpenSpec changes        | `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json`                                                                                                                                        | Pass: 83 items, 0 failed.                                                                                   |
| Changed-file format         | `bunx prettier --check <Tasks 1.2/1.3 core and packet files>`                                                                                                                                                       | Pass after formatting the final evidence update.                                                            |
| Diff whitespace             | `git diff --check`                                                                                                                                                                                                  | Pass.                                                                                                       |

### Tasks 1.2 and 1.3 R5 fault observations

| Check                          | Injected fault                                                               | Observed failure                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Labelled targeted refresh      | Returned `tagIds: []` from the memory source's targeted `listByIds`.         | Production runner expected the first and second exact tag IDs between patches and received `[[], []]`.               |
| Incident dependency validation | Removed the refresh boundary's requested-endpoint predicate.                 | The unrelated-edge phase resolved instead of rejecting.                                                              |
| Project validation             | Removed the refresh boundary's work-item project predicate.                  | The cross-project-work-item phase resolved instead of rejecting.                                                     |
| Requested work-item identity   | Removed the refresh boundary's requested-ID predicate.                       | The unrequested-row phase resolved instead of rejecting.                                                             |
| Satellite identity             | Replaced the shared unrequested-satellite throw with a return.               | The unrequested-estimate phase resolved instead of rejecting.                                                        |
| Dependency project             | Removed the refresh boundary's dependency project predicate.                 | The cross-project-edge phase resolved instead of rejecting.                                                          |
| Lazy mutation-port selection   | Passed `scope.stores.workItems` eagerly while constructing the working plan. | The absent-account admission test threw `something asked it for workItems` instead of returning modeled `forbidden`. |

## Publication checkpoint integration

Fetched `origin/main` at `9b13f98e62a7cd880977e348421e992e8c4951a3` and merged it into
`change/live-plan-snapshot` as `9458956029dc336c1213f40c658c84b5d8d5cde6`. The merge completed
without conflicts. Main's status-command, zero-step scheduler and host-image changes remain present;
the live snapshot reader groundwork and Tasks 1.1, 2.1 and 2.2 remain present. At that checkpoint,
Tasks 1.2, 1.3 and 2.3 onward remained open.

| Scope                       | Command                                                                                                                                                  | Result                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Complete integrated core    | `NX_DAEMON=false bunx nx run core:test --output-style=static`                                                                                            | Pass: 428 tests, 1,503 assertions. |
| Memory source certification | `bun test libs/store-memory/src/testing/source-conformance.test.ts --test-name-pattern 'runs every offered existing case'`                               | Pass: 1 test, 1,040 assertions.    |
| SQLite source certification | `bun test libs/store-sqlite/src/testing/source-conformance.db.test.ts --test-name-pattern 'SQLite terminal certification runs every exact offered case'` | Pass: 1 test, 1,409 assertions.    |
| SQLite malformed state      | `bun test libs/store-sqlite/src/targeted-readers.db.test.ts`                                                                                             | Pass: 1 test, 4 assertions.        |
| Conformance framework       | `NX_DAEMON=false bunx nx run conformance:test --output-style=static`                                                                                     | Pass: 33 tests, 58 assertions.     |
| Owning lint and typechecks  | `NX_DAEMON=false bunx nx run-many -t lint typecheck -p core store-memory store-sqlite conformance --parallel=2 --output-style=static`                    | Pass: all 8 targets.               |

## Astra P2 ordering and memory trusted-state follow-up

The targeted work-item reader now preserves its full reader's authoritative order. A loaded
WorkingPlan replaces refreshed groups at their retained positions and replaces incident dependency
identities in place, so unrelated interleavings remain untouched. The memory satellite readers
share one admission boundary: it resolves requested stored work items, filters valid foreign-project
owners, reads and validates project steps once, then validates the admitted family-specific values
before ordering.

| Scope                       | Command                                                                                                                                                                                                               | Result                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Memory malformed state      | `bun test libs/store-memory/src/targeted-readers.test.ts`                                                                                                                                                             | Pass: 5 tests, 24 assertions across estimate, actual, progress and measure targeted readers.          |
| Exact WorkingPlan order     | `bun test libs/core/src/service/working-plan.test.ts --test-name-pattern 'preserves the admitted work-item order\|preserves unrelated dependency interleaving'`                                                       | Pass: 2 tests, 4 assertions; retained rows and dependencies equal the current admitted source arrays. |
| Focused core paths          | `bun test libs/core/src/use-cases/admission.test.ts libs/core/src/service/plan-commands.test.ts libs/core/src/service/working-plan.test.ts`                                                                           | Pass: 15 tests, 55 assertions.                                                                        |
| Memory source certification | `bun test libs/store-memory/src/testing/source-conformance.test.ts --test-name-pattern 'runs every offered existing case'`                                                                                            | Pass: terminal certification, 1 test, 1,041 assertions.                                               |
| SQLite source certification | `bun test libs/store-sqlite/src/testing/source-conformance.db.test.ts --test-name-pattern 'SQLite terminal certification runs every exact offered case'`                                                              | Pass: terminal certification, 1 test, 1,410 assertions.                                               |
| SQLite malformed state      | `bun test libs/store-sqlite/src/targeted-readers.db.test.ts`                                                                                                                                                          | Pass: 1 test, 4 assertions.                                                                           |
| Owning tests                | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-review NX_DAEMON=false bunx nx run-many -t test -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache`           | Pass: all 4 targets; memory rerun 112 tests, SQLite 736 tests and conformance 33 tests; 0 failures.   |
| Owning lint and typechecks  | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-review NX_DAEMON=false bunx nx run-many -t lint typecheck -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache` | Pass: all 8 targets, 0 cache hits.                                                                    |
| Strict packet               | `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate live-plan-snapshot --strict --json`                                                                                                                    | Pass: 1 item, 0 failed.                                                                               |
| All OpenSpec changes        | `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json`                                                                                                                                          | Pass: 83 items, 0 failed.                                                                             |
| Workspace format            | `GSETTINGS_BACKEND=memory NX_DAEMON=false bunx nx format:check --all`                                                                                                                                                 | Pass.                                                                                                 |
| Diff whitespace             | `git diff --check`                                                                                                                                                                                                    | Pass.                                                                                                 |

### Astra P2 R5 fault observations

| Check                             | Injected fault                                                                | Observed failure                                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Authoritative targeted order      | Kept the memory reader's old ID sort.                                         | Memory certification failed: targeted `a,b,c,z` differed from the full reader's filtered `z,a,b,c`.                            |
| Retained work-item order          | Kept the old group-and-sort replacement.                                      | The production WorkingPlan regression received `a,b,c,z` instead of admitted `z,a,b,c`.                                        |
| Unrelated dependency interleaving | Kept the old remove-all-and-splice-at-first-incident replacement.             | The production WorkingPlan regression received `e1,e3,e2` instead of admitted `e1,e2,e3`.                                      |
| Memory satellite reference checks | Kept the old `listByIds` membership filter and absent-step position fallback. | All four regressions failed: missing/cross-project work items and cross-project steps resolved instead of rejecting.           |
| Memory satellite value checks     | Kept the old unvalidated stored rows.                                         | The estimate, actual, progress and measure regression failed because malformed values/times resolved instead of named rejects. |

## Astra P2 foreign-project parity repair

Each shared satellite case stores a valid project-B row, targets its work-item ID while asking for
project A, and compares the complete targeted answer with the project-A full answer filtered to
that ID. Both adapters return `[]`. The memory boundary still throws for a missing work-item owner
before filtering; after filtering, every admitted row must reference a project-A step and carry
valid family-specific values.

SQLite corruption tests now distinguish states the reader must reject from states ordinary schema
enforcement prevents. Foreign keys were disabled for every corruption injection so each update
could exercise the reader boundary; reference proofs depend on that setting, while representable
dynamic values do not. `ignore_check_constraints` was enabled only to prove the progress-state and
measure-metric reader defenses. Separate attempts with constraints active reported the exact stored
constraint names; binding `NaN` became `NULL` and hit the estimate column's `NOT NULL`.

| Scope                       | Command                                                                                                                                                                                                               | Result                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Memory targeted corruption  | `bun test libs/store-memory/src/targeted-readers.test.ts`                                                                                                                                                             | Pass: 5 tests, 24 assertions.                                                               |
| SQLite corruption matrix    | `bun test libs/store-sqlite/src/targeted-readers.db.test.ts`                                                                                                                                                          | Pass: 7 tests, 24 assertions.                                                               |
| Memory source certification | `bun test libs/store-memory/src/testing/source-conformance.test.ts --test-name-pattern 'runs every offered existing case'`                                                                                            | Pass: terminal certification, 1 test, 1,045 assertions.                                     |
| SQLite source certification | `bun test libs/store-sqlite/src/testing/source-conformance.db.test.ts --test-name-pattern 'SQLite terminal certification runs every exact offered case'`                                                              | Pass: terminal certification, 1 test, 1,414 assertions.                                     |
| Focused core paths          | `bun test libs/core/src/use-cases/admission.test.ts libs/core/src/service/plan-commands.test.ts libs/core/src/service/working-plan.test.ts`                                                                           | Pass: 15 tests, 55 assertions.                                                              |
| Owning lint and typechecks  | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-repair NX_DAEMON=false bunx nx run-many -t lint typecheck -p conformance store-memory store-sqlite core --parallel=2 --output-style=static --skip-nx-cache` | Pass: all 8 targets, 0 cache hits.                                                          |
| Owning tests                | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-repair NX_DAEMON=false bunx nx run-many -t test -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache`           | Pass: all 4 targets; core 490/1,617, memory 112/5,199, SQLite 742/8,416, conformance 33/58. |
| Strict and all OpenSpec     | `bunx @fission-ai/openspec@1.3.0 validate live-plan-snapshot --strict --json` and `bunx @fission-ai/openspec@1.3.0 validate --all --json`                                                                             | Pass: change 1/1; repository 83/83 (72 changes and 11 specs).                               |
| Format and whitespace       | `GSETTINGS_BACKEND=memory NX_DAEMON=false bunx nx format:check --all` and `git diff --check`                                                                                                                          | Pass.                                                                                       |

### Foreign-project parity R5 fault observation

| Check                             | Injected fault                                                 | Observed failure                                                                                                                                                                                                                                |
| --------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Valid foreign satellite filtering | Validated ownership before filtering the requested stored rows | Memory certification failed all four shared `listByWorkItems:scope-order` cases: estimate, actual, progress and measure each threw `<family> work-b-one/step-b-dev is outside project project-a` instead of matching filtered full-reader `[]`. |

### SQLite constraint evidence

| Attempt with constraints active       | Exact refusal                                     |
| ------------------------------------- | ------------------------------------------------- |
| Store progress state `broken`         | `CHECK constraint failed: role_progress_state`    |
| Store measure metric `broken`         | `CHECK constraint failed: role_measure_metric`    |
| Bind `NaN` into `estimate.optimistic` | `NOT NULL constraint failed: estimate.optimistic` |

## Astra SQLite targeted-order repair

All four shared satellite cases now seed valid `work-A` and `work-a` owners. Their complete targeted
answers must equal the SQLite-BINARY or memory-admitted full answer filtered to those IDs. SQLite's
targeted statements carry the same `ORDER BY` expressions as their full readers; no JavaScript
locale collation can reinterpret the stored order. A SQLite-backed WorkingPlan regression gives
`step-A` and `step-a` the same position, loads all four collections, patches their work item, and
compares every retained collection with its current full source read.

| Scope                          | Command                                                                                                                                                                                                              | Result                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Targeted and WorkingPlan paths | `bun test libs/store-sqlite/src/working-plan-order.db.test.ts libs/store-sqlite/src/targeted-readers.db.test.ts`                                                                                                     | Pass: 8 tests, 29 assertions.                                                |
| Memory source certification    | `bun test libs/store-memory/src/testing/source-conformance.test.ts --test-name-pattern 'runs every offered existing case'`                                                                                           | Pass: 1 test, 1,049 assertions.                                              |
| SQLite source certification    | `bun test libs/store-sqlite/src/testing/source-conformance.db.test.ts --test-name-pattern 'SQLite terminal certification runs every exact offered case'`                                                             | Pass: 1 test, 1,418 assertions.                                              |
| Owning lint and typechecks     | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-order NX_DAEMON=false bunx nx run-many -t lint typecheck -p conformance store-memory store-sqlite core --parallel=2 --output-style=static --skip-nx-cache` | Pass: all 8 targets, no cache.                                               |
| Owning tests                   | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-order NX_DAEMON=false bunx nx run-many -t test -p core store-memory store-sqlite conformance --parallel=2 --output-style=static --skip-nx-cache`           | Pass: core 490/1,617; memory 112/5,203; SQLite 743/8,425; conformance 33/58. |
| Strict and all OpenSpec        | `bunx @fission-ai/openspec@1.3.0 validate live-plan-snapshot --strict --json` and `bunx @fission-ai/openspec@1.3.0 validate --all --json`                                                                            | Pass: change 1/1; repository 83/83.                                          |
| Format and whitespace          | `GSETTINGS_BACKEND=memory NX_DAEMON=false bunx nx format:check --all` and `git diff --check`                                                                                                                         | Pass.                                                                        |

### SQLite targeted-order R5 fault observations

| Check                      | Injected fault                            | Observed failure                                                                                                                                                  |
| -------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mixed-case owner parity    | Kept the four `localeCompare` post-sorts. | SQLite certification failed estimate, actual, progress and measure scope-order cases because targeted `work-a,work-A` disagreed with full-reader `work-A,work-a`. |
| WorkingPlan retained order | Kept the four `localeCompare` post-sorts. | The SQLite WorkingPlan regression failed first on estimates: retained `step-a,step-A` disagreed with the current full source's `step-A,step-a`.                   |

## Task 2.3 work-item row refreshes

The working row store refreshes the inserted/moved/removed identities, their affected parents and
every explicit respace or promotion before returning. Frozen-number writes refresh every update.
A refused patch does not consult the targeted reader or advance the retained collection. The
`listByIds` port JSDoc now names its actual ordering contract: the authoritative full-project
reader's order, rather than id order.

| Scope                     | Command                                                                                                                                                                       | Result                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Focused pre-change RED    | `bun test libs/core/src/service/plan-commands.test.ts --test-name-pattern 'working plan row mutations through runner commands'`                                               | Expected RED: 1 passed and 4 failed; insert/freeze assertions failed and move/promote placement threw.              |
| Exact respace fault       | Same focused file filtered to `refreshes an inserted row and every densely respaced sibling`, with only `respaced` ids omitted from insert refresh                            | Expected RED: 0 passed, 1 failed; second placement produced `A@10,Y@20,B@30,X@40` instead of `A@10,Y@15,X@20,B@30`. |
| Exact refused-patch fault | Same focused file filtered to `does not advance a retained row after a refused patch`, with patch refresh forced after `{ ok: false }`                                        | Expected RED: 0 passed, 1 failed; next within-batch read saw `Invented after refusal` instead of the stored name.   |
| Restored focused GREEN    | `bun test libs/core/src/service/plan-commands.test.ts libs/core/src/service/working-plan.test.ts`                                                                             | Pass: 14 tests, 46 assertions.                                                                                      |
| Complete core suite       | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-rows NX_DAEMON=false bunx nx run core:test --output-style=static --skip-nx-cache`                                   | Pass: 495 tests, 1,628 assertions; cache skipped.                                                                   |
| Core lint and typecheck   | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-rows NX_DAEMON=false bunx nx run-many -t lint typecheck -p core --parallel=2 --output-style=static --skip-nx-cache` | Pass: both targets; cache skipped.                                                                                  |
| Strict OpenSpec packet    | `OPENSPEC_TELEMETRY=0 bun x @fission-ai/openspec@1.3.0 validate live-plan-snapshot --strict --json`                                                                           | Pass: 1 item, 0 failed.                                                                                             |
| All OpenSpec artifacts    | `OPENSPEC_TELEMETRY=0 bun x @fission-ai/openspec@1.3.0 validate --all --json`                                                                                                 | Pass: 83 items, 0 failed (72 changes and 11 specs).                                                                 |
| Workspace format          | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-format NX_DAEMON=false bunx nx format:check --all`                                                                  | Pass.                                                                                                               |
| Diff whitespace           | `git diff --check`                                                                                                                                                            | Pass.                                                                                                               |

### Task 2.3 R5 fault observations

| Check                     | Injected fault                                            | Observed failure                                                                                          |
| ------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Dense sibling advancement | Omitted only insert's `respaced` ids from `refreshRows`.  | The later runner command placed Y from stale positions and moved X behind B.                              |
| Refused patch stability   | Called `refreshRows([id])` after a modeled patch refusal. | The instrumented next read inside the runner batch returned the targeted reader's invented advanced name. |

## Astra Task 2.3 bounded authoritative placement repair

`listByIds` now hydrates only the affected identities. New rows use the adapter's identity-only
`listPlacements` answer: the requested row plus its immediate predecessor in the full-reader order.
SQLite computes that predecessor under its BINARY id ordering; memory walks its insertion-ordered
map. Existing rows keep their retained slot, so ordinary patches issue no placement read.

| Scope                       | Command                                                                                                                                                                                                                                                                         | Result                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Cardinality RED             | `GSETTINGS_BACKEND=memory bun test libs/core/src/service/working-plan.test.ts --test-name-pattern 'hydrates only the affected identity after a single-row patch'` before the repair                                                                                             | Expected RED: 0 passed, 1 failed; the observed patch requested and returned 200 labelled rows instead of 1.                               |
| Placement source RED        | Memory terminal source certification with its new adapter method returning `[]`                                                                                                                                                                                                 | Expected RED: `workItems.listPlacements:source-order` expected the two requested identities and their source predecessors, received `[]`. |
| Focused GREEN               | `GSETTINGS_BACKEND=memory bun test libs/core/src/service/plan-commands.test.ts libs/core/src/service/working-plan.test.ts libs/store-sqlite/src/working-plan-order.db.test.ts libs/store-sqlite/src/targeted-readers.db.test.ts libs/store-memory/src/targeted-readers.test.ts` | Pass: 29 tests, 108 assertions. Each of three patches over 200 retained rows requested and returned exactly one labelled row.             |
| Memory source certification | `GSETTINGS_BACKEND=memory bun test libs/store-memory/src/testing/source-conformance.test.ts --test-name-pattern 'runs every offered existing case'`                                                                                                                             | Pass: terminal certification, 1 test, 1,060 assertions.                                                                                   |
| SQLite source certification | `GSETTINGS_BACKEND=memory bun test libs/store-sqlite/src/testing/source-conformance.db.test.ts --test-name-pattern 'SQLite terminal certification runs every exact offered case'`                                                                                               | Pass: terminal certification, 1 test, 1,433 assertions.                                                                                   |
| Owning tests                | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-bounded-tests NX_DAEMON=false bunx nx run-many -t test -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache`                                                              | Pass: all 4 targets; core 496/1,634, memory 112/5,214, SQLite 744/8,443, conformance 33/58; cache skipped.                                |
| Owning lint and typechecks  | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-bounded-checks NX_DAEMON=false bunx nx run-many -t lint typecheck -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache`                                                   | Pass: all 8 targets; cache skipped.                                                                                                       |
| Strict and all OpenSpec     | `OPENSPEC_TELEMETRY=0 bun x @fission-ai/openspec@1.3.0 validate live-plan-snapshot --strict --json` and `OPENSPEC_TELEMETRY=0 bun x @fission-ai/openspec@1.3.0 validate --all --json`                                                                                           | Pass: change 1/1; repository 83/83 (72 changes and 11 specs).                                                                             |
| Workspace format/whitespace | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-bounded-format-check NX_DAEMON=false bunx nx format:check --all` and `git diff --check`                                                                                                                               | Pass.                                                                                                                                     |

### Bounded row refresh R5 fault observations

| Check                          | Injected fault                                                                     | Observed failure                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Affected hydration cardinality | Kept `replaceAllInSourceOrder`, which expanded one patched id to all retained ids. | The 200-row production WorkingPlan patch recorded `{ requested: 200, returned: 200 }` instead of `{ requested: 1, returned: 1 }`. |
| Dense sibling advancement      | Omitted only insert's `respaced` ids from affected hydration.                      | The later runner command produced `A@10,Y@20,B@30,X@40` instead of `A@10,Y@15,X@20,B@30`.                                         |
| Refused patch stability        | Forced affected hydration after `{ ok: false }`.                                   | The next production-path read returned `Invented after refusal` instead of `Authoritative before refusal`.                        |

### Superseded: Astra Task 2.3 inserted-row order repair

This section records the earlier all-retained hydration implementation. It was superseded by
"Astra Task 2.3 bounded authoritative placement repair" above: the current implementation hydrates
only affected identities and asks `listPlacements` only for genuinely new retained rows. The table
below remains historical evidence for the ordering defect that prompted the replacement.

| Scope                       | Command                                                                                                                                                                                                                         | Result                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Current-implementation RED  | `GSETTINGS_BACKEND=memory bun test libs/store-sqlite/src/working-plan-order.db.test.ts`                                                                                                                                         | Expected RED: 1 passed, 1 failed; retained `z-existing,a-inserted` differed from source `a-inserted,z-existing`. |
| Focused GREEN               | `GSETTINGS_BACKEND=memory bun test libs/core/src/service/plan-commands.test.ts libs/core/src/service/working-plan.test.ts libs/store-sqlite/src/working-plan-order.db.test.ts`                                                  | Pass: 16 tests, 54 assertions.                                                                                   |
| Owning tests                | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-order-fix-tests NX_DAEMON=false bunx nx run-many -t test -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache`            | Pass: all 4 targets; core 495/1,628 and SQLite 744/8,428; cache skipped.                                         |
| Owning lint and typechecks  | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-order-fix-checks NX_DAEMON=false bunx nx run-many -t lint typecheck -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache` | Pass: all 8 targets; cache skipped.                                                                              |
| Strict and all OpenSpec     | `OPENSPEC_TELEMETRY=0 bun x @fission-ai/openspec@1.3.0 validate live-plan-snapshot --strict --json` and `OPENSPEC_TELEMETRY=0 bun x @fission-ai/openspec@1.3.0 validate --all --json`                                           | Pass: change 1/1; repository 83/83 (72 changes and 11 specs).                                                    |
| Workspace format/whitespace | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-order-fix-format NX_DAEMON=false bunx nx format:check --all` and `git diff --check`                                                                                   | Pass.                                                                                                            |

## Astra Task 2.3 final row-refresh hardening

SQLite `listPlacements` now keeps the requested project filter and ascending requested-row order,
while each requested row's predecessor is found by a correlated `(project_id, id)` descending seek
with `id < current`, `ORDER BY id DESC LIMIT 1`. Ordinary retained-row patches stop before the
placement source boundary because they introduce no new retained identity. Placement answers are
validated completely before the retained array changes, and every malformed-source failure escapes
the admitted unit of work so its preceding write rolls back.

| Scope                    | Command                                                                                                                                                                                                                          | Result                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| SQLite cost/shape RED    | Focused `targeted-readers.db.test.ts` test against the production self-join/`MAX` query on a 10,000-row project                                                                                                                  | Expected RED: returned the right predecessor, but `EXPLAIN` contained `AggStep` and the prefix loop's `Next`.                              |
| Empty-placement-call RED | `bun test libs/core/src/service/working-plan.test.ts --test-name-pattern 'hydrates only the affected identity'` before the short circuit                                                                                         | Expected RED: three 200-row patches made 3 placement calls; expected 0.                                                                    |
| Placement validation RED | `bun test libs/core/src/service/plan-commands.test.ts --test-name-pattern 'working plan placement validation'` before the distinct predecessor/duplicate guards                                                                  | Expected RED: 4 passed, 3 failed; duplicate was reported as unexpected, malformed predecessor as missing, and self-predecessor as missing. |
| Focused GREEN            | `GSETTINGS_BACKEND=memory bun test libs/core/src/service/plan-commands.test.ts libs/core/src/service/working-plan.test.ts libs/store-sqlite/src/targeted-readers.db.test.ts libs/store-sqlite/src/working-plan-order.db.test.ts` | Pass: 32 tests, 109 assertions. SQLite bytecode has `SeekLT` and `DecrJumpZero`, no `AggStep`; all seven rollback cases pass.              |
| Owning tests             | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-final-tests-2 NX_DAEMON=false bunx nx run-many -t test -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache`               | Pass: all 4 targets; core 503/1,655 and SQLite 745/8,447; cache skipped.                                                                   |
| Lint and typecheck       | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-final-checks-2 NX_DAEMON=false bunx nx run-many -t lint typecheck -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache`    | Pass: all 8 targets; cache skipped.                                                                                                        |
| Strict and all OpenSpec  | `OPENSPEC_TELEMETRY=0 bun x @fission-ai/openspec@1.3.0 validate live-plan-snapshot --strict --json` and `OPENSPEC_TELEMETRY=0 bun x @fission-ai/openspec@1.3.0 validate --all --json`                                            | Pass: change 1/1; repository 83/83 (72 changes and 11 specs).                                                                              |

### Final row-refresh R5 fault observations

| Check                                  | Injected fault                                 | Observed failure                                                                                                             |
| -------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Bounded SQLite predecessor             | Restored the production self-join/`MAX` query. | The 10,000-row regression found `AggStep` plus `Next`, proving the aggregate prefix scan.                                    |
| Zero placement calls for patches       | Kept the unconditional `loadPlacements([])`.   | Three ordinary patches over 200 retained rows made three placement-source calls instead of zero.                             |
| Omitted placement                      | Removed the omitted-placement guard.           | Durable IDs were `[anchor, generated-id]` instead of `[anchor]`.                                                             |
| Unexpected placement identity          | Removed the expected-identity guard.           | The production runner reported the later `omitted work item unexpected` error instead of rejecting at the violated boundary. |
| Duplicate placement identity           | Removed the duplicate-identity guard.          | Durable IDs were `[anchor, generated-id]` instead of `[anchor]`.                                                             |
| Missing predecessor                    | Removed the predecessor-presence guard.        | Durable IDs were `[anchor, generated-id]` instead of `[anchor]`.                                                             |
| Malformed predecessor                  | Removed the runtime predecessor-shape guard.   | Numeric predecessor `42` reached the later missing-predecessor branch.                                                       |
| Self predecessor                       | Removed the self-predecessor guard.            | The row reached the later missing-predecessor branch with its own identity.                                                  |
| New identity without authorized insert | Removed the authorized-insertion guard.        | The moved row's durable `parentId` became `null` instead of rolling back to `old-parent`.                                    |

Every placement-validation case runs through `PlanCommandRunner`, injects its broken source inside
the supplied `UnitOfWork` scope, and checks the durable source after rejection. Simultaneous
multiple-new-ID refresh is not applicable to Task 2.3's production path: the only wrapper that
supplies `insertedIds` is `WorkItemStore.insert`, and it supplies exactly its one inserted identity.
The future subtree wrapper in Task 2.6 is the first matrix row that can authorize multiple new IDs,
so no non-production helper-only claim was added here.

## Task 2.4 value refresh wrappers

`working-plan-values.ts` now persists each value mutation before refreshing retained identities.
Set refreshes only after `written`; remove refreshes its work item; `moveAll` refreshes both source
and destination before returning. The same wrapper serves estimates, actuals, progress and measures,
including every measure metric. The memory source now mirrors SQLite's work-item foreign-key cascade
for these four satellite tables, so its successful remove boundary cannot expose orphaned values.

| Scope                      | Command                                                                                                                                                                                                                          | Result                                                                                                                                                                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused RED                | `GSETTINGS_BACKEND=memory bun test libs/core/src/service/plan-commands.test.ts --test-name-pattern 'working plan value mutations'` before the wrapper                                                                            | Expected RED: 1 passed, 3 failed. The same-command move observation retained `estimates`, `actuals`, `progress`, and `measures` at the source; remove retained all four collections and all three measure keys; delete-last-child reached the memory adapter's orphaned estimate. |
| Focused GREEN              | `GSETTINGS_BACKEND=memory bun test libs/core/src/service/plan-commands.test.ts libs/core/src/service/working-plan.test.ts --test-name-pattern 'working plan value\|retained value'`                                              | Pass: 6 tests, 27 assertions.                                                                                                                                                                                                                                                     |
| Owning tests               | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-values-tests NX_DAEMON=false bunx nx run-many -t test -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache`                | Pass: all 4 targets; core 509 tests/1,682 assertions and SQLite 745 tests/8,447 assertions; cache skipped.                                                                                                                                                                        |
| Owning lint and typechecks | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-values-checks-all NX_DAEMON=false bunx nx run-many -t lint typecheck -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache` | Pass: all 8 targets; cache skipped.                                                                                                                                                                                                                                               |
| Strict OpenSpec packet     | `OPENSPEC_TELEMETRY=0 bun x @fission-ai/openspec@1.3.0 validate live-plan-snapshot --strict --json`                                                                                                                              | Pass: 1 item, 0 failed.                                                                                                                                                                                                                                                           |
| All OpenSpec artifacts     | `OPENSPEC_TELEMETRY=0 bun x @fission-ai/openspec@1.3.0 validate --all --json`                                                                                                                                                    | Pass: 83 items, 0 failed (72 changes and 11 specs).                                                                                                                                                                                                                               |
| Workspace format           | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-values-format-final-4 NX_DAEMON=false bunx nx format:check --all`                                                                                                      | Pass.                                                                                                                                                                                                                                                                             |
| Diff whitespace            | `git diff --check`                                                                                                                                                                                                               | Pass.                                                                                                                                                                                                                                                                             |

### Task 2.4 R5 fault observations

| Check                     | Injected fault                                                                               | Observed failure                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same-command move source  | Refreshed only `moveAll`'s destination (`refreshRows([toWorkItemId])`), omitting its source. | The production runner's same-command post-`moveAll` read returned `staleSources = ["estimates", "actuals", "progress", "measures"]` before another store call. |
| Successful remove         | Delegated `remove` without refreshing its work item.                                         | The production runner's same-method reads retained estimates, actuals, progress and each of the three measure keys.                                            |
| Modeled refusal stability | Refreshed an estimate after the source returned `unknown_step`.                              | The retained optimistic value became the targeted reader's injected `99` instead of remaining `1`.                                                             |
| Thrown write stability    | Refreshed an actual before its source removal, which then threw.                             | The retained actual became the targeted reader's injected `99` instead of remaining `2`.                                                                       |
| Memory remove parity      | Omitted the memory source's four satellite cascades.                                         | The production runner's delete-last-child hand-up rejected at the next targeted read with `targeted estimate has an invalid work-item reference`.              |

The be-01 suite was not run because Task 2.4 touched no be-01 file or composition boundary. The
h2puni gate was explicitly out of scope for this slice.

## Astra Task 2.4 authoritative value-group placement repair

Each value port now provides an identity-only populated-group placement read. Retained groups keep
their existing slots; placement is consulted only when targeted hydration introduces a group that
is not currently retained. The same generic validated placement machinery serves work-item rows
and grouped estimate, actual, progress, and measure rows. SQLite uses one correlated descending
seek per requested populated group; memory derives the satellite collection's lexical group order
instead of borrowing its insertion-ordered work-item reader.

| Scope                           | Command                                                                                                                                                                                                                              | Result                                                                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production ordering RED         | `GSETTINGS_BACKEND=memory bun test libs/store-sqlite/src/working-plan-order.db.test.ts --test-name-pattern 'value group'` before value placement                                                                                     | Expected RED: retained groups began `z-existing,a-earlier` while every authoritative source began `a-earlier,z-existing`; all three retained measure metrics for `z-existing` likewise preceded the three for `a-earlier`. |
| Source inventory RED            | `GSETTINGS_BACKEND=memory bun test libs/conformance/src/stores/existing.test.ts` after registering the four source cases                                                                                                             | Expected RED: the exact inventory received the four new `*.listPlacements:source-order` cases before its independent list was updated.                                                                                     |
| SQLite seek-shape RED           | `GSETTINGS_BACKEND=memory bun test libs/store-sqlite/src/targeted-readers.db.test.ts --test-name-pattern 'populated predecessor'` against the first join-shaped predecessor query                                                    | Expected RED: the bytecode had `SeekGT`, `Next`, and `Sort`, but no `SeekLT`; the query walked the populated prefix instead of seeking backward.                                                                           |
| Focused GREEN                   | `GSETTINGS_BACKEND=memory bun test libs/core/src/service/plan-commands.test.ts libs/core/src/service/working-plan.test.ts libs/store-sqlite/src/targeted-readers.db.test.ts libs/store-sqlite/src/working-plan-order.db.test.ts`     | Pass: 45 tests, 181 assertions.                                                                                                                                                                                            |
| Owning tests                    | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-values-order-tests NX_DAEMON=false bunx nx run-many -t test -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache`              | Pass: all 4 targets; core 514 tests/1,702 assertions and SQLite 747 tests/8,532 assertions; cache skipped.                                                                                                                 |
| Owning lint and typechecks      | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-values-order-checks-2 NX_DAEMON=false bunx nx run-many -t lint typecheck -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache` | Pass: all 8 targets; cache skipped.                                                                                                                                                                                        |
| Strict and all OpenSpec         | `OPENSPEC_TELEMETRY=0 bun x @fission-ai/openspec@1.3.0 validate live-plan-snapshot --strict --json` and `OPENSPEC_TELEMETRY=0 bun x @fission-ai/openspec@1.3.0 validate --all --json`                                                | Pass: change 1/1; repository 83/83 (72 changes and 11 specs).                                                                                                                                                              |
| Workspace format and whitespace | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-values-order-format-final NX_DAEMON=false bunx nx format:check --all` and `git diff --check`                                                                               | Pass.                                                                                                                                                                                                                      |

### Astra Task 2.4 R5 fault observations

| Check                         | Injected fault                                                                                                      | Observed failure                                                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact source endpoint refresh | Changed only `moveAll` refresh to `refreshRows([toWorkItemId])`, retaining destination refresh and omitting source. | The production same-command assertion received `staleSources = ["estimates", "actuals", "progress", "measures"]` instead of `[]`; no later command or barrier ran first.                                                          |
| Omitted value placement       | Removed the shared omitted-placement guard while the estimate adapter returned `[]` for a newly populated group.    | The production runner promise resolved instead of rejecting; its rollback assertion could no longer run. Restoring the guard makes all four adapter-specific omitted-placement cases reject and retain only `z-existing` durably. |
| Bounded SQLite predecessor    | Used the first join-shaped predecessor query over 10,000 populated groups.                                          | `EXPLAIN` lacked `SeekLT` and contained prefix-loop `Next` plus `Sort`; the correlated `EXISTS` form now has `SeekLT` and `DecrJumpZero`, with no `AggStep`.                                                                      |

The memory set regression observes new-group insertion and empty-group reinsertion across all four
families, while its move regression observes a destination before one unaffected populated group.
The SQLite set regression observes the same insertion and reinsertion cases. At this point the
SQLite move witness had no unaffected populated group, so it proved source removal and destination
hydration but not the destination's placement relative to retained groups. Every measure witness
carries all three metrics. No value refresh expands targeted hydration beyond its affected IDs.

## Astra Task 2.4 final mixed-case and moveAll ordering repair

Memory value placement now uses the same exported `localeCompare` group comparator as all four
authoritative memory full readers. A production `PlanCommandRunner` regression seeds every family
and all three measure metrics for `a`, loads the retained collections, then populates `A`; the
retained arrays equal the authoritative arrays exactly in `a,A` group order. The SQLite runner's
`moveAll` witness now retains a populated `m-unaffected` group while moving `z-existing` to
`a-inserted`, and compares every complete retained array with its source before checking the exact
group sequence.

| Scope                      | Command                                                                                                                                                                                                                          | Result                                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mixed-case RED             | `GSETTINGS_BACKEND=memory bun test libs/core/src/service/plan-commands.test.ts --test-name-pattern 'mixed-case memory value groups'` before the comparator repair                                                                | Expected RED: retained `A,a`; authoritative estimates, actuals and progress returned `a,A`, and measures returned three `a` rows before three `A` rows.                |
| SQLite placement fault RED | Focused SQLite runner after changing only value-group placement to append new groups                                                                                                                                             | Expected RED: retained every unaffected `m-unaffected` group before destination `a-inserted`; authoritative arrays placed `a-inserted` first for all four collections. |
| Focused GREEN              | `GSETTINGS_BACKEND=memory bun test libs/core/src/service/plan-commands.test.ts libs/core/src/service/working-plan.test.ts libs/store-sqlite/src/targeted-readers.db.test.ts libs/store-sqlite/src/working-plan-order.db.test.ts` | Pass: 46 tests, 186 assertions.                                                                                                                                        |
| Owning tests               | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-mixed-case-tests NX_DAEMON=false bunx nx run-many -t test -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache`            | Pass: all 4 targets; core 515 tests and SQLite 747 tests; cache skipped.                                                                                               |
| Owning lint and typechecks | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-mixed-case-checks NX_DAEMON=false bunx nx run-many -t lint typecheck -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache` | Pass: all 8 targets; cache skipped.                                                                                                                                    |
| Strict and all OpenSpec    | `OPENSPEC_TELEMETRY=0 bun x @fission-ai/openspec@1.3.0 validate live-plan-snapshot --strict --json` and `OPENSPEC_TELEMETRY=0 bun x @fission-ai/openspec@1.3.0 validate --all --json`                                            | Pass: change 1/1; repository 83/83 (72 changes and 11 specs).                                                                                                          |
| Workspace format and diff  | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-mixed-case-format-final-2 NX_DAEMON=false bunx nx format:check --all` and `git diff --check`                                                                           | Pass.                                                                                                                                                                  |

### Final Task 2.4 R5 fault observations

| Check                              | Injected fault                                             | Observed failure                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Mixed-case memory group placement  | Restored the binary string comparator in memory placement. | The production runner retained `A,a` while every authoritative full reader returned `a,A`, including all three measures for each group.  |
| SQLite moveAll destination placing | Appended new value groups instead of applying placement.   | All four retained collections returned `m-unaffected,a-inserted`; the exact authoritative comparison required `a-inserted,m-unaffected`. |

The be-01 suite and full workspace test, lint, typecheck, build, browser, deploy, and h2puni gates
were not run: this final repair is limited to the four owning libraries, and the task explicitly
excluded the host gate.

## Task 2.5 dependency refresh wrapper

`working-plan-edges.ts` persists dependency add/remove operations before refreshing both endpoint
rows and the retained edge set. `removeAllFor` reads its incident edges before deletion, retains
every endpoint outside the doomed set, then refreshes the doomed and surviving identities after
success. Existing edges keep their retained positions and genuinely new adapter-returned edges
append in authoritative memory and SQLite order. Returned edge records remain detached; modeled
cycle refusal and thrown source writes do not advance retained state.

| Scope                      | Command                                                                                                                                                                                                                                                                         | Result                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Added-edge RED             | `GSETTINGS_BACKEND=memory bun test libs/core/src/service/plan-commands.test.ts --test-name-pattern 'refuses a reversed edge'` before the add refresh                                                                                                                            | Expected RED: 0 passed, 1 failed; the actual runner returned `ok: true` and admitted both directions.              |
| Edge-order RED             | `GSETTINGS_BACKEND=memory bun test libs/core/src/service/working-plan.test.ts --test-name-pattern 'keeps a newly added edge'` before new-edge append                                                                                                                            | Expected RED: retained `edge-a-b,edge-a-e,edge-c-d`; authoritative memory order was `edge-a-b,edge-c-d,edge-a-e`.  |
| Remove RED                 | The same focused working-plan case with add refresh restored and remove still delegated                                                                                                                                                                                         | Expected RED: retained `edge-a-b` after the source deleted it.                                                     |
| Remove-all RED             | The same focused working-plan case with remove refresh restored and removeAllFor still delegated                                                                                                                                                                                | Expected RED: retained `edge-a-e` after the source deleted it.                                                     |
| Survivor revision RED      | `GSETTINGS_BACKEND=memory bun test libs/store-sqlite/src/working-plan-order.db.test.ts --test-name-pattern 'dependency survivor'` with only the captured survivor omitted from refresh                                                                                          | Expected RED: actual runner retained revision `1`; the admitted SQLite row was revision `2` before the next patch. |
| Focused GREEN              | `GSETTINGS_BACKEND=memory bun test libs/core/src/service/plan-commands.test.ts libs/core/src/service/working-plan.test.ts libs/store-sqlite/src/working-plan-order.db.test.ts libs/store-sqlite/src/targeted-readers.db.test.ts libs/store-memory/src/targeted-readers.test.ts` | Pass: 56 tests, 229 assertions.                                                                                    |
| Owning tests               | `GSETTINGS_BACKEND=memory NX_DAEMON=false bunx nx run-many -t test -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache`                                                                                                            | Pass: all 4 targets; core 518/1,717 and SQLite 749/8,541; cache skipped.                                           |
| Owning lint and typechecks | `GSETTINGS_BACKEND=memory NX_DAEMON=false bunx nx run-many -t lint typecheck -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache`                                                                                                  | Pass: all 8 targets; cache skipped.                                                                                |
| Strict and all OpenSpec    | `OPENSPEC_TELEMETRY=0 bun x @fission-ai/openspec@1.3.0 validate live-plan-snapshot --strict --json` and `OPENSPEC_TELEMETRY=0 bun x @fission-ai/openspec@1.3.0 validate --all --json`                                                                                           | Pass: change 1/1; repository 83/83 (72 changes and 11 specs).                                                      |
| Workspace format and diff  | `GSETTINGS_BACKEND=memory NX_DAEMON=false bunx nx format:check --all` and `git diff --check`                                                                                                                                                                                    | Pass.                                                                                                              |

### Task 2.5 R5 fault observations

| Check                    | Injected fault                                                               | Observed failure                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Mounted cycle refusal    | Omitted the newly added edge from retained reads.                            | The second reversed dependency was admitted and the batch returned `ok: true` instead of refusing `cycle`.                                  |
| Exact survivor revision  | Refreshed only doomed ids after `removeAllFor`, omitting captured survivors. | Before the next command, the production runner retained revision `1` while SQLite stored `2`; restored code journals expected revision `3`. |
| Authoritative edge order | Inserted a new incident edge beside the last retained incident edge.         | Memory retained `edge-a-b,edge-a-e,edge-c-d` instead of source order; the SQLite parity case now returns the same source sequence.          |
| Successful remove        | Delegated `remove` without refreshing either endpoint.                       | The deleted edge remained in the retained dependency collection.                                                                            |
| Successful remove-all    | Delegated `removeAllFor` without refreshing captured endpoints.              | The deleted external edge remained in the retained dependency collection.                                                                   |
| Thrown write stability   | Moved add/remove/removeAllFor refresh before injected source throws.         | The retained edge id became `invented-before-success` instead of remaining `stored-edge`.                                                   |

The SQLite runner witness records exact journal preconditions
`{expected:{survivor:3},from:{survivor:1}}`, then successfully undoes the batch and restores the
deleted branch, survivor name and external dependency endpoints. The be-01 suite was not run
because Task 2.5 touched no application composition boundary. Full workspace build, browser,
deploy and h2puni gates were explicitly outside this slice.

## Task 2.6 subtree refresh wrapper

`working-plan-subtrees.ts` now captures reparented rows before persistence, delegates the atomic
subtree write, then refreshes every copied row and parent, respaced/reparented row and old/new
parent, removed estimate/actual/progress/measure work-item key, and inserted dependency endpoint.
Every copied row is authorized for the shared multi-new-row placement path before the method
returns. The actual runner can therefore duplicate a two-row branch and patch the copied child in
the same batch. Restore-shaped controls compare all six retained collections with the uncached
source and keep every borrowed pre-write answer detached.

| Scope                      | Command                                                                                                                                                                                                                                                                          | Result                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate runner RED       | `GSETTINGS_BACKEND=memory bun test libs/core/src/service/plan-commands.test.ts --test-name-pattern 'patches a copied descendant'` before mounting the subtree wrapper                                                                                                            | Expected RED: 0 passed, 1 failed; the second command returned `not_found` at index 1.                                                               |
| Removed-estimate RED       | The focused restore-related working-plan test with `removedEstimates` omitted from the production refresh identities                                                                                                                                                             | Expected RED: the immediate post-insertion assertion found the prior parent's estimate (`Received: true`, expected `false`) before any later write. |
| SQLite subtree-order RED   | `GSETTINGS_BACKEND=memory bun test libs/store-sqlite/src/working-plan-order.db.test.ts --test-name-pattern 'places every new subtree row and value group in SQLite authoritative order'` with work-item placement synthesized from `insertedIds` instead of the adapter response | Expected RED: 0 passed, 1 failed; retained work items began `b-new-root,a-new-child` while SQLite began `a-new-child,b-new-root`.                   |
| Focused GREEN              | `GSETTINGS_BACKEND=memory bun test libs/core/src/service/plan-commands.test.ts libs/core/src/service/working-plan.test.ts libs/store-sqlite/src/working-plan-order.db.test.ts`                                                                                                   | Pass: 47 tests, 174 assertions.                                                                                                                     |
| Owning tests               | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-subtree-tests NX_DAEMON=false bunx nx run-many -t test -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache`                                                               | Pass: all 4 targets; core 522 tests/1,728 assertions and SQLite 750 tests/8,544 assertions; cache skipped.                                          |
| Owning lint and typechecks | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-subtree-checks-final NX_DAEMON=false bunx nx run-many -t lint typecheck -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache`                                              | Pass: all 8 targets; cache skipped.                                                                                                                 |
| Strict and all OpenSpec    | `OPENSPEC_TELEMETRY=0 bun x @fission-ai/openspec@1.3.0 validate live-plan-snapshot --strict --json` and `OPENSPEC_TELEMETRY=0 bun x @fission-ai/openspec@1.3.0 validate --all --json`                                                                                            | Pass: change 1/1; repository 83/83 (72 changes and 11 specs).                                                                                       |
| Workspace format and diff  | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-subtree-format-final-check NX_DAEMON=false bunx nx format:check --all` and `git diff --check`                                                                                                                          | Pass.                                                                                                                                               |

### Task 2.6 R5 fault observations

| Check                              | Injected fault                                                                                                                                     | Observed failure                                                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Mounted duplicate descendant       | Delegated `insertSubtree` without refreshing copied identities.                                                                                    | The second actual runner command refused the copied descendant as `not_found` and the batch rolled back.                     |
| Exact removed-estimate visibility  | Omitted only `removedEstimates` work-item IDs from the subtree refresh.                                                                            | The prior parent retained its removed estimate immediately after insertion, before another write could conceal it.           |
| Multi-new omitted placement        | The adapter omitted the copied child's placement from a two-row duplicate answer.                                                                  | The production runner rejected the trusted response and rolled both copied rows back.                                        |
| Multi-new malformed placement      | The adapter returned numeric predecessor `42` for the copied child.                                                                                | The production runner rejected the malformed predecessor and rolled both copied rows back.                                   |
| SQLite authoritative subtree order | Bypassed the work-item adapter's `listPlacements` response and synthesized multi-new placements from `insertSubtree`'s parent-first `insertedIds`. | The parity assertion failed: retained work items began `b-new-root,a-new-child` while SQLite began `a-new-child,b-new-root`. |

The be-01 suite was not run because Task 2.6 touched no application composition boundary. Full
workspace build, browser, deploy and h2puni gates were explicitly outside this slice.

## Task 2.7 directory refresh wrapper

`working-plan-directory.ts` delegates directory reads, reloads every already-retained global
collection after a successful global entry or membership mutation, and refreshes only the assigned
work-item row after a successful project-scoped assignment. Refused and thrown writes do not
advance retained state. The memory runner provides command-sequence/read-count smoke: its
create-person then assign and assign then patch paths cover assignment refresh reads, while its
delete-team then patch path asserts only the final row name. That path's custom directory adapter
does not cascade labels or bump row revisions; the SQLite runner is the actual cascade and revision
proof. Undo is demonstrated only for assign then patch, restoring the previous assignment and row
name. Global directory writes are unjournalled, so this does not claim restoration of directory
membership, and cascade deletion is not undone. A failed post-write reload rejects the command and
the SQLite unit of work rolls back both the directory write and its row cascade.

| Scope                      | Command                                                                                                                                                                                                                             | Result                                                                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assignment refresh RED     | Focused SQLite runner with the successful assignment target refresh removed                                                                                                                                                         | Expected RED: retained/stored revisions were `1/2` and `2/3`, instead of `2/2` and `3/3`; the next journal precondition therefore exposed the stale retained revision.                          |
| Deletion reload RED        | Focused SQLite runner with only `removeTeam`'s global reload barrier removed                                                                                                                                                        | Expected RED before the second command: retained revision `6`, `teamIds:[removed-team]` and `serviceTeamId:removed-team`; SQLite stored revision `7`, empty `teamIds` and null `serviceTeamId`. |
| Focused GREEN              | `GSETTINGS_BACKEND=memory bun test libs/core/src/service/working-plan-directory.test.ts libs/core/src/service/working-plan.test.ts libs/core/src/service/plan-commands.test.ts libs/store-sqlite/src/working-plan-order.db.test.ts` | Pass: 57 tests, 228 assertions.                                                                                                                                                                 |
| Owning tests               | `GSETTINGS_BACKEND=memory NX_DAEMON=false bunx nx run-many -t test -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache`                                                                | Pass: all 4 targets; core 530 tests/1,767 assertions and SQLite 752 tests/8,559 assertions; cache skipped.                                                                                      |
| Owning lint and typechecks | `GSETTINGS_BACKEND=memory NX_DAEMON=false bunx nx run-many -t lint typecheck -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache`                                                      | Pass: all 8 targets; cache skipped.                                                                                                                                                             |
| Strict and all OpenSpec    | `OPENSPEC_TELEMETRY=0 bun x @fission-ai/openspec@1.3.0 validate live-plan-snapshot --strict --json` and `OPENSPEC_TELEMETRY=0 bun x @fission-ai/openspec@1.3.0 validate --all --json`                                               | Pass: change 1/1; repository 83/83 (72 changes and 11 specs).                                                                                                                                   |
| Workspace format and diff  | `GSETTINGS_BACKEND=memory NX_DAEMON=false bunx nx format:check --all` and `git diff --check`                                                                                                                                        | Pass after formatting the changed source, tests and this verification record.                                                                                                                   |

### Task 2.7 R5 fault observations

| Check                             | Injected fault                                                                                                                          | Observed failure                                                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exact assignment revision         | Omitted only the successful assignment's target-row refresh.                                                                            | At the next patch boundary, retained/stored revisions diverged as `1/2` and then `2/3`; restored code journals `{expected:{row:4},from:{row:2}}`. |
| Exact deleted labels and revision | Delegated `removeTeam` without the global reload barrier.                                                                               | Before the following patch, the retained row still had the removed team and revision `6`, while SQLite had cleared both labels at revision `7`.   |
| Reload failure rollback           | Threw from the authoritative work-item reload after SQLite accepted `removeTeam`.                                                       | The command rejected, and a fresh SQLite read found the team and the exact pre-write labelled row restored.                                       |
| Refusal and throw stability       | Exercised one false outcome for every refusing global method, both assignment refusals, and throws from only `removeTeam` and `assign`. | Neither global reload nor target refresh ran; successful assignment refreshed one affected row with zero placement calls and no global reload.    |

The be-01 suite was not run because Task 2.7 touched no application composition boundary. Full
workspace build, browser, deploy and h2puni gates were explicitly outside this slice.

## Task 3.1 admitted working service graph

`PlanCommandRunner` now constructs each admitted command graph from that batch's owned
`WorkingPlan.stores` inside `UnitOfWork.run`. Directory-only batches, undo/redo, rollback repair,
and the after-commit announcement retain their nonworking graphs. The collector remains owned by
the runner and is passed unchanged to the admitted graph. Every created working plan closes from
the transaction callback's `finally`, including success, modeled refusal, and throw.

| Scope                      | Command                                                                                                                                                                                                                                         | Result                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle RED              | `bun test libs/core/src/service/plan-commands.test.ts --test-name-pattern 'working plan batch ownership'` before wiring the derived scope                                                                                                       | Expected RED: 2 passed and the retained callback after settlement resolved instead of rejecting.                                                          |
| Focused core GREEN         | `bun test libs/core/src/service/plan-commands.test.ts libs/core/src/service/working-plan.test.ts`                                                                                                                                               | Pass: 48 tests, 180 assertions.                                                                                                                           |
| Focused SQLite GREEN       | `bun test libs/store-sqlite/src/working-plan-order.db.test.ts`                                                                                                                                                                                  | Pass: 10 tests, 53 assertions, including refusal isolation and intervening-write undo.                                                                    |
| Source-owning tests        | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-task31-stores NX_DAEMON=false bunx nx run-many -t test -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache`                              | Pass: all 4 targets; core 534 tests/1,789 assertions and SQLite 754 tests/8,569 assertions; cache skipped.                                                |
| Application tests          | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-task31-be NX_DAEMON=false bunx nx run be-01:test --output-style=static --skip-nx-cache`                                                                                               | Pass: 1,075 tests/18,554 assertions; one existing solver-orphan boundary test skipped. The listener-capable rerun replaced a sandbox-denied combined run. |
| Integration fake cleanup   | `bun test apps/be-01/src/service/step.service.db.test.ts --test-name-pattern 'a step removed between the check and the write'` and `GSETTINGS_BACKEND=memory NX_DAEMON=false bunx nx run be-01:typecheck --output-style=static --skip-nx-cache` | Pass: 3 focused tests/7 assertions and application typecheck. The fake now delegates the required authoritative estimate placement read.                  |
| Owning lint and typechecks | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-task31-checks-final NX_DAEMON=false bunx nx run-many -t lint typecheck -p core store-sqlite store-memory conformance be-01 --parallel=2 --output-style=static --skip-nx-cache`        | Pass: all 10 targets; cache skipped.                                                                                                                      |
| Strict and all OpenSpec    | `OPENSPEC_TELEMETRY=0 bun x @fission-ai/openspec@1.3.0 validate live-plan-snapshot --strict --json` and `OPENSPEC_TELEMETRY=0 bun x @fission-ai/openspec@1.3.0 validate --all --json`                                                           | Pass: change 1/1; repository 83/83 (72 changes and 11 specs).                                                                                             |
| Workspace format and diff  | `GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-task31-format NX_DAEMON=false bunx nx format:check --all` and `git diff --check`                                                                                                      | Pass.                                                                                                                                                     |

### Task 3.1 R5 fault observations

The review repair was verified from clean base `b576dbd8a664314e259e29dbc39611f64dbb9e86`
with Bun 1.4.2. The focused four-file probe passed 82 tests and 303 assertions. The uncached
four-project `test` run passed for `core`, `store-sqlite`, `store-memory`, and `conformance`
(`core`: 534 tests/1,789 assertions; `store-sqlite`: 754 tests/8,569 assertions). The uncached
five-project `lint typecheck` run passed those four owners plus `be-01`. Strict validation passed
1/1 for this change and all-change validation passed 83/83. `nx format:check --all` and
`git diff --check` passed. The exact commands were:

```sh
bun test libs/core/src/service/plan-commands.test.ts libs/core/src/service/working-plan.test.ts libs/store-sqlite/src/working-plan-order.db.test.ts apps/be-01/src/service/plan-commands.db.test.ts
GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-task31-review-tests NX_DAEMON=false bunx nx run-many -t test -p core store-sqlite store-memory conformance --parallel=2 --output-style=static --skip-nx-cache
GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-task31-review-checks NX_DAEMON=false bunx nx run-many -t lint typecheck -p core store-sqlite store-memory conformance be-01 --parallel=2 --output-style=static --skip-nx-cache
OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate live-plan-snapshot --strict --json
OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json
GSETTINGS_BACKEND=memory NX_SOCKET_DIR=/tmp/nx-live-plan-task31-review-format NX_DAEMON=false bunx nx format:check --all
git diff --check
```

### Performance evidence-retention harness repair

The reporting repair started from clean checkout `d66b7a2ef5cb1dcafd9aa9c4586f54decaa27ca5`.
It does not change either workload, warm-up, pair order, timing boundary, or acceptance tolerance,
so the frozen `f91ed3ea8ebab8fa99e7e248298692aaf7ddbfe4` samples, medians, ranges, and ratios recorded in
Tasks 3.2 and 3.2a below remain the acceptance evidence. The 80 timed samples were therefore not
rerun.

The harness now attempts both fixtures independently, emits every available sample and summary
with host/workload provenance before evaluating both ratios, aggregates ratio failures, and emits
a terminal report from an outer `finally`. That report records initial and final HEAD plus status
and their equality. `WBS_PERFORMANCE_CERTIFY=1` explicitly requires a clean initial checkout;
ordinary developer runs may start dirty but must finish with the same HEAD and status.

| Scope                     | Command                                                                                                                                                                                             | Result                                                                                                 |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Test-first RED            | Reporting cases before the helper existed                                                                                                                                                           | Expected RED: 0 passed, 2 failed because `runPerformanceCertification` was undefined.                  |
| Old-order R5 fault        | Focused dual-ratio case with the homogeneous ratio failure restored inside the workload loop                                                                                                        | Expected RED: 0 passed, 1 failed; no measurement report existed before mixed could run.                |
| Outer-final R5 fault      | Focused partial-measurement case with the terminal emission removed                                                                                                                                 | Expected RED: 0 passed, 1 failed; the emitted snapshot lacked final HEAD, status, and unchanged state. |
| Reporting GREEN           | `GSETTINGS_BACKEND=memory bun test libs/store-sqlite/src/working-plan-performance.test.ts --test-name-pattern 'reports both completed\|emits partial evidence\|labels and refuses\|reports a HEAD'` | Pass: 4 tests, 19 assertions.                                                                          |
| Correctness and reporting | Same file, selecting every case except the 80-sample timing case                                                                                                                                    | Pass: 7 tests, 45 assertions.                                                                          |
| Remaining SQLite suite    | All 63 other `store-sqlite` test files                                                                                                                                                              | Pass: 754 tests, 8,569 assertions.                                                                     |
| SQLite lint and typecheck | `GSETTINGS_BACKEND=memory NX_DAEMON=false bunx nx run-many -t lint typecheck -p store-sqlite --parallel=2 --output-style=static --skip-nx-cache`                                                    | Pass: both targets, cache skipped.                                                                     |
| Strict and all OpenSpec   | `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate live-plan-snapshot --strict --json` and `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json`                 | Pass: change 1/1; repository 83/83.                                                                    |
| Workspace format and diff | `GSETTINGS_BACKEND=memory NX_DAEMON=false bunx nx format:check --all` and `git diff --check`                                                                                                        | Pass.                                                                                                  |

The full timed performance case and h2puni gate were deliberately not run: the former preserves
the still-valid frozen evidence above, and the latter remains Task 3.3 work excluded from this
repair.

| Check                         | Injected fault                                                                                                                         | Observed failure                                                                                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh graph and before-image  | Cached the first working graph in production and suppressed its close, then ran two SQLite batches around an ordinary estimate write.  | The second undo restored stale `{ optimistic: 4, realistic: 5, pessimistic: 6 }` instead of the intervening `{ optimistic: 7, realistic: 8, pessimistic: 9 }`.                                                         |
| Terminal close                | Omitted the working plan close, retaining callbacks from successful, refused, and throwing actual runner batches.                      | Each callback continued reading after its batch settled instead of rejecting `working plan is closed`.                                                                                                                 |
| Independent memory oracle     | Changed only the production targeted estimate reader to return `optimistic: 99`, preserving both requested identities and their order. | `keeps mixed-case memory value groups in the full readers order after population` failed its exact retained/admitted-store comparison: `A.optimistic` was `99` instead of the authoritative `2`; 0 passed, 1 failed.   |
| Nonworking announcement graph | Retained the admitted service graph and substituted it for `publicServices` at the exact after-commit assignment.                      | `announces after commit through the nonworking graph` failed with `{ announcements: 0, failure: "Working plan for <projectId> is closed" }` instead of `{ announcements: 1, failure: undefined }`; 0 passed, 1 failed. |

The five-project lint/typecheck run initially found an earlier port-integration omission in the
be-01 step-service test fake: its `EstimateStore` lacked `listPlacements`. The bounded cleanup
delegates to the real SQLite repository; the focused regression and `be-01:typecheck` then passed.
Full workspace build, browser, deploy, performance Task 3.2, and h2puni gate were outside this
slice.

## Tasks 3.2 and 3.2a performance acceptance

The frozen acceptance checkout was `f91ed3ea8ebab8fa99e7e248298692aaf7ddbfe4`; `git status
--short` was empty before the run and unchanged after all samples. The host was Linux
`7.0.11-76070011-generic`, x64, 12th Gen Intel Core i7-12800HX, 24 logical CPUs, Bun 1.4.2.
Both fixtures held 200 rows and exactly 200 commands. Each mode was warmed by one run and undo
before sampling. Twenty pairs per fixture alternated uncached-first and cached-first by pair index;
the semantic authored values and assignments were compared with the frozen baseline before each
timed run and after its untimed undo. The uncached runner graph used the raw admitted SQLite stores
captured inside the real UnitOfWork callback. The cached graph used the runner-created WorkingPlan.

| Fixture     | Mode     | Median (ms) | Range (ms)      | Cached / uncached | Acceptance |
| ----------- | -------- | ----------: | --------------- | ----------------: | ---------- |
| Homogeneous | Uncached |     204.428 | 189.780–210.928 |                 — | —          |
| Homogeneous | Cached   |     132.662 | 95.871–141.261  |             0.649 | Pass       |
| Mixed       | Uncached |     220.311 | 184.878–233.184 |                 — | —          |
| Mixed       | Cached   |     189.431 | 165.233–198.663 |             0.860 | Pass       |

Every retained sample, in collection order:

```text
homogeneous cached: 138.314, 134.724, 133.905, 133.778, 131.091, 95.871, 132.979, 126.201, 128.298, 134.583, 141.261, 129.276, 132.383, 134.407, 130.969, 133.656, 130.403, 130.314, 131.396, 132.941
homogeneous uncached: 207.737, 210.928, 201.302, 208.908, 199.094, 206.378, 201.001, 205.523, 203.008, 204.688, 204.680, 189.780, 203.359, 204.175, 207.562, 207.934, 201.505, 203.849, 197.207, 206.884
mixed cached: 187.365, 190.044, 185.804, 198.663, 186.642, 188.781, 178.670, 170.905, 192.920, 185.761, 186.663, 189.558, 193.936, 165.233, 190.151, 191.674, 192.039, 189.741, 191.053, 189.305
mixed uncached: 212.162, 222.382, 220.420, 214.144, 215.918, 222.300, 233.184, 219.442, 184.878, 217.554, 215.054, 219.468, 224.283, 221.137, 220.202, 225.891, 224.815, 222.457, 190.218, 221.142
```

The homogeneous correctness run loaded each of work items, estimates, actuals, progress,
measures and dependencies exactly once, with 400 targeted reads, zero placement reads, one
assignment read and 404 SQL write statements. All 200 changed estimates matched their distinct
expected values, and undo restored all 200 distinct originals. The mixed plan-only run also loaded
each retained collection once, with 994 targeted reads, zero placement reads, 41 separately-counted
assignment reads and 404 SQL write statements. Its 40 `setAssignee` commands repeatedly named the
two people created before the batch.

| Fault                     | Injected production-path fault                                                              | Observed failure                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Cached full-read bound    | Delegated the generic retained value store's `listByProject` directly to its SQLite source. | The 200-command homogeneous runner made 201 estimate full-project reads; expected at most one. |
| Assignment classification | Routed successful `DirectoryStore.assign` through the global directory reload barrier.      | The 40 assignments made 41 work-item full-project reads; expected at most one.                 |
| SQL statement observer    | Dropped the logger from the source connection.                                              | The admitted runner committed the 200 commands but the SQL write count stayed zero.            |

`GSETTINGS_BACKEND=memory bun test src/working-plan-performance.test.ts` from
`libs/store-sqlite` passed 4 tests and 365 assertions in 29.83 seconds on the frozen checkout.
The uncached `store-sqlite:test` owner suite then passed 758 tests and 8,934 assertions across 64
files in 97.00 seconds. Its lint and typecheck targets passed uncached. Strict change validation
passed 1/1 and repository validation passed 83/83; workspace format and `git diff --check` passed.
Task 3.3's core, memory, conformance and be-01 integration matrix and h2puni gate remain unclaimed.

```sh
GSETTINGS_BACKEND=memory bun test src/working-plan-performance.test.ts # from libs/store-sqlite
GSETTINGS_BACKEND=memory NX_DAEMON=false bunx nx run store-sqlite:test --output-style=static --skip-nx-cache
GSETTINGS_BACKEND=memory NX_DAEMON=false bunx nx run-many -t lint typecheck -p store-sqlite --parallel=2 --output-style=static --skip-nx-cache
OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate live-plan-snapshot --strict --json
OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json
GSETTINGS_BACKEND=memory NX_DAEMON=false bunx nx format:check --all
git diff --check
```

## Task 3.3 local closeout at implementation HEAD

The local checks below ran on 2026-09-14 from an initially clean checkout at exact implementation
HEAD `954995d7549f7211698c95e63261ac0b06442a1c`. The two terminal source certificates printed
that full revision without a `-dirty` suffix. The evidence-only commit made after these checks is
not a new implementation revision and is not represented as source certification.

| Scope                                                               | Command                                                                                                                                                                              | Result                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory source conformance and terminal certification                | `GSETTINGS_BACKEND=memory NX_DAEMON=false bunx nx run store-memory:test:conformance --output-style=static --skip-nx-cache`                                                           | Pass: 72 tests, 4,949 assertions, 0 failures. Certificate revision was exact HEAD; six declared exclusions and no absent families.                                                                                                           |
| SQLite source conformance and terminal certification                | `GSETTINGS_BACKEND=memory NX_DAEMON=false bunx nx run store-sqlite:test:conformance --output-style=static --skip-nx-cache`                                                           | Pass: 72 tests, 6,360 assertions, 0 failures. Certificate revision was exact HEAD; no exclusions or absent families.                                                                                                                         |
| Complete core and memory owning suites                              | `GSETTINGS_BACKEND=memory NX_DAEMON=false bunx nx run-many -t test -p core store-memory --parallel=2 --output-style=static --skip-nx-cache`                                          | Pass: both uncached targets. Core reported 534 tests, 1,789 assertions, 0 failures.                                                                                                                                                          |
| Complete SQLite owning suite, including the normal performance test | `GSETTINGS_BACKEND=memory NX_DAEMON=false bunx nx run store-sqlite:test --output-style=static --skip-nx-cache`                                                                       | Pass: 762 tests across 64 files, 8,946 assertions, 0 failures in 97.60 seconds. This was a developer-run performance execution, not a replacement frozen-clean timing certification; Tasks 3.2 and 3.2a retain the acceptance timings above. |
| be-01 unit suite, sandbox attempt                                   | `GSETTINGS_BACKEND=memory NX_DAEMON=false bunx nx run be-01:test:unit --output-style=static --skip-nx-cache`                                                                         | Environment refusal: 512 tests passed and the sole failure was `Bun.serve` returning `EPERM: operation not permitted, listen` in `refuses framed GET and HEAD bodies on the production health route`.                                        |
| be-01 unit suite, listener-capable rerun                            | `GSETTINGS_BACKEND=memory NX_DAEMON=false bunx nx run be-01:test:unit --output-style=static --skip-nx-cache`                                                                         | Pass with loopback-listener permission: 513 tests across 48 files, 2,727 assertions, 0 failures in 22.27 seconds.                                                                                                                            |
| Owning lint and typecheck matrix                                    | `GSETTINGS_BACKEND=memory NX_DAEMON=false bunx nx run-many -t lint typecheck -p core store-sqlite store-memory conformance be-01 --skip-nx-cache --parallel=2 --output-style=static` | Pass: all 10 uncached targets in 32.6 seconds. Nx could not create its optional plugin-worker socket in the sandbox and visibly used its main-process fallback; the targets ran and passed.                                                  |
| Strict change packet                                                | `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate live-plan-snapshot --strict --json`                                                                                   | Pass: 1/1, 0 failed.                                                                                                                                                                                                                         |
| All OpenSpec packets                                                | `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json`                                                                                                         | Pass: 83/83, 0 failed.                                                                                                                                                                                                                       |
| Workspace format                                                    | `GSETTINGS_BACKEND=memory NX_DAEMON=false bunx nx format:check --all`                                                                                                                | Pass.                                                                                                                                                                                                                                        |
| Diff whitespace                                                     | `git diff --check`                                                                                                                                                                   | Pass before the evidence edit; the post-format rerun against the evidence diff also passed before commit.                                                                                                                                    |

After the evidence was appended, the first repeated `GSETTINGS_BACKEND=memory NX_DAEMON=false
bunx nx format:check --all` exited 1 without naming a file. `bunx prettier --check
openspec/changes/live-plan-snapshot/verify.md` identified this file; `bunx prettier --write
openspec/changes/live-plan-snapshot/verify.md` formatted it, and the complete Nx `--all` check
then passed.

The exact-head h2puni gate and its build were not run because the implementation SHA is not on
the remote and integration remains the user's choice. Browser and deploy checks were also not
run; they are outside this local closeout. Task 3.3 remains unchecked until the required
`bin/h2puni-gate.sh <sha>` execution completes on h2puni.
