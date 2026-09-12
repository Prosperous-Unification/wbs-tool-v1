# Verification — `core-lib-extraction`

Nothing below is a claim until it carries observed output. A row with an empty **Observed**
cell is a check that has not been watched failing and therefore is not done (R5).

## Wave 0 collision gate

Re-run 2026-09-08 against `main` @ `5bb095a5`, over the file set this change declares: every
`project.json`, `eslint.config.js`, `tsconfig.base.json`, `package.json`, and all of
`apps/be-01/src/**`.

| Source                                      | Finding                                                                                                                                                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openspec/changes/dual-optimized-scheduler` | **Collides, hard.** Its remaining slices name `libs/domain`'s `SCHEDULER_CONTRACT_VERSION` and the optimizer's repository seams — files this change moves. It lands first or it rebases onto the new paths. |
| `openspec/changes/plan-json-import`         | **Collides.** An unbuilt `ImportService` under `apps/be-01/src/service/`, which is a directory this change empties. Whichever lands second writes it in `libs/core`.                                        |
| `openspec/changes/retired-schema-cleanup`   | **Coordinate.** Its §4 migrates `insertSubtree`, which moves to `libs/store-sqlite` here.                                                                                                                   |
| Open PRs                                    | (to be re-read at the moment this change starts — the gate is only true for the window it names)                                                                                                            |

## Failure-proof table

| Check                                      | Fault injected                                                             | Test that observed it        | Observed                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------- |
| Every project declares one ring            | a project's `ring:` tag removed                                            |                              |                                                                                    |
| A project cannot declare two               | a second `ring:` tag added                                                 |                              |                                                                                    |
| The application ring imports no adapter    | `@wbs/store-sqlite` imported from a `libs/core` production file            |                              |                                                                                    |
| The exemption stops at the production file | the same import moved out of `compose.test.ts` and into the file beside it |                              |                                                                                    |
| Core reaches for no driver                 | `drizzle-orm` imported, and `Bun` referenced, in a core production file    |                              |                                                                                    |
| Domain reaches for no node built-in        | `node:crypto` imported in `libs/domain`                                    |                              |                                                                                    |
| The relocated `bun:sqlite` ban still bites | `new Database()` outside `store-sqlite/db.ts`                              | `store-sqlite:lint`          | `direct-open-probe.ts:1:1`: restricted import; open through `store-sqlite/db.ts`   |
| The typecheck target compiles something    | `const deliberatelyWrong: number = 'not a number'` in each new lib         |                              |                                                                                    |
| The composition runs without an adapter    | (the proof itself: core over the memory source, no HTTP, SQLite or Bun)    |                              |                                                                                    |
| Project discovery reaches nested projects  | recursive descent replaced with `continue`                                 | `workspace-projects.test.ts` | expected outer/protocol; received `[]`                                             |
| Manifest axes and targets are required     | axis loop and nonempty-target guard removed                                | `workspace-projects.test.ts` | `readProjects unexpectedly succeeded`                                              |
| Duplicate project names are refused        | duplicate-name branch removed                                              | `workspace-projects.test.ts` | `readProjects unexpectedly succeeded`                                              |
| Unreadable state is not absence            | unreadable directory and manifest treated as empty/absent                  | `workspace-projects.test.ts` | both reported `readProjects unexpectedly succeeded`                                |
| Project symlinks are refused               | symlink rejection skipped                                                  | `workspace-projects.test.ts` | `readProjects unexpectedly succeeded`                                              |
| Memory history survives a staged commit    | replace independent history with the committed staged state                | `memory-source.test.ts`      | saved input was `undefined`; `toContain` rejected the non-array/non-string value   |
| Memory reads detach stored values          | return a stored project-step array directly                                | `memory-source.test.ts`      | expected `Dev`; received `Caller mutation`                                         |
| Memory dependencies have one table         | construct subtrees over a second dependency fixture                        | `memory-source.test.ts`      | expected the committed dependency; received `[]`                                   |
| Admitted stores do not retake their gate   | gate the stores already admitted inside a held batch                       | `memory-source.test.ts`      | expected `applied`; received `timed-out`                                           |
| A rollback discards its staged graph       | reuse the refused staged state for the next batch                          | `memory-source.test.ts`      | expected no refused step; received `["Refused only"]`                              |
| Capture is independent of the command gate | take the command coordinator while production `SavedPlanService.save` runs | `memory-source.test.ts`      | expected not `timed-out`; received `timed-out`, then cleanup drained both promises |

## Slice 1 — the rings

| Command                                              | When       | Result                                                                                                                                                                                |
| ---------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bunx nx run-many -t lint typecheck --skip-nx-cache` | 2026-09-08 | **24 projects, clean**                                                                                                                                                                |
| `bun run test:unit`                                  | 2026-09-08 | 7 tasks green                                                                                                                                                                         |
| `bun test` in `tools/tool-devsync`                   | 2026-09-08 | 60 pass / 6 fail — the six are **pre-existing**, measured on the parent commit as 58/6, and are the poller's shell-helper cases; they fail the same way on `main` in this environment |

