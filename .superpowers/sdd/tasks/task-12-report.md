# Task 12 Report: OpenSpec 2.4

## Implemented

- Pinned six representative pilot boundaries at source revision
  `7851161bf96312750d07b933ca5d42b75ce575c7`: domain saved-plan values, application use
  cases, the memory adapter, release-assembly infrastructure, a refactoring document set and a
  frozen OpenSpec archive.
- Recorded every pre-index path, Git mode and blob identity in `docs/wiki-policy/policy.json`.
  The pilot decoder rejects an empty baseline or a tuple outside its boundary selector.
- Added stable module IDs, exact index paths, explicit first-version predecessor arrays and known
  external-consumer memberships in `docs/wiki-policy/modules.json`.
- Added one owned `README.md` index per boundary. The exact membership sets were frozen from the
  pinned tuples before those README files existed, so an index cannot define its own baseline.
- Added typed applicable-check references to index metadata and resolved them through the existing
  relationship-declaration schema on the production lint path. Missing disposition, duplicates and
  unknown check IDs fail closed.
- Validated external-consumer paths against the selected candidate and rejected absent or
  boundary-owned targets. `none-known` remains the existing explicit typed declaration, never an
  omitted/default state.
- Exercised the reviewed candidate-owned files only as an observe-mode pilot proposal. The test
  supplies binding, policy, authority and evidence from an explicitly external temporary trust
  root; no production binding or CI authority was activated.
- Removed inherited Nx task-execution markers from nested project-graph discovery. A relationship
  read is discovery, not a recursive execution of the `tool-wiki:test` target which launched it.

## Bounded assumptions

- The change's recorded baseline revision `7851161b` is the pilot source of truth. Task execution
  began from branch commit `8a2e7ef0`, but later wiki-tool commits do not rewrite those source
  tuples.
- Empty predecessor arrays mean these are the first stable IDs for the selected boundaries; they
  do not claim that no historical code preceded them.
- Known in-repository consumers are expressed using the existing exact-path and bounded-prefix
  membership schema. No selected pilot boundary has `none-known`; unknown out-of-repository
  consumers remain outside this repository-scoped pilot.
- `domain:test`, `core:test`, `store-memory:test`, `tool-dagger:test` and `tool-wiki:test` are the
  applicable current checks for these selected boundaries. This is selected pilot coverage, not an
  exhaustive repository claim.
- The candidate-owned policy and mapping are reviewed proposal data only. Task 5.3 remains the
  authority-bootstrap boundary, and a candidate cannot select them for CI certification.

## Failure-proof observations

Each fault was injected alone, observed on the production CLI path and restored before the next.
Adjacent `Proof:` comments quote the observed assertion or refusal.

| Deliberate fault | Observed production-path failure |
| --- | --- |
| remove `canonical-plan-input.ts` from its actual owned index | observe lint exited 1 with `unindexed candidate path in libs/domain/src/saved-plan/README.md: libs/domain/src/saved-plan/canonical-plan-input.ts` |
| omit external-consumer target validation | `consumer/absent.ts` certified; the oracle expected exit 1 and received accepted true |
| omit applicable-check resolution | `check.does-not-exist` certified; the oracle expected exit 1 and received accepted true |
| remove explicit checks disposition | an index with neither an applicable check nor a checks-inapplicability reason certified; expected exit 1, received accepted true |
| remove duplicate applicable-check validation | two `check.fixture` references certified; expected exit 1, received accepted true |
| remove the non-empty pilot baseline guard | an empty saved-plan baseline was accepted and all six boundaries were merely reported changed; expected exit 1, received accepted true |
| remove pilot tuple-selector containment | a core replay tuple inside the saved-plan baseline was accepted; expected exit 1, received accepted true |
| inherit Nx task invocation markers into graph extraction | the configured test target failed with `tool-wiki:test -> tool-wiki:test` recursive task invocation |

## Verification

- Focused production policy tests: `50 pass`, `0 fail`, `1,331 expect() calls` across two files.
- Uncached tool-wiki lint and forced TypeScript build: exit 0; cache skipped and no target skipped.
- Full configured uncached tool-wiki suite: 282 pass, 0 fail, 3,690 assertions across 15 files in
  536.97 seconds (8m57s Nx duration); cache skipped and no target skipped.
- The first post-commit full run had 279 pass and three pilot failures before lint because the
  byte-identical overlay left no change for the fixture's commit. Commit `cebb1d77` makes that
  temporary immutable candidate explicit with `--allow-empty`; all three cases passed under the
  reproduced Nx environment before the full green rerun.
- Strict pinned OpenSpec 1.3.0: exit 0, change valid after marking only task 2.4.
- Repository-wide Nx format check and `git diff --check`: exit 0 after formatting the new evidence.
- Implementation commits `c26665a7` and `cebb1d77`: pre-commit secret scan, formatting and lint
  passed.
- `bin/h2puni-gate.sh cebb1d77` — unavailable, exit 70 immediately because required heavy-lock
  path `/home/puni1/.cache` does not exist. No host-gate step ran; the host gate is not green.

## Scope

Only OpenSpec task 2.4 is complete. Task 2.5 and all production trust activation or gate wiring
remain untouched.
