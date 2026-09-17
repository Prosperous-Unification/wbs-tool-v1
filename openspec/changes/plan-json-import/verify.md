# Verify

## Section 1 — current export and document boundary

Implementation began from `0451b8214b907948d920cd6249525a2b14728a32` on
2026-09-13. Before implementation, these focused baselines passed:

- `cd libs/core && bun test src/http/project.routes.test.ts` — 2 passed.
- `cd apps/be-01 && bun test src/controller/project.controller.test.ts` — 54 passed.

The completed Section 1 slice passed:

- `cd libs/contracts && bun test $(find src solver/src -name '*.test.ts' -o -name '*.test.tsx' | sort)` — 380 passed.
- `cd libs/core && bun test src` — 431 passed.
- `cd libs/store-memory && bun test src` — 29 passed, 1 skipped by the source's declared capability allowlist.
- `cd libs/core && bun test src/service/plan-document.test.ts src/http/project.routes.test.ts` — 10 passed.
- `cd apps/be-01 && bun test src/controller/project.controller.test.ts src/http/elysia/plan-document-boundary.test.ts` — 57 passed.
- `NX_DAEMON=false bunx nx run-many -t lint typecheck -p contracts core store-memory be-01 --skip-nx-cache` — all eight targets passed (observed as part of the owning run).
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate plan-json-import --strict --json` — 1 change passed, 0 failed.

## Failure-proof table

| Check                     | Fault injected                                                        | Test that observed it                                                                       | Observed failure                                                                                          |
| ------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Complete settings export  | Removed `settings.estimateRounding` from `PlanDocumentService.export` | mounted `projects > exports the project WBS and Gantt payload as JSON`                      | expected HTTP 200, received response-boundary 500 before unchanged project/row controls                   |
| Capacity closure          | Started referenced team ids empty                                     | mounted `projects > exports the referenced directory closure and authored calendar markers` | exact `Capacity only` team id/name missing while its capacity row remained                                |
| Membership closure        | Skipped assigned-person memberships                                   | same mounted closure test                                                                   | exact `Billing` team and owned-service id missing while assigned `Kat` remained                           |
| Team-service closure      | Skipped selected-team service ids                                     | same mounted closure test                                                                   | `services: []` instead of exact `Billing API` id/name                                                     |
| Minimal directory closure | Returned every tag                                                    | same mounted closure test                                                                   | exact unrelated tag id/name appeared beside `Release`                                                     |
| Missing reference refusal | Removed the missing-id guard                                          | same mounted closure test with the directory tag read faulted                               | expected HTTP 500, received 200 while the work item still referenced the absent tag                       |
| Structural path           | Changed the priority declaration to `unknown`                         | mounted `malformed priority names workItems[3].priority`                                    | expected 400 `invalid_body` at `workItems[3].priority`, received 204                                      |
| Version precedence        | Validated the version-1 body before checking its version              | mounted `unknown version precedes version-specific validation`                              | received `invalid_body` at `workItems[3].priority` instead of `unsupported_version` at `document.version` |

Each fault was watched, restored, and recorded beside the production check with a
`Proof:` comment.

## Section 2 — pure preparation

The first focused run was deliberately red: `bun test
libs/core/src/service/prepare-import.test.ts` could not resolve the absent
`./prepare-import` module. The first implementation run then exposed a validator
ordering defect of its own: `.at(-1)` treated the final priority band as the
first band's predecessor, so 18 of 19 cases refused the valid fixture at
`priorityBands[0].startsAt`. Changing the first predecessor to `undefined`
restored the intended ladder order.

The completed pure-preparation slice passed:

- `cd libs/core && bun test src` — 476 passed, 0 failed across 47 files.
- `cd apps/be-01 && bun test src/http/elysia/plan-document-boundary.test.ts` — 16 passed, 0 failed, including every requested malformed-document family with `countingUnitOfWork().calls` exactly `[]`.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint typecheck -p contracts core be-01 --skip-nx-cache` — all six targets passed.
- `bunx prettier --check apps/be-01/src/http/elysia/plan-document-boundary.test.ts libs/core/src/index.ts libs/core/src/service/prepare-import.ts libs/core/src/service/prepare-import.test.ts libs/core/src/testing/plan-document-fixture.ts openspec/changes/plan-json-import/tasks.md openspec/changes/plan-json-import/verify.md` — all named files matched.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate plan-json-import --strict --json` — 1 change passed, 0 failed.

The watched faults were applied to the production preparation function from
temporary `/tmp` scripts, run one at a time, and restored before the green runs.

| Check                     | Fault injected                                                                                                           | Test that observed it                                              | Observed failure                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| File identity and names   | Removed duplicate file-id and normalized-name lookups                                                                    | mounted duplicate row/tag cases                                    | exact refusal path was lost for the row; duplicate tag returned 204                           |
| Structural project values | Bypassed project-name, start-date, PERT, capacity, band and row-value guards individually                                | named focused core cases plus mounted capacity/band/priority cases | each named test failed; the mounted guards admitted the request                               |
| Zero admission            | Bypassed the priority guard with the counting unit of work assertion first                                               | mounted `invalid priority without opening a unit of work`          | expected `[]`, observed `['begin', 'commit']`                                                 |
| File-local references     | Bypassed step, system, person, capacity-team, membership, ownership and row-label lookups individually                   | named core/mounted unknown-reference cases                         | each named test failed; mounted step/system/person bypasses returned 204 and admitted         |
| Leaf values               | Bypassed estimate, actual, progress, metric, measure-map and measure-value checks individually                           | five named leaf-value cases and mounted invalid-leaf case          | every invalid value was accepted; mounted negative actual admitted                            |
| Complete hierarchy        | Skipped `firstHierarchyRefusal`                                                                                          | mounted `hierarchy cycle without opening a unit of work`           | expected 400 with zero admissions; received 204 through admission                             |
| Complete dependencies     | Skipped `firstDependencyRefusal`                                                                                         | mounted dangling dependency and focused ancestry/cycle cases       | dangling reference returned 204; complete ancestor/cycle graphs were accepted                 |
| Leaf authority            | Forced every row to be a leaf                                                                                            | `parent aggregate maps never become prepared facts`                | the deliberately invalid parent aggregate was interpreted and preparation returned `ok:false` |
| Deadline                  | Skipped date/deadline validation                                                                                         | mounted deadline-before-start case                                 | expected 400 with zero admissions; received 204 through admission                             |
| Scheduler capability      | Skipped the enabled-engine capability refusal                                                                            | mounted `enabled unavailable optimizer creates nothing`            | expected 400 with zero admissions; received 204 through admission                             |
| Marker/reason/ref bounds  | Bypassed each marker predicate, reason pair/length, external-ref id/url/name, step-position and dependency planner check | respective focused cases                                           | each named case failed while its invalid value was accepted                                   |

The global refusal vocabulary still treats `unknown_ref`, `cycle`, `ancestor`
and `deadline_before_project_start` as command-context envelopes. Section 4 owns
the dedicated public import refusal shapes. Until then, the staged mounted
harness keeps its declared `invalid_body` transport and exposes the exact pure
preparation discriminant as test-only `importError`; `ImportPreparation` itself
already carries exact code, path and detail.

## Environment notes

The first contracts owning run could not execute its compiler-spawn proof because
the isolated worktree had no local `node_modules/.bin/tsc`; an ignored worktree
symlink to the repository dependency installation restored the 380/0 result.

The combined owning test run also exercised all of `be-01` inside the restricted
sandbox. It reported 1040 passes, 1 skip and 17 failures. The failures were in
tests that open listener/process boundaries and included `Bun.serve` `EPERM:
operation not permitted, listen`; the Section 1 mounted suites above remained
green. The host-wide and browser gates remain assigned to task 5.2.

At the Section 2 checkpoint, Sections 3–5 were unimplemented and unchecked.

## Section 3.1 — admitted directory reconciliation

Task 3.1 began from stacked head `fce5ac333f03b019d73438eaeb30961d14d185c6`,
which contains Sections 1–2 and the accepted source-conformance prerequisite.
The first focused run was deliberately red: `cd libs/store-memory && bun test
src/import.service.test.ts` failed because `ImportService` was absent from the
core boundary.

`ImportService.import` now prepares before admission, creates one
`AnnouncementCollector`, and builds its service graph from the exact `Scope`
passed to `UnitOfWork.run`. All deployment-global name reads and writes plus the
solution-slug occupancy lookup happen through that admitted scope. Names remain
trimmed and case-sensitive. Existing teams and people are authoritative; only a
new team receives imported service ownership and only a new person receives the
imported kind and memberships. External-system vocabulary starts with the
classifier's seeded names but may grow through archival import; it still has no
public create route.

Fresh green evidence:

- `cd libs/store-memory && bun test src/import.service.test.ts` — 4 passed, 0 failed.
- `cd libs/store-sqlite && bun test src/import.service.db.test.ts` — 4 passed, 0 failed.
- `cd libs/core && bun test src/service/directory-usage.test.ts src/service/prepare-import.test.ts src/service/command-bindings.test.ts` — 48 passed, 0 failed.
- `cd libs/store-memory && bun test src/import.service.test.ts src/memory-source.test.ts` — 15 passed, 0 failed.
- `cd libs/store-sqlite && bun test src/import.service.db.test.ts src/directory.db.test.ts` — 17 passed, 0 failed.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint typecheck -p core store-memory store-sqlite --skip-nx-cache --parallel=1 --output-style=static` — all six targets passed.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate plan-json-import --strict --json` — 1 change passed, 0 failed.

| Check                                | Fault injected                                                              | Test that observed it                                                                                     | Observed failure                                                       |
| ------------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Existing person is global authority  | Patched a reused person with the file's `kind` and mapped memberships       | both source contracts, `keeps an existing person byte-equivalent when the file disagrees`                 | expected `person/held-team`; received `agent/imported-2` byte-for-byte |
| Occupied solution slug               | Replaced the admitted `findBySolutionSlug` lookup with unconditional `kept` | memory source contract, `leaves off a solution slug already held inside admission`                        | expected `left-off`; received `kept`                                   |
| Imported external-system persistence | Deliberately suffixed the SQLite post-insert name lookup                    | SQLite source contract, `reuses an existing tag by name` (its otherwise-valid document carries `Tracker`) | threw `external system vanished after insert: Tracker`                 |

Each fault was observed, restored and recorded beside its production check.
At the Task 3.1 checkpoint, Tasks 3.2–5.2 remained unimplemented and unchecked.

## Section 3.2 — exact project configuration

Task 3.2 extends the same admitted act with one project created directly through
`ProjectStore.create`, its supplied steps, priority ladder, capacity entries and
calendar markers. The import owns one stamp for these rows. It mints fresh
project, step and marker ids; the document's marker id remains a file-local ref.
The chosen solution reference is written only when Task 3.1's admitted lookup
reported its slug free.

The first focused test was red after preparation succeeded: the returned
admission had no `projectId`, and `findById(undefined)` returned `null` instead
of the supplied project settings. Memory and SQLite then both passed the five
source-contract cases, including the exact three-step order and marker
date/name/color. These focused semantic runs overlapped the E2E lane's final
static gate; no timing conclusion is drawn from them.

| Check                | Fault injected                                                                                                            | Test that observed it                                                                                       | Observed failure                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Exact imported steps | Replaced direct `ProjectStore.create(project, steps, stamp)` with `ProjectService.create`, whose defaults are Dev then QA | memory source contract, `stores exact project settings, nondefault step order, capacity, bands, and marker` | expected `Discover@10, Build@30, Verify@70`; received `Dev@10, QA@20` |

The fault was observed, restored and recorded beside the direct production
call.

After the E2E timing lane released the host, fresh final evidence passed:

- `cd libs/store-memory && bun test src/import.service.test.ts src/memory-source.test.ts` — 16 passed, 0 failed.
- `cd libs/store-sqlite && bun test src/import.service.db.test.ts src/directory.db.test.ts src/project.db.test.ts src/priority-band.db.test.ts src/capacity.db.test.ts src/calendar-marker.db.test.ts` — 70 passed, 0 failed.
- `cd libs/core && bun test src/service/prepare-import.test.ts src/service/calendar-marker.service.test.ts` — 62 passed, 0 failed.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint typecheck -p core store-memory store-sqlite --skip-nx-cache --parallel=3 --output-style=static` — five targets passed; `core:lint` found the new test's forbidden non-null assertions and unsafe asymmetric matcher.
- After replacing those assertions with explicit fixture/marker guards and a typed authored-marker projection, `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx lint core --skip-nx-cache --output-style=static` and `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t typecheck -p core store-memory store-sqlite --skip-nx-cache --parallel=3 --output-style=static` both passed.
- Final adapter contracts: memory 5 passed and SQLite 5 passed, 0 failed.
- `bunx prettier --check libs/core/src/service/import.service.ts libs/core/src/testing/import-service-source-contract.ts openspec/changes/plan-json-import/verify.md openspec/changes/plan-json-import/tasks.md` — all named files matched.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate plan-json-import --strict --json` — 1 change passed, 0 failed.

At the Task 3.2 checkpoint, Tasks 3.3–5.2 remained unimplemented and unchecked.

## Section 3.3 — complete imported tree

Task 3.3 allocates the new row identities before building the tree, orders the
prepared rows with parents before children, and writes the rows, leaf facts,
assignments and edges as one `SubtreeCopy`. Each row's own tag, service and type
sets and its ordered external references are then written through the admitted
work-item store. File ids remain references: new directory entries, project,
steps, rows, external references, dependency and marker all receive fresh
store-owned ids.
The original project used by the contract deliberately owns rows under the
file's row ids, making accidental reuse observable as corruption of existing
work rather than only as an equality assertion over an empty source.

The first valid memory run was red with `imported hierarchy is incomplete`:
preparation and project creation succeeded, but the import had not written a
tree. The completed focused contract reads a parent and two leaves, including
notes, freeze, floor/reason, deadline, fact dates, priority, parallelism, own
labels, ordered external refs, leaf estimates/actuals/progress/measures, an
explicit assignment and a sibling dependency. Deliberately invalid aggregate
maps on the parent remain absent from every satellite read.

| Check                  | Fault injected                                  | Test that observed it                                                                  | Observed failure                                                                  |
| ---------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Exact authored notes   | Wrote `''` instead of each prepared row's notes | `stores a fresh complete tree without changing rows that own the file ids`             | exact parent notes expected `Exact parent notes`, received `''`                   |
| Fresh imported row ids | Mapped each row to its file id                  | same memory source contract, with three snapshotted rows already owning those file ids | original project expected its three exact rows, reread returned `[]` after import |

Both faults were observed separately, restored, and recorded beside the
production fields they protect.

Final green evidence:

- `bun test libs/store-memory/src/import.service.test.ts` — 6 passed, 0 failed, 39 assertions.
- `bun test libs/store-sqlite/src/import.service.db.test.ts` — 6 passed, 0 failed, 39 assertions.
- `bun test libs/store-memory/src/import.service.test.ts libs/store-memory/src/memory-source.test.ts` — 17 passed, 0 failed, 208 assertions.
- `bun test libs/store-sqlite/src/import.service.db.test.ts libs/store-sqlite/src/work-item.db.test.ts libs/store-sqlite/src/external-ref.db.test.ts libs/store-sqlite/src/estimate.db.test.ts libs/store-sqlite/src/actual.db.test.ts libs/store-sqlite/src/step-progress.db.test.ts libs/store-sqlite/src/step-measure.db.test.ts libs/store-sqlite/src/dependency.db.test.ts libs/store-sqlite/src/assignment-scope.db.test.ts libs/store-sqlite/src/work-item-type.db.test.ts` — 122 passed, 0 failed, 277 assertions.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint typecheck -p core store-memory store-sqlite --skip-nx-cache --parallel=3 --output-style=static` — all six targets passed.
- `bunx prettier --check libs/core/src/service/import.service.ts libs/core/src/testing/import-service-source-contract.ts openspec/changes/plan-json-import/tasks.md openspec/changes/plan-json-import/verify.md` — all named files matched.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate plan-json-import --strict --json` — 1 change passed, 0 failed.

At the Task 3.3 checkpoint, Tasks 3.4–5.2 remained unimplemented and unchecked.

## Section 3.4 — terminal rollback

The rollback contract uses each production source's real `UnitOfWork`. A test
wrapper changes only the first admitted work-item label patch: it reads the
newly created `Billing` team, project and row through the admitted scope, then
holds that later write until the test releases either a typed `unknown_tag`
refusal or an exact thrown error. The valid document therefore proves writes
occurred before the injected terminal condition; the old pre-admission dangling
dependency is not involved.

The first memory run was red only for the modeled arm: it expected a returned
`source_refused` outcome at `workItems[0]` but received the thrown
`created work item refused its labels: unknown_tag` error. The thrown arm
already preserved the exact injected error and rolled back. `ImportService`
now returns the typed store refusal with `commit:false`, rethrows unexpected
source errors, and sends its collector only after a committed admission.

| Check                     | Fault injected                                         | Test that observed it                                                   | Observed failure                                                |
| ------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------- |
| Modeled terminal rollback | Returned `commit:true` with the `source_refused` value | memory `rolls back visible admitted writes after a later store refused` | final directory expected no `Billing` team, but found it stored |

The mutant was observed, restored, and recorded beside the `commit:false`
decision it protects.

Final green evidence:

- `bun test libs/store-memory/src/import.service.test.ts` — 8 passed, 0 failed, 53 assertions.
- `bun test libs/store-sqlite/src/import.service.db.test.ts` — 8 passed, 0 failed, 53 assertions.
- `bun test libs/store-memory/src/import.service.test.ts libs/store-memory/src/memory-source.test.ts` — 19 passed, 0 failed, 222 assertions.
- `bun test libs/store-sqlite/src/import.service.db.test.ts libs/store-sqlite/src/sqlite-unit-of-work.db.test.ts` — 14 passed, 0 failed, 71 assertions.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint typecheck -p core store-memory store-sqlite --skip-nx-cache --parallel=3 --output-style=static` — all six targets passed.
- `bunx prettier --check libs/core/src/service/import.service.ts libs/core/src/testing/import-service-source-contract.ts openspec/changes/plan-json-import/tasks.md openspec/changes/plan-json-import/verify.md` — all named files matched.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate plan-json-import --strict --json` — 1 change passed, 0 failed.

At the Task 3.4 checkpoint, Tasks 3.5–5.2 remained unimplemented and unchecked.

## Section 3.5 — concurrent solution reference ownership

The source contract holds the first import at its admitted project creation,
after that import found the shared solution slug free. It then observes a
second invocation enter the same `UnitOfWork` and queue behind the first. Once
released, both requests settle successfully: the first project keeps the exact
reference, the second reports `left-off` and stores null, and their project ids
are distinct. This uses one import service and clock so generated-id collisions
cannot masquerade as solution ownership behavior.

Task 3.5 required no new production branch: Task 3.1's lookup already occurs
inside the admitted unit of work immediately before project creation. The new
contract proves that placement under contention.

| Check                    | Fault injected                                         | Test that observed it                                                | Observed failure                                                                               |
| ------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Admitted solution lookup | Replaced the admitted lookup with unconditional `kept` | `serializes concurrent imports competing for one free solution slug` | memory returned `kept`/`kept`; SQLite leaked `UNIQUE constraint failed: project.solution_slug` |

The fault was observed against both sources, restored, and recorded beside the
admitted lookup.

Final green evidence:

- `bun test libs/store-memory/src/import.service.test.ts` — 9 passed, 0 failed, 58 assertions.
- `bun test libs/store-sqlite/src/import.service.db.test.ts` — 9 passed, 0 failed, 58 assertions.
- `bun test libs/store-memory/src/import.service.test.ts libs/store-memory/src/memory-source.test.ts` — 20 passed, 0 failed, 227 assertions.
- `bun test libs/store-sqlite/src/import.service.db.test.ts libs/store-sqlite/src/sqlite-unit-of-work.db.test.ts libs/store-sqlite/src/project.db.test.ts` — 46 passed, 0 failed, 139 assertions.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint typecheck -p core store-memory store-sqlite --skip-nx-cache --parallel=3 --output-style=static` — all six targets passed.
- `bunx prettier --check libs/core/src/service/import.service.ts libs/core/src/testing/import-service-source-contract.ts openspec/changes/plan-json-import/tasks.md openspec/changes/plan-json-import/verify.md` — all named files matched.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate plan-json-import --strict --json` — 1 change passed, 0 failed.

At the Task 3.5 checkpoint, Tasks 3.6–5.2 remain unimplemented and unchecked.

## Section 3.6 — announcements after admission

The import's scoped service graph now collects one `directory_changed` for
every project when the import creates a deployment-global directory name, the
new project's exact `project_settings_changed`, and its full
`tree_replaced`. The collector drains only after `UnitOfWork.run` has committed
and released its turn. An existing project's subscriber rereads the public
directory from its callback and observes the imported `Billing` name, proving
the global directory fan-out rather than only inspecting an event recorder.

The same source contract asserts the imported project has neither command
journal entries nor plan-history rows. Its existing later-refusal and thrown
source-error cases continue to assert that no collected announcement is sent.

| Check                          | Fault injected                                               | Test that observed it                                                      | Observed failure                                                                |
| ------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Global directory announcement  | Omitted the directory fan-out                                | `publishes directory, project, and tree refreshes without writing history` | existing subscriber recorded no refresh and never read the imported team name   |
| Gate release before publishing | Moved `AnnouncementCollector.send()` inside the unit of work | `releases admission before a held publisher settles`                       | timed out at 1,000 ms while the queued ordinary project write awaited admission |

Both faults were observed on the production import path, restored, and
recorded beside the checks they protect.

Final green evidence:

- `bun test libs/store-memory/src/import.service.test.ts` — 11 passed, 0 failed, 65 assertions.
- `bun test libs/store-sqlite/src/import.service.db.test.ts -t 'publishes directory, project, and tree refreshes without writing history|releases admission before a held publisher settles'` — 2 passed, 0 failed, 7 assertions.
- `bun test libs/store-memory/src/import.service.test.ts libs/store-memory/src/memory-source.test.ts` — 22 passed, 0 failed, 235 assertions.
- `bun test libs/store-sqlite/src/import.service.db.test.ts libs/store-sqlite/src/sqlite-unit-of-work.db.test.ts libs/store-sqlite/src/project.db.test.ts` — 48 passed, 0 failed, 147 assertions.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint typecheck -p core store-memory store-sqlite --skip-nx-cache --parallel=3 --output-style=static` — all six targets passed.
- `bunx prettier --check libs/core/src/service/import.service.ts libs/core/src/testing/import-service-source-contract.ts openspec/changes/plan-json-import/tasks.md openspec/changes/plan-json-import/verify.md` — all named files matched.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate plan-json-import --strict --json` — 1 change passed, 0 failed.

At the Task 3.6 checkpoint, Tasks 3.7–5.2 remain unimplemented and unchecked.

## Section 3.7 — authored round trip

The shared real-source contract creates a fully authored seed, exports it
through `PlanDocumentService`, imports that classified archival request back
into the same compatible directory, and exports the restored project again.
Its id-independent snapshot compares the complete writable boundary after
aliasing project-local and directory ids, normalizing the export stamp, and
excluding the approved solution-reference collision. The fixture contains a
parent and two leaves, three nondefault ordered steps, every directory and row
satellite kind, a dependency, deadline/not-before/reason, frozen number,
capacity, priority bands, marker, and nondefault optimization preferences.

The second import reports `left-off` because the seed holds the solution slug,
and the directory is byte-equivalent before and after that import. The
normalized exports agree. Direct reads of estimates, actuals, progress, and
measures separately prove that only leaf ids own stored values.

| Check                   | Fault injected                            | Test that observed it                                             | Observed failure                                                                                                                                     |
| ----------------------- | ----------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Leaf-only value restore | Forced every prepared work item to a leaf | `round trips every authored input while storing leaf values only` | the restored parent appeared in all four source tables and in the exact estimate-owner id set; re-export alone remained equal because roll-up hid it |

The fault was observed on the production preparation path, restored, and
recorded beside the leafhood derivation. The combined source-table and
re-export assertion prevents the readable projection from masking duplicated
stored facts.

Final green evidence:

- `bun test libs/store-memory/src/import.service.test.ts -t 'round trips every authored input while storing leaf values only'` — 1 passed, 0 failed, 4 assertions.
- `bun test libs/store-sqlite/src/import.service.db.test.ts -t 'round trips every authored input while storing leaf values only'` — 1 passed, 0 failed, 4 assertions.
- `bun test libs/store-memory/src/import.service.test.ts libs/store-memory/src/memory-source.test.ts` — 23 passed, 0 failed, 239 assertions.
- `bun test libs/store-sqlite/src/import.service.db.test.ts libs/store-sqlite/src/sqlite-unit-of-work.db.test.ts libs/store-sqlite/src/project.db.test.ts` — 49 passed, 0 failed, 151 assertions.
- `bun test libs/core/src/service/plan-document.test.ts libs/core/src/service/prepare-import.test.ts` — 53 passed, 0 failed, 92 assertions.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint typecheck -p core store-memory store-sqlite --skip-nx-cache --parallel=3 --output-style=static` — all six targets passed.
- `bunx prettier --check libs/core/src/service/prepare-import.ts libs/core/src/testing/import-service-source-contract.ts openspec/changes/plan-json-import/tasks.md openspec/changes/plan-json-import/verify.md` — all named files matched.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate plan-json-import --strict --json` — 1 change passed, 0 failed.

At the Task 3.7 checkpoint, Section 3 is complete. Sections 4–5 remain
unimplemented and unchecked.

## Section 4.1 — mounted import boundary

Before this slice, the branch integrated `origin/main` at
`9b13f98e62a7cd880977e348421e992e8c4951a3` with merge commit
`f6246ea60c3cbc5bd337d40e81bfd83db4fe90b0`. The conflict-free integration
baseline passed 125 tests with 482 assertions across the core plan-document,
memory import/source and SQLite import/unit-of-work/project suites. Lint and
typecheck also passed for core, store-memory and store-sqlite.

The shared shape now declares `postApiProjectsImport` at
`POST /api/projects/import`, with the archival plan request, exact 201 creation
summary, contextual 400/409 refusals, and the ordinary 401/403 authentication
refusals. Core binds classification and `ImportService.import`; the production
app mounts that binding with cookie-origin followed by write-scope admission.
The successful source outcome now carries the exact row count and newly created
directory names needed by the public summary.

| Check                         | Fault injected                                                                    | Test that observed it                                                     | Observed failure                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Production mount reachability | Removed `...importRoutes(opts.writes.imports)` from the production endpoint table | `mounts the production import path and returns the typed 201 summary`     | expected 201 and received the actual fallback 404                                                                        |
| Write-scope admission         | Weakened the import identity policy from `write-scope` to `signed-in`             | `checks cookie origin and write scope before parsing the import document` | a read-only caller's valid import expected 403 but wrote and returned 201                                                |
| Policy-before-body precedence | Injected target-specific eager JSON parsing before the production policy loop     | the same mounted precedence test with a malformed read-only request       | the valid read-only control stayed 403, while the malformed request expected 403 and instead returned 400 `invalid_body` |

Each production-path mutation was run separately, observed failing, restored,
and followed by the green suite. The mounted test also proves that a foreign
session origin wins over malformed JSON and that neither refusal invokes the
import service. Shape/endpoint reachability and the complete production policy
inventory include the new operation.

Fresh final evidence:

- `bun test libs/contracts/src/http/import-shapes.test.ts libs/contracts/src/http/document-from-shapes.test.ts libs/contracts/src/http/client.test.ts libs/contracts/src/http/infrastructure-shapes.test.ts libs/core/src/http/import.routes.test.ts libs/core/src/compose.test.ts apps/be-01/src/controller/import.controller.test.ts apps/be-01/src/app.routes.test.ts apps/be-01/src/app.test.ts apps/be-01/src/http/elysia/mount.test.ts apps/be-01/src/http/elysia/plan-document-boundary.test.ts libs/store-memory/src/import.service.test.ts libs/store-sqlite/src/import.service.db.test.ts` — 165 passed, 0 failed, 1,188 assertions.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint typecheck -p contracts core be-01 --skip-nx-cache --parallel=1 --output-style=static` — all six targets passed.

