# Task 1.2 report — named broken-source proofs

## Scope completed

- Added a manifest-derived closed fault-ID registry, typed fault definition and
  per-run activation controls.
- Added `brokenSource` with exact factory arguments/result and receiver-safe
  method substitution for class-backed ports.
- Added a proof recorder that distinguishes observed assertion failures from
  setup failures, phase failures and assertions that still pass.
- Added memory staged-write and SQLite transaction-write controls under each
  adapter's `src/testing/`; these are inert before arm and remain test-local.
- Added the three named Task 1.2 tests plus compile and adapter-control cases.

## Failure evidence

All nine checks in the Task 1.2 `verify.md` table were watched with their
production check removed or faulted, then restored. The receiver negative used
a real private-field class method; the early-failure negatives went through
`recordFaultProof`, and the compile fixture exercised the public exported API.

## Scope boundary

No shared store case, source declaration, adapter write operation or production
source factory was changed. The adapter controls name where future late-write
faults must be reached, but installation at each actual transaction/staged
write belongs to that family task. Task 1.3 remains the next open slice.

## Verification

- Conformance: 23 pass, 0 fail; lint and typecheck passed.
- Both source fault-control tests passed; both source lint/typecheck targets
  passed.
- Existing focused source suites passed: memory 20 with its one declared legacy
  gap skipped, SQLite 14 with no skip.
- Formatting and OpenSpec strict/all validation passed.
- Full source, workspace, build and browser gates were skipped proportionally
  because this slice changes test-only infrastructure, not adapter behavior.

## Astra correction

The controller rejected the deferred adapter installation. The correction:

- matches the reached phase exactly through the shared proof recorder and both
  source-specific controls;
- creates lifecycle state per proof, refuses repeat arm/open use and proves
  overlapping proof setup remains inert;
- installs source-local late-write seams at the actual memory staged-state and
  SQLite transaction points for subtree satellites, journal history and saved
  plan schedule bodies;
- proves each real operation reaches its named barrier, preserves the sentinel
  after rejection and succeeds again with a restored, unarmed source.

All shared, memory and SQLite phase/reuse negatives were observed on their
production recorder/source paths. Moving the six barriers outside rollback (or
publishing memory's staged state on rejection) made the public reads include
`faulted`; disconnecting each barrier made the expected rejection resolve.

The corrected full-source verification is 29/29 conformance tests, 35/35
memory tests with one pre-existing declared gap skipped, and 659/659 SQLite
tests. Lint and typecheck passed for all three changed projects. The workspace,
build and browser gates remain explicitly skipped because this task has no UI,
browser or deployment surface.
