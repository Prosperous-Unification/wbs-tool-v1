# Source conformance completion verification

## 2026-09-12 — task 1.1 execution-aware certification infrastructure

Task 1.1 adds the closed nineteen-family manifest, exact admission-specific
history cases, typed capability declarations, lifecycle-owned execution and
terminal exact-set certification. The four existing source kits remain on the
legacy runner until task 1.3 moves their bodies.

### Failure-proof table

| Check                                     | Fault injected                                                                    | Test that observed it                                         | Observed failure                                                                                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration set cannot lose a family     | Removed the missing-registration refusal after omitting the projects kit          | `rejects a missing family`                                    | Expected `missing registered cases: projects: projects.create:steps`; received the later `missing case reports: projects: projects.create:steps, ...` diagnostic. |
| Registration set rejects duplicates       | Removed the duplicate-registration refusal after registering the first case twice | `rejects a duplicated case`                                   | Expected `duplicate registered cases`; received `duplicate case reports: projects: projects.create:steps`.                                                        |
| Declaration does not imply execution      | Marked a registration with no body as passed                                      | `a declared body is not a passed body`                        | Expected status `incomplete`; received `passed`.                                                                                                                  |
| Incomplete execution cannot certify       | Removed the incomplete-status refusal                                             | `refuses a body that was declared but never invoked`          | Expected `incomplete cases`; certification did not throw.                                                                                                         |
| Cleanup is part of passing                | Marked the cleanup-failure branch passed                                          | `a failed close cannot certify its case`                      | Expected `failed cases ... (cleanup: injected close failure)`; certification did not throw.                                                                       |
| A focused run is not full certification   | Reported every execution as full                                                  | `focused execution reports partial`                           | Expected `partial`; received `full`.                                                                                                                              |
| Unknown gaps cannot excuse cases          | Removed declaration gap validation after the offered body executed                | `rejects an unknown gap after executing the offered baseline` | Expected `unknown gaps`; certification did not throw.                                                                                                             |
| Duplicate gaps cannot hide one exclusion  | Removed duplicate-gap validation                                                  | `rejects a duplicated gap`                                    | Expected `duplicate gaps`; certification did not throw.                                                                                                           |
| Capability and terminal status agree      | Removed capability/status correlation                                             | `rejects not-offered status for an offered case`              | Expected `capability status mismatch`; certification did not throw.                                                                                               |
| Port additions require manifest additions | Removed the expected-error guard from the composition-extension fixture           | `conformance:typecheck`                                       | TS2741: property `conformanceProbe` is missing in `CASE_MANIFEST`.                                                                                                |
| A caller cannot shrink full certification | Exposed a caller-supplied `expected` override                                     | `conformance:typecheck`                                       | TS2578: the forbidden-property `@ts-expect-error` became unused.                                                                                                  |

### Passing commands

- `bun test src` in `libs/conformance`: 12 pass, 0 fail across 5 files.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run conformance:lint`: success.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run conformance:typecheck`: success after restoring the compile guard.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run conformance:test`: 12 pass, 0 fail.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t typecheck -p store-memory,store-sqlite --parallel=2`: both source typechecks succeeded.
- `bun test src/source-conformance.test.ts` in `libs/store-memory`: 20 pass, 1 declared legacy gap skip, 0 fail.
- `bun test src/sqlite-source.db.test.ts` in `libs/store-sqlite`: 14 pass, 0 fail.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate source-conformance-completion --strict`: valid.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json`: 75/75 artifacts valid.

### Explicitly not run in task 1.1

- The full h2puni workspace gate, full source test targets, browser tests and
  builds are deferred to the integrated task 7.3 gate; this slice changes only
  the conformance library and exercised both current source consumers directly.
- New `store-*:test:conformance` targets do not exist yet; task 7.2 owns them.
- No later store-family bodies, broken-source helpers or source-specific fault
  controls were implemented; tasks 1.2 onward own those changes.

One command is explicitly invalid evidence: `bun test src` was accidentally
invoked from the repository root after a formatting pass. Bun collected
unrelated workspace suites and sandboxed listener tests failed on `EPERM`. The
process ended; the command was replaced by the scoped `conformance:test` target
and is not counted above.

## 2026-09-12 — task 1.1 round-one certification corrections

The execution state is now a discriminated union: unexecuted cases cannot carry
started lifecycle evidence, while a pass requires a fixture identity, start and
end timing, and completed cleanup. Certification validates those relationships
again at runtime and verifies that a passed case's registration had an
`openAndRun` body. Assertion failure detection uses a separate caught flag so a
legal `Promise.reject(undefined)` cannot collide with the absence sentinel.

### Additional failure-proof table

| Check                                                 | Fault injected                                                                                   | Test that observed it                                                     | Observed failure                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Setup rejection cannot become a pass                  | Reported the setup catch as a completed pass                                                     | `a setup rejection is failed execution and cannot certify`                | Expected `failed cases ... (setup: injected setup failure)`; certification did not throw.                      |
| Ordinary assertion failure still fails after cleanup  | Ignored the caught assertion after successful cleanup                                            | `an assertion rejection still cleans up and cannot certify`               | Expected `failed cases ... (assertion: injected assertion failure)`; certification did not throw.              |
| Undefined rejection is still an assertion failure     | Restored `assertionFailure !== undefined` as the caught sentinel                                 | `an undefined assertion rejection fails after cleanup and cannot certify` | Expected `failed cases ... (assertion: undefined)`; certification did not throw.                               |
| Cleanup does not erase an undefined assertion reason  | Restored the same sentinel while cleanup also rejected                                           | `an undefined assertion rejection is retained when cleanup also fails`    | Expected `undefined; cleanup failed: injected close failure`; received only `cleanup: injected close failure`. |
| Declaration metadata cannot be relabeled as a pass    | Removed runtime execution-evidence validation after changing only `incomplete` to `passed`       | `refuses a declaration-only case relabeled as passed`                     | Expected `invalid execution evidence`; certification did not throw.                                            |
| A pass carries lifecycle identity and timing          | Removed runtime execution-evidence validation from a passed record without fixture/timing fields | `refuses a passed case with missing lifecycle evidence`                   | Expected `invalid execution evidence`; certification did not throw.                                            |
| Passed evidence requires an invoked registration body | Removed the registration-body check while retaining an untouched passed report                   | `refuses passed evidence paired with a declaration-only registration`     | Expected `invalid execution evidence`; certification did not throw.                                            |
| Pass is assigned only after cleanup                   | Removed runtime execution-evidence validation after changing completed phase to `assertion`      | `refuses a pass recorded before successful cleanup`                       | Expected `invalid execution evidence`; certification did not throw.                                            |

### Passing correction commands

- `bun test src` in `libs/conformance`: 20 pass, 0 fail across 5 files.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run conformance:lint --skip-nx-cache`: success.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run conformance:typecheck --skip-nx-cache`: success; the existing missing-family compile fixture remains active.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t typecheck -p store-memory,store-sqlite --parallel=2 --skip-nx-cache`: both source typechecks succeeded.
- `bun test src/source-conformance.test.ts` in `libs/store-memory`: 20 pass, 1 declared legacy gap skip, 0 fail.
- `bun test src/sqlite-source.db.test.ts` in `libs/store-sqlite`: 14 pass, 0 fail.
- Prettier checks for every changed source/evidence file and `git diff --check`: clean.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate source-conformance-completion --strict`: valid.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json`: 75/75 artifacts valid.

The Task 1.1 scope skips recorded above remain unchanged for this correction.

## 2026-09-12 — task 1.2 named broken-source proof infrastructure

`brokenSource` retains the source factory's parameter and result types, and
`replaceMethod` uses a Proxy that binds both the replacement and every
untouched method to the real class instance. Each fault owns a per-run control;
the proof recorder verifies setup, arms the fault, requires entry into its
named phase and only then records a named assertion failure. Memory and SQLite
controls expose separate staged-write and transaction-write reach methods for
later adapter-owned late-failure seams; neither is ambient production state.

### Task 1.2 failure-proof table

| Check                                               | Fault injected                                     | Test that observed it                                   | Observed failure                                                                                       |
| --------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Fault is inert through verified setup               | Removed the shared control's pre-arm guard         | `an armed fault reaches its named assertion`            | Expected `observed`; received `setup-failed` with `baseline counter was not one`.                      |
| Recorder arms before the exercise                   | Removed `fault.control.arm()`                      | `an armed fault reaches its named assertion`            | Expected `observed`; received `phase-failed` with `fault did not reach counter-read`.                  |
| Forwarded class methods keep their receiver         | Returned the raw prototype function from the Proxy | `a class port keeps unmodified prototype methods`       | `TypeError: Cannot access invalid private field` at `this.#count`.                                     |
| Setup errors are not assertion proofs               | Classified the setup catch as observed             | `a pre-setup failure does not prove an atomicity check` | Expected `setup-failed`; received `observed` with the fixture error as `observedFailure`.              |
| Pre-phase operation errors are not assertion proofs | Classified the exercise catch as observed          | `a pre-setup failure does not prove an atomicity check` | Expected `phase-failed`; received `observed` with the operation error as `observedFailure`.            |
| An unrelated assertion cannot replace phase reach   | Removed the `control.reached()` check              | `a pre-setup failure does not prove an atomicity check` | Expected `phase-failed`; received `observed` with `an unrelated assertion failed`.                     |
| Memory late-write control is inert before arm       | Removed its pre-arm guard                          | `arms a named staged-state write point per run`         | Expected `false`; received `true`.                                                                     |
| SQLite late-write control is inert before arm       | Removed its pre-arm guard                          | `arms a named transaction write point per run`          | Expected `false`; received `true`.                                                                     |
| Factory and fault registry remain closed            | Removed all three expected-error guards            | `conformance:typecheck`                                 | TS2554 for the missing factory argument; TS2322 for the arbitrary fault ID and mismatched owning case. |

### Task 1.2 verification

- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run conformance:test --skip-nx-cache`: 23 pass, 0 fail across 7 files.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run conformance:lint --skip-nx-cache`: success.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run conformance:typecheck --skip-nx-cache`: success after restoring all compile guards.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint,typecheck -p store-memory,store-sqlite --parallel=4 --skip-nx-cache`: all four targets succeeded.
- `bun test src/testing/faults.test.ts` in each source: 1 pass, 0 fail per source.
- `bun test src/source-conformance.test.ts` in memory: 20 pass, 1 declared legacy gap skip, 0 fail.
- `bun test src/sqlite-source.db.test.ts` in SQLite: 14 pass, 0 fail.
- Prettier checks for every changed source/evidence file and `git diff --check`: clean.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate source-conformance-completion --strict`: valid.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json`: 75/75 artifacts valid.

The complete memory/SQLite test targets, full workspace gate and build/browser
targets were not run: Task 1.2 adds test-only infrastructure and changes no
adapter operation. Later case mutations and installation into actual adapter
transaction/staged-state operations remain owned by their ordered store-family
tasks.

## 2026-09-12 — task 1.2 Astra correction

The earlier deferral above was not authorized. Fault definitions now create a
fresh control for every proof, a fault run can open one source only, and both
sequential and overlapping proofs have isolated lifecycle state. Every reach
method matches the exact configured phase. Adapter-owned seams are installed
inside all three real late-write paths: subtree final satellite, journal history
insert and saved-plan schedule body. Memory reaches these while its cloned state
is still staged; SQLite reaches them before its transaction commits.

### Additional failure-proof table

| Check                                          | Fault injected                                                                                            | Test that observed it                                               | Observed failure                                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Shared reach matches its configured phase      | Ignored the reached phase                                                                                 | `a different phase cannot satisfy the named fault`                  | Expected `phase-failed`; received `observed` from the unrelated write assertion.                       |
| Memory reach matches its configured phase      | Ignored the reached phase                                                                                 | `reports a different staged-state phase through the proof recorder` | Expected `phase-failed`; received `observed` from the unrelated saved-plan assertion.                  |
| SQLite reach matches its configured phase      | Ignored the reached phase                                                                                 | `reports a different transaction phase through the proof recorder`  | Expected `phase-failed`; received `observed` from the unrelated journal assertion.                     |
| A prior proof cannot supply reach evidence     | Reused the definition's control                                                                           | `a prior proof cannot satisfy a later proof`                        | Expected `phase-failed`; received `observed` from `unrelated second failure`.                          |
| A reused control is rejected before setup      | Returned the same one-shot control from the definition twice                                              | `a reused control is refused before another setup`                  | The second setup ran, then the recorder escaped on `fault control for counter-read was already armed`. |
| Concurrent proofs keep setup inert             | Shared one control across overlapping proofs                                                              | `concurrent proofs own independent controls`                        | Held setup expected `false`; received `true` after the other proof armed.                              |
| One run cannot decorate two opened sources     | Removed the one-open guard                                                                                | `one fault run cannot open a second source`                         | The second source opened instead of throwing `opened more than one source`.                            |
| Controls are one-shot                          | Removed each shared/memory/SQLite repeated-arm guard                                                      | The three control lifecycle tests                                   | Expected `already armed`; the second arm returned `undefined`.                                         |
| Every adapter phase is wired to its real write | Removed each of the six source seam calls                                                                 | The six `reaches ... inside the real ...` cases                     | Each promise resolved where the test required its named injected rejection.                            |
| Memory rejection keeps staged state private    | Published the staged state from the rejection path; published saved-plan state before its barrier         | The three memory source-path cases                                  | Each public list gained `faulted` beside `sentinel`.                                                   |
| SQLite rejection rolls back the transaction    | Moved each barrier after commit; for saved plans, propagated the original error without a second rollback | The three SQLite source-path cases                                  | Each public list gained `faulted` beside `sentinel`.                                                   |

### Passing correction commands

- Focused four-file fault suite: 21 pass, 0 fail, 55 assertions.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run conformance:test --skip-nx-cache`: 29 pass, 0 fail.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run store-memory:test --skip-nx-cache`: 35 pass, 1 declared legacy gap skip, 0 fail.
- `bun test --coverage --coverage-reporter=lcov` in `libs/store-sqlite`: 659 pass, 0 fail, 2,029 assertions across 60 files.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint,typecheck -p conformance,store-memory,store-sqlite --skip-nx-cache`: all six targets succeeded.

The full workspace gate and build/browser targets remain skipped: Task 1.2 has
no UI, browser or deploy surface. Both complete changed-adapter test targets
were run after installing the real seams.

## 2026-09-12 — task 1.2 Astra re-review proof correction

The memory journal source now exposes an internal, conformance-only reader for
the journal fixture's own event array. The proof reads that backing seam rather
than the independently bound public `planEvents` fixture, so it certifies only
the named journal-history mutation and staged rollback. Public journal/history
integration remains explicitly uncertified until Task 5.1.

Memory and SQLite subtree proof copies now contain one estimate satellite on a
real starting step. Each proof establishes its public-reader baseline, records
the completed satellite key at the actual adapter seam, verifies exact root and
estimate restoration after rejection, and performs a successful restored
write.

### Additional failure-proof table

| Check                                                       | Fault injected                                                | Test that observed it                                                | Observed failure                              |
| ----------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------- |
| Memory proof reads the actual journal-history backing seam  | Disconnected `journalHistoryFor` from the journal event array | `reaches a journal late write inside the real staged source`         | Expected `["event-sentinel"]`; received `[]`. |
| Memory history phase follows the actual history mutation    | Moved the staged barrier before the journal event push        | `reaches a journal late write inside the real staged source`         | Expected `["event-faulted"]`; received `[]`.  |
| Memory final-satellite phase follows a real satellite write | Moved the staged barrier before the estimate write            | `reaches the final subtree write inside the real staged source`      | Expected `["faulted:step-1"]`; received `[]`. |
| SQLite final-satellite phase follows a real satellite write | Moved the transaction barrier before the estimate insert      | `reaches the final subtree write inside the real SQLite transaction` | Expected `["faulted:step-1"]`; received `[]`. |

### Passing correction commands

- Focused four-file fault suite: 21 pass, 0 fail, 67 assertions.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run conformance:test --skip-nx-cache`: 29 pass, 0 fail, 47 assertions.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run store-memory:test --skip-nx-cache`: 35 pass, 1 declared legacy gap skip, 0 fail, 223 assertions.
- `bun test --coverage --coverage-reporter=lcov` in `libs/store-sqlite`: 659 pass, 0 fail, 2,033 assertions across 60 files.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint,typecheck -p conformance,store-memory,store-sqlite --skip-nx-cache`: all six targets succeeded.

The full workspace gate and build/browser targets remain skipped because this
correction is confined to internal source conformance seams and tests. The one
memory `estimates.set:unknown_step` skip is the pre-existing declared legacy
gap owned by Task 1.3.

## 2026-09-12 — task 1.3 existing-family migration

The steps, estimates, directory and eventLog cases now live in their named
family files and execute through `runCases`. Their twelve IDs remain an
independent exact list in certification. Both source tests open the actual
source factory per case and seed the same explicit two-project fixture. SQLite
runs all twelve cases. Memory runs eleven; bypassing its declaration proves
that `estimates.set:unknown_step` still answers `written`, so the gap remains
with the observed assertion and source revision.

### Task 1.3 failure-proof table