An exploratory directory invocation, `bun test libs/contracts/src/http ...`,
was invalid for this repository because it also discovered ignored
`dist/out-tsc` compiler-output copies; source tests passed, while three copied
tests failed on their generated module paths. The explicit source-file suite
above supersedes that invocation.

At the Task 4.1 checkpoint, Tasks 4.2–5.2 remain unimplemented and unchecked.

## Section 4.2 — generated OpenAPI and MCP import input

Task 4.2 continued from merged `origin/main` at
`c83219128f840f725ff80c6f49dd6e1a9a67b188`. The mounted OpenAPI document and
the production-derived MCP tool table now locate `postApiProjectsImport` by its
operation id instead of accepting an incremented global operation/tool count.
Both boundaries assert an inline JSON object request; the MCP assertion pins the
eight top-level document fields and verifies that no `$ref` survives derivation.
The generated client response type also refuses a `created` summary that omits
one directory kind.

| Check                           | Fault injected                               | Test that observed it                                                | Observed failure                                                                                       |
| ------------------------------- | -------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Shared-shape MCP publication    | Removed `importProject` from `httpShapes`    | `exposes the import document tool`                                   | exact production-generated lookup threw `no tool named postApiProjectsImport was derived` (1/1 failed) |
| Complete created-summary typing | Made `createdNames.externalSystems` optional | compile-only `importSummaryTypeFixtures` under `contracts:typecheck` | TS2578: the incomplete-summary `@ts-expect-error` became unused                                        |