The workspace lint is the verdict here rather than per-project runs: a rule that changes what
may import what is exactly the kind that passes project by project and fails as a set
(2026-08-30's import-sort incident).

## Slice 2a — `libs/core` exists, and holds what has no adapter in it

| Command                                              | When       | Result                                                      |
| ---------------------------------------------------- | ---------- | ----------------------------------------------------------- |
| `bunx nx run-many -t lint typecheck --skip-nx-cache` | 2026-09-08 | **25 projects, clean** (24 before; `core` is the new one)   |
| `bun test` in `apps/be-01`                           | 2026-09-08 | 2,035 pass / 2 skip / 0 fail, same count as before the move |
| `bun run test:unit`                                  | 2026-09-08 | 7 tasks green                                               |

## Slice 2.2a.1 — signatures that blocked the store ports

| Command                                              | When       | Result                                   |
| ---------------------------------------------------- | ---------- | ---------------------------------------- |
| `bunx nx run-many -t lint typecheck --skip-nx-cache` | 2026-09-08 | 25 projects, clean                       |
| `bun test` in `apps/be-01`                           | 2026-09-08 | 2,035 pass / 2 skip / 0 fail, same count |
| `bun run test:unit`                                  | 2026-09-08 | 7 tasks green                            |

At this checkpoint, `repository/index.ts` imported `@wbs/core`, `@wbs/domain` and one
adapter-only event-log type, with no import from `./schema` or `./db`. Adding an adapter
import back was already watched failing through the ring rule in slice 2a.

`SavedPlanRow` was still `typeof savedPlan.$inferSelect` in the saved-plan port at this
checkpoint. Slice 2.2b.1 below subsequently declared it explicitly and moved the remaining
history contracts into core.

`.nxignore` also gained `.worktrees`. Two worktree checkouts appeared below this checkout
mid-slice, and Nx read them as duplicate projects, failing `run-many` before a target ran.
The repository convention is `.worktrees/<name>`, so Nx excludes that directory.

## Slice 2.0 — recursive workspace project discovery

| Command                                                                               | When       | Result                                                                                                                                |
| ------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `bun test tools/tool-devsync/src/{workspace-projects,workspace-targets,sync}.test.ts` | 2026-09-09 | **49 pass / 0 fail**                                                                                                                  |
| `bunx eslint tools/tool-devsync/src tools/tool-devsync/workspace-projects.mjs`        | 2026-09-09 | clean                                                                                                                                 |
| `bunx tsc --build --force tools/tool-devsync/tsconfig.json`                           | 2026-09-09 | clean; root `.mjs` checked by the spec project                                                                                        |
| `bunx prettier --check` on all changed tool-devsync files                             | 2026-09-09 | clean                                                                                                                                 |
| `bunx nx test tool-devsync --skip-nx-cache`                                           | 2026-09-09 | **71 pass / 6 fail**; all six are the existing macOS poller failures caused by GNU-only `mv -T`, unchanged from the prior 60/6 record |

Removing the nested supervisor protocol entry from `RESTART_PATHS` failed the production
coverage case on `Expected to contain: "libs/contracts/solver/supervisor-protocol/project.json"`.

## Slice 2.2b — transaction-free history ports

- `bun test` over the seven event-log, optimizer-event, saved-plan atomicity/quota/busy,
  capture, and core boundary files: **50 pass / 0 fail** on 2026-09-09.
- `bunx tsc --build --force libs/core/tsconfig.json apps/be-01/tsconfig.json`: clean.
- Adding `recordEventIn`, `holdingOf`, or `bodyOf` to a core port independently failed
  `store-boundaries.test.ts` at TS2741 because its adapter-free fixture lacked that method.
- Moving the saved-plan quota callback before `BEGIN IMMEDIATE` admitted the injected rival
  connection and failed on `Expected: [false] · Received: [true]`.
- Throwing from event insertion after the optimized cache write is covered by
  `rolls a plan-infeasible certificate back when recording its event crashes`; both durable
  rows remain inside the same SQLite transaction.

## Slice 2.2b.1 — core-owned store contracts

- `bunx tsc --build --force libs/core/tsconfig.json`: clean; this compiles
  `ports/stores.types.test.ts`.
- `bunx tsc --build --force apps/be-01/tsconfig.json`: clean; this compiles
  `repository/store-contracts.types.test.ts`.
- `bun test` in `libs/core`: **5 pass / 0 fail**.
- `bunx eslint libs/core/src apps/be-01/src/repository/store-contracts.types.test.ts`:
  clean.
- `bunx prettier --check libs/core/src apps/be-01/src/repository/store-contracts.types.test.ts`:
  clean.
- Removing the expected error from the valid command-scope fixture failed
  `core:typecheck` on TS2339: `PlanTransactionalStores` has no `savedPlans`.
- Dropping nullable `scheduleAbsentReason` from the explicit core row failed
  `be-01:typecheck` at the adapter-to-port boundary on TS2741.

## Slice 2.2b.2 — command graphs from admitted scopes

- `bun test` over `plan-command-scope.test.ts`, `announcement-ownership.db.test.ts`,
  `plan-commands.db.test.ts` and `sqlite-unit-of-work.db.test.ts`: **33 pass / 0 fail**.
- `bun test` over the write-coordinator, mounted work-item, route and app files:
  **20 pass / 0 fail**. The framed-request case required the permitted localhost socket;
  under the restricted sandbox Bun reported `EADDRINUSE` for `port: 0`.
- `bunx tsc --build --force apps/be-01/tsconfig.json`: clean.
- ESLint and Prettier over every changed application file: clean.
- Building a batch from `publicServices` let `rolled back` survive a refusal and failed
  on `Expected: [] · Received: ["rolled back"]`.
- Reusing the first staged graph made the later batch disappear and failed on
  `Expected: ["kept", "later"] · Received: ["kept"]`.
- Repairing through the discarded graph failed the in-window assertion on
  `Expected: true · Received: false`; the queued writer remained behind the repair turn.

## Slice 2.2b.3 — runtime contracts and pure deadlines

- `bun test` over the clock, push-deadline, retention-timer, saved-plan-retry and
  logger suites: **38 pass / 0 fail**.
- `bun run test:unit`: **897 pass / 1 intentional skip / 0 fail** in `be-01`, then
  all seven library test targets green. The first restricted run failed only where three
  tests needed ephemeral localhost sockets; the permitted rerun passed those cases.
- `bunx tsc --build --force` for contracts, core, runtime-portable, observability and
  `be-01`: clean.
- ESLint and Prettier over every changed contracts, core, runtime-portable,
  observability and `be-01` file: clean.
- Removing the two expected errors from the real `WorkItemService` and `AuthService`
  constructions failed `be-01:typecheck` twice on TS2741: required `clock` was missing.
- The existing deadline proof cases still cover a timeout during fetch, a delayed timer
  after fetch settles, and cleanup after completion.

## Slice 2.2b.4 — OIDC verifier boundary

- The four service/controller/identity files: **71 pass / 0 fail**; `boot.db.test.ts`:
  **13 pass / 0 fail** with its required ephemeral localhost sockets.
- `bun test` in `libs/auth`: **95 pass / 0 fail**, including the real local JWKS adapter.
- `bun run test:unit`: **897 pass / 1 intentional skip / 0 fail** in `be-01`, then
  all seven library test targets green.
- Contracts, core, auth and `be-01` typechecks: clean. ESLint and Prettier over every
  touched target: clean.
- Returning null for a discovery outage failed the mounted verifier-outage case on
  `Expected: 500 · Received: 401`.
- Catching account resolution as an invalid credential failed its mounted outage case on
  `Expected: 500 · Received: 401`.
- Falling back while password sessions were disabled failed the literal service case:
  expected null, received the authenticated `legacy` account.

## Slice 2.2c — directory and project service families

Verified 2026-09-09 from base `7cf1631849bb980660d172f44be57e6aa8dd089f`.

- Auth, project, step, directory, capacity, priority-band and calendar-marker services
  now live under `libs/core/src/service/` with their original basenames. Their old
  be-01 paths reexport inward. Shared pure siblings moved first: assumed-assignee,
  broadcast, clean-name, directory-usage and login-throttle.
- `NumberedWorkItem` and its `Days` value shape were extracted into
  `numbered-work-item.ts` so broadcast does not import work-item behavior.
  The old work-item and roll-up type exports remain compatible. Optimizer process
  code remains in be-01; only `OptimizerAvailability` moved to the scheduler port.
- `STEP_POSITION_STEP`, `StepHoldings` and `stepIsInUse` now have one domain
  authority in `libs/domain/src/step.ts`. SQLite and service callers use it;
  previous exports remain compatible. `servicesOver` already accepted
  `PlanTransactionalStores` at this slice's base and required no further change.

| Command                                                                                       | Observed                                                                                      |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Baseline nine service suites before moving                                                    | 124 pass, 0 fail                                                                              |
| `bun test ./libs/core/src`                                                                    | 35 pass, 0 fail, 8 files                                                                      |
| Six retained service suites below                                                             | 97 pass, 0 fail, 6 files                                                                      |
| `bun test ./apps/be-01/src/repository/step.db.test.ts`                                        | 25 pass, 0 fail                                                                               |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun run test:unit` with permitted localhost sockets | be-01: 872 pass, 1 intentional source-capability skip, 0 fail; all seven library targets pass |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint typecheck --skip-nx-cache` | 25 projects, all 50 targets pass, 1m 14s                                                      |
| Prettier check through its API on all changed/new code and config                             | 53 files pass                                                                                 |
| `git diff --check`                                                                            | clean                                                                                         |

Four suites relocated without changing executable assertions: `assumed-assignee.test.ts`
(7), `calendar-marker.service.test.ts` (17), `directory-usage.test.ts` (3) and
`login-throttle.test.ts` (2). This transfers 29 cases out of be-01; core now has its
previous 5 plus those 29 and one new production-boundary test (35 total).

Retained in be-01: `auth-service-null-password.test.ts` (4) uses real Bun password/token
adapters; `broadcast.test.ts` (11) composes the be-01 service graph; and the SQLite
suites `step.service.db.test.ts` (22), `directory.service.db.test.ts` (51),
`capacity-migration-identity.db.test.ts` (3), `priority-band-identity.db.test.ts` (6).
Moving adapter-composition tests produced a real Nx cycle through their be-01 fixtures.
The authorized resolution retained those suites and extracted only the pure fixtures
needed by relocated tests into `libs/core/src/testing/`, with old fixture paths
reexporting inward. No lint exception or hidden graph edge was introduced.

| Check                                           | Injected fault                                                                                                        | Observed                                                                                                                                                                                 |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The production family exists in core            | Before moving the family, run `service-boundaries.test.ts`                                                            | Expected true, received false for core's missing `assumed-assignee.ts`                                                                                                                   |
| The test exemption stops at adjacent production | Add `import '../../../../apps/be-01/src/repository/schema';` at the top of `libs/core/src/service/project.service.ts` | Both `core:lint` and `service-boundaries.test.ts` fail on `@nx/enforce-module-boundaries`: “Projects cannot be imported by a relative or absolute path, and must begin with a npm scope” |

The injected import was removed before green verification; the observed diagnostic is
recorded beside the test. The broader driver/global enforcement inventory remains task 2.3.

The first restricted unit run failed only its three ephemeral HTTP-server cases; the
permitted rerun above passed them. One exploratory Bun command omitted `./` and also
collected generated `dist/out-tsc` tests; the final runs explicitly scoped source paths.
An initially requested nonexistent `repository/step.test.ts` contributed no cases;
the actual `step.db.test.ts` was then run separately with the 25-case result above.
Builds, the complete database tier, Chromium and the final landing gate were not run
for this checkpoint. Task 5.1 still owns adding core to the root fast-tier inventory;
core was run explicitly here.

### Review fix 1 — clock oracle follows moved services

The review found that `apps/be-01/src/service/clock.test.ts` still scanned only its
own folder. That folder now contains compatibility reexports for this slice's services.

- Adding `now?: () => number;` to the moved `CapacityServiceOptions` left the old
  oracle green: **4 pass, 0 fail**. It was reading the be-01 shim.
- The oracle now scans both `apps/be-01/src/service` and `libs/core/src/service`,
  reports paths instead of ambiguous basenames, and asserts that it sees the actual
  core CapacityService and still-local WorkItemService definitions.
- With that same core fault retained, the corrected clock case failed:
  expected `[]`, received `["libs/core/src/service/capacity.service.ts"]`
  (**3 pass, 1 fail**).
- A separate injected private `stampFor(actorId: string): WriteStamp` method in
  core's CapacityService failed the second case on that same path (**3 pass, 1 fail**).
- Removing the core folder from the scan failed its coverage assertion on
  `Received: undefined`, while both shape checks passed (**3 pass, 1 fail**).
  The initial coverage assertion used `toContain` on an absent value and produced a
  matcher type error; it now checks presence first and the final negative above
  was observed at `toBeDefined`.
- All injected faults are removed. The clock, core clock and calendar-marker suites
  pass **23 tests, 0 fail**; the clock suite remains four cases.
  Forced core/be-01 lint and typecheck targets pass; Prettier and `git diff --check`
  are clean. Only the clock oracle and this evidence changed; production code is
  byte-identical to the checkpoint.
- The broader unit, database and browser gates were not repeated for this test-only
  review fix; their checkpoint results and outstanding limitations above still apply.

## Slice 2.2c.1 — work-item services and pure satellites

Verified 2026-09-09 from clean, current-main-merged base `5352ae704041`.

- `work-item.service`, `plan-command`, `plan-commands`, `compensating`, `dependency`
  and `roll-up` now live under `libs/core/src/service/`; their be-01 paths reexport
  inward. `UnitOfWork`, generic `Scope<S>` and `Decision<T, S>` live in
  `core/ports/unit-of-work.ts` and preserve a source's admitted store subtype.
- The command runner consumes the four-service `PlanCommandServices` contract. The app
  supplies work items, directory, capacity and priority bands; core no longer imports the
  app graph, SQLite schema or optimized runtime reader.
- Ten pure suites moved adjacent to core without changing their named test structure:
  compensating (3), dependency (16), plan-command scope (1), roll-up (34), work-item
  service (98), estimate (13), actual (17), progress (21), measure (27) and freeze (8).
  An AST comparison found every named `describe`/`it`/`test` call identical and ordered
  for every old/new pair.
- `revision.db.test.ts` (27), `undo.db.test.ts` (89) and `plan-commands.db.test.ts` (23)
  remain in be-01 because they open SQLite and construct repository adapters directly.
  Their 139 cases ran with the 238 relocated cases: **377 pass / 0 fail**, 946 assertions.
- Pure in-memory fixtures required by the relocated suites now live under
  `libs/core/src/testing/`; old app fixture paths reexport inward. The core scheduler fake
  implements the scheduler port and imports no optimizer runtime adapter.

| Command                                                        | Observed                                                                                 |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `bun test ./libs/core/src`                                     | 273 pass, 0 fail                                                                         |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun run test:unit`   | be-01 640 pass, 1 intentional capability skip, 0 fail; all seven listed libraries passed |
| forced `core:typecheck` and `be-01:typecheck`                  | both pass                                                                                |
| uncached `core:lint`, `be-01:lint` and `fe-01:lint`            | all pass                                                                                 |
| Prettier over core and touched app sources; `git diff --check` | clean                                                                                    |

The be-01 fast-tier count fell by 238 because those exact cases moved into core. Core is
still outside the root fast-tier project list until task 5.1, so its complete 273-case
source suite was run explicitly rather than inferred from `test:unit`.

| Check                                     | Injected fault                                                                      | Observed                                                                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relocated production family exists        | Run the expanded boundary test before moving production                             | Expected true, received false for missing `libs/core/src/service/compensating.ts`                                                                                 |
| Production core cannot import the app     | Import `apps/be-01/src/repository/schema` from adjacent core `work-item.service.ts` | `core:lint` failed at line 41 with `@nx/enforce-module-boundaries`: “Projects cannot be imported by a relative or absolute path, and must begin with a npm scope” |
| Source-specific stores survive the port   | Remove the store generic from `UnitOfWork`                                          | `core:typecheck` failed on TS2315 (`UnitOfWork` is not generic) and TS7006 for the erased scope parameter                                                         |
| Clock authority follows the moved service | Remove `export` from core's `WorkItemService`                                       | Clock authority test failed because the core source no longer contained `export class WorkItemService`                                                            |

All injected faults were removed before the restored green runs. Independent review found
and rechecked the generic port, test relocation, live source links and source-neutral JSDoc;
spec compliance and code quality passed with no remaining findings. The complete workspace,
database and browser gates remain owned by the final integration task.

## Slice 2.2c.2 — saved-plan and publication services

Verified 2026-09-09 from base `207bc347`.

- Saved-plan default naming, input projection, integrity, quota, retry, schedule body,
  captured scheduling and `SavedPlanService` now live under `libs/core/src/service/`.
  History, replay buffer/orchestration, retention jobs and `GatewayBroadcaster` moved with
  them. `OptimizerTriggerBroadcaster`, another pure publisher, moved in the same family.
- `GatewayBroadcaster` consumes the source-neutral `PushTransport` port. The HTTP client,
  bounded retry logic and real fetch cancellation live in
  `libs/runtime-portable/src/push-client.ts`; the old be-01 paths reexport inward.
- `ReplayBuffer` and `RetentionTimer` require clocks from composition. Retention consumes
  `Intervals.every`, whose cancellation closes the runtime-owned handle, and drains an
  active sweep before stopping. Saved-plan retry likewise requires its monotonic clock and
  sleep capability instead of reaching runtime globals. `LoginThrottle` also requires its
  clock, and ordinary password-only app composition receives the same process clock as the
  rest of the service graph.
- Fifteen pure test files moved beside their authorities. An AST comparison found every
  named `describe`/`it`/`test` node identical and ordered for all old/new pairs, including
  broadcast, gateway, optimizer trigger, plan history, replay buffer and its properties,
  retention, five saved-plan helpers, and the three push-client suites.
- SQLite suites remain in be-01. The focused saved-plan/replay/retention/gateway group ran
  **98 pass / 0 fail**. The independent-history suite separately ran **3 pass / 0 fail**,
  including successful saved plans surviving both batch commit and rollback.

| Command                                                                                       | Observed                                                                                       |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `bun test ./libs/core/src/service ./libs/core/src/ports`                                      | 362 pass, 0 fail                                                                               |
| Push unit/deadline suites                                                                     | 17 pass, 0 fail                                                                                |
| Push real-socket cancellation suite with permitted localhost sockets                          | 2 pass, 0 fail; headers and body stalls both cancelled                                         |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun run test:unit` with permitted localhost sockets | be-01: 532 pass, 1 intentional source-capability skip, 0 fail; all seven listed libraries pass |
| forced `core:typecheck`, `runtime-portable:typecheck` and `be-01:typecheck`                   | all pass                                                                                       |
| uncached `core:lint`, `runtime-portable:lint` and `be-01:lint`                                | all pass                                                                                       |

The be-01 fast tier fell from 640 to 532 because 108 pure cases moved to core or
runtime-portable. Those two projects remain outside the root fast-tier inventory until task
5.1, so both were run explicitly here. The first restricted root run failed only when a
test tried to bind an ephemeral localhost socket; the permitted rerun passed. The complete
database, browser and landing gates remain task 5.2.

| Check                                   | Injected fault                                                                | Observed                                                                                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Production family exists in core        | Run the expanded boundary test before moving production                       | Expected true, received false for missing `libs/core/src/service/gateway-broadcaster.ts`                                                               |
| Core cannot import the SQLite adapter   | Import be-01 repository schema from adjacent core `gateway-broadcaster.ts`    | `core:lint` failed with `@nx/enforce-module-boundaries`: “Projects cannot be imported by a relative or absolute path, and must begin with a npm scope” |
| Replay clock is supplied by composition | Remove `now` from production `ReplayBuffer` construction                      | `be-01:typecheck` failed at `services.ts:303` with TS2741: property `now` is missing in `ReplayBufferOptions`                                          |
| Retention runtime is explicit           | Remove `intervals`, then `now`, from production `RetentionTimer` construction | `be-01:typecheck` failed at `services.ts:427` with TS2741 for each missing required property                                                           |
| Login throttle clock is composed        | Remove `now` from production `LoginThrottle` construction                     | `be-01:typecheck` failed at `app.ts:193` with TS2741: property `now` is missing in `LoginThrottleOptions`                                              |

All injected faults were removed before green verification. The existing push deadline and
cleanup oracles retained their names and passed after relocation. `SavedPlanRetryOptions`
also requires `nowMs` and `sleep`; it has no production caller until task 2.2d creates the
save use case, so this slice has no production-call-path negative for those two fields.

## Slice 2.2d — endpoint bindings and use-case admission

Verified 2026-09-10 from base `3b0668a9`.

- The framework-free endpoint contract, route builder and ten binding modules now live
  under `libs/core/src/http/`; the old be-01 paths are inward reexports. OIDC,
  password-auth and infrastructure endpoint builders remain in be-01 because they bind
  provider, cookie, throttle, logger, metric and database adapters.
- Nine pure route suites (20 cases) and the two-case endpoint suite moved beside their
  authorities. Their named `describe`/`it`/`test` calls and order are unchanged. SQLite,
  mounted Elysia and controller tests remain with the application adapter.
- `runCommandBatch`, `savePlan`, `replay` and `retentionSweep` expose named graph, input
  and outcome interfaces. Batch and save admission now check write scope directly;
  save also reads the project, checks ownership and publishes once only after `saved`.
  Replay and retention require an internal principal at their direct boundaries.
- HTTP still authenticates the principal before invoking the bindings. The use cases
  consume that trusted principal and never derive identity from request bodies. An actor
  id without account provenance is denied when it does not own the project; adapter
  authentication remains the guarantee that the principal represents an account.
- Pre-parse policies and status-specific response alternatives are unchanged. The
  production application still binds every shared HTTP shape exactly once.

- Focused core HTTP, use-case and retention-timer source tests: **36 pass / 0 fail**,
  136 assertions across 12 files.
- `bun test apps/be-01/src/http/elysia/*.test.ts`: **85 pass / 0 fail**, 681
  assertions across seven files.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx test core`: **390 pass / 0
  fail**, 1379 assertions across 41 files.
- Uncached `core:typecheck`, `be-01:typecheck`, `core:lint` and `be-01:lint`: all
  pass. Prettier over the touched core/app sources is clean.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun run test:unit` with permitted
  localhost sockets: be-01 **510 pass / 1 intentional capability skip / 0 fail**;
  all seven listed library targets passed.

The first restricted root-unit run could not bind the production-health test's ephemeral
localhost socket: be-01 reached 509 pass, 1 intentional skip and 1 `EADDRINUSE` failure,
then the root `&&` stopped before the seven library targets. The permitted rerun above
executed that case and the downstream targets successfully. A directory-based Bun source
command also collected generated `dist/out-tsc` JavaScript and reported 11 module-resolution
errors after 35 source cases passed. The authoritative focused command is
`bun test libs/core/src/http/*.test.ts libs/core/src/use-cases/*.test.ts
libs/core/src/service/retention-timer.test.ts`; its file globs exclude build output.
Complete database and browser gates remain task 5.2.

| Check                          | Injected fault                                          | Observed                                                                                                                   |
| ------------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Direct write-scope admission   | Delete `runCommandBatch`'s scope refusal                | The read-only direct test returned `ok: true` and failed its expected `insufficient_scope` outcome                         |
| Authenticated actor forwarding | Replace the admitted actor id with the project owner    | The absent-account direct test returned `ok: true` and created one work item                                               |
| Direct project ownership       | Delete `savePlan`'s `canEdit` refusal                   | The wrong-owner direct test saved a record instead of returning `forbidden`                                                |
| Success-only publication       | Publish before `SavedPlanService.save`                  | The quota-refusal test observed `["publish", "save"]` instead of `["save"]`                                                |
| One binding per shape          | Run the binding inventory after relocating the builders | `binds each shared HTTP shape once in every configuration that owns it` passed; its existing omission proofs stay adjacent |

All injected faults were removed before the green runs. The first TDD run failed with
`Cannot find module './replay'` before the four use-case modules existed. No required
check was skipped; remote CI execution was not invoked.

## Slice 2.3 — production/test boundary enforcement

Verified 2026-09-10 from base `cb077938`.

- The effective Nx rule now combines `ring:adapter` and `runtime:browser`: browser
  adapters may depend on domain-ring code or another browser adapter, and may not depend
  on application-ring code. The scope and runtime constraints remain active in tests;
  only ring composition is exempt.
- Core and domain production reject Bun and Node imports, framework and persistence
  drivers, ambient runtime globals, and both direct forms of `globalThis.fetch`. Tests
  with the four tracked suffixes may import their runner; core testing fixtures retain
  the same exception.
- TypeBox is forbidden repository-wide so ArkType remains the wire-schema authority.
- The three Bun corpus writers moved from domain production to `tools/dev`; their pure
  corpus computations remain exported by domain. Running both writer entrypoints left
  their checked-in fixtures byte-for-byte unchanged.
- `eslint-boundaries.test.ts` exercises ESLint's calculated configuration and lint result
  for real project paths. Its adjacent `Proof:` comments record the observed fault for
  each changed safety check.
- Four runtime-portable tests now use relative imports for their own deadline and testing
  modules. Restoring Nx constraints in tests exposed those same-project aliases through
  the whole-workspace lint target.

| Command                                                                                                               | Observed                                                                                |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `bun test tools/tool-devsync/src/eslint-boundaries.test.ts --timeout 30000`                                           | 8 pass, 0 fail, 50 assertions                                                           |
| `bun test tools/tool-devsync/src/workspace-projects.test.ts --timeout 30000`                                          | 11 pass, 0 fail, 13 assertions                                                          |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun test tools/tool-devsync/src/workspace-targets.test.ts --timeout 120000` | 10 pass, 0 fail, 36 assertions; the external-input inventory completed in 109ms         |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint --all --skip-nx-cache`                             | all 25 projects pass in 1m19s                                                           |
| forced `core`, `domain`, `fe-01`, `tool-dev-setup` and `tool-devsync` typecheck targets                               | all pass                                                                                |
| uncached forced `domain`, `runtime-portable`, `tool-devsync` and `config` typecheck targets                           | all pass                                                                                |
| `bunx nx test core --skip-nx-cache`                                                                                   | pass                                                                                    |
| `bunx nx test domain --skip-nx-cache`                                                                                 | 604 pass, 0 fail                                                                        |
| `bun test tools/tool-dev-setup/src`                                                                                   | 17 pass, 0 fail                                                                         |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun run test:unit` with permitted localhost sockets                         | be-01: 510 pass, 1 intentional capability skip, 0 fail; all seven listed libraries pass |
| `bun tools/dev/write-fast-golden-corpus.ts` and `bun tools/dev/write-solver-quantum-golden-corpus.ts`                 | both completed; `git diff --exit-code` reported no fixture changes                      |

| Ports-plan negative  | Injected fault                                                                           | Observed diagnostic                                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1                    | `elysia` imported from temporary core production sibling                                 | `no-restricted-imports`: “Core and domain receive runtime behavior through ports.”                                                                                                       |
| 2                    | `node:crypto` imported from temporary domain production sibling                          | `no-restricted-imports`: “Core and domain receive runtime behavior through ports.”                                                                                                       |
| 3                    | `globalThis.fetch(...)`, then `globalThis['fetch'](...)`, in core production             | `no-restricted-syntax`: “Core and domain receive fetch through a transport port.” for each spelling                                                                                      |
| 4                    | `@wbs/core` imported from tracked frontend production, then test, source                 | `@nx/enforce-module-boundaries`: “A project tagged with \"ring:adapter\" and \"runtime:browser\" can only depend on libs tagged with \"ring:domain\", \"runtime:browser\"” in both files |
| 6                    | `@wbs/be-01` imported from domain production                                             | `@nx/enforce-module-boundaries` reported the domain↔be-01 circular dependency and its file chain                                                                                         |
| domain ring fence    | non-circular `@wbs/contracts/solver/supervisor-protocol` imported from domain production | `@nx/enforce-module-boundaries`: “A project tagged with \"ring:domain\" can only depend on libs tagged with \"ring:domain\"”                                                             |
| 9                    | `@sinclair/typebox` imported from `tools/dev` production                                 | `no-restricted-imports`: “Declare wire schemas with ArkType; TypeBox would restore a second schema authority.”                                                                           |
| 12                   | remove domain's ring tag, then add a second ring tag                                     | `libs/domain/project.json must carry exactly one ring: tag; found 0`, then `found 2`                                                                                                     |
| 15                   | import `bun:test` from a temporary core test, then its production sibling                | the test passed `core:lint` and Bun with 1 pass; production failed `no-restricted-imports`: “Core and domain receive runtime behavior through ports.”                                    |
| driver fence         | import `drizzle-orm`, then `bun:sqlite`, from core production                            | each failed `no-restricted-imports`: “Core and domain receive runtime behavior through ports.”                                                                                           |
| scope fence in tests | `@wbs/tool-compose` imported from config's tracked test source                           | `@nx/enforce-module-boundaries`: “A project tagged with \"scope:shared\" can only depend on libs tagged with \"scope:shared\"”                                                           |

All probes were injected one at a time and removed before the green runs. A new untracked
frontend probe initially produced no Nx diagnostic because it was absent from the cached
project graph; the production and test imports were therefore injected into tracked
frontend sources and both failed the real uncached `fe-01:lint` target as recorded above.
After the runtime-portable self-import fixes, its permitted real-socket test target passed
32 cases with 95 assertions. The restricted run had first passed its 30 pure cases and
failed only the two `Bun.serve` cases with sandbox `EADDRINUSE`.

The first serial `workspace-targets.test.ts` run left the Nx daemon enabled and its
external-input inventory timed out after 30 seconds; the other nine cases passed. The
daemon-disabled rerun above completed the whole suite in 432ms. The full branch
`tool-devsync:test` target reported 79 pass and six failures in `poller.test.ts`. A fresh
isolated checkout of exact `origin/main` `11e11358` reported the same six diagnostics (60
pass, six fail), so those environment-sensitive poller failures are unchanged by this
slice; the changed boundary and totality suites are green.

Ports-plan cases 5 and 13 remain deferred to task 4.3, when the store projects exist.
Product/layout cases 10 and 11 and the product half of case 16 remain with
repo-namespacing. The complete database, browser and landing gates remain task 5.2.

## Slice 3.1 — SQLite as one source

Verified 2026-09-10. `libs/store-sqlite` is discovered by Nx with
`ring:adapter`, `runtime:bun` and complete `lint`, `lint:fast`, `test`, and
`typecheck` targets. Adapter production, database tests, source conformance kits,
the write coordinator, store builder, and the optimized-outcome transaction now
have one authority there. Compatibility exports keep the application paths live.
The deploy migration directory and three migration CLIs remain in `apps/be-01`
for slice 3.2.

| Command                                                           | Observed                                                                                      |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `bunx nx run store-sqlite:test --skip-nx-cache`                   | 651 pass, 0 fail, 2,005 assertions, 59 files                                                  |
| `bunx nx run store-sqlite:lint`                                   | clean; direct `bun:sqlite` fault below was removed before this rerun                          |
| `bunx nx run store-sqlite:typecheck`                              | source and spec projects clean                                                                |
| `bunx nx run core:typecheck` and `bunx nx run be-01:typecheck`    | both clean                                                                                    |
| `bunx nx run core:lint`; `bunx nx run be-01:lint --skip-nx-cache` | both clean; backend rerun bypassed Nx cache                                                   |
| `bunx nx run core:test`                                           | 390 pass, 0 fail, 1,382 assertions, 41 files                                                  |
| `bun run test:unit` with permitted localhost sockets              | be-01: 495 pass, 1 intentional source-capability skip, 0 fail; all seven library targets pass |
| focused saved-plan classification cases                           | 2 pass, 0 fail after the extracted authority made the previously duplicated error class exact |

The first restricted root-unit run failed only when `Bun.serve({ port: 0 })`
could not bind (`EADDRINUSE`); the permitted rerun above passed. An AST comparison
over 57 moved test files found all 693 prior `describe`/`it`/`test` nodes in the
same order; the destination has 695 after the two migration failure cases. The
three optimized-outcome transaction cases retained their order after being split
from the application's process-orchestration suite.

The application-wide `bun test --coverage --coverage-reporter=lcov` is task 5.2,
not this slice's acceptance target. It reported 1,042 pass, 2 intentional skips,
0 assertion failures and 2 between-test errors across the branch's 89 application
files. Clean `main` reproduced the same two errors while running its 180 pre-move
application files: 2,058 pass, 2 intentional skips, 0 assertion failures and 2
between-test errors. Both are late coordinator work against a removed temporary
database (`solver_slot` and `solver_queue`, `SQLITE_IOERR_VNODE`). The two
parameterized Retry cases wait for a spawn recorder rather than coordinator drain;
coordinator lifecycle and that test remain unchanged for task 5.2.

The extraction did expose one application delta: the single authority made
`UnknownSavedPlanBodyVersionError` identity exact, revealing that the save route
caught project and announcement errors around the whole use case. Before the fix,
both focused cases expected 500 and received 501 with
`unsupported_body_version`. `SavedPlanWriteError` now marks only the saved-plan
write boundary; the same two cases pass and the full application run has no
assertion failure.

- Importing `bun:sqlite` from a temporary production
  `store-sqlite/src/direct-open-probe.ts` failed the actual library lint target at
  `1:1` with `@typescript-eslint/no-restricted-imports` and the instruction to
  open through `openDatabase()` in `store-sqlite/db.ts`.
- Making a missing migration directory return `[]` failed because the function
  did not throw and returned `[]`. Catching an unreadable root directory and
  returning `[]` failed the same way. Restoring the prior `existsSync` filter for
  a readable root with an unreadable migration child failed the focused test on
  `Expected pattern: /EACCES|permission denied/i`, `Received function did not
throw`, `Received value: []`. Converting an unreadable `down.sql` to an empty
  script failed because the received message was the modeled empty-script error
  rather than `/EACCES|permission denied/`.
- The five source guarantees were broken one at a time. The tests observed a
  created `__drizzle_migrations` table on open; two process connections instead
  of one; one history connection instead of two; corrupt health resolving rather
  than rejecting; a second close surfacing `close failed`; and a swallowed close
  failure resolving rather than rejecting. Each fault was restored before the
  full target run.

## Slice 3.2 — stable deploy entrypoints

Verified 2026-09-10. The three migration CLI files and `apps/be-01/drizzle/`
remain at their deployed paths. The CLIs now import the SQLite source's runner
modules directly. The swap's migrate command joins its existing status and down
commands as a fixture-backed command builder. `apps/be-01/Dockerfile` is
unchanged and still copies the complete application, including `drizzle/`, then
runs from `/app/apps/be-01` where the CLIs resolve `./drizzle`.

| Command                                                                                | Observed                                                                                                   |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `bun test src/migration-cli.db.test.ts` from `apps/be-01`                              | 2 pass, 0 fail, 11 assertions; real up, status, down, and status CLIs used one isolated temporary database |
| `bun test src/migrate.db.test.ts src/migrate-down.db.test.ts` from `libs/store-sqlite` | 87 pass, 0 fail, 381 assertions                                                                            |
| focused `tools/tool-remote-scripts/src/lib/docker.test.ts` migration command cases     | 5 pass, 0 fail, 5 assertions                                                                               |
| `bunx nx run be-01:typecheck --skip-nx-cache`                                          | clean                                                                                                      |
| `bunx nx run tool-remote-scripts:lint --skip-nx-cache` and `:typecheck`                | clean                                                                                                      |
| direct ESLint over the four changed backend files                                      | clean after correcting import order                                                                        |
| Prettier check over all changed code                                                   | clean                                                                                                      |

Changing the production CLI's runner import to
`@wbs/store-sqlite/migrate-missing` made the real isolated `migrate-cli.ts`
invocation exit 1. The test's first production-path assertion received empty
stdout and `Cannot find module '@wbs/store-sqlite/migrate-missing'` instead of
exit 0 and `migrations applied`. A separate working-directory fault changed the
migration folder from `./drizzle` to `../drizzle`; the same invocation exited 1
with `ENOENT: no such file or directory, scandir '../drizzle'`. Both faults were
restored before the green run, and the adjacent `Proof:` comment records the
observed outputs.

The restricted full `tool-remote-scripts:test` run reported 275 pass, 3
intentional Docker/Linux skips, and 2 failures because the sandbox denied the
Unix listener sockets (`EADDRINUSE`). Those two environment-sensitive listener
cases do not exercise the migration commands. A permitted rerun and the final
whole-workspace gate remain outstanding.

## Slice 3.3 — one staged memory source

Verified 2026-09-10. `libs/store-memory` is discovered as an isomorphic adapter
with lint, typecheck, and test targets. Its `MemoryState` owns only cloneable table
values; recording counters live outside production. Each command act receives a
fresh staged graph, and commit copies staged tables into the stable committed state
observed by public store closures. One catalog-level boundary detaches returns from
all 17 explicit stores for both public and admitted graphs. Public writes serialize
behind command acts while admitted scope stores use their held turn. Saved-plan
history and capture remain independent: capture clones committed state at entry,
and a production `SavedPlanService.save` completes while a batch is held and
survives both commit and rollback. A second, independent coordinator holds saved-plan
quota calculation, its awaited check, and the history write in one turn.

| Command                                                       | Observed                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `nx run store-memory:test --skip-nx-cache`                    | 28 pass, 1 declared estimate capability skip, 0 fail, 196 assertions           |
| `nx run store-memory:lint --skip-nx-cache`                    | clean                                                                          |
| `nx run store-memory:typecheck --skip-nx-cache`               | source and spec projects compile clean                                         |
| source-conformance and unit-of-work reports                   | 11 named source cases ran, 1 declared skip; all 6 named unit-of-work cases ran |
| `nx run-many -t lint typecheck -p core be-01 --skip-nx-cache` | all four affected consumer targets clean                                       |
| `nx run core:test --skip-nx-cache`                            | 390 pass, 0 fail, 1,382 assertions                                             |

Sixty-four non-adapter consumer, test, and compatibility files now import the
memory fixtures from their owning project. Nx represents production and tests in
one graph, so the boundary rule ignores only the `core`/`store-memory` circular
pair needed for core's tests to execute its ports over the adapter. The ring rule
still rejects adapter imports from core production files.

The original six injected faults and their observed diagnostics remain beside
their assertions. The capture deadlock branch
releases the held batch and awaits both promises before reporting its bounded
failure, so the negative cannot leak pending work into another case. The source
allowlist contains only `estimates.set:unknown_step`. The four composition cases
mentioned by task 3.3 are not the source-conformance store families and are not
claimed here; task 4.2 remains unchecked. SQLite's immediate-busy test remains in
`store-sqlite` and was not represented as an interleaved success here.

| Check                                                       | Injected fault                                                                                     | Observed                                                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Every explicit memory binding detaches returned state       | Bypass the one catalog detacher while the 17-key public/admitted inventory and mutation matrix run | Both boundary cases reread user id `reader:caller-mutation` instead of `reader`            |
| Saved-plan quota is atomic independently of command batches | Bypass the history coordinator around holding/check/set                                            | Competing production saves returned `["saved", "saved"]` instead of `["refused", "saved"]` |

The app-barrel cache proof belonged to the source-kit path retired by slice 4.1.
The replacement project-edge proof and its observed diagnostic are recorded in
that slice rather than preserving evidence about a path that no longer exists.

The restricted root `bun run test:unit` run reached 502 pass and one intentional
skip before its sole failure: `app.routes.test.ts` could not bind
`Bun.serve({ port: 0 })` and reported `EADDRINUSE`. The isolated case reproduced
the same sandbox failure. A permitted rerun passed 503 backend cases with the one
declared memory-source capability skip and 0 failures, then passed all seven
library targets.

## Slice 4.1 — shared conformance kits

Verified 2026-09-10. The four existing source-family kits and the unit-of-work
harness now live in `libs/conformance`, tagged `ring:application` and
`runtime:bun`. The shared project imports core ports and core test rows only; it
contains no SQLite or memory adapter import or construction. SQLite and staged
memory tests import the shared kit and supply their own opened source. The
memory certification moved from the app into its source project, removing the
app-to-SQLite re-export chain.

| Command                                                                                  | Observed                                                    |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `nx run conformance:test --skip-nx-cache`                                                | 1 pass, 0 fail; independent missing-registration diagnostic |
| `nx run store-memory:test --skip-nx-cache`                                               | 29 pass, 1 declared skip, 0 fail, 196 assertions            |
| `nx run store-sqlite:test --skip-nx-cache`                                               | 652 pass, 0 fail, 2,005 assertions, 59 files                |
| `nx run-many -t lint typecheck -p conformance store-memory store-sqlite --skip-nx-cache` | all six targets clean                                       |
| focused SQLite source and unit-of-work files                                             | 20 pass, 0 fail, 42 assertions                              |

The SQLite target printed all twelve case IDs as ran and `not offered: none`.
The memory target printed eleven as ran and
`not offered: estimates.set:unknown_step`. The thirteen unimplemented store
families remain assigned to `source-conformance-completion` and are not counted
by this catalog.

| Check                                              | Injected fault                                                                                                                                       | Observed                                                                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Expected cases are independent of kit registration | Delete the step-family registration from the real shared `sourceConformance` composition, then run the memory source test                            | The report failed on `in-memory certification missing cases: steps.add, steps.rename, steps.rename:unknown` while every remaining body passed |
| The source target hashes its shared production kit | Warm `store-memory:test` to a confirmed local-cache hit, add a top-level throw to the imported conformance source, then repeat the identical command | Nx reran and failed on `injected conformance dependency cache fault` instead of replaying the cached green result                             |

## Slice 4.2 — one public composition and fresh admitted graphs

Verified 2026-09-10. `core/compose.ts` now accepts an opened source plus explicit
runtime/shared ports, builds the public buffer, broadcaster, throttle, saved-plan
history and retention service once, and builds every command graph from its admitted
scope. Its overloads expose auth only when both account stores and account runtime
ports are supplied. be-01 opens the SQLite source at boot, calls the core composition
once, mounts the composed services (including the login throttle), and closes the
source after retention and optimizer shutdown.

| Command                                                        | Observed                                            |
| -------------------------------------------------------------- | --------------------------------------------------- |
| `bun test` in `libs/core`                                      | 398 pass, 0 fail, 1,406 assertions across 42 files  |
| `bun test src/compose.test.ts` in `libs/core`                  | 8 pass, 0 fail, 26 assertions                       |
| focused be-01 services and authentication files                | 43 pass, 0 fail; service graph 10/10 and auth 33/33 |
| focused elevated boot identity case                            | 1 pass, 13 filtered, 0 fail, 2 assertions           |
| focused elevated boot shutdown-order case                      | 1 pass, 14 filtered, 0 fail, 1 assertion            |
| `bun test src/source.test.ts` in `libs/store-sqlite`           | 5 pass, 0 fail, 9 assertions                        |
| source/spec TypeScript builds for core, be-01 and store-sqlite | all compile clean                                   |
| `nx run core:typecheck --skip-nx-cache`                        | clean; cache skipped                                |
| ESLint over core, be-01 and store-sqlite source trees          | all clean                                           |

The broader four-file be-01 run reached 50 passes and 609 assertions; its only
failure was the sandbox refusing `Bun.serve({ port: 0 })` with `EADDRINUSE`. The
same boot-dependent composition case passed in the permitted focused rerun above.

| Check                                      | Injected fault                                      | Observed                                                                                                                 |
| ------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Accountless source rejects account runtime | Allow account keys on the accountless overload      | `core:typecheck` failed with TS2578 at `compose.test.ts:158`; the mismatch compiled                                      |
| Account source requires account runtime    | Remove `users?: never` from `AccountlessSource`     | `core:typecheck` failed with TS2578 at `compose.test.ts:163`; the reverse mismatch compiled                              |
| Two batches use the public replay buffer   | Construct a second buffer for `ReplayOrchestrator`  | The two-event committed replay returned `{status: "denied", reason: "out_of_range"}` instead of both buffered sequences  |
| Every batch owns its collector             | Reuse one constructor-owned `AnnouncementCollector` | The two-batch identity assertion received the same collector for both batches                                            |
| Stale undo repairs through the fresh scope | Discard through the rolled-back scope               | The composition case threw `no journal entry id-5` instead of consuming the committed stale entry                        |
| HTTP consumes the composed public graph    | Give `buildApp` a second `LoginThrottle`            | `boot.db.test.ts:258` expected 429 and received 401; 0 pass, 1 fail, 13 filtered, 2 assertions                           |
| Source closes after runtime services stop  | Close the source before stopping either service     | The close boundary observed `{optimizerRunning: true, retentionRunning: true}`; 0 pass, 1 fail, 14 filtered, 1 assertion |

## Slice 4.2a — portable composition in Chromium

Verified 2026-09-10. Bun bundles the pure portable probe as browser ESM, then
Playwright injects it into a fresh Chromium page whose only fulfilled request is
`https://core-probe.invalid/`. The page is a secure context with Web Crypto. It
opens the staged memory source and composes the graph with a fixed clock,
controllable timers, Web Crypto SHA-256, and an in-page push recorder. The probe
records completion only after mixed-store commit and rollback, denied admission,
saved-plan denial plus persisted read-back, buffered replay after durable pruning,
and retention waiting for a held batch to release before pruning six seeded rows
to the exact four-row limit observed through the public event-log port.

| Command                                                    | Observed                                                                                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `nx run core:test:portable --skip-nx-cache`                | build dependency bundled 363 modules in 22ms; Chromium 1 pass, 0 fail in 1.6s                                                       |
| portable bundle identity                                   | `dist/libs/core/portable-composition.js`, 893,095 bytes, SHA-256 `01bb37e989b16bda6d72f9f495947e62d181991950b2a0b44d099cf3cda40214` |
| `nx run core:test --skip-nx-cache`                         | 398 pass, 0 fail, 1,408 assertions, 42 files; Bun collected only `src`                                                              |
| `nx run core:typecheck --skip-nx-cache`                    | core library, Bun specs, portable probe/spec and Playwright config compile clean                                                    |
| `nx run core:lint --skip-nx-cache`                         | core `src`, portable `testing`, and root Playwright config clean                                                                    |
| Prettier check over the six changed core code/config files | clean                                                                                                                               |

The first restricted browser launch failed before a test ran because the sandbox
denied Chromium's Mach rendezvous port. The permitted isolated reruns used no
server and no actual network. An injected image request initially exposed a race:
the ledger assertion ran before Playwright's route callback. A bounded 50ms
observer-settlement window now precedes that assertion; the same fire-and-forget
request then failed on the exact unexpected URL.

| Check                                      | Injected fault                                                   | Observed                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Browser runtime has no Bun global          | Read production `Bun.version` and allow the bundle to execute    | `page.evaluate: ReferenceError: Bun is not defined` at the bundled access    |
| Completion is independent of probe control | Omit `completed.add('retention')`                                | Playwright's exact record diff received `retention: false` instead of `true` |
| Save is proved by stored state             | Return `written` without storing in `memorySavedPlans.write`     | `page.evaluate: Error: saved browser plan was not readable`                  |
| Retention changes stored state             | Make memory `pruneBeyond` return zero without removing rows      | `page.evaluate: Error: retention kept` all six rows with sequences 0–5       |
| Every non-bootstrap request fails the test | Inject an image request for `https://unexpected.invalid/fault`   | The final ledger received that URL as its sole member instead of `[]`        |
| Portable TypeScript is discovered          | Assign `'portable type fault'` to a number in the portable probe | `core:typecheck` failed at `portable-composition.ts:12` with TS2322          |
| Root Playwright config is linted           | Add an unused declaration to `libs/core/playwright.config.ts`    | `core:lint` failed at line 3 with `@typescript-eslint/no-unused-vars`        |

## Slice 4.3 — original enforcement inventory

Verified 2026-09-10. Current-tree lint passed for `core`, `domain`, `fe-01`,
`store-sqlite` and `tool-dev-setup`. Core's real `compose.test.ts` passed 8
cases with 26 assertions while importing both `bun:test` and
`@wbs/store-memory`; the adjacent production probe was refused. The tag and
binding tests were green again after every injected fault was restored.

| Ports-plan case | Disposition                                                       | Fault and observed diagnostic                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1               | Existing evidence revalidated on this tree                        | A temporary core production sibling importing `elysia` failed `no-restricted-imports`: “Core and domain receive runtime behavior through ports.” Current `core:lint` is clean.                                                                                                                                                                                                                       |
| 2               | Existing evidence revalidated on this tree                        | A temporary domain production sibling importing `node:crypto` failed `no-restricted-imports` with the same runtime-through-ports diagnostic. Current `domain:lint` is clean.                                                                                                                                                                                                                         |
| 3               | Existing evidence revalidated on this tree                        | `globalThis.fetch(...)` and `globalThis['fetch'](...)` in core production each failed `no-restricted-syntax`: “Core and domain receive fetch through a transport port.” Current `core:lint` is clean.                                                                                                                                                                                                |
| 4               | Existing evidence revalidated on this tree                        | A tracked fe-01 production import and test import of `@wbs/core` each failed `@nx/enforce-module-boundaries`: a `ring:adapter` + `runtime:browser` project may depend only on `ring:domain` or `runtime:browser`. Current uncached `fe-01:lint` is clean.                                                                                                                                            |
| 5               | Observed here                                                     | A core production sibling importing `@wbs/store-sqlite`, with only circular-diagnostic preemption disabled for the probe, failed the generic `@nx/enforce-module-boundaries` ring rule: a `ring:application` project may depend only on `ring:domain` or `ring:application`. Without that probe-only diagnostic setting, the same rule first reported the real `core -> store-sqlite -> core` cycle. |
| 6               | Existing evidence revalidated on this tree                        | A domain production import of `@wbs/be-01` failed `@nx/enforce-module-boundaries` on the domain/be-01 cycle; a non-circular adapter import separately failed the generic domain-ring restriction. Current `domain:lint` is clean.                                                                                                                                                                    |
| 7               | Existing evidence revalidated on this tree                        | A production `direct-open-probe.ts` importing `Database` from `bun:sqlite` outside `store-sqlite/db.ts` failed `store-sqlite:lint` at 1:1: “Open connections through openDatabase() in store-sqlite/db.ts.” Current `store-sqlite:lint` is clean.                                                                                                                                                    |
| 8               | Observed in task 5.1                                              | The root now selects `test:unit` targets. A temporary eligible library nested at `libs/fast-tier-proof/nested` appeared in the real root run's 16-project inventory and failed its deliberate assertion on Expected: false, Received: true.                                                                                                                                                          |
| 9               | Existing evidence revalidated on this tree                        | A production `@sinclair/typebox` import under `tools/dev` failed `no-restricted-imports`: “Declare wire schemas with ArkType; TypeBox would restore a second schema authority.” Current `tool-dev-setup:lint` is clean.                                                                                                                                                                              |
| 10              | Owned by `repo-namespacing`                                       | That change owns the `libs/wbs/adapters/` layout rule and its misplaced `ring:application` project fault.                                                                                                                                                                                                                                                                                            |
| 11              | Owned by `repo-namespacing`                                       | That change owns the cross-product dependency constraint and the second product importing `@wbs/core` fault.                                                                                                                                                                                                                                                                                         |
| 12              | Observed here                                                     | Removing `ring:adapter` from the recursively discovered `libs/contracts/solver/supervisor-protocol/project.json` failed the totality assertion with `... must carry exactly one ring: tag; found 0`; adding `ring:domain` beside it failed the same assertion with `found 2`.                                                                                                                        |
| 13              | Observed here                                                     | A core production sibling importing `@wbs/store-memory` failed the generic ring rule: a `ring:application` project may depend only on `ring:domain` or `ring:application`. The real import in `compose.test.ts` passed 8 cases, proving the exemption's test edge.                                                                                                                                   |
| 14              | Observed here                                                     | Removing the real `...smokeRoutes()` binding failed `binds each shared HTTP shape once in every configuration that owns it`: expected 41 endpoints and received 40. Restored, it passed with 88 assertions.                                                                                                                                                                                          |
| 15              | Existing evidence revalidated on this tree                        | A core test importing `bun:test` passed; moving the same import to its production sibling failed `no-restricted-imports`: “Core and domain receive runtime behavior through ports.” The real core composition test and current `core:lint` are green.                                                                                                                                                |
| 16              | Tool half observed here; product half owned by `repo-namespacing` | Removing the ring from recursively discovered `tools/dev/project.json` failed the totality assertion with `tools/dev/project.json ... found 0`. `repo-namespacing` owns both the missing `product:` tag and the forbidden `product:` tag on a tool.                                                                                                                                                  |

The first version of the current-tree tag probes stopped in `readProjects`
before the totality assertion. The inventory test now converts only its exact
axis-cardinality rejection into the `wrong` list; malformed, unreadable and
otherwise unexpected discovery failures still throw. The three injected tag
faults above consequently failed `expect(wrong).toEqual([])` with their real
manifest paths, rather than dying during fixture setup or defaulting unreadable
output.

## Slice 5.1 — discovered fast tier

Verified 2026-09-10. The root `test:unit` script now runs
`nx run-many -t test:unit`. be-01 retains its non-DB split and fe-01 retains its
Node-only Vitest tier. Every non-Python library with at least one tracked
`*.test.ts(x)` outside the `.db.test` tier declares the target; store-sqlite's
target runs its six non-DB files, excludes its database suite, and hashes the
be-01 migrations read by `source.test.ts`. Playwright `*.spec.ts`, Python and
the be-01 `.proc.db.test.ts` process cases are outside this target. The inventory
allows only be-01 and fe-01 to declare the target outside `libs/`; a process,
browser or tool project that adds it is reported as unexpected.

| Command                                                                                                 | Observed                                                                                       |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bun run test:unit` with permitted localhost sockets           | all 15 discovered targets passed uncached in 23.3s                                             |
| `nx run store-sqlite:test:unit --skip-nx-cache`                                                         | 20 pass, 0 fail, 26 assertions across six non-DB files                                         |
| `nx run contracts:test` and `nx run contracts:test:unit`, each uncached                                 | each passed 378 tests / 1,067 assertions across the parent's 40 owned files                    |
| `nx run solver-supervisor-protocol:test:unit --skip-nx-cache`                                           | 9 pass, 0 fail, 26 assertions across its one nested file                                       |
| focused `workspace-targets.test.ts`                                                                     | 12 pass, 0 fail, 41 assertions on the restored tree                                            |
| remove nested supervisor protocol's `test:unit`, then run the independent inventory assertion           | `missing: ["solver-supervisor-protocol"]`, `unexpected: []`                                    |
| add `test:unit` to the discovered `tool-devsync` project, then run that assertion                       | `missing: []`, `unexpected: ["tool-devsync"]`; 0 pass, 1 fail                                  |
| add temporary nested `fast-tier-negative` project and failing test, then run the exact root `test:unit` | target discovered among 16; assertion failed on Expected: false, Received: true; root exited 1 |

The restricted negative run also reported the repository's three known
localhost-socket failures in auth, runtime-portable and be-01. They did not
substitute for the injected proof: the captured output separately named
`fast-tier-negative:test:unit`, its test file, its assertion and its 0-pass /
1-fail count. The restored permitted run then passed those three socket-owning
targets along with the other twelve.

## Gate

## 2026-09-10 current-main merge checkpoint

Merged `origin/main` at `87bf2931` onto the pushed extraction checkpoint
`deb31876`. The merge preserves the extracted app compatibility shims, ports
main's transactional event-log contract into `store-sqlite`, and consolidates
the stored vocabulary in `libs/domain/src/stored-vocabularies.ts`.

Main's shared scratch helper is now the nested `tool-test-scratch` Nx project.
Its 17 tool consumers import `@wbs/tool-test-scratch`; the relative imports
failed the production lint boundary with “External resources cannot be imported
using a relative or absolute path.” Devsync restart inputs and Nx input globs
now discover nested `core`, `domain`, `store-memory`, and `store-sqlite` changes.

| Check                                                 | Result                                                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| affected lint and typecheck for nine changed projects | passed                                                                                                          |
| `tools/tool-devsync/src/sync.test.ts`                 | 30 pass, 0 fail, 89 assertions                                                                                  |
| store-sqlite event-log and optimized-outcome tests    | 11 pass, 0 fail, 48 assertions                                                                                  |
| warm-cache devsync target, then nested ring removal   | cache hit on the unchanged run; removal re-executed and failed with `must carry exactly one ring: tag; found 0` |
| remove each added devsync restart path in sequence    | each restored fault failed on its missing `core`, `domain`, `store-memory`, or `store-sqlite` path              |

## 2026-09-10 landing evidence

The first h2puni invocation used the gate script from its stale checkout and is
not evidence about this branch. The valid run used a dedicated detached worktree
at the requested revision and invoked that worktree's gate script. Its printed
HEAD matched `1212c159ea086a82a58fcea3bee0b77ffc3f382d` before any check ran.

| Command / fault                                                                                     | Result                                                                                                                                               |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/h2puni-gate.sh 1212c159ea086a82a58fcea3bee0b77ffc3f382d` in the exact detached worktree        | all 101 lint, typecheck, test and build tasks passed uncached across 30 projects in 10m05s; `be-01:solver-image-smoke` then passed 3/3 process cases |
| `CI=1 E2E_PORT_SHIFT=1900 bun run e2e`, with 5000/5100/6100 checked free first                      | 327 pass, 37 intentional rendering-baseline skips, 0 fail in 17m38s; Playwright retries are disabled                                                 |
| widen the production optimization cue from 11.5rem to 44rem, then run its real Chromium budget case | failed on `Expected: <= 1568 · Received: 2085.875`; the restored case passed and the complete browser run above passed it again                      |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json` at `0dbf2913`          | 70 items passed, 0 failed, including the two synced main specs                                                                                       |
| pre-commit checks at `0dbf2913`                                                                     | doc cap, plaintext-secrets scan, Prettier and lint passed                                                                                            |

The browser run initially found the toolbar budget pinned 0.875px below the
landing Chromium measurement: 1565.875px against the old 1565px tolerated
ceiling. The pin now records 1566px with the existing 2px tolerance. Replaying
the proof named in the old comment also found that it had become vacuous: putting
the reading sentence inside the already fixed-width pill passed. The proof above
breaks the production width boundary itself and fails at the assertion it names.

The final frozen h2puni gate ran from a new detached worktree at exact pushed
revision `c779ff9f432cd0e779071c3c77ffa27e8ac40ab1`. All 101 workspace lint,
typecheck, test and build tasks passed uncached across 30 projects in 10m30s;
`fe-01:test` was the 9m01s critical path. The subsequent real Docker
`be-01:solver-image-smoke` passed 3 cases, 0 failed and 15 assertions in 1m32s.
Together with the complete Chromium and exact-revision OpenSpec results above,
this closes task 5.2. The accepted ADR statuses, synced main specs, queue entry,
moved-test counts and explicit source-capability limit close task 5.3.

## Final integrated head

After `origin/main` advanced to `a42fbf4e`, merge revision
`3d67da8ec717642c4c9ae13ad14ff38e13a81835` was pushed and verified as the
combined landing candidate.

| Command                                                                                             | Observed                                                                                                                                 |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `CI=1 E2E_PORT_SHIFT=1900 bun run e2e` on the merged tree, with 5000/5100/6100 free                 | **328 pass / 37 intentional rendering-baseline skips / 0 fail** in 17m57s                                                                |
| `bin/h2puni-gate.sh 3d67da8ec717642c4c9ae13ad14ff38e13a81835` from a clean isolated h2puni worktree | all **101** lint, typecheck, test and build tasks passed uncached across 30 projects in 10m13s; `fe-01:test` was the 8m47s critical path |
| the gate's real Docker `be-01:solver-image-smoke`                                                   | **3 pass / 0 fail / 15 assertions** in 1m32s                                                                                             |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json`                        | **70 passed / 0 failed**: 59 active changes and 11 main specs                                                                            |

The first attempt to use h2puni's shared checkout was refused before testing
because another lane's files prevented the pinned checkout. The successful run
above used a newly created isolated worktree, printed the full requested SHA
after acquiring the host-wide heavy lock, and then ran every gate step.