| Check                                                          | Fault injected                                                            | Test that observed it                                                           | Observed failure                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Existing IDs survive the migration                             | Loaded the inventory test before `existingStoreRegistrations` existed     | `preserves the original offered-case IDs`                                       | `SyntaxError: Export named 'existingStoreRegistrations' not found`.                       |
| SQLite executes the real seeded cases                          | Opened the real source with project rows missing required estimate fields | `SQLite runs every offered existing case`                                       | All case setups failed on `undefined is not an object (evaluating 'weights.optimistic')`. |
| Memory gap is an observed failure, not an exclusion assumption | Bypassed the declaration and ran `estimates.set:unknown_step`             | `memory's unknown-step gap names an observed refusal mismatch`                  | `Expected: "unknown_step"`; `Received: "written"`.                                        |
| Added step is observable                                       | `break:steps.add` changed the written name                                | `reinjects the existing add, rename, estimate, remove, range, and prune faults` | `Expected to contain: "Wiring"`; received `"faulted add"`.                                |
| Renamed step is observable                                     | `break:steps.rename` changed the requested name                           | Same shared-runner fault test                                                   | `Expected: "Renamed"`; `Received: "faulted rename"`.                                      |
| Estimate value is observable                                   | `break:estimates.set` incremented realistic days                          | Same shared-runner fault test                                                   | `Expected: 2`; `Received: 3`.                                                             |
| Removed estimate is absent                                     | `break:estimates.remove` omitted the removal                              | Same shared-runner fault test                                                   | Received the extra `"work-a-two"`.                                                        |
| Event range is observed                                        | `break:eventLog.rangeSince` returned no rows                              | Same shared-runner fault test                                                   | `Expected: [1]`; `Received: []`.                                                          |
| Prune count is observed                                        | `break:eventLog.pruneBeyond` returned zero without pruning                | Same shared-runner fault test                                                   | `Expected: 2`; `Received: 0`.                                                             |

### Task 1.3 passing commands

- Focused three-file suite: 5 pass, 0 fail, 71 assertions.
- Coverage-mode source-conformance files: memory 2 pass/0 fail and SQLite 2
  pass/0 fail; evidence matching is stable with Bun's ANSI presentation
  removed before comparing the recorded text.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run conformance:test --skip-nx-cache`:
  29 pass, 0 fail, 47 assertions.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run store-memory:test --skip-nx-cache`:
  23 pass, 0 fail, 226 assertions.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run store-sqlite:test --skip-nx-cache`:
  647 pass, 0 fail, 2,051 assertions across 60 files.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t typecheck -p conformance store-memory store-sqlite --skip-nx-cache`:
  all three targets succeeded; the missing-family compile fixture remains active.
- The matching three-project lint run succeeded; OpenSpec strict validation and
  all 75 artifacts passed.
- Prettier checks for every changed source/evidence file and `git diff --check`
  passed.

The full workspace, build, deploy and browser gates were not run: this slice
moves the four existing adapter contract cases and changes no browser,
transport or deployment behavior.

One earlier command is explicitly invalid evidence: `bun test libs/conformance
libs/store-memory libs/store-sqlite` was invoked from the repository root after
direct TypeScript builds. Bun also collected generated `dist/out-tsc` test
duplicates, which cannot resolve workspace aliases or migration paths from
that location. The official project-scoped Nx targets above run from each
project's configured working directory and replaced that command; all three
passed.

## 2026-09-12 — task 1.3 Astra lifecycle correction

SQLite fixture setup now owns its source and temporary directory from creation
through verified seeding. Every setup failure closes the real source and then
removes the directory; if cleanup also fails, the original and cleanup failures
are retained together. Fault proof setup opens, seeds and verifies the source
while the control is inert. Only the selected shared case runs after arming,
and runner failures outside its assertion phase are classified as phase
failures rather than assertion observations.

### Lifecycle failure-proof table

| Check                                             | Fault injected                                                                  | Production-path test                                                          | Observed RED                                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Failed setup releases both resources              | Rejected the first real `users.create` during seed                              | `failed SQLite setup closes its source and removes its temporary directory`   | Close count was `0` rather than `1`; the temporary directory still existed.                                      |
| Setup and cleanup failures are both retained      | Rejected seed and then rejected the real source close                           | `failed SQLite setup preserves its original and cleanup failures`             | `Expected: true`, `Received: false` after replacing the aggregate with cleanup alone.                            |
| Seed reach cannot certify the shared assertion    | Called the decorated real `steps.add` from project seed and then rejected setup | `a seed failure cannot become an observed shared-case assertion`              | Proof was `observed` with `reachedDuringSeed === true` although the shared assertion never ran.                  |
| Cleanup reach cannot certify the shared assertion | Rejected close after the decorated real `steps.add` reached its fault           | `a cleanup failure after fault reach is a phase failure, not assertion proof` | Proof was `observed`; its text also contained `cleanup failed: injected cleanup failure after actual steps.add`. |

### Lifecycle correction verification

- Focused SQLite source-conformance file: 6 pass, 0 fail, 273 assertions.
- Full SQLite adapter target: 651 pass, 0 fail, 2,282 assertions across 60 files.
- Direct SQLite TypeScript build and focused ESLint check passed.
- The final proportional multi-project and OpenSpec commands are recorded in
  the Task 1.3 report.

No later source family was implemented. The full workspace, build, deploy and
browser gates remain skipped because this correction changes only test fixture
ownership and certification classification.

## 2026-09-12 — task 1.3 Astra diagnostic correction

The execution runner and fault-proof recorder now use one internal failure
renderer. It retains an aggregate's own context and recursively renders its
members in insertion order, so setup, cleanup and nested cleanup failures
survive both returned certification-report boundaries.

### Diagnostic failure-proof table

| Check                                              | Fault injected                                                                                                  | Production-path test                                                     | Observed RED                                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `ExecutionReport` retains all setup/cleanup causes | The real SQLite seed rejected, then actual source close threw a cleanup aggregate containing a nested aggregate | `the execution report surfaces nested SQLite setup and cleanup failures` | Expected `original report setup sentinel`; received only `SQLite conformance setup and cleanup failed`. |
| `FaultProof` retains all setup/cleanup causes      | The same real SQLite setup/cleanup shape ran through `recordFaultProof`                                         | `the fault proof surfaces nested SQLite setup and cleanup failures`      | Expected `original proof setup sentinel`; received only `SQLite conformance setup and cleanup failed`.  |

Both restored tests assert the complete surfaced string, including the outer
context, original setup sentinel, cleanup sentinel and nested cleanup sentinel.
They also retain setup classification, require one real close and verify the
temporary directory is absent.

### Diagnostic correction verification

- Focused SQLite source-conformance file: 8 pass, 0 fail, 282 assertions.
- Conformance target: 29 pass, 0 fail, 47 assertions.
- Memory target: 23 pass, 0 fail, 226 assertions.
- Full SQLite target: 653 pass, 0 fail, 2,291 assertions across 60 files.
- All six conformance/memory/SQLite lint and typecheck targets succeeded; the
  missing-family compile fixture remains active.
- OpenSpec strict validation succeeded and all 75 artifacts passed.

No later source family was implemented. Full workspace, build, deploy and
browser gates remain skipped because this correction changes only shared
conformance diagnostic rendering and its real SQLite probes.

## 2026-09-12 — task 2.1 project-family cases

The shared runner now registers all three project cases before the preserved
twelve existing cases. Both real source factories open independently seeded
two-project fixtures with distinct owners and explicit stamps. Creation checks
the complete project and ordered starting steps; update pre-asserts both
project sentinels, renames only A and refuses an unknown ID; access history
gives the two actors deliberately different orders and timestamps.

### Task 2.1 failure-proof table

| Check                                    | Fault injected                                                                           | Production-path test                                                    | Observed failure                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Registration cannot omit the project kit | Loaded the independent 15-ID inventory before registering `projectRegistrations`         | `preserves the original IDs and adds the project cases`                 | The received list omitted all three `projects.*` IDs.                     |
| Create persists both starting steps      | Both source decorators passed an empty starting-step list into the real project `create` | `reinjects project step, scope, and reader-order faults` in each source | Expected the two `project-created-*` rows; received `[]`.                 |
| Update is scoped to project A            | Both source decorators repeated the real update against project B                        | Same source-specific fault tests                                        | Project B expected `Project 2`; received `Renamed project`.               |
| Access order is caller-specific          | Both source decorators ignored the requested user and read owner A's access rows         | Same source-specific fault tests                                        | Owner B expected `Project 1, Project 2`; received `Project 2, Project 1`. |

Each fault proof seeded while inert, reached its named method only after arm,
failed the shared assertion, and was followed by a restored run of those same
three registrations. Memory required no project gap; its existing exact
`estimates.set:unknown_step` gap is unchanged.

### Task 2.1 verification

- Focused shared inventory: 1 pass, 0 fail.
- Focused memory source: 3 pass, 0 fail, 72 assertions.
- Focused SQLite source: 9 pass, 0 fail, 398 assertions.
- Existing SQLite project repository and settings suites: 35 pass, 0 fail, 87 assertions.
- Conformance target: 29 pass, 0 fail, 47 assertions.
- Memory target: 24 pass, 0 fail, 270 assertions.
- SQLite target: 654 pass, 0 fail, 2,407 assertions across 60 files.
- All six conformance/memory/SQLite lint and typecheck targets succeeded; the
  missing-family compile fixture remains active.
- OpenSpec strict validation succeeded and all 75 artifacts passed.

The full workspace, build, browser and deploy gates were not run: Task 2.1
adds one store-family conformance kit and test-only source decorators, with no
transport, UI, migration or deploy behavior.

## 2026-09-12 — task 2.2 user-family cases

The shared runner now registers the four user cases after projects. Both real
source factories offer the users family without a gap. The cases assert a
duplicate username's original and attempted replacement IDs after settlement,
the complete nullable account read through both keys, issuer-plus-subject
identity, and a verified-email collision with the claiming account unchanged.

### Task 2.2 failure-proof table

| Check                                     | Fault injected                                                                                  | Production-path test                                                          | Observed failure                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Registration cannot omit the user kit     | Loaded the independent 19-ID inventory before registering `userRegistrations`                   | `preserves the original IDs and adds the project and user cases`              | The received list omitted all four `users.*` IDs.                               |
| Duplicate username cannot create a new ID | Both decorators overwrote the existing account at the source's real backing seam                | `reinjects account uniqueness, read-shape, issuer, and verified-email faults` | `duplicate` received `user-duplicate`; the original no longer matched.          |
| Nullable password survives both reads     | Both decorators removed `passwordHash` from actual `findById` and `findByUsername` results      | Same source-specific fault test                                               | Both expected `passwordHash: null` fields were absent.                          |
| OIDC identity includes issuer and subject | Both decorators substituted the first issuer when the same subject arrived under another issuer | Same source-specific fault test                                               | `otherIssuer` received `oidc-primary`; `otherStored` was null.                  |
| Verified-email collision refuses creation | Both decorators changed only the conflicting request to unverified before the actual resolution | Same source-specific fault test                                               | `conflict` and `conflicting` received the newly stored `oidc-conflict` account. |

Every fault seeded while inert, reached only its named assertion phase, and was
followed by the unchanged four registrations passing on a fresh source. Memory
required no user gap; its existing exact `estimates.set:unknown_step` gap is
unchanged.

### Task 2.2 verification

- Focused shared inventory: 1 pass, 0 fail.
- Focused memory source: 4 pass, 0 fail, 93 assertions.
- Focused SQLite source: 10 pass, 0 fail, 515 assertions.
- Existing SQLite OIDC repository suite: 5 pass, 0 fail, 12 assertions.
- Conformance target: 29 pass, 0 fail, 47 assertions.
- Memory target: 25 pass, 0 fail, 291 assertions.
- SQLite target: 655 pass, 0 fail, 2,524 assertions across 60 files.
- All six relevant lint/typecheck targets succeeded; the missing-family compile
  fixture remains active.
- Formatting and OpenSpec validation passed in the final verification run.

The full workspace, build, browser and deploy gates were not run: Task 2.2
adds account-store conformance cases and test-only source decorators, without
changing transport-token verification, UI, migration or deploy behavior.

## 2026-09-12 — task 2.3 capacity and priority-band families

The shared runner now registers all three capacity and all three priority-band
cases. Each case observes a complete public map/list or ladder snapshot beside
unchanged project and team sentinels. The ladder replacement case first observes
unconfigured B's default, then writes and pre-asserts independent valid five-band
ladders for A and B before replacing A again. It compares both configured ladders
afterward. Validation remains solely at its existing controller boundary.

### Task 2.3 failure-proof table

| Check                                                | Fault injected                                                                                                                                                                                         | Production-path test                                                          | Observed failure                                                                                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration cannot omit either configuration kit    | Loaded the independent inventory before registering either six-case kit                                                                                                                                | `preserves the original IDs and adds project, user, and configuration cases`  | Received inventory omitted all six `capacity.*` / `priorityBands.*` IDs.                                                                                        |
| Capacity identity includes project and team          | Both decorators redirected the second same-team write to the first project through the real store                                                                                                      | Source-specific configuration fault test                                      | A's complete map/list held `team-a: 5` instead of 2 and B was empty.                                                                                            |
| Clear means absent rather than zero                  | Memory passed zero into its real store; SQLite enabled its connection-local constraint bypass and passed zero into the real repository                                                                 | Source-specific configuration fault test                                      | `hasClearedKey` received true and both public reads exposed `team-a: 0`.                                                                                        |
| Capacity refuses missing references without rows     | SQLite redirected both requests to held references; memory ran the exact unexcluded case before its gap was recorded                                                                                   | SQLite fault test / `names the observed configuration-reference refusal gaps` | SQLite returned both true and exposed A's row; memory returned both true and exposed rows under the missing project/team keys (`Expected - 6 / Received + 14`). |
| Unconfigured projects receive the default ladder     | Both decorators completed the real reads, then returned empty ladders                                                                                                                                  | Source-specific configuration fault test                                      | Both projects received `[]` instead of all five default bands (`Expected - 54 / Received + 2`).                                                                 |
| Replacement writes the whole five-band ladder        | Both decorators sent the first replacement rung plus four existing A rungs through the real replacement                                                                                                | Source-specific configuration fault test                                      | A retained `Soon`, `Planned`, `Later`, and `Parked`; the complete comparison failed with Expected -10 / Received +10 while B stayed exact.                      |
| Replacement remains scoped to its project            | SQLite installed a connection-local trigger immediately before A's second replacement, broadening that real transaction's delete to B; memory reset B through the staged source before the same A call | Separate source-specific project-scope fault tests                            | Both received B's `Critical/High/Medium/Low/Lowest` defaults instead of its configured `Now/Next/Queued/Deferred/Backlog` ladder (Expected -13 / Received +13). |
| Missing-project replacement refuses without a ladder | SQLite redirected the real replacement to A; memory ran the exact unexcluded case before its gap was recorded                                                                                          | SQLite fault test / memory gap-bypass test                                    | SQLite returned true and changed A; memory returned true and exposed the missing project's stored ladder (`Expected - 16 / Received + 15`).                     |

All injected faults seeded while inert, reached only their named case after arm,
and were followed by the unchanged supported registrations passing against fresh
sources. Memory declares only its two newly observed reference-set limitations;
SQLite executes all six with no gap. Memory's earlier exact
`estimates.set:unknown_step` gap is unchanged.

### Task 2.3 verification

- Focused shared inventory: 1 pass, 0 fail.
- Focused memory source: 6 pass, 0 fail, 182 assertions.
- Focused SQLite source: 11 pass, 0 fail, 765 assertions.
- Existing SQLite capacity and priority-band suites: 17 pass, 0 fail, 34 assertions.
- Conformance target: 29 pass, 0 fail, 47 assertions.
- Memory target: 27 pass, 0 fail, 380 assertions.
- SQLite target: 656 pass, 0 fail, 2,774 assertions across 60 files.
- All six relevant lint/typecheck targets passed; the missing-family compile
  fixture remains active.
- Formatting, `git diff --check`, OpenSpec strict validation and all 75 artifacts
  passed.

The full workspace, build, browser and deploy gates were not run: Task 2.3 adds
configuration-store conformance cases and test-only source decorators, with no
transport, UI, migration or deployment behavior.

### Task 2.3 review repair and acceptance

Astra's first review observed that an unconfigured B read could not distinguish
preservation from broad deletion because both states returned the default ladder.
The shared case now establishes the configured sentinel described above. The
first-rung proof remains separate and targets A's second replacement by its own
per-project call count, so B's added setup cannot consume its fault window.

Focused repair evidence on 2026-09-12:

- Combined offered-case, first-rung and project-scope proof runs: memory 3 pass,
  0 fail, 150 assertions; SQLite 3 pass, 0 fail, 492 assertions.
- Isolated observed project-scope proof runs before restoration: memory 1 pass,
  0 fail, 22 assertions; SQLite 1 pass, 0 fail, 38 assertions. These test
  results mean the proof harness observed the named shared-case failure and its
  following unchanged-source case passed; the injected source did not pass
  conformance.
- Uncached normal targets after restoration: conformance 29 pass, 0 fail, 47
  assertions; memory 28 pass, 0 fail, 411 assertions; SQLite 657 pass, 0 fail,
  2,821 assertions across 60 files.
- Uncached lint and typecheck targets passed for conformance, store-memory and
  store-sqlite.
- Pinned OpenSpec 1.3.0 strict validation passed for this change; all-artifact
  validation reported 75 passed, 0 failed. Both commands exited 0 after
  non-fatal telemetry DNS warnings from the sandbox.

The six changed files passed focused Prettier checking and `git diff --check`.
The workspace, build, browser and deploy gates remain outside this bounded
repair; the parallel browser owner reported its own result separately.

Astra xhigh accepted the repair on 2026-09-12, with no new Critical or Important
findings. It independently removed the project predicate from a temporary copy
of the actual SQLite replacement adapter and activated that mutation only on
the second A replacement, after both complete stored ladders were pre-asserted.
The intended final comparison failed with A exact and B's configured ladder
replaced by defaults (Expected -13 / Received +13); the restored shared case
passed. A separate all-writes activation failed earlier when B's setup erased A;
that earlier collision is not the acceptance evidence for the final comparison.
The two probe tests passed with 74 assertions in 389 ms. Reports and full output:
`/tmp/source-conformance-2-3-astra-rereview.md` and
`/tmp/source-conformance-2-3-astra-rereview-probes/output.txt`.

Task 2.3 is complete again, bringing this local change to 6/24 tasks. The minor
gap-diagnostic note remains open: two memory gap strings pin diff sizes rather
than observed values; no current false exclusion was demonstrated, and this
repair did not change those cases. The eighteen remaining slices, current-main
integration and final whole-change certification/gates remain pending.