Both production mutations were applied separately, observed red, restored, and
recorded beside the assertions they protect.

Fresh green evidence:

- `bun test libs/contracts/src/http/import-shapes.test.ts libs/contracts/src/http/document-from-shapes.test.ts apps/mcp-01/src/openapi-tools.test.ts apps/mcp-01/src/generated-document.test.ts apps/mcp-01/src/shape-document.test.ts apps/be-01/src/openapi/openapi-document.test.ts` — 59 passed, 0 failed, 332 assertions.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint typecheck -p contracts mcp-01 be-01 --skip-nx-cache --parallel=2 --output-style=static` — all six targets passed.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate plan-json-import --strict --json` — 1 change passed, 0 failed.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json` — 83 items passed, 0 failed.
- `bunx prettier --check apps/be-01/src/openapi/openapi-document.test.ts apps/mcp-01/src/generated-document.test.ts apps/mcp-01/src/openapi-tools.test.ts libs/contracts/src/http/import-shapes.test.ts openspec/changes/plan-json-import/tasks.md openspec/changes/plan-json-import/verify.md` — all named files matched.

At the Task 4.2 checkpoint, Tasks 4.3–5.2 remain unimplemented and unchecked.

## Section 5.1 — SQLite import measurement

The production `ImportService` imported exactly 500 root rows into a migrated
SQLite file. The UTF-8 JSON request was 381,862 bytes. A direct call to pure
`prepareImport` took 7.702 ms and issued 0 SQL statements or native transaction
controls. The separately timed admitted `UnitOfWork.run` interval took 223.086
ms. Drizzle logged 7,065 statements from `BEGIN IMMEDIATE` through `COMMIT`,
inclusive. The same production connection observed 507 successful native
transaction wrappers nested inside that interval; their 507 `SAVEPOINT` and
507 `RELEASE` controls bypass Drizzle's logger. The admitted total is therefore
7,065 logged statements + 1,014 native controls = 8,079 SQL statements. These
observed times are evidence, not pass/fail budgets.

An ordinary public directory write was started synchronously from inside the
admitted act, so the production `WriteCoordinator` queued it behind the import.
It completed after admission in 224.695 ms from queueing; the logger placed its
first `tag` insert after the import's `COMMIT`. The imported project contained
all 500 rows, and the queued tag was readable after settlement.

| Check                         | Fault injected                                        | Test that observed it                                                           | Observed failure                                                    |
| ----------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Real SQL statement accounting | Omitted the logger when opening the closable database | `measures preparation and admitted SQLite work separately for exactly 500 rows` | expected a logged `BEGIN IMMEDIATE` index at least 0, received `-1` |
| Native transaction accounting | Omitted the native transaction observer               | same production-path measurement test                                           | expected 507 native wrappers, received 0                            |

Both faults were watched and restored. The adjacent `Proof:` comments guard
against reporting either a fake zero statement count or a Drizzle-only count
that silently omits native controls. The row-count, stored-row,
transaction-boundary and post-commit queued-write assertions prevent a fast
refusal or empty import from masquerading as a measurement.

Fresh green evidence:

- `bun test src/import-performance.db.test.ts src/import.service.db.test.ts src/db.db.test.ts` from `libs/store-sqlite` — 19 passed, 0 failed, 90 assertions. Measurement output: `{"measurement":"plan-json-import-500","rows":500,"inputBytes":381862,"prepareMs":7.702,"prepareStatements":{"drizzle":0,"nativeControls":0,"total":0},"admittedMs":223.086,"admittedStatements":{"drizzle":7065,"nativeTransactionWrappers":507,"nativeControls":1014,"total":8079},"queuedWrite":{"completed":true,"elapsedMs":224.695,"completedAfterAdmission":true}}`.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint typecheck -p store-sqlite --skip-nx-cache --parallel=1 --output-style=static` — both targets passed.

