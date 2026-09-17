# Task 1.1 report — execution-aware source certification

## Scope completed

- Added an independently typed manifest for all seventeen transactional and
  two history store families, preserving every existing case ID and declaring
  the exact common and admission-specific history cases.
- Added the typed capability, gap, deterministic seed, reader and scenario
  protocol from the approved design.
- Added a case runner that distinguishes declaration from execution, owns
  fixture cleanup before assigning pass, records setup/assertion/cleanup
  failures, emits not-offered cases from exact absent/gap declarations and
  marks focused runs partial.
- Added terminal certification for exact expected/registration/report sets,
  duplicate and unknown cases/gaps, capability/status agreement and failed or
  incomplete execution.
- Preserved the legacy four-family runner for task 1.3; only its declaration
  type was renamed internally to avoid colliding with the new exported type.

## Evidence

Every new safety assertion has a neighboring `Proof:` comment taken from an
observed mutation. The compile fixture extends `TransactionalStores` with
`conformanceProbe`; without its expected-error guard, the real root
`conformance:typecheck` fails on TS2741 because the manifest lacks that family.
The full command and fault table are in
`openspec/changes/source-conformance-completion/verify.md`.

## Verification summary

- Conformance: 12 tests passed; lint and typecheck passed.
- Compatibility: memory and SQLite typechecks passed; the existing memory
  source conformance file passed 20 with its one known gap skipped, and SQLite
  passed all 14.
- Skipped by scope: full workspace gate, full source suites, browser/build
  gates and not-yet-created source certification targets.

## Concerns for later slices

- Task 1.3 must replace the legacy runner rather than maintaining two permanent
  report models.
- Store-kit registration should use `CaseRegistration.openAndRun` closures so
  the generic runner never erases a family port type.
- Source factories must pass their declaration into `runCases`; otherwise an
  exact gap would execute instead of receiving `not-offered`.

## Round-one review correction

The review reproduced two false-certification paths in the Task 1.1 boundary.
Both are closed in the follow-up:

- assertion rejection now tracks whether `catch` ran independently of the
  rejection value, retaining `undefined` through both assertion-only and
  combined assertion/cleanup failures;
- `CaseExecution` is a discriminated terminal-state union, and certification
  rejects a pass without an invoked registration body, execution flag, fixture
  identity, finite ordered timing or completed cleanup.

The eight new negatives run through `runCases` and `certifyExecution`. Their
restored-fault output and final commands are recorded in `verify.md`. Later
store bodies, source declarations and source-specific fault machinery remain
outside this correction.

## Task 1.2 Astra re-review correction

The memory journal proof now reads the command-journal fixture's own history
table through the internal `journalHistoryFor` source reader. It observes the
successful sentinel, the same sentinel after the injected rejection, and a
fresh restored write. The control records the faulted event ID from the actual
history array only after its push; moving the barrier before that push was
observed returning no event ID. This deliberately does not claim that the separate
public `planEvents` fixture is coupled to journal history; that integration
remains Task 5.1 work.

Both subtree fixtures now write an estimate satellite on a real step and read
its exact state through the public estimate store before arming, after the
late fault, and after restoration. The late-write controls record a satellite
key only after the actual estimate write has returned. Moving either adapter's
barrier before that write was observed failing on `Expected:
["faulted:step-1"]; Received: []`, so root rollback can no longer stand in for
proof of final-satellite timing.

The correction keeps the exact-phase and per-run control semantics from the
previous review. Full memory and SQLite adapter suites, all three affected
projects' lint/typecheck targets, focused fault tests, formatting, and OpenSpec
validation were rerun; exact results and remaining skips are in `verify.md`.