## 2026-09-13 — task 2.4 calendar-marker family

The shared runner now registers both calendar-marker cases. The order case
creates marker-c/marker-a/marker-b with identical date and createdAt, proves the
tie from settled write answers, then asserts marker-a/marker-b/marker-c through
the public list. The write case creates exact A/B sentinels on literal
2026-09-10 with null automatic color, renames and recolors A, clears it to null,
refuses B's three mutations against A, removes A and observes B unchanged.

### Task 2.4 failure-proof table

| Check                                 | Fault injected                                                                                            | Production-path test                                                                 | Observed failure                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Registration includes both marker IDs | Loaded the independent inventory before registering `calendarMarkerRegistrations`                         | `preserves the original IDs and adds project, user, configuration, and marker cases` | Both `calendarMarkers.*` IDs were absent (Expected -2 / Received +0).                                 |
| Tied lists use ID as the third key    | Memory restored insertion order after the real read; SQLite queried the real table by date/createdAt only | Source-specific marker fault test                                                    | Both read c/a/b instead of a/b/c (Expected -1 / Received +1).                                         |
| Writes remain in project scope        | Both decorators routed B's rename of A through A's real rename path                                       | Source-specific marker fault test                                                    | Rename returned true and A read `Mine now` instead of refusal/unchanged (Expected -3 / Received +10). |
| ISO day remains literal               | Both decorators changed only A's create argument from 2026-09-10 to 2026-09-11                            | Source-specific marker fault test                                                    | Settled create answer held 2026-09-11 (Expected -1 / Received +1).                                    |

All three faults were armed after verified two-project seed, reached only after
their case-specific preconditions, failed the shared assertion and were followed
by the unchanged two registrations passing against fresh sources. Neither
source needs a calendar-marker gap. Existing marker adapters were unchanged.

### Task 2.4 verification

- Focused shared inventory: 1 pass, 0 fail, 1 assertion.
- Focused memory source: 8 pass, 0 fail, 263 assertions.
- Focused SQLite source: 13 pass, 0 fail, 918 assertions.
- Existing SQLite marker repository/table/migration suites: 19 pass, 0 fail,
  40 assertions.
- Auckland zoned marker runner: 2 files, 3 tests passed; it emitted the existing
  Vite native-config warning.
- Uncached normal targets: conformance 29 pass, 0 fail, 47 assertions; memory
  29 pass, 0 fail, 461 assertions; SQLite 658 pass, 0 fail, 2,927 assertions
  across 60 files.
- All six uncached lint/typecheck targets for conformance, store-memory and
  store-sqlite succeeded.
- Pinned OpenSpec 1.3.0 strict validation passed; all-artifact validation
  reported 75 passed, 0 failed.

The full workspace, build, browser and deploy gates were not run: Task 2.4 adds
one shared store-family kit and test-only source faults, with no application,
transport, migration or deployment behavior. Task 3.1 remains untouched and
Task 2.4 stays unchecked until independent review.

### Task 2.4 review fix round 1 — mutable-input oracle

Astra's review mutated the exact object passed to `create` in place. The first
oracle reused that object after `await`, so both source proof tests received
`assertion-passed` for the literal-date fault instead of `observed`: memory
0 pass / 1 fail / 23 assertions; SQLite 0 pass / 1 fail / 47 assertions.

The case now passes an independent clone into each real source and retains its
untouched expected marker. Both permanent source faults use
`Object.assign(marker, { date: '2026-09-11' })`. A temporary capture assertion
exposed the intended settled create-answer diff in both sources: expected
2026-09-10, received 2026-09-11 (Expected -1 / Received +1). The capture runs
failed with memory 0 pass / 1 fail / 18 assertions and SQLite 0 pass / 1 fail /
42 assertions. With the capture removed, the focused proof/restoration tests
passed with memory 1/0/34 and SQLite 1/0/74.

After restoration, the complete memory source-conformance file passed 8 tests
with 263 assertions and the complete SQLite file passed 13 tests with 918
assertions. All six uncached lint/typecheck targets for conformance,
store-memory and store-sqlite succeeded. Focused formatting and diff checks are
recorded in the task report.

Astra xhigh accepted fix round 1 on 2026-09-12. The shared case passes independent
clones at both create calls while the expected marker objects remain untouched, and
both permanent source faults retain the demonstrated in-place `Object.assign`
mutation. The re-review found no new Critical or Important breakage and needed no
additional probe. Task 2.4 is complete; the source change is now 7/24 tasks. Task
3.1 remains untouched. Reports: `/tmp/source-conformance-2-4-astra-review.md` and
`/tmp/source-conformance-2-4-astra-rereview.md`.

## 2026-09-13 — task 3.1 work-item family

The shared runner now registers all five work-item cases. Each source opens the
real public `WorkItemStore`, verifies both deterministic projects and their row
IDs before fault activation, and observes state only through
`listByProject`/`findById`. Memory ran every case without a new gap; SQLite ran
all five and retains zero gaps.

### Task 3.1 failure-proof table

| Check                                        | Fault injected                                                                                                                 | Production-path test                                                  | Observed failure                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Registration includes all five work-item IDs | Loaded the independent inventory before registering `workItemRegistrations`                                                    | `preserves the original IDs and adds each completed family inventory` | All five `workItems.*` IDs were absent (Expected -5 / Received +0).                                                                     |
| Insert applies declared respacing            | Both decorators passed an empty `respaced` list into the real insert                                                           | Source-specific work-item fault test                                  | The second sibling remained at position 11 instead of 30.                                                                               |
| Unknown-team refusal is atomic               | Both decorators first completed and publicly verified the scalar rename, then invoked the real patch carrying the unknown team | Source-specific work-item fault test                                  | The refusal was modeled, but the complete settled row changed from `Work 1` to `Escaped rename` (SQLite also advanced revision 1 to 2). |
| Every surviving child is promoted            | Both decorators omitted `work-a-child-two` from the real promotion list                                                        | Source-specific work-item fault test                                  | Memory retained its old `work-a-one` parent link; SQLite refused and rolled back, so `didRefuse` was true and the parent remained.      |
| Clearing one frozen number is key-specific   | Both decorators appended a null update for the other frozen row to the real batch                                              | Source-specific work-item fault test                                  | `work-a-two` received null instead of retaining `020`.                                                                                  |

`workItems.move:parent-position` deliberately has no fifth mutation. Its normal
case moves one row beneath a different parent, respaces the existing child and
compares the exact project/parent/position set while project B remains an exact
public-read sentinel. All four faults were first run as inert controls and
failed the proof test as `phase-failed`; after implementation they were observed
at the named assertion and the unchanged registrations passed on fresh sources.

### Task 3.1 verification

- Registration RED: 0 pass, 1 fail; five expected IDs missing. Restored: 1 pass,
  0 fail, 1 assertion.
- Exact unexcluded five-case runs before faults: memory 1 pass, 0 fail, 43
  assertions; SQLite 1 pass, 0 fail, 63 assertions.
- Focused normal plus four proof/restoration runs: memory 2 pass, 0 fail, 113
  assertions; SQLite 2 pass, 0 fail, 165 assertions.
- Complete source files: memory 10 pass, 0 fail, 600 assertions; SQLite 15 pass,
  0 fail, 1,083 assertions.
- Existing SQLite work-item suite: 38 pass, 0 fail, 87 assertions.
- Uncached normal targets: conformance 29 pass / 47 assertions; memory 31 pass /
  798 assertions; SQLite 660 pass / 3,092 assertions across 60 files.
- All six uncached lint/typecheck targets for conformance, store-memory and
  store-sqlite succeeded.
- Focused Prettier and `git diff --check` passed after the evidence update.
- Pinned OpenSpec 1.3.0 strict validation passed; all-artifact validation
  reported 75 passed and 0 failed.

The source-specific `test:conformance` targets remain a planned Task 7.2
integration and do not exist in the three current project files, so no such
command is claimed here. The full workspace, build, browser and deploy gates
were not run: this slice adds a shared store conformance kit and test-only
source decorators, without application, transport, migration or deployment
behavior. Task 3.1 remains unchecked pending independent review; Task 3.2 was
not started.

### Task 3.1 Astra fix round 1 — complete public snapshots

Astra's review found the insert, move, promotion and freeze assertions projected
away most of each `LabelledWorkItem`. The cases now compare independently
constructed complete project-A lists and unchanged complete project-B lists.
Affected survivors carry nonempty team, service, type and external-reference
witnesses before fault activation; SQLite also carries the seeded tag witness.
Literal placement, frozen-number and removal-settlement assertions remain.

The complete expected lists retain revision. They allow only the two precise
public outcomes the sources expose: no structural bookkeeping bump, or exact
increments of moved +1; reparented children +1 with the position-only sibling
unchanged; and frozen rows +2/+1 across the two batches. The expected rows are
cloned before the operation, including source-minted external-reference IDs, so
neither mutable request input nor the settled source answer can rewrite the
oracle.

- Exact five-case runs: memory 1 pass / 83 assertions; SQLite 1 pass / 103
  assertions. No new memory gap; SQLite remains at zero gaps.
- The unchanged four permanent faults failed inside the complete snapshot
  assertions, and their restored proof tests passed: memory 1/0/129; SQLite
  1/0/161.
- Complete source files passed: memory 10/0/923; SQLite 15/0/1,474. The existing
  SQLite work-item suite passed 38/0/87.
- All six uncached lint/typecheck targets for conformance, store-memory and
  store-sqlite passed after the fix.

Astra xhigh accepted fix round 1 at `6a8481a7` on 2026-09-12. The re-review
confirmed that every affected case now compares complete, independently built
public project-A arrays alongside an unchanged project-B sentinel. Revision
variance is restricted to whole-array alternatives for the exact durable
outcomes exposed by the two sources, so rows from incompatible alternatives
cannot be mixed. The four permanent faults still fail inside those complete
snapshots. No Critical or Important finding remains. Task 3.1 is complete; the
source change is now 8/24 tasks, and Task 3.2 is next. Review:
`/tmp/source-conformance-3-1-astra-rereview.md`.

## 2026-09-13 — task 3.2 estimate ownership and actuals implementation evidence

The shared runner now registers `estimates.moveAll:ownership` and all four
actual cases. Every case uses two seeded projects with two work items and two
steps, distinct estimate values or actual timestamps, complete pre-operation
public snapshots and an unchanged project-B sentinel. Settled assertions keep
the complete composite keys, estimate trios, actual days and `recordedAt`.

Memory's real unexcluded `actuals.set:unknown_step` run failed at the shared
assertion with expected `unknown_step` and received `written`. That exact new
gap is declared only after the observed run. The existing estimate unknown-step
gap was bypassed again and remains open with the same mismatch. SQLite executed
all five new cases and retains zero gaps.

### Task 3.2 failure-proof table

| Check                               | Fault injected through the real source                                                      | Production-path test                                                  | Observed failure                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Registration includes all five IDs  | Loaded the independent inventory before estimate ownership and actual registrations existed | `preserves the original IDs and adds each completed family inventory` | All five IDs were absent (Expected -5 / Received +0).                               |
| Estimate move transfers ownership   | Copied both source trios through real `set` calls and omitted source removal                | Source-specific estimate/actual fault test                            | Both `work-a-one` trios remained beside the target trios (Received +14 diff lines). |
| Actual replacement restamps the row | Replaced the days through real `set` while retaining the first `recordedAt`                 | Same source-specific fault test                                       | Expected `recordedAt: 201`; received 101.                                           |
| Actual removal is pair-specific     | Invoked real removal for the requested pair and the same step on `work-a-two`               | Same source-specific fault test                                       | The complete `work-a-two`/`step-a-dev` survivor was absent.                         |
| Actual move transfers ownership     | Copied both source rows through real `set` calls and omitted source removal                 | Same source-specific fault test                                       | Both `work-a-one` rows remained beside the target rows (Received +12 diff lines).   |
| Actual set refuses a missing step   | Redirected the missing-step write through a real known-step `set` call                      | Same source-specific fault test                                       | Expected `unknown_step`; received `written`.                                        |

All controls were inert during verified seed, armed afterward, reached their
named phase and failed a settled shared assertion. Restored registrations ran
against fresh sources: memory passed the four offered cases and reported its
actual unknown-step gap as `not-offered`; SQLite passed all five.

### Task 3.2 verification

- Registration RED: 0 pass / 1 fail / 1 assertion, five IDs absent. Restored:
  1/0/1.
- Focused final runs: memory 4/0/464; SQLite 2/0/667. The memory run includes
  both estimate and actual unknown-step bypass evidence.
- Existing adapter coverage: SQLite estimate/actual suites 15/0/26; complete
  memory-source suite 9/0/153.
- Uncached normal targets: conformance 29/0/47; memory 33/0/1,294; SQLite
  661/0/3,728 across 60 files.
- All six uncached lint/typecheck targets for conformance, store-memory and
  store-sqlite passed. Pinned OpenSpec strict validation passed; all-artifact
  validation reported 75 passed and 0 failed. Formatting and diff results are
  in the Task 3.2 report.

The source-specific `test:conformance` targets remain deferred to Task 7.2 and
are absent from the current project files. The full workspace, build, browser
and deploy gates were not run because this slice adds shared conformance cases
and test-only source decorators only. Task 3.2 remains unchecked pending
independent review; Task 3.3 was not started.

### Task 3.2 Astra fix round 1 — complete settlement observations

The missing-step case now retains its outcome and reads both complete project
lists before one combined assertion. The real memory bypass and both source
faults expose received `written` together with the escaped
`work-a-one`/`no-such-step` row, days 13 at `recordedAt: 201`. The observed
memory gap remains exact; SQLite retains zero gaps.

Removal now asserts both complete project lists after call one, then repeats
them after the idempotent second call. A new permanent fault suppresses only
the first call and was observed failing in that first settlement window with
the complete targeted row still present. The retained broad-deletion fault was
re-observed there with the complete `work-a-two`/`step-a-dev`/days-5/
`recordedAt`-103 survivor absent.

All Task 3.2 permanent diagnostics now require exact signed multi-line evidence
for the intended composite rows and values. Ownership pins both extra source
rows alongside complete destination rows; replacement pins expected 201 and
received 101 on work-a-one/dev; missing-step pins both outcome and escaped row.

- Focused memory bypass/fault/restoration: 3/0/153; focused SQLite
  fault/restoration: 1/0/182.
- Complete source files: memory 12/0/1,114; SQLite 16/0/1,737.
- Existing adapters: SQLite estimate/actual 15/0/26; memory source 9/0/153.
- Uncached targets: conformance 29/0/47; memory 33/0/1,312; SQLite
  661/0/3,746 across 60 files.
- All six uncached lint/typecheck targets passed.

Formatting, diff and pinned OpenSpec validation evidence is retained in the
Task 3.2 report. The same proportional skips apply. Independent review remains
pending; Task 3.2 remains unchecked and Task 3.3 has not started.

Astra xhigh accepted fix round 1 at `3110f637` on 2026-09-13. Its focused
re-review confirmed that the missing-step case completes both public reads
before comparing outcome and state, the first removal is observed before the
idempotent second call, and every Task 3.2 diagnostic distinguishes the exact
composite rows, timestamps and expected/received direction it claims. The two
removal controls share the closed case-derived fault ID but have distinct
required phases and opposite complete-row diagnostics on fresh sources. No
Critical, Important or Minor issue remains. Task 3.2 is complete; the source
change is now 9/24 tasks, and Task 3.3 is next. Reviews:
`/tmp/source-conformance-3-2-astra-review.md` and
`/tmp/source-conformance-3-2-astra-rereview.md`.

## 2026-09-13 — task 3.3 measure metric identity and ownership evidence

The shared runner now registers all four measure cases. Set and remove place
`token_estimate`, `token_actual`, and `hours_actual` together on one pair and
retain complete other-item, other-step, and other-project sentinels. Set replaces
one metric's value and `recordedAt`; remove observes its first settlement before
the idempotent second call; move transfers every source metric and timestamp,
leaves no source rows, and preserves target and project sentinels. Missing-step
settlement retains its outcome and completes both public project reads before
one combined comparison.

Memory's real unexcluded `measures.set:unknown_step` run failed in the shared
assertion with expected `unknown_step`, received `written`, and the complete
escaped `work-a-one/no-such-step/token_estimate` row, value 21 at `recordedAt` 201. That exact gap was declared only after the run. All three supported measure
cases still execute in memory; SQLite executes all four and retains zero gaps.

### Task 3.3 failure-proof table

| Check                                   | Fault injected through the real source                                           | Production-path test                                                  | Observed failure                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Registration includes all four IDs      | Loaded the independent inventory before measure registration existed             | `preserves the original IDs and adds each completed family inventory` | All four measure IDs were absent (`Expected - 4 / Received + 0`).                                         |
| Set identity includes metric            | Removed both non-target metrics through real remove calls before the replacement | Source-specific measure fault test                                    | Complete hours value 12/time 103 and token estimate value 10/time 101 survivors were expected but absent. |
| Replacement preserves the supplied time | Passed the replacement through real set with stale `recordedAt`                  | Same source-specific fault test                                       | On the complete token-actual row, expected 201 and received 102.                                          |
| Remove identity includes metric         | Ran real remove for the requested metric and both pair survivors                 | Same source-specific fault test                                       | The same complete hours and token-estimate survivors were absent in the first settlement window.          |
| Move transfers every metric             | Moved only token-estimate rows through real set/remove calls                     | Same source-specific fault test                                       | Complete hours and token-actual rows remained received on work-a-one instead of expected work-a-two.      |
| Move preserves `recordedAt`             | Ran real move, then rewrote the destination token-actual row with time 999       | Same source-specific fault test                                       | On the complete destination row, expected 102 and received 999.                                           |
| Missing step is refused without a write | Accepted and durably wrote the absent-step request                               | Same source-specific fault test                                       | Received `written` plus the complete escaped token-estimate row in project A's public read.               |