At the Task 5.1 checkpoint, Tasks 4.3–4.5 and 5.2 remain unimplemented and
unchecked.

## Section 4.3 — generated-client facade and plan transfer controls

`ProjectApi` now exposes only `exportPlan(projectId)` and
`importPlan(document)` for archival transfer, with both methods backed by the
shared generated client. The plan toolbar names the combined menu
`Export / Import`, downloads the complete server JSON under `planFileName`, and
contains an `application/json` file input hidden behind the `Import JSON`
label. File reading, submission state, selection and import outcomes remain in
Task 4.4.

The production `WbsTable` test makes one download after collapsing a parent and
a second after filtering out a root. Both downloaded documents retain the
hidden rows by exact id and name. The initial TDD run failed four new assertions:
the facade methods were absent, the summary still read `Export`, and no
`Download JSON` control existed; the other 145 focused assertions passed.

Review repair added a persistent error toast for rejected downloads and a
`PlanImportRefusalError` that retains the generated client's validated refusal
object. Its focused 400 response names `unknown_ref`,
`workItems[12].dependsOn[0]`, and the exact missing-reference detail. Before
production repair, both new tests failed and the unhandled download rejection
was also reported by Vitest.

| Check                            | Fault injected                                                       | Test that observed it                                      | Observed failure                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Complete server JSON download    | Replaced the server document's workItems with production `shownRows` | `downloads JSON with collapsed and filtered-out rows`      | exact collapsed row `{ id: "w2", name: "Collapsed child exact" }` was absent; 1 failed, 28 skipped               |
| Visible rejected-download report | Removed the production promise rejection handler                     | `reports a rejected JSON download and creates no file`     | toast list stayed empty and Vitest reported unhandled `network unavailable exact`; 1 failed, 29 skipped, 1 error |
| Structured import refusal        | Replaced `PlanImportRefusalError(reply.body)` with `Error(error)`    | `retains a validated import refusal code, path and detail` | expected the named structured refusal and received only `Error: unknown_ref`; 1 failed, 55 skipped               |

