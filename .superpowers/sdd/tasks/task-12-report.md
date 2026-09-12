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

## Astra Fix Round 1

Applicable-check IDs now resolve only to extracted `nx-target` facts, the currently modeled
executable check authority. A prose or topology fact cannot become a check merely by retaining a
known ID.

Pilot policies now require an externally selected module-mapping artifact. The binding pins its
stable-read path and SHA-256 separately from the candidate. Production lint strictly decodes that
artifact, requires the candidate proposal to have the same exact identity, and reconciles every
module's source revision, stable ID, predecessor bytes, index path, owned path set, exact trusted
boundary, external consumers and completeness against the candidate's checked README indexes.
This remains local-operator observe authority; no candidate file selects CI trust.

An index's own README is now part of its owned set for external-consumer validation, alongside its
declared members.

| Deliberate fault | Observed production-path failure |
| --- | --- |
| replace all five Nx check facts with external-consumer prose under the same IDs | production observe lint returned accepted true before the fix; restored code refuses `docs/refactoring/w4-4/README.md: check.tool-wiki.test (external-consumer)` |
| declare the saved-plan README as its own external consumer | production observe lint returned accepted true before the fix; restored code refuses that exact owned README path |
| change only the candidate's saved-plan predecessor while external trust retains the reviewed mapping | production observe lint returned accepted true with regenerated authority/evidence; restored code refuses the candidate/external mapping identity mismatch |
| delete the required saved-plan README | production observe lint returned accepted true with regenerated authority/evidence; restored code names the absent module index |
| rename the externally pinned saved-plan module | production observe lint returned accepted true with regenerated authority/evidence; restored code names the mapping/index module-ID disagreement |
| change saved-plan ownership to the core use-case tree | removing the direct check moved failure to `trusted pilot boundary has no exact module mapping: boundary.domain.saved-plan`, so the index-ownership assertion failed at its own expected diagnostic |
| declare no mapped saved-plan consumers | removing consumer reconciliation returned accepted true; restored code names the mapping/index consumer disagreement |
| omit the saved-plan module from the externally pinned mapping | removing completeness returned accepted true; restored code names the unmapped selected index |

Verification on implementation commit `29a84723`:

- Pilot production CLI: 10 pass, 0 fail, 163 assertions in 274.36 seconds.
- Existing trusted-policy production CLI: 47 pass, 0 fail, 1,272 assertions in 88.35 seconds.
- Uncached Nx lint and forced typecheck: exit 0; cache skipped and no target skipped.
- Full configured uncached Nx suite: 289 pass, 0 fail, 3,794 assertions across 15 files in 757.95
  seconds (12m38s Nx duration); cache skipped and no target skipped.
- An initial combined run exposed canonical serialization of an explicit `undefined` mapping
  identity for non-pilot bindings. The final implementation preserves the prior non-pilot identity
  shape; its fresh 47-case trust run and full suite are green.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate agent-scalable-llm-wiki --strict`: exit 0, change valid.
- `NX_DAEMON=false NX_INVOCATION_ROOT_PID=91304 bunx nx format:check --all`: exit 0.
- `git diff --check`: exit 0.
- `bin/h2puni-gate.sh 29a84723` — unavailable, exit 70 immediately because required heavy-lock
  path `/home/puni1/.cache` does not exist. No host-gate step ran; the host gate is not green.

Only Task 2.4 remains marked complete. Task 2.5, Task 3.5 and Task 5.3 authority activation remain
untouched.

## Astra Fix Round 2

The externally selected pilot module-mapping loader now has production `lint-local observe`
failure proofs for every trust-boundary guard requested in review. This round changes no loader
behavior: it adds only production-path regression cases and adjacent observed `Proof:` comments.
The unreadability case changes the actual external artifact to mode `000`, observes `EACCES`
rather than absence, and restores mode `600` in `finally` before cleanup.

| Deliberate one-at-a-time fault | Observed production-path failure |
| --- | --- |
| remove the external-location guard and point the binding at candidate `modules.json` | observe returned accepted true; the test failed on `Expected: 1 / Received: 0` |
| point the missing-file dependency at the existing readable external mapping | observe returned accepted true; the test failed on `Expected: 1 / Received: 0`; restored fault reports `ENOENT` |
| make the mode-`000` external mapping readable | observe returned accepted true; the test failed on `Expected: 1 / Received: 0`; restored fault reports `EACCES`, not `ENOENT` |
| remove the bound-digest comparison | observe returned accepted true; the test failed on `Expected: 1 / Received: 0` |
| remove the source-revision comparison after committing identical wrong revisions to both mapping copies and regenerating all candidate-bound authority/evidence | observe returned accepted true; the test failed on `Expected: 1 / Received: 0` |

The source-revision row supersedes the round-2 diagnostic-only mutation. Commit `56811ee7`
regenerates the external mapping, binding digest, candidate identity, source base and authority from
the committed wrong-revision candidate, so mapping identity agrees and only the source guard can
refuse it.

Verification on proof commits `1c98e3a3` and `56811ee7`:

- Five new production CLI negatives: 5 pass, 0 fail, 53 assertions in 9.60 seconds after every
  injected fault was restored.
- Full pilot production CLI file: 15 pass, 0 fail, 219 assertions in 177.45 seconds.
- Existing trusted-policy production CLI file: 47 pass, 0 fail, 1,272 assertions in 89.00 seconds.
- `NX_DAEMON=false NX_INVOCATION_ROOT_PID=91309 bunx nx run-many -t lint typecheck -p
  tool-wiki --skip-nx-cache --output-style=static`: exit 0; cache skipped and no target skipped.
- `NX_DAEMON=false NX_INVOCATION_ROOT_PID=91306 bunx nx test tool-wiki --skip-nx-cache
  --output-style=static`: exit 0; 294 pass, 0 fail, 3,847 assertions across 15 files in 643.27
  seconds (10m43s Nx duration); cache skipped and no target skipped.
- Strict pinned OpenSpec 1.3.0: exit 0, change valid.
- `NX_DAEMON=false NX_INVOCATION_ROOT_PID=91308 bunx nx format:check --all`: exit 0.
- `git diff --check`: exit 0.
- `bin/h2puni-gate.sh 1c98e3a3`: unavailable, exit 70 immediately because required heavy-lock
  path `/home/puni1/.cache` does not exist. No host-gate step ran; the host gate is not green.
- Round-3 `NX_DAEMON=false NX_INVOCATION_ROOT_PID=91310 bunx nx test tool-wiki
  --skip-nx-cache --output-style=static`: exit 0; 294 pass, 0 fail, 3,850 assertions across 15
  files in 651.15 seconds (10m51s Nx duration); cache skipped and no target skipped.
- Round-3 strict pinned OpenSpec 1.3.0: exit 0, change valid.
- `NX_DAEMON=false NX_INVOCATION_ROOT_PID=91311 bunx nx format:check --all` and
  `git diff --check`: exit 0.
- `bin/h2puni-gate.sh 56811ee7`: unavailable, exit 70 immediately because required heavy-lock
  path `/home/puni1/.cache` does not exist. No host-gate step ran.

Only Task 2.4 remains marked complete. No production activation or later task changed.