Every source control's injected mutation stayed inert through the complete
measure setup snapshots, then activated at its named target operation, reached
that exact phase, and failed the settled shared assertion. The harness arms the
control after base-source seeding and before the shared case begins; the
operation-specific guards keep setup unaffected. Restored cases ran against
fresh sources. The permanent diagnostics pin full composite rows, values,
timestamps, and expected/received direction.

### Task 3.3 verification

- Inventory RED: 0/1/1 with four absent IDs; restored 1/0/1.
- Focused final proof/gap runs: memory 2/0/130; SQLite 1/0/167.
- Complete source files: memory 14/0/1,282; SQLite 17/0/1,969.
- Existing measure/memory suites: SQLite 11/0/22; memory 9/0/153.
- Uncached targets: conformance 29/0/47; memory 35/0/1,480; SQLite
  662/0/3,978 across 60 files.
- All six uncached lint/typecheck targets passed.
- Formatting, diff, and pinned OpenSpec validation evidence is in the Task 3.3
  report after the terminal rerun.

The source-specific conformance targets remain deferred to Task 7.2. The full
workspace, build, browser, and deploy gates were skipped as outside this shared
case and test-decorator slice. Task 3.3 remains unchecked pending independent
review; Task 3.4 was not started.

Astra xhigh approved `b2e37575` on 2026-09-13 with no Critical or Important
issue. Fresh focused review runs passed the memory gap/proof/restoration paths
with 2 tests and 130 assertions, and SQLite's six proofs plus all four restored
cases with 1 test and 167 assertions. The one Minor finding corrected the
evidence above to distinguish when the harness arms its control from when an
operation-specific fault can activate; it did not affect proof validity. Task
3.3 is complete; the source change is now 10/24 tasks, and Task 3.4 is next.
Review: `/tmp/source-conformance-3-3-astra-review.md`.

## 2026-09-13 — task 3.4 progress state and ownership evidence

The shared runner now registers `progress.set:replace`,
`progress.remove:absence`, `progress.moveAll:ownership`, and
`progress.set:unknown_step`. Every case compares complete, sorted public lists
for projects A and B, including other-item, other-step, target, and
other-project sentinels with exact state and `statedAt`. Stored progress is
limited to `in_progress` and `done`; removal proves `not_started` by absence
after its first settlement and again after an idempotent second call.

Move seeds two distinct source-step statements (`done` at 101 and
`in_progress` at 102), a separate target-step sentinel, and a project-B
sentinel. Its settled result requires both source rows to disappear and both
destination rows to retain their state and timestamp. The missing-step case
retains its outcome, completes both public project reads, and then makes one
combined outcome/state assertion.

Memory's real, unexcluded `progress.set:unknown_step` run failed in the shared
assertion with expected `unknown_step`, received `written`, and the complete
escaped `work-a-one/no-such-step/done` row at `statedAt: 201`. The exact
case-specific gap was declared only after that run. The three supported memory
cases still execute; SQLite executes all four with zero gaps.

### Task 3.4 failure-proof table

| Check                                   | Fault injected through the real source                                                            | Production-path test                                                  | Observed failure                                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration includes all four IDs      | Loaded the independent inventory before progress registration existed                             | `preserves the original IDs and adds each completed family inventory` | All four progress IDs were absent (`Expected - 4 / Received + 0`).                                                                                |
| Set replaces state and timestamp        | Replaced the incoming `done` at 201 with the stale `in_progress` at 101 through real `set`        | Source-specific progress fault test                                   | The complete `work-a-one/step-a-dev` row showed expected `done`/201 and received `in_progress`/101.                                               |
| Remove means storage absence            | Ran real `remove`, then crossed the test-only port boundary with a `not_started` surrogate at 201 | Same source-specific fault test                                       | The complete surrogate row was received in project A's public list where no row was expected.                                                     |
| Move transfers every source statement   | Copied both source rows through real `list` and `set` calls without removing either source row    | Same source-specific fault test                                       | Both complete source remnants were received: dev `done`/101 and qa `in_progress`/102, beside their complete destination rows and target sentinel. |
| Missing step is refused without a write | Accepted and durably wrote the absent-step request                                                | Same source-specific fault test                                       | Received `written` plus the complete escaped `work-a-one/no-such-step/done` row at 201 after both public project reads completed.                 |

The SQLite surrogate uses its test-only SQL boundary to insert the invalid
stored state and then exposes it through the real public progress reader. The
memory surrogate uses an adjacent justified test-only cast because the precise
port excludes the invalid state. The harness arms each control after
base-source seeding and before the shared case; operation-specific guards keep
its injected mutation inactive through the complete progress setup snapshots,
then activate it at the named target operation. Each fault reaches that exact
phase and fails a signed, structured, complete-row diagnostic taken from
observed output. Restorations use fresh real sources.

### Task 3.4 verification

- Inventory RED: 0/1/1 with four absent IDs; restored 1/0/1.
- Focused final gap/proof runs: memory 3/0/548; SQLite 2/0/766.
- Existing progress/memory suites: domain progress 8/0/77; SQLite progress
  10/0/20; memory source 9/0/153.
- Uncached targets: conformance 29/0/47; memory 37/0/1,661. SQLite's exact
  uncached target command completed directly with coverage at 663/0/4,176
  across 60 files.
- All six uncached lint/typecheck targets, formatting, diff, and pinned
  OpenSpec validation are recorded in the Task 3.4 report after their terminal
  rerun.

The first SQLite Nx stream completed without a retained exit result, and an
immediate retry hit Nx's recursive-invocation guard; neither run is counted as
evidence. The direct target command is the retained SQLite evidence. The
source-specific `test:conformance` targets remain deferred to Task 7.2 and are
absent from the current project files. Full workspace, build, browser, and
deploy gates were skipped as outside this shared conformance and test-decorator
slice. Task 3.4 remains unchecked pending independent review; Task 4.1 was not
started.

### Task 3.4 Astra fix round 1 — progress-only SQLite setup ownership

The progress-only third-step seed now runs as `seedSqliteSource`'s final seed
operation, after the verified base seed but inside the same resource owner. A
rejection therefore closes the source and removes its temporary directory for
both the ordinary case opener and `proveFault`; `throwAfterCleanup` retains the
original and cleanup failures without a second cleanup implementation. A
successful seed still hands ownership to the normal fixture teardown, which
closes exactly once.

Permanent negatives reject only the add of `PROGRESS_SENTINEL_STEP_ID`, after
the base seed succeeds. With the late seed moved back outside the owner, both
entry paths failed on expected `{ closeCalls: 1, directoryExists: false }` and
received `{ closeCalls: 0, directoryExists: true }`; the aggregation case
failed on `Expected: true · Received: false`. A separate double-cleanup
injection failed with expected `closeCalls: 1` and received `closeCalls: 2`.
Restored cleanup coverage passed 4/0/59, progress proof/restoration remained
2/0/766, and the complete SQLite source-conformance file passed 22/0/2,226.

Adjacent comments now identify the isolated SQLite test database at the CHECK
and FK overrides, the forbidden `not_started` and missing-step rows, restoration
in `finally`, and the direct `step_progress` read required because the public
reader's normal inner step join hides the stored orphan.

Fresh uncached targets passed: conformance 29/0/47, memory 37/0/1,661, and
SQLite 667/0/4,235 across 60 files. All six uncached lint/typecheck targets
passed. Formatting, diff, and pinned OpenSpec evidence is retained in the
updated Task 3.4 report. Independent re-review remains pending; Task 3.4 stays
unchecked and Task 4.1 remains untouched.

Astra xhigh accepted fix round 1 at `986d966d` on 2026-09-13. Fresh focused
baseline ran nine tests with 208 assertions, including the four cleanup cases,
the inherited setup/aggregation paths, and progress proofs/restoration. Moving
the progress seed outside the owner again made all three permanent late-seed
negatives fail with the recorded leaks and lost aggregation; injecting double
cleanup failed on two closes instead of one. Restored cleanup coverage passed
4/0/59. Both I1 and M1 are closed, and no new Critical, Important or Minor
finding remains. Task 3.4 is complete; the source change is now 11/24 tasks,
and Task 4.1 is next. Reviews: `/tmp/source-conformance-3-4-astra-review.md` and
`/tmp/source-conformance-3-4-astra-rereview.md`.

## 2026-09-13 — task 4.1 dependency and empty-retention evidence

The shared runner now registers `dependencies.add:idempotent-pair`,
`dependencies.remove:pair`, `dependencies.removeAllFor:touching-set`, and
`eventLog.pruneBeyond:empty-sequence`. Both memory and SQLite offer all four
cases with zero new gaps.

Dependency fixtures add two project-A survivor rows inside the source-owned
seed lifecycle. Each case then seeds literal complete edges in projects A and B
and compares the complete public lists, including ID, project, predecessor and
successor, after setup and after every settled operation. Adding the same pair
under a second ID retains the original edge only. Exact pair removal preserves
edges sharing either endpoint. Full-set removal takes incoming, outgoing and
doomed-to-doomed edges while retaining the survivor and other-project edges.
The repeated add, remove and removeAllFor calls are observed in separate
post-settlement snapshots.

The event-log case records exact sequence-0/1 records and a second-subscription
sentinel, prunes every retained row with `pruneBeyond(0)`, and observes empty
ranges, null oldest sequences and unchanged latest sequence positions. Its next
real `recordEvent` return is compared as a complete record with sequence 2;
the public range independently confirms that literal record.

### Task 4.1 failure-proof table

| Check                                     | Fault injected through the real source                                                     | Production-path test                                                  | Observed failure                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Registration includes all four IDs        | Loaded the independent inventory before dependency and empty-sequence registration existed | `preserves the original IDs and adds each completed family inventory` | All four IDs were absent (`Expected - 4 / Received + 0`).                    |
| Add identity is the ordered pair          | Decorated add/list with an ID-keyed view after real adds                                   | Source-specific dependency fault test                                 | The complete received second-ID edge duplicated `work-a-one -> work-a-two`.  |
| Remove uses both pair predicates          | Omitted the successor predicate and ran real removes for every matching predecessor        | Same source-specific test                                             | The complete expected same-predecessor edge was absent.                      |
| Full-set removal includes incoming edges  | Ran real removes for outgoing edges only                                                   | Same source-specific test                                             | The complete incoming survivor-to-doomed edge remained received.             |
| Full-set removal uses every doomed ID     | Passed only the first doomed ID to the real removeAllFor                                   | Same source-specific test                                             | The complete outgoing edge from the second doomed row remained received.     |
| Empty retention does not reset allocation | Derived the next returned sequence from retained MAX after the real prune and append       | Source-specific event-log fault test                                  | The complete next record showed expected sequence 2 and received sequence 0. |

Every control is created per fresh source and remains inert through verified
base seeding. The shared case completes and checks its public setup snapshot
before the targeted operation. Each permanent source decorator then reaches
its distinct named phase and fails the intended signed complete-edge or
complete-record assertion. Restorations open fresh real sources.

### Task 4.1 verification

- Inventory RED: 0/1/1 with four absent registrations; restored 1/0/1.
- Focused real cases plus proofs/restoration: memory 3/0/617 assertions; SQLite
  3/0/897.
- Existing SQLite dependency/event-log suites: 16/0/27; staged memory source:
  9/0/153.
- Full uncached targets: conformance 29/0/47; memory 39/0/1,873; SQLite
  669/0/4,499 across 60 files.
- All six uncached lint/typecheck targets passed for conformance, store-memory
  and store-sqlite.
- Pinned OpenSpec 1.3.0 strict validation reported the change valid; the
  all-artifact JSON run reported 75 passed and 0 failed.

Nx could not use its sandboxed plugin sockets and ran plugins in-process; every
retained target command still completed with exit 0. The source-specific
`test:conformance` targets remain deferred to Task 7.2 and do not exist. The
full workspace, build, browser, deploy and h2puni SHA gate were skipped as
outside this shared conformance/test-decorator slice and because no commit was
authorized. Task 4.1 remains unchecked pending independent review; Task 4.2 was
not started.

### Task 4.1 Astra repair — independent oracles, durable sequence fault and memory ownership

Dependency cases now pass a structured clone to every `add`, leaving each
complete expected edge independent from the source input. Permanent mutation
faults change the original input ID in place on both real source paths and the
setup-list assertion reports the signed complete-edge replacement from
`dependency-idempotent-original` to `dependency-idempotent-mutated`. Removing
the clone made both source proof suites report `assertion-passed` for that
fault; restoring it returned both suites to passing proof observations.

The ID-keyed fault forwards the first three adds unchanged and checks after
each that its target phase has not been reached. It arms only for the second ID
on the established ordered pair, then removes the original pair and inserts
the second ID through the real dependency port. Both source-owned public lists
therefore report the exact signed original-to-second-ID replacement. Injecting
premature reach on either source failed with `dependency ID fault reached
during setup`; restoration passed both focused suites.

The retained-MAX fault now changes actual allocation state before the real
append: memory resets its adapter-owned `nextSeq` map from retained rows, and
SQLite updates `event_sequencer.next_seq`. Each decorator verifies through the
public range and `latestSeq` APIs that the stored record and returned record
both carry sequence 0, then the shared case's first next-record assertion
reports the exact sequence 2 to 0 change. Disabling either persistence seam
made its proof `assertion-passed`; restoration returned both focused proofs to
passing observations.

Memory base seeding and family companion seeding now share one cleanup owner
for ordinary and proof entry paths. Permanent negatives reject the second
dependency survivor insert. Bypassing that owner produced `closeCalls = 0` in
both paths and replaced the expected aggregate with the lone setup error.
Restored tests close once in both failure paths, retain both setup and cleanup
errors in one `AggregateError`, and leave a successful fixture open until its
single normal teardown.

Fresh terminal evidence after restoration:

- Focused repair proofs: memory dependency 1/0/111 and event 1/0/45; SQLite
  dependency 1/0/143 and event 1/0/53. Memory lifecycle 4/0/43.
- Full uncached targets: conformance 29/0/47; memory 43/0/1,927; SQLite
  669/0/4,514 across 60 files.
- Existing adapter suites: memory source 9/0/153; SQLite dependency/event-log
  16/0/27.
- All six uncached lint/typecheck targets passed for conformance, store-memory
  and store-sqlite.
- Pinned OpenSpec 1.3.0 strict validation reported the change valid; all
  artifacts reported 75 passed and 0 failed.

Task 4.1 stays unchecked for review. The absent source-specific conformance
targets remain owned by Task 7.2. The full workspace, build, browser, deploy
and h2puni SHA gates were skipped; this repair is confined to source
conformance/test seams, and no commit was authorized.

### Task 4.1 Astra repair round 2 — canonical ID-keyed duplicate

The dependency identity fault now models the binding-matrix regression
directly. It forwards the three setup adds unchanged and checks that its phase
has not been reached. At the second-ID operation, memory inserts by ID into its
adapter-owned committed dependency table. SQLite removes the isolated
fixture's pair-unique index and calls the real repository `add`. Neither fault
removes the original edge or overlays the reader.

Before the shared assertion runs, each decorator reads the real public project
list and requires the pair to contain exactly the complete original and
second-ID records. The shared complete-list assertion then reports only the
extra second-ID edge, with all four fields and received `+` direction.

Disabling memory's source-owned ID insertion produced the exact public-state
failure with the complete second-ID edge absent. Disabling SQLite's isolated
index removal produced the same failure after its real add settled as a no-op.
In both focused proof tests, the signed extra-edge diagnostic could no longer
match. Restoring the seams passed memory at 1/0/112 and SQLite at 1/0/144.

Fresh restored verification:

- Complete source-conformance files: memory 22/0/1,730; SQLite 24/0/2,506.
- Existing SQLite dependency repository: 8/0/13.
- Uncached `test` targets for conformance, store-memory and store-sqlite all
  passed; all six uncached lint/typecheck targets also passed.
- Formatting, diff and pinned OpenSpec evidence is recorded in the Task 4.1
  report after the final terminal run.

Task 4.1 remains unchecked for independent review. Task 4.2 is untouched. No
commit or push was performed.

Astra xhigh accepted Task 4.1 at `a192c886` on 2026-09-13 with no Critical,
Important or Minor findings. Its final independent probes confirmed that both
real adapters retain the original and second IDs in source-owned state, expose
both through public reads and fail first at the shared complete-edge assertion.
The reviewer also reran the setup-timing, input-mutation, durable-sequence and
memory-cleanup proofs; 26 focused tests passed with 564 assertions. Task 4.1 is
checked complete and Task 4.2 is next. Reviews:
`/tmp/source-conformance-4-1-astra-review.md`,
`/tmp/source-conformance-4-1-astra-rereview.md` and
`/tmp/source-conformance-4-1-astra-final-review.md`.

### Task 4.2 directory assignment scope and team refusal atomicity

`directory.assign:scope-replace-clear` now establishes three survivor
assignments around one target pair: another item on the same step, another
step on the same item, and another project. After initial assignment,
replacement, and clearing, it compares complete assignment records through
`assignmentsFor`, `assignmentsOf`, and both `assignmentsInProject` results.
Those project results also compare the exact named people implied by the same
assignment state.

`directory.patchTeam:atomic-refusal` establishes two complete teams and two
services. A patch combining `Directory escaped` with an unknown service must
return `unknown_service`; complete team and service lists must still contain
the original target name, ownership, and the second team/service sentinel.

The inventory test was run before registration and failed 0/1/1 with both
case IDs absent (`Expected - 2 / Received + 0`). After registration it passed
1/0/1. Permanent memory and SQLite decorators remain inert through setup and
reach only these named phases:

- `directory.assign:scope-replace-clear:pair-scope` performs a real
  collateral clear of the same-step survivor before the real target
  replacement. The shared complete-state assertion reports the missing
  `work-a-two` / `step-a-dev` / `person-a` assignment.
- `directory.patchTeam:atomic-refusal:early-rename` performs and publicly
  verifies a real name-only patch, then invokes the real combined patch and
  refusal. The shared complete-team assertion reports expected
  `Directory original` and received `Directory escaped` while service
  ownership stays complete.