Each production mutation was observed red independently, restored, and
recorded in its adjacent `Proof:` comment.

Fresh green evidence:

- `TZ=UTC bunx vitest run src/lib/wbs-api.test.ts src/components/wbs/plan-export.test.ts src/components/wbs/plan-toolbar.test.tsx --no-file-parallelism --maxWorkers=1` from `apps/fe-01` — 3 files passed, 151 tests passed.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx typecheck fe-01 --outputStyle=static` — target passed.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx lint fe-01 --outputStyle=static` — target passed.
- `bunx prettier --check apps/fe-01/src/lib/wbs-api.ts apps/fe-01/src/lib/wbs-api.test.ts apps/fe-01/src/components/wbs/wbs-table.tsx apps/fe-01/src/components/wbs/plan-toolbar.test.tsx openspec/changes/plan-json-import/verify.md` — all named files matched.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate plan-json-import --strict --json` — 1 change passed, 0 failed.

At the Task 4.3 checkpoint, Tasks 4.4–4.5 and 5.2 remain unimplemented and
unchecked.

## Section 4.4 — interactive JSON import

`ProjectPage` now owns the import attempt and production toast API outside the
project-keyed `WbsTable`. Its synchronous admission ref blocks a second file
read as well as a second request. An API-lifetime token ignores settlement from
a replaced page dependency; the captured source project prevents a valid old
completion navigating away from a project selected while it was pending.

Success installs a freshly read project catalogue, verifies that it contains
the created id, then uses the existing picker selection path. The one summary
toast is held by the page and rendered by the remounted table, so its lifetime
survives the project key. Cancellation remains inert; read, syntax, schema and
server failures retain the prior selection. The archival request is parsed once
as JSON and normalized by the existing shared Standard Schema declaration. Its
first issue is preserved as `invalid_body` with the exact document path and
validator detail rather than collapsed to generated preflight's
`invalid_request` code.

The repair TDD run was 4 failed / 52 passed: the picker value was empty after
success, two rapid changes invoked `readAsText` twice, the stale-completion
resolver had not yet been reached by the first async read, and the malformed
row produced no stable page toast. After the first implementation, the added
API-lifetime assertion was separately red because the replacement input
remained disabled; tying busy/admission state to the API token made the new
lifetime usable without allowing the old completion to report.

A subsequent ownership review found two earlier async boundaries were still
open. A file read or schema validation could settle after `api` changed and
still call the departed facade, and a catalogue fetched for the old facade
could install after replacement. Import now checks its lifetime after each
await and immediately before the write. Catalogue fetching and installation
are separate operations, with ownership checked after fetch and before install,
selection, and reporting. The new tests were first observed red together: the
held-reader case called the old `importPlan` once instead of zero, and the held
catalogue selected `Imported exact` instead of retaining `Rewire the shed`.

| Check                      | Fault injected                                                           | Production-path test                                                                  | Observed RED                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stable success report      | Omitted the page-owned toast API passed into the keyed table             | `refreshes the picker catalogue and keeps one success toast across the table remount` | expected the exact 40-row/one-tag summary; received `[]`                                                                                                 |
| Installed catalogue        | Read `api.listProjects()` without installing it through `reloadProjects` | same success case                                                                     | picker expected `Imported exact`; received an empty value while the imported tree opened                                                                 |
| Synchronous admission      | Removed the `admittedLifetime` early return                              | `admits only one asynchronous file read and request at a time`                        | `readAsText` expected 1 call; received 2                                                                                                                 |
| Departed-project ownership | Removed the source/current project comparison                            | `does not navigate when an import completes after its project was departed`           | picker expected `Paint the fence`; received `Imported exact`                                                                                             |
| API-lifetime ownership     | Removed the lifetime guards from success, failure and settlement         | `ignores an import completion from a replaced API lifetime`                           | expected no toast; received `Plan JSON import failed (imported_project_missing).`                                                                        |
| Actionable schema issue    | Replaced `PlanDocumentSchemaError` with `Error('invalid_request')`       | `reports a malformed row with its exact schema path and detail`                       | expected `invalid_body` at `workItems[0].priority` with `must be a number or null (was a string)`; received `Plan JSON import failed (invalid_request).` |
| File read failure          | Removed `FileReader.onerror` rejection                                   | `reports an asynchronous file read failure without submitting`                        | expected `file_read_failed`; received no toast                                                                                                           |
| Same-file reselection      | Removed `input.value = ''` settlement reset                              | `clears the file control so the same file can complete twice`                         | expected empty input value; retained exact `C:\\fakepath\\plan.json`                                                                                     |
| Refusal keeps selection    | Injected `openProject('p2')` into the request-refusal path               | `keeps the selected project when the request returns a structured refusal`            | picker expected `Rewire the shed`; received `Paint the fence`                                                                                            |
| Pre-write lifetime         | Removed both post-read and pre-write lifetime checks                     | `does not submit a file whose read finishes after the API lifetime is replaced`       | old `importPlan` expected 0 calls; received 1                                                                                                            |
| Pre-install lifetime       | Installed the fetched catalogue before its post-fetch lifetime check     | `does not install a catalogue fetched by a replaced API lifetime`                     | expected no `project-option-p3`; received the exact stale `Imported exact` option                                                                        |
| Busy file control          | Replaced `disabled={importBusy}` with `disabled={false}`                 | `disables the import file control while an import is in flight`                       | expected the input disabled; received an enabled input                                                                                                   |

Each fault was applied separately, observed red, restored and named by an
adjacent `Proof:` comment. The success case also asserts one `data-toasts`
region, the exact selected name and the imported option. Request-phase admission
is independently held after the async read and asserts one read and one request;
the toolbar test separately proves the rendered disabled state.

Fresh green evidence:

- `TZ=UTC bunx vitest run src/lib/wbs-api.test.ts src/components/wbs/plan-toolbar.test.tsx src/components/wbs/project-page.test.tsx --no-file-parallelism --maxWorkers=1` from `apps/fe-01` — 3 files passed, 153 tests passed.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run fe-01:lint --skip-nx-cache --output-style=stream` — passed.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run fe-01:typecheck --skip-nx-cache --output-style=stream` — passed.
- `bunx prettier --check apps/fe-01/src/lib/wbs-api.ts apps/fe-01/src/components/wbs/use-plan-read.ts apps/fe-01/src/components/wbs/use-plan-import.ts apps/fe-01/src/components/wbs/plan-toolbar.tsx apps/fe-01/src/components/wbs/wbs-table.tsx apps/fe-01/src/components/wbs/plan-toolbar.test.tsx apps/fe-01/src/components/wbs/project-page.tsx apps/fe-01/src/components/wbs/project-page.test.tsx openspec/changes/plan-json-import/tasks.md openspec/changes/plan-json-import/verify.md` — all named files matched.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate plan-json-import --strict --json` — 1 change passed, 0 failed.

