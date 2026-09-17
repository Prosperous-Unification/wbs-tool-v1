# Task 1.3 report — existing source-family migration

## Scope completed

- Moved the twelve existing steps, estimates, directory and eventLog bodies
  into four family files and composed them as typed case registrations.
- Added one deterministic two-project seed and real per-case openers for
  `openMemorySource` and `openSqliteSource`.
- Replaced legacy declaration-time reporting with shared execution reports;
  SQLite records twelve executed passes, while memory records eleven executed
  passes and one unexecuted `not-offered` gap.
- Removed the old memory exclusion, ran the excluded case directly and retained
  only the gap whose actual source failure remains `unknown_step` versus
  `written`.
- Ran add, rename, estimate, remove, range and prune decorators through the
  actual SQLite factory and the same shared registration bodies.

## TDD and R5 evidence

The inventory test first failed because `existingStoreRegistrations` did not
exist. The first real SQLite run then failed all setup paths because the new
fixture omitted required project estimate settings; adding the real project
shape made all twelve shared cases pass. Removing memory's declaration gap ran
the actual case and failed on `Expected: "unknown_step"` / `Received:
"written"`, so the gap was retained with that evidence.

Each of the six required behavioral faults produced an `observed` proof only
after its named production method was reached. The actual outputs were:
`Wiring` missing in favor of `faulted add`, `Renamed` replaced by `faulted
rename`, realistic days 2 becoming 3, `work-a-two` surviving removal, range
`[1]` becoming `[]`, and prune count 2 becoming 0. Adjacent Proof comments name
the injected fault and shared-runner test.

## Verification

- Focused case/source suite: 5 pass, 0 fail, 71 assertions.
- Conformance target: 29 pass, 0 fail, 47 assertions.
- Memory target: 23 pass, 0 fail, 226 assertions.
- SQLite target: 647 pass, 0 fail, 2,051 assertions across 60 files.
- Conformance, memory and SQLite typecheck targets passed, including the
  missing-family compile fixture.
- All three relevant lint targets passed. OpenSpec strict validation and all 75
  artifacts passed. Prettier and the final diff check passed.

## Scope boundary and skips

No later source family was implemented and no adapter behavior was changed.
Complete source declarations and dedicated conformance targets remain owned by
Task 7.1/7.2. The full workspace, build, deploy and browser gates were skipped
because this slice moves existing adapter contract cases and has no such
surface.

An attempted root-scoped `bun test libs/...` is not counted: direct TypeScript
build output under `dist/out-tsc` was also collected and failed from unresolved
workspace aliases/migration paths. The official project-scoped Nx targets
listed above replaced it and passed.

## Astra lifecycle correction

The review found two ways the proof harness could certify the wrong lifecycle
window. SQLite seed/setup now owns cleanup from temporary-directory creation,
verifies the exact public seed before returning a fixture, always attempts
directory removal after close, and aggregates original and cleanup failures.
Fault proofs now perform that setup before arming, run only the selected shared
registration, and accept only an assertion-phase failure as an observed proof.

Four production-path negatives were watched RED and restored: failed seed left
close count `0` and its directory present; throwing only the cleanup failure
made the aggregate check receive `false`; a real decorated `steps.add` reached
during seed produced a false `observed`; and a close rejection after real fault
reach also produced `observed` with the cleanup failure attached. Adjacent
Proof comments record those actual outputs. The six required fault cases also
run restored through the same shared runner after their injections.

Correction verification: the focused SQLite source-conformance file passed 6
tests with 273 assertions; the complete SQLite target passed 651 tests with
2,282 assertions across 60 files; the direct SQLite TypeScript build and
focused ESLint check passed. The conformance target passed 29 tests with 47
assertions, and the memory target passed 23 tests with 226 assertions. All six
relevant lint/typecheck targets passed, including the missing-family compile
fixture. OpenSpec strict validation and all 75 artifacts passed. No later
family or adapter behavior was added; full workspace, build, browser and deploy
checks remain skipped as outside this correction's surface.

## Astra diagnostic rereview correction

The remaining defect was at both report boundaries: `runCases` and
`recordFaultProof` reduced every `Error` to `.message`, so the aggregate created
by correct SQLite cleanup ownership lost all of its members. A shared internal
renderer now retains aggregate context and recursively renders ordered members,
including nested cleanup aggregates. The public report shapes remain closed and
unchanged.

Two tests use the real SQLite source, seed path, close and temporary directory.
Before the renderer, the returned `ExecutionReport` failed on `Expected to
contain: "original report setup sentinel"; Received: "SQLite conformance setup
and cleanup failed"`; the returned `FaultProof` failed equivalently for
`original proof setup sentinel`. Restored tests assert the full stable strings,
correct setup classifications, one close and removed directories. Existing
seed-time and cleanup-time false-proof tests remain green.

Verification: focused SQLite conformance passed 8 tests/282 assertions;
conformance passed 29/47; memory passed 23/226; and the complete SQLite target
passed 653 tests with 2,291 assertions across 60 files. Relevant lint,
typecheck, formatting and OpenSpec results are recorded in `verify.md`. No
later family was added; workspace, build, browser and deploy gates remain
skipped as outside this diagnostic-only correction.