Removing the collateral clear changed each focused proof from `observed` to
`assertion-passed`. Removing the early rename made each decorator's exact
public-state guard receive `Directory original` where `Directory escaped` was
expected. After restoration the focused memory proof passed 1/0/68 assertions
and SQLite passed 1/0/84.

Fresh restored verification:

- Existing SQLite directory and assignment suites: 15/0/56.
- Complete source-conformance files: memory 29/0/1,816 across two files;
  SQLite 25/0/2,590.
- Uncached targets: conformance 29/0/47, memory 44/0/1,996, SQLite
  670/0/4,599 across 60 files.
- All six lint/typecheck commands passed for conformance, store-memory, and
  store-sqlite.
- Pinned OpenSpec 1.3.0 strict validation reported the change valid; the
  all-artifact JSON run reported 75 passed and 0 failed.

Nx could not create sandboxed plugin-worker sockets and ran plugins in the
main process; the retained target commands completed successfully. The
source-specific `test:conformance` targets remain deferred to Task 7.2 and do
not exist. Full workspace, build, browser, deploy, and the h2puni SHA gate were
skipped because this slice changes shared cases and test-only fault seams and
no commit was authorized. Task 4.2 remains unchecked pending independent
review; Task 4.3 was not started.

### Epic 3 wave repair — frozen prerequisite, implemented inventory, and memory ownership

`workItems.setFrozenNumbers:clear` now reads both projects immediately after
the initial `010`/`020` batch and before clearing the first row. Project A is
compared as complete independently held work-item rows, including every
junction collection, against the exact whole-array alternatives for unchanged
memory revisions or one SQLite revision bump per row. Project B must equal its
complete pre-operation snapshot at both the intermediate and final reads.

Permanent memory and SQLite faults replace only the first row's initial `010`
with null while forwarding the full batch through the real adapter. They reach
`workItems.setFrozenNumbers:clear:first-freeze`; the first intermediate
snapshot prints the complete faulty `work-a-one` row (revision 0 in memory,
revision 2 in SQLite) with null where `010` was required. Removing that
substitution changed the fourth proof result from `observed` to
`assertion-passed` on both sources. The pre-existing broad-clear fault remains
the fifth proof and still observes the second row losing `020`.

The independent inventory equality test first failed with the five Epic 3
work-item IDs and the two currently registered directory IDs absent
(`Expected - 7 / Received + 0`). `SOURCE_CONFORMANCE_CASES` now explicitly
lists all seven in implementation order and equals the independently composed
registration kit. Dedicated five-case work-item runs remain in both sources.

The Task 4.1 shared memory setup owner already covers the final progress-only
seed, so production fixture setup was unchanged. Four progress-specific
lifecycle tests now demonstrate the integrated state: ordinary and proof late
seed rejection each close once, setup plus cleanup rejection remains one
ordered `AggregateError`, and successful setup closes zero times before
handoff and once at normal teardown.

Fresh restored evidence:

- Inventory equality: 1/0/2 assertions.
- Frozen fault proofs/restoration: memory 1/0/150; SQLite 1/0/186.
- Memory progress lifecycle: 4/0/42.
- Relevant source and adapter files: memory 42/0/2,150 across three files;
  SQLite 63/0/2,848 across the conformance and work-item files.
- Uncached targets: conformance 29/0/48; store-memory 48/0/2,177;
  store-sqlite 670/0/4,770 across 60 files.
- All six lint/typecheck commands passed after the final type repair.
- Pinned OpenSpec 1.3.0 strict validation passed; all-artifact JSON validation
  reported 75 passed and 0 failed.

Nx used its in-process plugin fallback because sandbox policy denied its
plugin-worker socket; all retained targets completed successfully. Full
workspace, build, browser, deploy, and h2puni SHA gate were skipped because
the repair is confined to shared cases, inventory, and test-only fault and
lifecycle seams and no commit was authorized. Completed task checkboxes and
the pending Task 4.2 checkbox were unchanged; Task 4.3 was not started.

### Task 4.2 Astra repair — late team phase and assignment subset

The team atomicity decorator now performs the real name-only patch and verifies
the complete escaped team plus both ownership sets through `listTeams` before
marking `directory.patchTeam:atomic-refusal:early-rename` reached. It reaches
immediately before the real combined rename/unknown-service patch. A permanent
pre-write failure source on each adapter throws from the attempted name-only
patch, records the complete unchanged two-team state, and counts one cleanup.
Its proof is `phase-failed` with `fault did not reach
directory.patchTeam:atomic-refusal:early-rename`.

Moving `reach` back before the write made both permanent negatives fail: each
proof became `observed` with `observedFailure: injected failure before early
directory rename`. After restoration, the canonical proof still reaches the
late phase and reports the precise complete-team name change from
`Directory original` to `Directory escaped`.

The assignment state now retains its existing all-item `assignmentsOf` read
and adds a strict two-item project-A subset read at every initial, replacement,
and clear settlement. The project-B assignment remains stored and visible
through the other complete readers, but is absent from `ofSubset`. Permanent
memory and SQLite faults ignore the subset by calling the real adapter reader
with the omitted project-B item added; the shared assertion reports that
complete row as received-extra. Forwarding the requested subset unchanged
made the first proof `assertion-passed` on both sources.

The current implemented inventory equality remains passing and includes both
directory IDs. Fresh restored evidence:

- Focused pre-write and canonical directory proofs: memory 2/0/96; SQLite
  2/0/120.
- Complete relevant runs: memory source files 34/0/2,025; SQLite source plus
  directory/assignment adapters 41/0/2,853. The adapter-only directory and
  assignment suites remain 15/0/56 within that run.
- Uncached targets: conformance 29/0/48; store-memory 49/0/2,205;
  store-sqlite 671/0/4,806 across 60 files.
- All six lint/typecheck commands passed. Pinned OpenSpec 1.3.0 strict
  validation passed, and all-artifact JSON validation reported 75/75.

Nx used its in-process plugin fallback because sandbox policy denied its
plugin-worker socket. Full workspace, build, browser, deploy, and h2puni SHA
gate were skipped because this repair changes only shared observations and
test fault/proof seams and no commit was authorized. Task 4.2 remains
unchecked pending rereview; Task 4.3 was not started.

### Epic 3 Astra wave acceptance

Astra xhigh accepted the integrated Epic 3 repairs at `3da5a113` on
2026-09-13 with no Critical or Important findings. Its exact-head rereview
confirmed that the intermediate frozen-number snapshots fail before the clear
on both real adapters, the current shared memory owner covers both progress
setup entry paths without double cleanup, and all 51 implemented case IDs
equal the independent registrations. Nine focused tests passed with 570
assertions, and every targeted negative failed for its named reason.

The remaining Minor documentation note was repaired by recording the fifth
work-item fault, the missing initial freeze, in `design.md`. Reviews:
`/tmp/source-conformance-epic-3-astra-review.md` and
`/tmp/source-conformance-epic-3-astra-rereview.md`.

### Task 4.2 Astra acceptance

Astra xhigh accepted Task 4.2 at `8f62a7d2` on 2026-09-13 with no Critical,
Important or Minor findings. Its exact-head probes verified that pre-write
team failures remain `phase-failed` with unchanged public state and one close,
the canonical fault reaches only after the early rename is durably visible,
and both real adapters expose an exact extra assignment when the strict-subset
reader is broadened. The independent inventory includes both directory IDs.
Twenty-eight focused tests passed with 842 assertions, and both adversarial
reversions failed for their named reasons. Task 4.2 is checked complete and
Task 4.3 is next. Reviews: `/tmp/source-conformance-4-2-astra-review.md` and
`/tmp/source-conformance-4-2-astra-rereview.md`.

### Task 4.3 implementation — subtree complete copy and late failure

The independent inventory test was first run with the two new IDs present only
in `SOURCE_CONFORMANCE_CASES`. It failed with `Expected - 2 / Received + 0`,
naming `subtrees.insertSubtree:complete-copy` and
`subtrees.insertSubtree:late-failure`. The restored inventory is independent of
the registrations and both sources offer both cases without a legacy gap.

The complete-copy case seeds meaningful project-A and project-B work items and
every readable satellite, including touching and surviving dependencies. Its
copy populates parent-before-child work items, reparenting, sibling spacing,
estimates, actuals, all three measure metrics, progress, dependencies,
assignments, every removal collection, and the three exact removed-measure
keys. Pre-call and settled assertions compare complete independently held
records through the ordinary public readers; project B remains byte-for-byte
unchanged. The memory fixture now restores the explicit copied `teamIds`
through the real work-item patch path. Before that repair, the shared assertion
reported the copied root missing `team-b` and the child with an empty team set.

The memory dependency fault writes the copied edge to a separate real
in-memory dependency store while the ordinary staged source omits it. The
SQLite equivalent persists the edge in a separate adapter-owned temporary
table while the ordinary dependency reader omits it. Both fail the shared
complete-state assertion on the exact missing `subtree-copy-dependency` edge.
The pair-wide faults pass all three metrics for every selected removal pair
through the real insertion path. Both fail on the exact unrequested surviving
token_actual/value-102/recordedAt-132 row. Disabling the dependency isolation
or pair-wide deletion changes only its corresponding proof to
`assertion-passed`.

The late-failure case snapshots both projects across every affected public
store. Memory deliberately calls the real committed-state subtree repository
instead of the staged unit of work; SQLite runs the same repository statements
with only its transaction seam disabled. Each reaches the named final-actual
satellite phase, throws there, then fails the complete post-rejection snapshot
on the escaped `subtree-copy-root` record. Restoring the staged memory call or
SQLite transaction made the focused proof `assertion-passed`.

Fresh restored evidence:

- Focused subtree and permanent proof runs: memory 3/0/82; SQLite 3/0/102.
- Existing source and mixed adapter coverage: memory 15/0/180; SQLite
  44/0/111 before the final broad runs.
- Uncached targets: conformance 29/0/48; store-memory 52/0/2,317;
  store-sqlite 674/0/4,946 across 60 files.
- All six uncached lint/typecheck targets passed for conformance, store-memory,
  and store-sqlite with the Nx daemon and plugin isolation disabled.

Prettier reported all 14 changed implementation/evidence files formatted.
Pinned OpenSpec 1.3.0 strict validation reported this change valid, and
all-artifact JSON validation reported 75 passed and 0 failed. `git diff
--check` passed after the final evidence edit. Full workspace, build, browser,
deploy, h2puni SHA gate, commit, push, merge, and archive are skipped:
the task authorizes the three relevant project targets and forbids repository
publication or integration. Task 4.3 remains unchecked pending Astra review;
Task 5.1 is untouched.

### Task 4.3 / Epic 4 Astra repair — proof timing, measure identity, and mutant boundaries

Both shared late-failure runs now assert the complete seeded A/B state before
arming or snapshotting. Removing the seeded estimate makes the permanent memory
and SQLite prerequisite proofs `phase-failed` before insertion (`attempts: 0`)
with complete A/B state and one close. Removing the shared prerequisite instead
changed the proof to `observed` after the rollback-disabled insert leaked its
copy.

The complete-copy dependency faults reach only after the real base copy, the
adapter-owned isolated-edge persistence, and an exact complete public-state
prerequisite. The shared assertion reports the signed missing record with ID
`subtree-copy-dependency`, project `project-a`, predecessor
`subtree-copy-root`, and successor `subtree-copy-child`. Independently disabling
isolation changed the proof kinds to `[assertion-passed, observed]`.

Removed-measure targets are now distributed across pairs. Removing
`token_estimate` from `work-a-two` / `step-a-dev` must preserve its unrequested
`token_actual` sibling with value 102 at recordedAt 132. The memory and SQLite
pair-wide faults delete all metrics at that pair through the real insert path,
verify the exact corrupted public prerequisite, and then reach. Disabling only
the pair-wide deletion changed the proof kinds to `[observed,
assertion-passed]`; the shared complete-state diff names the full missing
metric/value/time record.

Rollback reach now comes only from the actual adapter final-actual callback
after earlier writes. The memory fault bypasses the staged state swap; the
SQLite fault uses a narrow internal non-atomic repository factory. Each fails
the post-rejection complete snapshot on the full escaped copied-root work-item
record. Restoring staging or the transaction made the expected `observed`
proof become `assertion-passed`.

Three copied-ID/terminal-text pre-write failures per adapter stay
`phase-failed`, leave complete A/B public state unchanged, and close exactly
once. Moving generic reach back before the real insert changed these proofs to
`observed`, demonstrating that message substrings cannot certify the named
phase. The memory staged-call guard also has a permanent unknown copied-root
team test. Removing only that guard failed with `Expected promise that
rejects`; the operation resolved and committed both copied rows with the root
retaining the wrong `team-a` state.

Ordinary SQLite construction no longer accepts the transaction-disabling
boolean. The non-atomic repository factory is excluded from the public barrel
and used only by the adapter testing fault factory. Exporting it made the
runtime boundary assertion fail with expected false and received true; compile
checks also reject fourth arguments to `buildStores` and the repository
constructor. The restored internal-seam rollback proof passes.

Fresh restored evidence:

- Focused source repair files: memory 6/0/184; SQLite 5/0/202.
- Existing mixed memory subtree coverage: 14/0/176; SQLite work-item and fault
  coverage: 9/0/25.
- Complete source-conformance files: memory 34/0/2,225; SQLite 31/0/3,041.
- Uncached targets: conformance 29/0/48; store-memory 55/0/2,423;
  store-sqlite 677/0/5,052 across 60 files.
- All six uncached lint/typecheck targets passed for conformance, store-memory,
  and store-sqlite. Prettier check passed for all nine changed code/test files,
  and the final diff check passed.
- Pinned OpenSpec 1.3.0 strict validation passed; all-artifact JSON validation
  reported 75 passed and 0 failed.

Nx could not create sandboxed daemon/plugin-worker sockets and completed using
its documented in-process fallback. A raw recursive
`bun test libs/conformance/src` run discovered stale generated `dist/out-tsc`
copies and failed inside that generated tree; the authoritative uncached
`conformance:test` target passed, so the polluted recursive run is recorded and
not treated as source evidence. Full workspace, build, browser, deploy, and the
h2puni SHA gate were skipped because this repair is scoped to the three
relevant project targets and no commit was authorized. Commit, push, merge,
archive, and deploy were not performed. Task 4.3 remains unchecked pending
Astra rereview; Task 5.1 remains untouched.

### Final Task 4.3 / Epic 4 prerequisite repair

Both complete-copy fault decorators now have a permanent successful-incomplete
negative on each real adapter. The test wrapper sits beneath the canonical
dependency-isolation or pair-wide-measure decorator, calls the real insertion
once with only copied progress omitted, and captures the complete committed
public state. That state includes the copied rows and every other expected
satellite while lacking the exact `subtree-copy-root` / `step-a-dev` progress
record plus the canonical missing dependency or measure records. Cleanup runs
once for every fixture.

With the complete-state prerequisite present, all four proofs are
`phase-failed` with the exact named phase not reached. Removing only the two
memory and two SQLite `assertCompleteStateAlternative` calls changed each
adapter's result from `[phase-failed, phase-failed]` to `[observed, observed]`:
both focused tests failed with `Expected - 2 / Received + 2`. The adjacent
guard comments record this observed mutant output.

The late missing-estimate evidence now records the actual reversal: removing
only `assertSeedState` produces `observed` on both adapters after the
rollback-disabled write leaks state. The shared measure proof describes the
current pair-wide deletion and its complete unrequested sibling metric. The
memory copied-team refusal guard now carries its own adjacent proof naming the
permanent test and `Expected promise that rejects / Received promise that
resolved`; the later rollback assertions do not claim to execute in that
mutant. `SubtreeRepository` JSDoc is again immediately attached to the class.

Fresh restored evidence:

- Focused repaired proofs: memory 6/0/188; SQLite 4/0/183; SQLite public mutant
  boundary 1/0/2.
- Current source/adapter files: memory 50/0/2,444 across three files; SQLite
  77/0/3,201 across three files.
- Uncached targets: conformance 29/0/48; store-memory 56/0/2,462;
  store-sqlite 678/0/5,099 across 60 files.
- All six uncached lint/typecheck targets passed for conformance, store-memory,
  and store-sqlite.

Nx used its in-process plugin mode because the sandbox denied daemon sockets.
Full workspace, build, browser, deploy, and the h2puni SHA gate remain skipped
because this is the assigned three-project repair and no commit was authorized.
Task 4.3 remains unchecked pending final Astra review; Task 5.1 is untouched.

### Task 4.3 and Epic 4 Astra acceptance

Task-level and completed-wave Astra xhigh reviews accepted `7a66f180` on
2026-09-13 with no Critical, Important or Minor findings. The final rereviews
independently confirmed that successful incomplete dependency and measure
inserts stop as `phase-failed` before proof reach on both adapters, while
removing their guards changes all four outcomes to `observed` and breaks the
permanent negatives. Triple-key measure survivors, pre-write classification,
copied-team rollback, the internal-only SQLite mutant boundary, complete
satellite snapshots, multiplicity, and once-only cleanup also remained sound.

The task review ran 16 focused tests with 484 assertions and SQLite typecheck.
The wave review reran the integrated source/fault suite at 75/0/5,380,
conformance infrastructure at 29/0/48, and existing adapter regressions at
84/0/350, plus every array-omission and multiplicity adversary. Task 4.3 is
checked complete and Epic 4 is closed; Task 5.1 is next. Reviews:
`/tmp/source-conformance-4-3-astra-review.md`,
`/tmp/source-conformance-4-3-astra-rereview.md`,
`/tmp/source-conformance-4-3-astra-final-review.md`,
`/tmp/source-conformance-epic-4-astra-review.md`,
`/tmp/source-conformance-epic-4-astra-rereview.md` and
`/tmp/source-conformance-epic-4-astra-final-review.md`.

### Task 5.1 journal append source conformance