At the Task 4.4 checkpoint, Tasks 4.5 and 5.2 remain unimplemented and
unchecked. The full h2puni gate and browser gate remain Task 5.2 and were not
run here.

## Section 4.5 — owned-stack browser import

`apps/fe-01/e2e/plan-import.spec.ts` uses the shared `seedPlan` and
`openSeededPlan` fixture against public HTTP and the real picker. The success
case downloads a real 13-row document, checks every exported row id, validates
it through generated `importProject` preflight, gives the copy a unique name,
and adds one unique file-local tag to its first row. The hidden file chooser
imports that document; the picker selects and offers the exact new name, and
one toast reports 13 rows and the one created tag.

The refusal case downloads at least 13 rows and completes generated preflight
before injecting `missing-file-row` at `workItems[12].dependsOn[0]`. The
fixture's generated client was extended only with `listProjects`, which proves
the backend project count before and after. The browser receives exact
`unknown_ref` at that path, retains the seeded project, and the backend count
does not change.

The run used `E2E_PORT_SHIFT=8700`: be-01 `11800`, gw-01 `11900`, fe-01
`12900`. A privileged `ss -ltn` check immediately before each browser run found
no listener on any port. `CI=1` made reuse impossible, and the final green run
owned `tmp/e2e-1789380828433.db` through the Playwright config.