Implemented the exact shared `journal.append:history-atomic` and
`journal.append:account-redo-depth` cases for both real sources. Memory's
public plan-event reader now observes the journal's staged event collection;
SQLite continues to use its shared transaction/table. The cases assert complete
journal entries and complete plan events across two actors and two projects.
The depth case retains the exact newest 50 actor-A entries while preserving all
corresponding history, actor B's redo branch, and project-B state.

R5 evidence:

- Removing `journalRegistrations(openers.journal)` made the independent
  inventory equality fail with both exact IDs absent:
  `Expected - 2 / Received + 0`.
- Independent-history, outside-owner late failure, broad-redo clearing, and
  history-pruning faults were each `observed` on memory and SQLite with signed
  complete record diagnostics. Removing their four phase bridges changed each
  adapter list to four `phase-failed` outcomes:
  `Expected - 4 / Received + 4`.
- Pre-write errors containing `journal-history-insert` remained `phase-failed`
  on both sources, with one attempted target and one close.
- Focused source/proof/pre-write runs passed at memory `3/0/98` and SQLite
  `3/0/127`. Existing SQLite command-journal, plan-event, and UoW tests passed
  `18/0/48`.
- Uncached targets passed: conformance `29/0/48`, store-memory `59/0/2,589`,
  store-sqlite `681/0/5,263` across 60 files.
- All six lint/typecheck targets passed. `nx format:check --all` passed. Pinned
  OpenSpec 1.3.0 strict validation passed; all-artifact validation reported
  `75 passed / 0 failed`.

The requested Task 5.1 brief file is absent. The inventory mutation was
captured after implementation, so it is recorded as breakability evidence
without claiming chronological initial RED. Nx used its sandbox fallback for
denied sockets. OpenSpec's optional telemetry DNS failed after successful
validation and both commands exited 0. Full workspace/build/browser/deploy and
the h2puni SHA gate are deferred until the reviewed integration SHA exists.
Task 5.1 remains unchecked pending Astra review; Task 5.2 is untouched.

#### Task 5.1 Astra I1-I4 repair

The shared atomic case now certifies both a successful append and a real late
`journal-history-insert` rejection through each adapter's actual staged or
transactional owner. Complete public journal/history state is checked after
sentinel setup, successful settlement, and rollback. Pre-write failures capture
the full settled A/B-account and other-project state and remain
`phase-failed`; successful incomplete sources commit the full late journal row
while omitting only its history, then fail the complete-history prerequisite
before proof reach and close once.

The redo/depth case now checks complete journal, direction, and history state
after all three redo flips and immediately after the actor-A replacement. The
replacement is inspected with its full payload, inverse, preconditions, stamp,
and sequence before retention can evict it. Permanent real-path faults remove
the same-project actor-B row, corrupt the replacement inverse, and omit actor
B's redo setup. The first two are observed with exact signed records; missing
redo setup is `phase-failed` before the canonical broad-clear phase.

The workload and oracle are independent of the implementation constant: 51
literal bulk writes, an explicit complete newest-50 expectation with sequences
3 through 52, and independently constructed complete 51-event history.
Changing only `JOURNAL_DEPTH` to 51 and 2 failed both adapter runs at
`Expected: 50 / Received: 51` and `Expected: 50 / Received: 2`.

Independent-history faults now preserve the target project/event identity.
Memory moves the exact committed event into fixture-owned independent adapter
state; SQLite moves the exact row into an independent temporary adapter table.
The intended journal entry remains committed while its intended public history
is absent. Disabling only either route changed the first canonical proof from
`observed` to `assertion-passed` and broke the permanent four-fault assertion.
Removing only each outside-owner complete-history prerequisite changed the new
incomplete proof from `phase-failed` to `observed` after three complete journal
rows had committed.

Fresh restored evidence:

- Focused Task 5.1 source/proof/prerequisite runs: memory `5/0/180`; SQLite
  `5/0/223`. The subsequent pre-write snapshot-only runs passed `1/0/16` and
  `1/0/20`.
- Journal/history/UoW regressions: memory `15/0/171`; SQLite `23/0/57`.
- Uncached targets: conformance `29/0/48`, store-memory `61/0/2,679`, and
  store-sqlite `683/0/5,367` across 60 files.

All six final uncached lint/typecheck targets passed. The changed-file Prettier
check and final diff check passed. Pinned OpenSpec 1.3.0 strict validation
passed, and all-artifact validation reported `75 passed / 0 failed`. Nx used its
in-process plugin fallback because sandbox socket creation was denied. Full
workspace/build/browser/deploy and the h2puni SHA gate remain skipped because
this is an uncommitted review repair. Task 5.1 remains unchecked; Task 5.2 is
untouched.

#### Task 5.1 late-write certification repair

The blocking review found that both ordinary history-atomic openers selected an
ordinary scenario, so source certification proved the successful append but
never armed the real adapter late-write seam. Both openers now create their
adapter's `journal-history-insert` control, open the real source with that
control, and expose the late-write scenario. The shared case first verifies a
complete successful `atomic-target` entry/history append, then requires the
late scenario, arms it, attempts `atomic-late-target`, proves the callback was
reached after both staged writes, and compares complete public journal/history
state with the settled pre-failure snapshot.

The independent-history fault fails the successful target's complete-history
assertion before its proof fixture later exercises the real late seam. The outside-owner
fault uses the late proof scenario and leaks the complete `atomic-late-target`
record, while a same-wording pre-write error remains `phase-failed`.

R5: removing only the journal-control branch from either ordinary opener made
its dedicated Task 5.1 run fail after the successful append with
`journal.append:history-atomic requires journal-history-insert scenario`
(memory: `0/1`, 27 assertions; SQLite: `0/1`, 35 assertions). Restored focused
runs passed at memory `3/0/104` and SQLite `3/0/133`. Relevant real seam/UoW
regressions passed at memory `21/0/198` and SQLite `25/0/74`.

#### Task 5.1 rereview lifecycle and guard repair

SQLite's independent-history TEMP table is now created by the proof's owned
preparation step after seeding returns the source and directory to the fixture
cleanup owner. The canonical proof still routes the exact real event through
that table.

Permanent lifecycle tests establish three outcomes:

- the first TEMP CREATE fails from the owned preparation callback as
  `setup-failed`, closes once, removes the directory, preserves the complete
  failed CREATE diagnostic, and leaves the retained connection unusable;
- that first CREATE failure combined with an injected close failure preserves
  both messages through the established aggregate formatter, closes once, and
  still removes the directory;
- successful TEMP setup records zero closes during preparation, its canonical
  fault is `observed`, and teardown closes exactly once.

The decorators now only retain the source or wrap `close`; every fallible table
setup runs after `seedSqliteSource` returns ownership. Moving the first CREATE
back into fault mutation reproduced the leak: the lifecycle negative failed
with expected `closeCalls: 1` and received `closeCalls: 0`. Restoring the owned
preparation passed all three lifecycle tests (`3/0/53`). Closing successful
preparation early changed that proof to `phase-failed` and recorded one close
during preparation plus two total closes.

Final lifecycle repair verification passed the complete SQLite source proof
file (`40/0/3,410`) and journal/history/UoW/fault regressions (`25/0/74`). All
six uncached conformance, memory, and SQLite lint/typecheck targets passed.
Changed-file Prettier and `git diff --check` passed. Pinned OpenSpec 1.3.0
validated this change strictly and all 75 artifacts passed.

The memory fixture's missing-event guard now has an adjacent R5 proof and a
real-fixture negative. The test seeds one complete legitimate journal/history
pair, requests `missing-event`, requires `no journal event missing-event`,
and verifies the complete public history, empty independent history, and full
journal row remain unchanged. Removing only the guard failed at the throw
assertion with `Received function did not throw; Received value: undefined`.

Fresh restored evidence:

- integrated Task 5.1 inventory/source/guard/lifecycle focus: `17/0/468`;
- focused memory guard: `1/0/4`;
- focused SQLite canonical and TEMP lifecycle: `5/0/187`;
- memory source/fault regressions: `16/0/184`;
- SQLite journal/history/UoW/fault regressions: `25/0/74`.

Both affected adapters' uncached lint/typecheck targets passed. Changed-file
Prettier, the final diff check, OpenSpec strict validation, and all-artifact
validation also passed. Task 5.1 remains unchecked and Task 5.2 is untouched.
No commit, push, merge, archive, or deploy
was performed.

#### Task 5.1 acceptance

Astra accepted Task 5.1 at `6cfb3e96` with zero Critical, Important, or
Minor findings. The final review reran the integrated Task 5.1 focus
(`17/0/468`) and rechecked the transaction/staging, account settlement,
fixed-depth, independent-routing, history order/count, alias, missing-event,
and lifecycle reversals. Both failure decorators contain no database work;
all fallible TEMP-table setup now runs after the fixture owns cleanup.

Task 5.1 is checked complete. Task 5.2 is next. Review:
`/tmp/source-conformance-5-1-astra-acceptance.md`.

### Task 5.2 journal settlement and plan-event conformance

Added the shared `journal.flip:preconditions`,
`planEvents.listFor:filters-order`, and
`planEvents.pruneOlderThan:strict-cutoff` cases. Plan-event fixtures write only
through the real journal append boundary and use complete, independently built
event and journal expectations. The fixture covers two projects, distinct
kinds, a plan-wide event, the combined item-and-kind predicate, cutoff records
at 99/100/101, and three equal-instant IDs inserted z/a/m but expected z/m/a.
Journal settlement compares complete `{ entries, states, history }` snapshots
after append, flip, restamp, and each discard. History pruning compares one
complete `{ deletedCount, projectAEvents, projectBEvents, journals }` result,
including every retained cutoff event and every untouched journal row.

R5 evidence:

- Adding exactly the three IDs to the independent inventory first failed with
  `Expected - 3 / Received + 0`; after registration the inventory passed at
  `1/0/2`.
- Both adapters observed all four named production-method faults: retaining the
  old flip preconditions, changing direction during restamp, omitting the item
  predicate, and turning strict cutoff into `<=`. Diagnostics included revision
  21 versus 11; `undone: true` versus false together with `redoable: true`
  versus false; both the plan-wide and other-item leaks; and deleted count 2
  versus 6 with all four missing cutoff rows named.
- Reversing all four mutations while retaining their verified phase reach
  changed each adapter's exact fault list from four `observed` outcomes to four
  `assertion-passed` outcomes (`Expected - 4 / Received + 4`).
- Removing memory's ID tie-break returned z/a/m. Removing SQLite's ID order
  returned m/a/z. Each failed on complete event objects; both production files
  were restored before the passing runs.
- Successful no-op flip and prune decorators cannot certify either family.
  Each adapter returned two `phase-failed` outcomes after one attempt and one
  close, with the complete pre-mutation journal, state, event, and sentinel
  snapshots retained.

Fresh passing evidence:

- Focused shared/fault/window runs: memory `3/0/122`; SQLite `3/0/158`.
- SQLite journal, plan-event, and UoW regressions: `18/0/48`. Core history,
  retention, and compensating-command callers: `18/0/40`.
- Uncached targets: conformance `29/0/48`, store-memory `65/0/2,834`, and
  store-sqlite `689/0/5,619` across 60 files.
- Core portable composition passed in Chromium (`1/0`) with bundle SHA-256
  `1c4940b5b26a4fa3a8aad7ca484d5ebc455e2db3ec8ea9cd73cbf952cd51e6e7`.
- All six uncached lint/typecheck targets passed for conformance, memory, and
  SQLite. The changed-file formatting check, `git diff --check`, pinned
  OpenSpec 1.3.0 strict validation, and all-artifact validation (`75/0`) passed.

The first full memory target exposed that its partial declaration omitted the
newly registered `planEvents` capability. Adding that source declaration
wiring made the rerun pass. The first portable-composition attempt could not
launch Chromium in the restricted sandbox (`sandbox_host_linux.cc:41`,
`Operation not permitted`); the same required target passed outside that
sandbox.

Full workspace build/test gates, UI browser suites, deploy checks, and the
h2puni committed-SHA gate remain skipped because Task 5.2 is an uncommitted
three-project conformance slice. No production adapter behavior changed. Task
5.2 remains unchecked pending Astra review; no commit, push, merge, archive, or
deploy was performed.

#### Task 5.2 Astra setup and effect-window repair

The list/filter case now verifies complete project-A and project-B events and
both complete journals before its first filtered read. The canonical ignored
item-filter controls independently verify that same complete public setup
before reaching their named phase. Permanent memory and SQLite negatives
suppress all three project-B appends or perform every append and then discard
all journal rows. Both variants remain `phase-failed`, close once, and expose
their complete invalid public state. Removing the shared prerequisite alone
left these negatives `phase-failed`; removing the fault-side prerequisite too
changed both outcomes to `observed` in each adapter (`Expected - 2 / Received +
2`).

Permanent effect-window negatives now no-op the real restamp flip or return a
real, partially filtered list. Each attempts its target once, closes once,
retains a complete public snapshot, and remains `phase-failed`. Removing the
canonical complete restamp and filtered-result guards changed both outcomes to
`observed` in each adapter (`Expected - 2 / Received + 2`). The shared case also
queries `{ workItemId, kinds: [] }`. Temporarily dropping the item predicate
only for that empty-kinds combination failed in both adapters with the complete
plan-wide `history-a-101-wide` and other-item `history-a-100-a` records added to
the result (`Expected - 0 / Received + 36`). Both production mutations were
restored.

Fresh restored evidence:

- Focused Task 5.2 shared, canonical fault, setup-window, and effect-window
  runs passed at memory `4/0/109` and SQLite `4/0/145`.
- The full memory adapter suite passed `67/0/2,893`; the full uncached SQLite
  target passed `691/0/5,694` across 60 files. SQLite journal, plan-event, and
  UoW regressions passed `18/0/48`. Core history, retention,
  compensating-command, and history-route callers passed `19/0/41`.
- All six uncached conformance, memory, and SQLite lint/typecheck targets
  passed. `nx format:check --all` and `git diff --check` passed.
- Pinned OpenSpec 1.3.0 strict validation passed, and all-artifact validation
  passed `75/0`.

Nx used its in-process plugin fallback because sandbox socket creation was
denied. Full workspace/build/browser/deploy checks, a repeated portable-browser
composition, and the h2puni committed-SHA gate remain skipped for this
uncommitted review repair. Task 5.2 remains unchecked; Task 6 is untouched. No
commit, push, merge, archive, or deploy was performed.

#### Task 5.2 acceptance

Astra accepted Task 5.2 at `2cebf9cf` with zero Critical, Important, or
Minor findings. The acceptance review reran the repaired focus (`11/0/394`)
and affected regressions (`136/0/6,619`), including the missing-project,
empty-journal, empty-kinds, restamp, partial-list, tie-order, alias, cutoff,
project-scope, and payload reversals. All six uncached lint/typecheck targets
also passed.

Task 5.2 is checked complete and Epic 5 is closed. Task 6.1 is next. Review:
`/tmp/source-conformance-5-2-astra-rereview.md`.

#### Epic 5 independent acceptance at the Task 6 boundary

Epic 5 was independently accepted at `65719aeb` with zero Critical, Important,
or Minor findings. The review recorded fresh regression `149/0/6,672`, focus
`27/0/860`, framework `29/0/48`, and all six lint/typecheck targets passing.
Review: `/tmp/source-conformance-epic-5-astra-review.md`.

An exploratory root `bun test` is not a project test contract: it discovers
Vitest browser files under Bun, where `vi.stubGlobal` is unavailable. Project
Nx targets and the focused Vitest invocation remain the authoritative routes.

#### Task 6.1 saved-plan source conformance

The inventory-first RED named exactly the two absent IDs:
`savedPlans.write:bytes-and-bodies` and
`savedPlans.touch:principals-scope` (`Expected - 2 / Received + 0`). The shared
kit now uses literal multibyte inputs and independent byte-count oracles
(`A🔦B` = 6, `é` = 2, `Zürich` = 7), opaque literal hashes, present/absent
schedule unions, nullable and non-null creators, distinct display/creator/owner
values, two projects, and complete list/read/principal snapshots around every
write, rename, unknown touch, and delete.

Both real adapters observed all seven named production-path faults at their
distinct phases: UTF-16 counts (expected/received 6/4 and 2/1), header without
either body, altered input bytes (`A🔦B`/`A🔦C`), altered schedule hash, creator
and owner conflation, and rename/delete returning `touched` instead of
`no_such_plan`. The unmutated cases passed again after every fault. Memory
faults mutate adapter-owned history state through guarded fixture seams;
SQLite faults mutate the isolated real tables and require affected-row counts.

Astra's preflight demonstrated ten false greens in the initial WIP. The final
faults require an exact complete successful write before corruption, an exact
complete corrupted record before reach, the full target plus principals for
creator corruption, and all four plans across both projects plus all principals
before either unknown-touch phase. Permanent lower-path probes remove both
bodies under UTF-8 and header-only faults, corrupt the creator display, and
delete the peer during unknown rename/delete. Each canonical run remains
`phase-failed`, attempts its target once, and closes once; the historical WIP
without these prerequisites classified all ten examples as `observed`. Prewrite failure also
remains `phase-failed` with exact empty two-project state and one close. Existing
fixture regressions retain combined setup/cleanup diagnostics and single-owner
teardown for memory and SQLite.

Fresh restored evidence:

- Focused Task 6.1 shared/fault/window runs: memory `3/0/337`; SQLite
  `3/0/411`. The memory fixture-seam prerequisite regression passed `1/0/12`.
- Uncached targets: conformance `29/0/48`, store-memory `71/0/3,292`, and
  store-sqlite `694/0/6,163` across 60 files.
- Saved-plan core and be-01 caller regressions passed `166/0/570`; the four
  fe-01 saved-plan Vitest files passed `63/0`.
- All six uncached conformance/memory/SQLite lint and typecheck targets passed.
  `nx format:check --all` and `git diff --check` passed.
- Pinned `@fission-ai/openspec@1.3.0` strict validation passed `1/0`; all
  artifacts passed `75/0`. Its optional PostHog flush could not resolve
  `edge.openspec.dev`, after both validation commands had returned success.