R5 proof: `firstDependencyRefusal(document.workItems)` was replaced with a null
refusal, then only the dangling-dependency browser case ran on the same isolated
ports with its own `tmp/e2e-1789380439296.db`. It failed after 32.9 seconds:
the toast expected `Plan JSON import refused: unknown_ref at
workItems[12].dependsOn[0].` and received exact `Plan JSON import failed
(http_500).` The production guard was restored; the adjacent `Proof:` comment
is on the browser assertion.

Fresh green evidence:

- `CI=1 NX_DAEMON=false NX_ISOLATE_PLUGINS=false E2E_PORT_SHIFT=8700 bunx playwright test --config apps/fe-01/playwright.config.ts apps/fe-01/e2e/plan-import.spec.ts` — 2 passed in 13.5 seconds against the owned ports/database above. Vite logged websocket-proxy `EPIPE` while a page was replaced; neither case nor server readiness failed.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run fe-01:test:unit --skip-nx-cache --output-style=stream` — 34 files and 552 tests passed in 4.6 seconds when run with permission for its documented Bun subprocess probes. The sandboxed attempt failed 3 probes with `spawnSync bun EPERM`; no assertion or code fault was involved.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run fe-01:typecheck --skip-nx-cache --output-style=stream` — passed in 2.5 seconds.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run fe-01:lint --skip-nx-cache --output-style=stream` — passed in 42.1 seconds. Before repair, direct ESLint exposed the wrapper's otherwise silent `no-unnecessary-condition` on a null check forbidden by Playwright's precise download-path type.
- `bunx prettier --check apps/fe-01/e2e/plan-import.spec.ts apps/fe-01/e2e/plan-fixture.ts openspec/changes/plan-json-import/tasks.md openspec/changes/plan-json-import/verify.md` — all named files matched.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate plan-json-import --strict --json` — 1 change passed, 0 failed.
- `git diff --check` — passed.