Core portable composition was not repeated because Task 6.1 changes no core
composition or production port. Full workspace/build/browser/deploy checks and
the committed-SHA h2puni gate remain deferred to Task 7.3. Task 6.1 remains
unchecked pending Astra review; no commit, push, merge, archive, or deploy was
performed.

#### Task 6.1 final-review R5 repair

The SQLite affected-row assertion now has its own permanent production-routed
negative. It writes the complete `saved-present` record through the real port,
then executes a real body-table DELETE for an absent ID and records zero changed
rows. With the assertion present the proof is `phase-failed`, with one attempt,
one close, exact zero-row evidence, and unchanged complete saved-plan state.
Removing only the affected-row assertion changed the proof to
`assertion-passed`; the permanent test failed with expected `phase-failed`,
received `assertion-passed` (`0/1`, 23 assertions). The earlier complete-write
prerequisite remains intact.

Every permanent successful-incomplete probe now captures reads, both project
lists, and principals before teardown. Both body modes require the complete
header with both bodies absent; creator corruption requires its complete record
and principals; rename/delete collateral probes require the exact surviving
three-plan, two-project state. Suppressing only the lower real write left both
body states null and the creator snapshot empty. The complete equality failed
on both adapters with `Expected - 166 / Received + 5`, while cleanup still ran
once (memory `0/1`, 92 assertions; SQLite `0/1`, 118 assertions). Restoring the
writers returned the focused runs to green.

Fresh isolated removal of the four memory fixture guards produced the exact
documented failures: missing body removal and input replacement reached
`stored.bodies` TypeErrors; missing hash replacement reached a `stored.header`
TypeError. Removing the already-missing body, input-body, or absent-hash guards
made the real fixture test receive `undefined` from calls expected to throw.
The fixture JSDoc now states every modeled missing-plan/body/hash refusal.

Fresh restored repair evidence:

- Task 6.1 memory focus passed `3/0/338`; the retained memory seam regression
  passed `1/0/12`.
- Task 6.1 SQLite focus, including the new affected-row negative, passed
  `4/0/429`.
- Memory and SQLite lint/typecheck targets passed uncached. Changed-file
  formatting and `git diff --check` passed.

The independent review report was not changed. Task 6.1 remains unchecked
pending rereview; no commit or push was performed.

#### Task 6.1 acceptance

Astra accepted Task 6.1 at `468878d3` with zero Critical, Important, or Minor
findings. The rereview independently re-ran the affected-row assertion removal,
the omitted-real-write reversals for both adapters, and each corrected memory
guard removal. The original ten preflight counterexamples remained
`phase-failed` with one close. Fresh acceptance evidence passed `9/0/781`
focused checks, `193/0/7,669` affected regressions, and all six uncached
conformance, memory, and SQLite lint/typecheck targets. Review:
`/tmp/source-conformance-6-1-astra-rereview.md`.

#### Task 6.2 saved-plan quota and late-write conformance

The inventory-first RED named exactly `savedPlans.write:quota-refusal`,
`savedPlans.write:quota-window`, and `savedPlans.write:late-body-failure`
(`Expected - 3 / Received + 0`). The shared cases use fixed UTF-8 byte counts
and hashes, detached requests, complete two-project read/list/principal setup
and settlement snapshots, and one combined outcome/mechanism/public-state
comparison. Memory's rival runs through the real history coordinator and is
quota-refused after seeing 2 plans/18 bytes. SQLite's second real repository
connection returns immediate `snapshot_busy` while the primary owns `BEGIN
IMMEDIATE`.

Both adapters observed the three canonical faults: a refused record persisted
with both bodies, a quota check moved before the atomic owner so both rivals
persisted, and header/input persistence split before schedule failure. Their
diagnostics include the wrong outcome/mechanism together with the complete
escaped record. Mutation removal is `assertion-passed`; retained mutation with
reach removed and failures before callback/body phases are `phase-failed`.
Premature operations attempt once and close once.

The advisory preflight at
`/tmp/source-conformance-6-2-astra-preflight.md` reported C0/I5/M1. Every item
has a permanent runtime counterexample:

- I1: callback values are copied at entry; real callback aliases repaired after
  return retain `bytes: -777` and fail on both adapters.
- I2: complete A/B state is asserted immediately before the target; real
  deletion of project B fails before a target wrapper can restore it.
- I3: every issued rival settles on primary success or failure. Dual real-path
  failures preserve both causes, prove rival settlement before close, and close
  once on both adapters.
- I4: callback/outcome/mechanism and all reads, lists, and principals are read
  before one equality. Canonical failures contain the complete refused, rival,
  or partial target state.
- I5: the armed adapter boundary verifies the actual complete target header and
  input. Omitting only the real input write is `phase-failed`; removing the
  guard changes that permanent proof to `observed`. The watched removals failed
  `0/1` on both adapters with expected `phase-failed`, received `observed`
  (memory 15 assertions; SQLite 19 assertions).
- M1: rival settlement now has one explicit per-run owner shared across source
  decoration. The stale-check faults are `observed` on memory and SQLite.

Fresh evidence:

- Focused complete conformance files: memory `56/0/3,425`; SQLite
  `57/0/4,604`; inventory `1/0/2`.
- Uncached affected targets: conformance `29/0/48`, store-memory
  `79/0/3,639`, store-sqlite `703/0/6,615` across 60 files.
- Retained adapters: memory `17/0/196`; SQLite `32/0/92`. Saved-plan callers:
  core `20/0/32`; be-01 `15/0/64`.
- All six uncached conformance/memory/SQLite lint and typecheck targets passed.
  Pinned OpenSpec strict validation passed and all artifacts passed `75/0`.
  `git diff --check` passed.

Core portable composition built, but its Chromium check is unavailable in this
sandbox: Chromium aborted with `sandbox_host_linux.cc:41 ... Operation not
permitted`. This is recorded as an explicit environmental skip. Task 6.2
remains unchecked pending Astra review. No commit, push, merge, archive, or
deploy was performed.

#### Task 6.2 acceptance

Astra round two accepted Task 6.2 at
`65c7975fd28cf12efea1d4e4430d9c1f92355c74` with zero Critical or Important
findings and one nonblocking Minor limited to a SQLite Proof comment. The
review confirmed all original and round-one findings closed. The Minor was
then corrected to state the observed old defect precisely: snapshot rejection
left the SQLite connection open even though directory cleanup still ran.

Fresh independent acceptance evidence passed the complete two-adapter
source-conformance suite and inventory at `120/0/8,244`, thirteen affected
adapter and caller files at `88/0/405`, all six uncached conformance, memory,
and SQLite lint/typecheck targets, changed-file Prettier for all nine reviewed
files, and the restored Task 6.2/public-boundary/restart focus at `22/0/746`.
Diff whitespace and immutable snapshot integrity passed with all 3,048 tracked
entries unchanged. The decisive reversals suppressed the real target or only
its mutation, removed input and canonical target/content guards, skipped
snapshot or writer close, dropped combined errors, delayed rival ownership,
and restored stale rival or rollback behavior; each corresponding permanent
negative failed. Review: `/tmp/source-conformance-6-2-astra-review-2.md`.

#### Task 6.3 saved-plan capture values and detachment

The inventory-first RED named exactly
`savedPlanCapture.readPlanInput:complete`,
`savedPlanCapture.readPlanInput:missing-project`, and
`savedPlanCapture.readPlanInput:detached` (`Expected - 3 / Received + 0`). The
shared cases project all 17 declared `PlanInputReads` fields and compare them
with separately written complete literals. The two-project seed includes a
capacity-only team, an unassigned person's membership, capture-only tag,
service and work-item type rows, distinct assignments/facts/ladders, and the
complete global external-system directory. Project-scoped set-like rows are
normalized by explicit keys while step and priority-band order remains
semantic.

Memory and SQLite both pass the complete capture, return null for an unknown
project without disturbing complete A/B state, and return detached arrays. The
detached case mutates all fifteen top-level arrays plus the nonempty nested
team, tag, service, type, membership and ownership arrays, then compares fresh
A/B captures with the independent complete oracles. The memory work-item
fixture now persists a supplied `tagIds` replacement; removing that write
fails the public capture seed at the exact tag relation.

Both adapters observe the three named value-boundary faults after calling the
real public capture: omit the complete tag directory, substitute a typed empty
capture for a real null unknown read, and reuse the first returned tag array
only after caller mutation and a pristine second real capture. Neutralizing
only mutation is `assertion-passed`; suppressing reach, suppressing the target
operation, targeting another project, or breaking a prerequisite is
`phase-failed`. Each fixture closes once. SQLite removes its owned directory,
and assertion plus cleanup failures retain operation-then-cleanup order.

The initial Astra review at `3c887a25` found that the missing-null and detached
second-read prerequisites lacked permanent source-specific negatives. The
repair now records the real unknown attempt, both detached target ordinals,
the caller-mutation window, complete pre-mutation A state, complete independent
B state, pristine second A state where available, exact fault phase, one
close, and SQLite directory removal. Removing the missing-null guard failed
both new adapter probes (`0/2`, 76 assertions). Removing the pristine
second-capture guard failed both detached probes. Replacing the second real
capture with a clone of the first failed all four detached prerequisite and
ordinal probes (`0/4`, 164 assertions); the refusal probe observed only one
real target call instead of ordinal two. Restoring the guards and real call
returned both focused suites to green.

Fresh restored evidence:

- Task 6.3 focus passed memory `6/0/787` and SQLite `6/0/875`; the independent
  inventory passed `1/0/2`.
- The complete two-adapter source-conformance suite and inventory passed
  `132/0/10,132` across three files.
- Uncached conformance, memory and SQLite project targets passed respectively
  `29/0/48`, `85/0/4,507`, and `714/0/7,623` before the proof-only repair. The
  final complete source run exercises the repaired tests.
- All six uncached conformance/memory/SQLite lint and typecheck targets passed.
  `nx format:check --all`, changed-file Prettier and `git diff --check` passed.
- Pinned OpenSpec strict validation passed; all artifacts passed `82/0` (71
  changes and 11 specs).

Core portable composition built 368 modules. Its Playwright phase remains
unavailable in this sandbox because Chromium aborts at
`sandbox_host_linux.cc:41` with `Operation not permitted`. The committed-SHA
h2puni gate and full integrated browser/workspace checks remain Task 7.3.

#### Task 6.4 coherent capture interleave and owner isolation

The inventory-first RED named exactly
`savedPlanCapture.readPlanInput:coherent-interleave`: one expected case was
missing and none was received. The shared case holds after the first actual non-null project read,
commits a tag rename and unassigned-person membership change through the
independent writer, and compares the held capture with the complete before
oracle and the next capture with the complete after oracle. Both adapters
return exact successful directory outcomes before release.

Memory clones its committed epoch before the awaited seam; SQLite holds a
dedicated read transaction while the process connection commits the writer.
The named mutant performs real public directory reads outside that epoch and
returns a torn capture. Both adapters observe the stable before/after tag
diagnostic, while neutral mutation is `assertion-passed`; omitted reach,
incomplete before state, wrong target, and writer rejection are `phase-failed`.
Held operations drain and sources close once; SQLite also removes each owned
directory.

The rollback proofs inject capture rejection only after exact writer success
and public after-state. A fresh public capture remains completely after-state
for the real memory clone and SQLite dedicated connection. The forbidden
memory staged owner establishes the same after-state inside a real pending
unit of work and then rolls it back to the complete before directory. The
forbidden SQLite repository borrows the process handle, verifies affected-row
counts and public after-state inside the capture transaction, then its rollback
restores the complete before directory. Removing memory's project-tag relation
lookup made the shared case receive no touched project instead of
`project-a`; restoring the source-owned lookup returned the case to green.

Fresh evidence:

- Task 6.4 focus passed memory `3/0/288` and SQLite `3/0/320`; inventory passed
  `1/0/2`.
- Retained adapter and caller checks passed memory `17/0/196`, SQLite
  `35/0/139`, core `16/0/33`, and be-01 `16/0/79`.
- Uncached project targets passed conformance `29/0/48`, store-memory
  `91/0/4,951`, and store-sqlite `720/0/8,115` across 60 SQLite files. Core
  portable composition passed `1/0` in Chromium after running outside the
  restricted filesystem sandbox that rejected Chromium startup with EPERM.
- All six uncached conformance/memory/SQLite lint and typecheck targets passed.
  `nx format:check --all`, `git diff --check`, pinned strict change validation,
  and all OpenSpec artifacts `82/82` passed.

The branch contains current `origin/main` at `c61b370d`. The committed-SHA
h2puni gate remains Task 7.3.

#### Task 6.5 independent history beside command batches

The inventory RED contained exactly the four new `history.batch` IDs. Source
registration selects the two common cases plus the declaration's admission
mechanism. SQLite settles `snapshot_busy` on the real history connection while
the process UoW holds its write lock, and its independently prewritten complete
plan survives commit and rollback. Memory observes `written` before settlement
and reads the exact complete ID after either terminal decision.

The bounded coordinator mutants returned `pending`, then release drained the
real write before the shared assertion failed. The memory command-owned history
mutant held the complete target in the active stage and lost it on rollback;
the suppressed replacement mutant ran the quota callback and returned `written`
but exact-ID public readback returned null. Neutralizing each mutant made its
permanent negative report `passed`, proving the checks directionally breakable.

Fresh evidence:

- Task 6.5 focus and inventory passed memory `4/0/1,005`, SQLite `3/0/1,329`,
  and conformance inventory `4/0/6`.
- Full source files passed memory `71/0` and SQLite `71/0`; uncached project
  targets passed conformance `29/0/48`, memory `94/0/5,023`, and SQLite
  `722/0/8,175`.
- Retained memory history/UoW tests passed `17/0/196`, SQLite saved-plan and
  fault tests `13/0/48`, and core composition/type tests `8/0/26`.
- All six uncached conformance/memory/SQLite lint and typecheck targets passed
  after correcting conformance export order. Changed-file Prettier,
  `git diff --check`, strict change validation, and all-artifact OpenSpec
  validation passed.

A fresh fetch was unavailable because the managed filesystem made the shared
worktree `FETCH_HEAD` read-only; the existing tip contains `origin/main` at
`c61b370d`. The committed-SHA h2puni gate remains Task 7.3.

#### Task 7.1 terminal source declarations and reports

Both real source suites now execute full terminal reports and call
`certifyExecution` against independently derived exact case sets. SQLite
declares all nineteen families offered with no gaps and passed every required
case. Memory reports its six case-specific gaps as unexecuted `not-offered`
records while every other required case passes.

The six memory exclusions were also bypassed through real source registrations:
the four unknown-step cases and the capacity and priority-band missing-reference
cases reproduced their recorded assertion failures (`5/0/121` across five
tests). Shared certification tests prove a removed final history kit cannot
shrink the expected set, an uninvoked body remains incomplete, a passing bypass
cannot retain a gap, and an absent users capability neither has an opener nor
executes registered account bodies.

Fresh evidence:

- Shared certification passed `9/0/11`; the uncached conformance target passed
  `32/0/53`.
- Full real source files passed memory `71/0` and SQLite `71/0`; terminal source
  focus passed memory `1/0/967` and SQLite `1/0/1,312`.
- All six uncached conformance/memory/SQLite lint and typecheck targets passed.
  Changed-file Prettier, strict change validation, format and diff checks passed.

#### Task 7.2 dedicated certification targets and discovery

Both adapter manifests now provide cached `test:conformance` targets selecting
their one exact terminal source file. The ordinary test targets retain their
existing broad discovery, so CI and the final gate continue to execute source
certification without duplicating it through target dependencies. SQLite's
dedicated target declares the migration directory it reads; neither target has
a name filter or browser-capable directory selector.

Before the explicit targets existed, Nx interpreted `test:conformance` as the
broad `test` target, demonstrating that a successful command did not prove the
intended selection. The restored dedicated targets passed memory `71/0/4,811`
and SQLite `71/0/6,178`. The normal memory target passed `94/0/5,025`.

Removing supplemental history registration made both the dedicated and normal
memory targets fail terminal certification naming exactly independent commit,
independent rollback, and interleaved-success-survives. Broadening memory's
selector to `src/testing` failed the workspace target oracle. A string-to-number
fault in that actual workspace test failed `tool-devsync:typecheck` at its exact
path, and its unused binding failed `tool-devsync:lint`; restored targets pass.

The focused workspace discovery test passed `1/0/1`. All eight uncached lint
and typecheck targets for conformance, both adapters, and tool-devsync passed.
Strict OpenSpec validation, changed-file formatting and diff checks passed. The
full tool-devsync test remains unavailable in the restricted sandbox because
its unrelated deployment probes require local listener sockets and fail EPERM.

#### Final source review repair: unfilterable, visible, enumerable certification

The final source review found that Nx forwarded a caller's test-name filter into
both dedicated targets. The reviewed command therefore passed one matching gap
test while filtering out terminal certification. Both targets now refuse
forwarded CLI arguments, and workspace discovery asserts that contract. Repeating
the exact review command with `--args='-t configuration-reference'` ran all 72
tests in each source file: memory passed with 4,812 assertions and SQLite passed
with 6,179 assertions.

Terminal certification now prints one structured record containing source and
revision, exact certified case IDs, exclusions with evidence, and absent
families. The memory target printed 64 certified IDs and its six exact exclusions;
SQLite printed all 70 required IDs with empty exclusions and absent families.
Suppressing the report writer leaves certification otherwise green but makes the
permanent output-path test receive no line.

The closed fault type now derives case ownership from an explicit literal variant
registry. Forty-eight cross-source variants and four SQLite-only variants
have distinct IDs and source applicability. Each adapter enumerates its real fault
objects and checks the exact applicable registry set. Removing the first memory
fault or duplicating the first SQLite fault throws the named coverage mismatch
while all shared case registrations remain intact.

Fresh repair evidence:

- Shared conformance passed `33/0/58`; the focused target-discovery oracle passed
  `1/0/1`.
- The exact filtered review commands ran the full source files: memory
  `72/0/4,812`, SQLite `72/0/6,179`, and both printed their certification record.
- Broad adapter targets passed memory `95/0/5,026` and SQLite `723/0/8,219`.
- All eight uncached lint and typecheck targets for conformance, memory, SQLite,
  and tool-devsync passed after restoring sorted imports and explicit void blocks.
- Changed-file Prettier, `git diff --check`, and strict change validation passed.
  All-artifact validation reported 82 of 84 valid; the only failures are the
  unrelated pre-existing empty-delta changes `local-solver-development` and
  `stale-solver-seat-masks-failure`.

Task 7.3 remains unchecked until the repaired immutable commit receives the
requested independent rereview.

The first rereview found two final enumeration/reporting omissions. The four
saved-plan byte/body mutations now have separate UTF-8-length, header-only,
altered-body, and altered-hash IDs on both sources and are present in both exact
inventories. SQLite's separate affected-row proof also has its own registered ID.
The inventory tests therefore cover 48 cross-source variants and four
SQLite-only variants.

Source certificates now resolve the full Git revision of the checkout at runtime
and append `-dirty` when uncommitted changes are present. The permanent terminal
tests require that full revision form. Restoring the retired eight-character
memory and SQLite literals failed both terminal tests before their certificates
could print (`0/2`, with the exact stale values in the diagnostics); the restored
dirty-checkout run printed `2c088636a1275ce10f3f9802ac9ab2b2e31cafd6-dirty`
for both sources and passed both terminal cases plus both inventories (`4/0`).
The final exact filtered target runs passed memory `72/0/4,813` and SQLite
`72/0/6,180`; shared conformance passed `33/0/58`. All eight uncached lint and
typecheck targets for conformance, memory, SQLite, and tool-devsync passed.

### Certification cache identity repair

The terminal certificates read repository-wide Git identity, including dirt
outside either source project. Nx cannot express that changing dirty-state as a
sound file input, so both dedicated certification targets and each ordinary
source target that selects a terminal certificate set `cache: false`.
With `cache: true`, a clean run followed by an untracked workspace-root
`source-certification-probe` reproduced `[existing outputs match the cache]`
and replayed clean revision `41908dcd763dc7f13768872099ec7d577679f9a4`.
After disabling caching, the same second invocation executed the suite and
printed `41908dcd763dc7f13768872099ec7d577679f9a4-dirty`.

The Tool Wiki relationship declarations now pin `store-memory:test` to that
uncached configuration. Proof: setting the candidate target back to
`cache: true` made production `extract-relationships working . HEAD` exit 1
for both relationship manifests, naming `check.store-memory.test` with
expected `cache: false` and received `cache: true`; restoring `cache: false`
made both committed extractions exit 0.

### 2026-09-13 latest-main integration

The reviewed source-conformance work was merged without conflict with
`origin/main` at `9b13f98e62a7cd880977e348421e992e8c4951a3`. On the resulting tree, the
uncached `test`, `lint`, and `typecheck` targets for conformance, memory, and
SQLite all passed: nine successful targets in 1m16s. Strict validation of this
OpenSpec change and `git diff --check` also passed. Task 7.3 remains unchecked
because the canonical h2puni workspace gate has not run for this commit.

### 2026-09-14 task 7.3 closeout before the immutable gate

The clean source baseline was fast-forwarded, without merge commit or rebase,
from `d9e82a3f28569a2c54303fe5f36d2e2b95cadbbf` to refreshed
`origin/main` at `8779208a38b5312cae949d9706c650a392f33415`. The manifest's
last source revision is `cdce7b2cdcee95f72f258d2e04666ee5e75053b3`; both terminal
source files' last source revision is
`41908dcd763dc7f13768872099ec7d577679f9a4`. Exact content hashes at the
tested checkout were:

- case manifest: `b2fb1c906da6bb5bfd4b32a61e69bc57fce174bcda992d8261995f3b39969189`;
- closed fault-variant registry: `40c76d38cc62df015a53eb35fb632e1cbf97c6e464b8fac04c79d5dba4388838`;
- memory terminal source: `f76bc041884cee48279bd6a7e57ce58e7cbd7bb4d83721d7d536fbd176238a50`;
- SQLite terminal source: `16c210676483151f0bbec46e6096e02f186f030fa878d6170b71e7cfd6c191d9`.

Both unfilterable source targets ran every actual shared-case baseline, every
adapter-applicable named matrix mutation, the mutation-removal reversals and
the setup/effect-window refusal probes. Their exact-inventory tests admit no
missing or duplicate registered variant: 48 variants apply to both sources
and four additional variants apply only to SQLite. The family-level matrix
outcomes below are assertions made by the passing terminal tests, not inferred
from their process exit codes.

| Shared-case fault group                                        | Actual shared-case observation under the armed mutation                                                                                                     | Diagnostic/reversal reviewed                                                                                                                                          | Restored source            |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| projects, users, capacity, priority bands and calendar markers | every applicable proof was `observed` only after its named phase                                                                                            | wrong steps/scope/actor or identity, complete map/ladder mismatch, marker order/scope/literal-date mismatch; neutral mutation becomes `assertion-passed`              | both source targets passed |
| migrated steps, estimates, directory and event log             | changed/missing public value, missing removal/range/prune, broad assignment deletion or retained maximum was observed through the original shared case      | the terminal files retain exact case IDs and require setup before reach; removed mutation is rejected by the reversal assertions                                      | both source targets passed |
| work items, actuals, measures, progress and dependencies       | all row/fact/key/ownership/atomicity mutations were `observed` against complete public snapshots                                                            | premature or incomplete setup remains `phase-failed`; neutral mutations become `assertion-passed`; settlement diagnostics include the escaped or missing exact rows   | both source targets passed |
| subtree complete copy and late failure                         | disconnected dependency/measure state and escaped uncommitted writes were observed only through ordinary source readers                                     | pre-write or missing populated prerequisites remain `phase-failed`; transaction/staged-state restoration passes                                                       | both source targets passed |
| journal and plan events                                        | retained preconditions, wrong restamp direction, independent/late history, collateral redo/depth damage, ignored filters and inclusive cutoff were observed | complete journal/history snapshots expose each mutation; no-op or pre-phase mutations remain `phase-failed`                                                           | both source targets passed |
| saved-plan values, quota, ownership and late bodies            | distinct UTF-8, header-only, altered-body/hash, principal, unknown-touch, persisted-refusal, stale-window and split-write faults were observed              | missing real writes, wrong target/content/phase, premature calls and removed reach cannot count; SQLite's zero affected-row guard has its separate registered variant | both source targets passed |
| capture and independent history                                | omitted/null/detachment/epoch faults and command-owned history faults were observed through the shared capture/history cases                                | mutation reversals pass; wrong target, missing second read, failed writer and unentered phase remain refused                                                          | both source targets passed |

Terminal certification sets at checkout revision
`8779208a38b5312cae949d9706c650a392f33415`:

| Source | Families offered | Absent | Gaps / `not-offered` | Passed | Failed | Incomplete |
| ------ | ---------------: | -----: | -------------------: | -----: | -----: | ---------: |
| memory |               19 |      0 |                    6 |     64 |      0 |          0 |
| SQLite |               19 |      0 |                    0 |     70 |      0 |          0 |

Memory's six exact gaps remain
`actuals.set:unknown_step`, `capacity.set:missing-reference`,
`estimates.set:unknown_step`, `measures.set:unknown_step`,
`priorityBands.replace:missing-project`, and
`progress.set:unknown_step`; their bypass diagnostics remain embedded in the
printed certificate. SQLite has no exclusions. Neither source has an absent
family.

Source-specific mechanisms were exercised rather than normalized away:

- staged memory admitted the independent history write as `written`, retained
  its exact saved ID across both command-batch commit and rollback, serialized
  the competing quota writer against the history owner, and injected late
  faults inside staged writes;
- SQLite settled the competing history attempt as `snapshot_busy` before the
  held command batch was released, retained the separately prewritten saved ID
  across commit and rollback, returned immediate busy for the quota rival, and
  injected atomicity faults inside its real transaction/connection seams.

Fresh pre-gate commands and results:

| Command                                                                                                       | Result                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run store-memory:test:conformance --skip-nx-cache`          | 72 passed, 0 failed, 4,813 assertions; exact memory certificate printed                                                                                                                                                                                          |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run store-sqlite:test:conformance --skip-nx-cache`          | 72 passed, 0 failed, 6,180 assertions; exact SQLite certificate printed                                                                                                                                                                                          |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run conformance:test --skip-nx-cache`                       | 33 passed, 0 failed, 58 assertions across eight files                                                                                                                                                                                                            |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run store-memory:test --skip-nx-cache`                      | 95 passed, 0 failed, 5,027 assertions across four files                                                                                                                                                                                                          |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run store-sqlite:test --skip-nx-cache`                      | 723 passed, 0 failed, 8,220 assertions across 60 files                                                                                                                                                                                                           |
| `bun test src/source-conformance.test.ts` from `libs/store-memory`                                            | unit-of-work conformance: 6 passed, 0 failed, 18 assertions                                                                                                                                                                                                      |
| `bun test src/sqlite-unit-of-work.db.test.ts` from `libs/store-sqlite`                                        | unit-of-work conformance: 6 passed, 0 failed, 18 assertions                                                                                                                                                                                                      |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run core:test:portable --skip-nx-cache`                     | restricted sandbox reproduced Chromium `sandbox_host_linux.cc:41` EPERM after bundling 369 modules; the identical approved run outside that sandbox passed 1/0, bundle SHA-256 `38ae0a909d349233cfbd17c5d067929be0b5d6e8e35eb263bf14fb176eefd27b`, 922,839 bytes |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate source-conformance-completion --strict --json` | 1 passed, 0 failed                                                                                                                                                                                                                                               |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json`                                  | 83 passed, 0 failed: 72 changes and 11 specs                                                                                                                                                                                                                     |

Independent Astra task/epic reviews and their decisive mutation reversals are
recorded beside each slice above. The final source review's two enumeration
findings were repaired before the terminal source files at `41908dcd`; the
subsequent latest-main integration changed neither terminal source file nor
the manifest. The only remaining task 7.3 evidence is the committed-SHA
canonical h2puni gate.

### 2026-09-14 final review repair: staged-history proof and batch lifecycle

The memory command-stage disposal mutant is now the registered variant
`break:history.batch:interleaved-success-survives:staged-owner` and participates
in the exact memory inventory. Its named `complete-staged-write` phase is reached
only after the real stage contains the complete expected header and bodies and
the shared writer has returned exactly `{ outcome: "written" }`. After rollback,
the fixture separately records that an exact-ID public read returned null; the
shared case must then fail with that same missing ID. A wrong-body adversary
(`wrong-stage-body`) is rejected before phase reach, while the actual disposal
mutant is `observed`.

Both history-batch fixtures now race admission against early batch rejection.
Update and readback failures therefore reject the shared assertion instead of
waiting forever for `entered`. Settlement records whether a batch rejection was
already reported; teardown drains an unobserved batch failure, then always closes
the source. SQLite additionally always removes its exact opened temporary
directory. When settlement and cleanup both reject, `runCases` retains the
operation first and appends the cleanup cause. The bounded terminal tests cover
update, readback, and settlement failure for both adapters and assert one actual
close attempt, no unhandled rejection, and (for SQLite) absent opened directories.

#### R5 reversals observed

| Check                                          | Reversal                                                         | Exact observed failure                                                                                                                                                    |
| ---------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete staged prerequisite gates proof reach | Replaced the complete staged-plan equality with an ID-only check | `wrongBodyProof.kind` changed from expected `phase-failed` to received `observed`.                                                                                        |
| Admission owns early memory rejection          | Restored unconditional `await entered`                           | Bun surfaced `injected memory history update failure` as unhandled and failed the bounded terminal test.                                                                  |
| Admission owns early SQLite rejection          | Restored unconditional `await entered`                           | Bounded test failed `update admission did not terminate` after 500 ms.                                                                                                    |
| Cleanup owns a rejected batch before disposal  | Restored the early `await batch` throw in both teardowns         | Update/readback rows changed from one close + assertion phase to zero closes + cleanup phase; SQLite's exact opened directory remained until restored cleanup removed it. |

#### Restored verification

| Command                                                                                                                                             | Result                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run store-memory:test:conformance --skip-nx-cache`                                                | 73 passed, 0 failed, 4,850 assertions                                                                                                                                                            |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run store-sqlite:test:conformance --skip-nx-cache`                                                | 73 passed, 0 failed, 6,223 assertions                                                                                                                                                            |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run conformance:test --skip-nx-cache`                                                             | 33 passed, 0 failed, 58 assertions across 8 files                                                                                                                                                |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run store-memory:test --skip-nx-cache`                                                            | 96 passed, 0 failed, 5,064 assertions across 4 files                                                                                                                                             |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run store-sqlite:test --skip-nx-cache`                                                            | 724 passed, 0 failed, 8,263 assertions across 60 files                                                                                                                                           |
| `bun test src/source-conformance.test.ts` from `libs/store-memory`                                                                                  | 6 passed, 0 failed, 18 assertions                                                                                                                                                                |
| `bun test src/sqlite-unit-of-work.db.test.ts` from `libs/store-sqlite`                                                                              | 6 passed, 0 failed, 18 assertions                                                                                                                                                                |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run core:test:portable --skip-nx-cache`                                                           | Restricted run could not start Chromium; approved identical run passed 1/0 after bundling 369 modules, SHA-256 `38ae0a909d349233cfbd17c5d067929be0b5d6e8e35eb263bf14fb176eefd27b`, 922,839 bytes |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint,typecheck -p conformance,store-memory,store-sqlite --skip-nx-cache --parallel=1` | All six scoped targets passed                                                                                                                                                                    |

Task 7.3 deliberately remains unchecked: the repaired immutable commit still
requires the canonical h2puni gate and independent re-review.

### 2026-09-14 second final-review repair: failure ordering and real close boundaries

The shared history-batch case no longer lets a rejected `scenario.settle`
escape a `finally` and replace the history writer's rejection. It captures the
settlement failure, drains a still-pending history write before fixture close,
and reports simultaneous causes in operation-first order. The production-path
regression opens the shared `historyBatchRegistrations`, executes the real
`runCases` lifecycle, and covers writer+settlement and
writer+settlement+cleanup failures.

The adapter terminal tests no longer count a callback before disposal. Memory
decorates the exact `source.close` method used by its history fixture. SQLite
injects a precisely typed replacement for `closeSqliteResources`, which calls
the real boundary (including exact-directory removal) before injecting cleanup
rejection. Both continue to cover update, readback and settlement failures,
one real boundary invocation, and no unhandled rejection.

#### R5 reversals observed

| Check                                                       | Reversal                                                                                               | Exact observed failure                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Writer and settlement causes survive together               | Ran the new shared production-path test against the former `finally { await settle() }` implementation | Writer+settlement expected `history batch write and settlement failed: [injected history writer failure; injected history settlement failure]`; received only `injected history settlement failure`. The cleanup row likewise received settlement+cleanup and lost the writer cause. |
| Pending history write is drained before close               | The same former implementation let settlement escape before awaiting the delayed writer rejection      | Both shared rows failed `Expected: true`, `Received: false` at the close-after-write oracle; restored implementation awaits the write before close and both rows pass.                                                                                                               |
| Memory cleanup oracle observes the actual source close      | Omitted, then duplicated, the fixture's `source.close()` call                                          | Omission changed all three rows from `closeCalls: 1` to `0`; duplication changed the update/readback rows to `closeCalls: 2`.                                                                                                                                                        |
| SQLite cleanup oracle observes close plus directory removal | Omitted, then duplicated, the fixture's `closeSqliteResources()` call                                  | Omission changed all rows to `closeCalls: 0` and `directoryExists: true`; duplication changed update/readback rows to `closeCalls: 2` while directories remained removed.                                                                                                            |

#### Restored verification

| Command                                                                                                                                             | Result                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run conformance:test --skip-nx-cache`                                                             | 35 passed, 0 failed, 66 assertions across 9 files; both shared lifecycle regressions passed.                                                                                                                 |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run store-memory:test:conformance --skip-nx-cache`                                                | 73 passed, 0 failed, 4,850 assertions; exact memory certificate printed.                                                                                                                                     |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run store-sqlite:test:conformance --skip-nx-cache`                                                | 73 passed, 0 failed, 6,223 assertions; exact SQLite certificate printed.                                                                                                                                     |
| Focused Task 6.5 terminal tests in each adapter                                                                                                     | Memory 1/0 with 31 assertions; SQLite 1/0 with 43 assertions.                                                                                                                                                |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run store-memory:test --skip-nx-cache`                                                            | 96 passed, 0 failed, 5,064 assertions across 4 files.                                                                                                                                                        |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run store-sqlite:test --skip-nx-cache`                                                            | 724 passed, 0 failed, 8,263 assertions across 60 files.                                                                                                                                                      |
| Unit-of-work suites (`bun test src/source-conformance.test.ts`; `bun test src/sqlite-unit-of-work.db.test.ts`)                                      | Each passed 6/0 with 18 assertions.                                                                                                                                                                          |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run core:test:portable --skip-nx-cache`                                                           | Restricted Chromium launch reproduced `sandbox_host_linux.cc:41` EPERM; approved identical run passed 1/0, bundle SHA-256 `38ae0a909d349233cfbd17c5d067929be0b5d6e8e35eb263bf14fb176eefd27b`, 922,839 bytes. |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint,typecheck -p conformance,store-memory,store-sqlite --skip-nx-cache --parallel=1` | All six scoped targets passed.                                                                                                                                                                               |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate source-conformance-completion --strict --json`                                       | 1 passed, 0 failed.                                                                                                                                                                                          |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json`                                                                        | 83 passed, 0 failed: 72 changes and 11 specs.                                                                                                                                                                |

Task 7.3 remains unchecked pending the canonical committed-SHA gate and final
independent Astra re-review.