At the Task 4.5 checkpoint, only Task 5.2 remains unchecked.

## Section 5.2 — final verification (in progress)

The affected-project matrix was run uncached with
`NX_CLOUD=false NX_NO_CLOUD=true NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t test lint typecheck -p contracts core store-sqlite store-memory conformance be-01 fe-01 mcp-01 --skipNxCache --parallel=2 --outputStyle=static`.
Every requested lint and typecheck target passed. The first sandboxed test pass
also passed every test target except three environment-bound targets: be-01
could not bind loopback (`EPERM`), fe-01 subprocess probes could not run, and
contracts could not find the worktree-local `node_modules/.bin/tsc`.

The exact failed test targets were then rerun outside the network/process
sandbox. The combined rerun began before the worktree dependency link was
present, so its backend and frontend results were green while contracts was
superseded by a contracts-only rerun after adding that link. Fresh terminal
evidence:

- `NX_CLOUD=false NX_NO_CLOUD=true NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run contracts:test --skipNxCache --outputStyle=static` — 394 passed, 0 failed.
- `NX_CLOUD=false NX_NO_CLOUD=true NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t test -p contracts be-01 fe-01 --skipNxCache --parallel=1 --outputStyle=static` — be-01 passed 1,075 tests with one pre-existing skip; fe-01 passed 107 files and 2,778 tests plus 2 zoned files and 3 zoned tests. Contracts in this earlier rerun still lacked the worktree dependency link and was superseded by the green contracts-only command above.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx format:check --all --outputStyle=static` — passed.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --strict --json` — every reported spec and change was valid; exit 0.
- `git diff --check origin/main...HEAD` — the committed branch was clean before
  the browser-discovered repair below; this result does not cover that
  uncommitted repair.

The first whole-browser run used
`CI=1 NX_DAEMON=false NX_ISOLATE_PLUGINS=false E2E_PORT_SHIFT=9700 bun run e2e`
against be-01 `12800`, gw-01 `12900`, fe-01 `13900` and its fresh Playwright
database. It completed 370 passed and 37 skipped in 19.3 minutes, with four
failures. Both phone sweeps measured the new Import JSON label at 32px rather
than the required 44px. Both 1280px toolbar budgets measured about 42px of
unbudgeted width after the Export summary became Export / Import.

The repair keeps the required exact menu name but wraps its summary inside the
old width budget, and includes the visible file-input label in the existing
phone-surface tap-target floor. The four failed production-path cases were then
rerun together with
`CI=1 NX_DAEMON=false NX_ISOLATE_PLUGINS=false E2E_PORT_SHIFT=9700 bunx playwright test --config apps/fe-01/playwright.config.ts apps/fe-01/e2e/mobile.spec.ts apps/fe-01/e2e/optimization-cue.spec.ts apps/fe-01/e2e/project-settings.spec.ts --grep "gives every control on the phone’s own surfaces at least 44px|is still cards, at a finger’s size, and still does not scroll sideways|lays the 1280 toolbar out inside its budget with the cue on it|the toolbar keeps its 1280 budget with one settings control"`:
4 passed in 13.3 seconds. The same repaired frontend then passed 552 unit tests,
lint, typecheck and named-file Prettier checks. An Astra xhigh review found no
production-code issue and independently passed the 39 toolbar/style tests.

A fresh whole-browser rerun used
`CI=1 NX_DAEMON=false NX_ISOLATE_PLUGINS=false E2E_PORT_SHIFT=9900 bun run e2e`
on separately owned ports be-01 `13000`, gw-01 `13100` and fe-01 `14100`, with
fresh database `tmp/e2e-1789383780717.db`. It completed 374 passed, 37
intentionally skipped and 0 failed in 19.3 minutes. Vite's websocket proxy
logged `EPIPE` as test pages disconnected; server readiness and the terminal
Playwright result remained green.

The h2puni exact-SHA gate has not run. Task 5.2 therefore remains unchecked.
