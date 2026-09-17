# Verification Report

**Change**: `trusted-activation-relocation`
**Verified at**: 2026-09-16, on branch `change/trusted-activation-relocation`
**Verifier**: Claude Fable 5.1, tasks 5.3 and the policy-file half of 5.4

---

## 1. Structural Validation

- [x] `bunx @fission-ai/openspec@1.3.0 validate --all --json` — all items `"valid": true`

```
"totals": { "items": 84, "passed": 84, "failed": 0 },
"byType": { "change": { "items": 73, "passed": 73, "failed": 0 },
            "spec":   { "items": 11, "passed": 11, "failed": 0 } }
```

| Item                            | Type   | Issues |
| ------------------------------- | ------ | ------ |
| `trusted-activation-relocation` | change | none   |
| all other changes and specs     | both   | none   |

---

## 2. Task Completion

- [ ] Every `- [ ]` in tasks.md is now `- [x]`

Slice 4 was renumbered when the policy-file edits landed: the old 4.1 (the operator run) is now
4.2 and the old 4.2 (this report) is now 4.3.

| Task                        | Reason incomplete                                                                                                                                                                                                                                                                                                                                                                                                 | Blocks archive? |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 4.2 operator activation run | The command takes an `AuditReview` record produced by the trusted review harness for the exact candidate SHA. That harness is operator-run and lives outside this repository; no run for this branch head is reachable from this session, and the command refuses a record that does not bind the candidate (R17). Publishing the release and setting the three repository variables also needs repository admin. | Yes             |

---

## 3. Delta Spec Sync

| Capability                      | Sync status | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `trusted-activation-relocation` | ✓ synced    | All three requirements are implemented: the selector-miss refusal (1.1), the preparation command and its refusals (2.2, 2.3), and the runbook `Relocation` section with its anchor and serialization limit (3.1). The spec's "a production test derives that anchor from the refusal text it observed and resolves it against the runbook's own headings" is the case beside the refusal-string pin in `pilot-policy.test.ts`, which resolves the anchor with `markdownAnchors`, the reader `check-indexes` uses. No Markdown document links the anchor, so the repository link check never sees it and the spec no longer claims it does. |

---

## 4. Failure Proofs

> Rows 1–2 are slice 1's (task 5.1 report). Everything from R1 to the four CLI-argument refusals
> is slice 2's (task 5.2 report): the R1–R21 refusals, R19's Bun-pin and absent-module branches,
> the reviewed-snapshot refusal, the toolchain-pin and validator-rebuild refusals, the four
> CLI-argument refusals and the three review findings (skips, required attestation flags,
> `--work`/`--destination` containment). The last seven rows are slice 4's: the three on-disk
> policy-oracle assertions, the runbook-anchor pin beside the production refusal, and the three
> standing pins on the relationship facts and external consumers. Every row was observed failing
> with the check broken or the fault injected.

| Check (file:line)                                                                                        | Fault injected                                                           | Test that observed the failure                                                                             | Result                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trust.ts` `validateSelectedInputs` selector-miss message                                                | message left at the old one-line text                                    | `trusted-policy.test.ts` `lint validates that every trusted selector actually selects candidate inputs`    | `Received: "trusted boundary selector selects no candidate input: boundary.application\n"` against the new text                                                               |
| same check, pilot negative                                                                               | trusted selector left at the candidate's post-move path                  | `pilot-policy.test.ts` `refuses a trusted selector left at the pre-move directory of a relocated boundary` | `"refusals":[],"accepted":true`; `Expected: 1 / Received: 0`                                                                                                                  |
| R1 `assertCommittedCandidate` revision resolution                                                        | resolution removed                                                       | `refuses a candidate revision the repository does not carry`                                               | `candidate checkout is not at the candidate revision: HEAD 8d2ca07a… != 9999…`                                                                                                |
| R2 HEAD comparison                                                                                       | comparison forced false                                                  | `refuses a checkout that is not at the candidate revision, or is dirty`                                    | `ENOENT: failed to open root directory: <candidate>/src/new`                                                                                                                  |
| R3 porcelain refusal                                                                                     | refusal forced false                                                     | same test                                                                                                  | `Expected: 1 / Received: 0` — a full activation prepared from edited working files                                                                                            |
| R3 `assertOutsideCandidate` containment                                                                  | refusal forced false                                                     | `refuses a work or destination path inside the candidate repository`                                       | roles and the rebuilt validator written into the candidate; the refusal arrived only from `prepareActivation`'s role guard                                                    |
| R4 relocation policy equality                                                                            | canonical comparison forced false                                        | `refuses a candidate policy that changes anything but its selectors`                                       | `Received function did not throw`                                                                                                                                             |
| R5 moved boundary without `sourceSelector`                                                               | refusal forced false                                                     | `refuses a boundary the candidate moved without a source selector`                                         | `Received function did not throw`                                                                                                                                             |
| R6 `sourceSelector` equals base selector                                                                 | comparison forced false                                                  | `refuses a source selector that names neither the base selector nor its baseline`                          | `boundary sourceSelector selects nothing in the base baseline: boundary.fixture.module`                                                                                       |
| R7 `sourceSelector` selects a base baseline                                                              | refusal forced false                                                     | same test                                                                                                  | `Received function did not throw`                                                                                                                                             |
| R8 baseline present at `pilot.sourceRevision`                                                            | reconciliation forced false                                              | `refuses a pilot source revision bumped past the move`                                                     | `mapping source revision differs from pilot policy: 06225ba4… != aa8cf40c…`                                                                                                   |
| R9 mapping source revision                                                                               | comparison forced false                                                  | `refuses a mapping pinned to another source revision`                                                      | `Received function did not throw`                                                                                                                                             |
| R10 candidate selector resolves                                                                          | refusal forced false                                                     | `refuses a candidate whose selector still names the pre-move directory`                                    | `module memberships do not equal any boundary's selected members: module.fixture.module`                                                                                      |
| R11 predecessor resolution                                                                               | resolution forced false                                                  | `refuses a module lineage the base activation cannot resolve`                                              | `Received function did not throw`                                                                                                                                             |
| R12 new module names a predecessor                                                                       | refusal forced false                                                     | same test                                                                                                  | `module memberships do not equal any boundary's selected members: module.fixture.added`                                                                                       |
| R13 base module has a successor                                                                          | refusal forced false                                                     | same test                                                                                                  | `boundary has no module: boundary.fixture.module`                                                                                                                             |
| R14 membership ownership                                                                                 | `boundaries.length !== 1` forced false                                   | `refuses memberships that do not land on exactly one boundary`                                             | `undefined is not an object (evaluating 'boundaries[0].boundaryId')`                                                                                                          |
| R14 boundary completeness                                                                                | refusal forced false                                                     | same test                                                                                                  | `Received function did not throw`                                                                                                                                             |
| R14 empty membership                                                                                     | refusal forced false                                                     | `refuses a membership that selects nothing at the candidate revision`                                      | `module memberships do not equal any boundary's selected members: module.fixture.module`                                                                                      |
| R15 executable `nx-target` fact                                                                          | refusal forced false                                                     | `refuses a check the candidate declares no executable target for`                                          | `undefined is not an object (evaluating 'fact.project')`                                                                                                                      |
| R16 failed check                                                                                         | `exitCode !== 0` forced false                                            | `refuses a failed check instead of recording it`                                                           | `Expected: 1 / Received: 0` — a check that exited 1 recorded `status: passed`, certified and tarred                                                                           |
| R16 skipped work                                                                                         | skip channel forced to `'none'`; then the refusal forced false           | `measures the skips a bun test check reports instead of claiming none`                                     | `Expected: 1 / Received: 0` with the channel off; with skips recorded, `prepared activation is not certified by its own launcher`                                             |
| R17 review joins (obligation, `candidateIdentity`, `sourceBase`, generation)                             | each join forced false in turn                                           | `refuses a review record that does not bind this candidate`                                                | `Received function did not throw` (each)                                                                                                                                      |
| R17 subject, phase status, trust scope                                                                   | each comparison forced false                                             | `refuses a review whose subject, phases or trust scope do not bind the candidate`                          | `Received function did not throw` (each)                                                                                                                                      |
| R18 validator entry inside the boundary                                                                  | refusal forced false                                                     | `refuses a validator entry the policy does not select`                                                     | `Received function did not throw`                                                                                                                                             |
| R19 trusted node module is a real directory                                                              | `isDirectory` check forced false                                         | `refuses a trusted node module that is a symlink`                                                          | `Expected: 1 / Received: 0` — the archive copied symlinked packages                                                                                                           |
| R20 launcher self-check                                                                                  | self-check refusal forced false                                          | `refuses an activation its own launcher cannot certify`                                                    | `Expected: 1 / Received: 0` — tarred an activation the launcher had just refused                                                                                              |
| R21 base authority stratifies the review                                                                 | replaced with `previous?.riskStratum ?? 'risk.public-admission'`         | `refuses a review the base authority never stratified`                                                     | `Received function did not throw`                                                                                                                                             |
| R19 `assertPinnedRuntime` Bun pin                                                                        | comparison forced false                                                  | `refuses an operator runtime other than the candidate pin`                                                 | `Received function did not throw`                                                                                                                                             |
| R19 trusted node module absent or unreadable (`prepare-relocation-activation-cli.ts` `packageDirectory`) | `lstat` failure rethrown unwrapped instead of refusing                   | `refuses a trusted node module the candidate has not installed`                                            | `ENOENT: no such file or directory, lstat '<candidate>/node_modules/typescript'` instead of the named refusal                                                                 |
| reviewed snapshot is a committed selection (`relocation-activation.ts`, before the obligation request)   | refusal forced false, so a working selection reached the request         | `refuses a reviewed snapshot that is not a committed selection`                                            | `canonical JSON cannot serialize undefined` from the obligation request instead of the named refusal                                                                          |
| `deriveToolIdentity` toolchain pin                                                                       | refusal forced false                                                     | `refuses a candidate package manifest with no toolchain pin`                                               | `canonical JSON cannot serialize undefined`                                                                                                                                   |
| validator rebuild failure context                                                                        | context wrapper replaced with a rethrow                                  | `refuses a validator entry the candidate cannot rebuild`                                                   | `Received: "Bundle failed"`                                                                                                                                                   |
| CLI unknown flag                                                                                         | refusal forced false                                                     | `refuses unknown flags, missing flags and an already selected destination`                                 | `relocation activation: …` at exit 0 — prepared from the defaults                                                                                                             |
| CLI missing flag                                                                                         | refusal forced false                                                     | same test                                                                                                  | `The "paths[0]" property must be of type string, got undefined`                                                                                                               |
| CLI destination already selected                                                                         | refusal forced false                                                     | same test                                                                                                  | `relocation activation: …` at exit 0 — a second version written into a selected root                                                                                          |
| CLI required attestation flags                                                                           | `--resource-lane` / `--cwd-identity` defaults restored                   | `refuses a preparation that attests to no resource lane or cwd identity`                                   | `relocation activation: …` at exit 0, attesting `operator.tool-wiki-bootstrap` / `repository.candidate-checkout`                                                              |
| `pilot-policy.test.ts` bootstrap selectors resolve at HEAD                                               | the three moved boundaries left selecting the pre-move prefixes          | `the bootstrap policy and mapping select the moved pilot boundaries at HEAD`                               | received `["boundary.domain.saved-plan", "boundary.application.use-cases", "boundary.adapter.store-memory"]` against `[]`                                                     |
| same case, baselines stay under `sourceSelector`                                                         | one `boundary.domain.saved-plan` baseline path moved to the new prefix   | same test                                                                                                  | received `["boundary.domain.saved-plan"]` against `[]`                                                                                                                        |
| same case, module memberships lie under the new selector                                                 | `modules.bootstrap.json` left at the pre-move prefixes                   | same test                                                                                                  | received all three module ids with their index paths and membership prefixes as strays                                                                                        |
| the refusal's runbook anchor resolves (`pilot-policy.test.ts`, beside the refusal-string pin)            | the runbook heading renamed to `## Relocating the boundary`              | `refuses a trusted selector left at the pre-move directory of a relocated boundary`                        | `Expected to contain: "relocation"` against `["tool-wiki-trusted-activation", "prepare", "transport-and-admission", "relocating-the-boundary", "final-binding-and-recovery"]` |
| every bootstrap `nx-target` fact names a workspace project                                               | `check.core.test` pointed at the pre-move project `core`                 | `every bootstrap nx-target fact names a workspace project whose cwd exists at HEAD`                        | received `["check.core.test -> core"]` against `[]`                                                                                                                           |
| every bootstrap `nx-target` fact's `options.cwd` exists at HEAD                                          | the same fact's `cwd` pointed at `libs/core`, project left correct       | same test                                                                                                  | received `["check.core.test -> libs/core"]` against `[]`                                                                                                                      |
| every bootstrap module's `externalConsumers` prefix exists at HEAD                                       | `module.domain.saved-plan`'s consumer prefix reverted to `libs/core/src` | `every bootstrap module declares external consumers that exist at HEAD`                                    | received `["module.domain.saved-plan -> libs/core/src"]` against `[]`                                                                                                         |

- [x] Every check in this change has a row
- [x] Each negative test reaches the production call path, not a copy of it
- [ ] Where code distinguishes filesystem state, both absence AND unreadability were tested —
      the preparation command distinguishes an absent candidate file (R1/`git show`) but not an
      unreadable one; `git show` reads from the object store, not the work tree, so there is no
      unreadable-but-present case on that path.
- [x] No row relies on an exit code unless the tool's contract guarantees the effect

---

## 5. Gate Output

| Command                                                                                                                   | Result                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bunx nx test tool-devsync --skip-nx-cache -- --test-name-pattern 'links'` (before commit 1)                              | `2 pass, 0 fail, 3 expect() calls`                                                                                                                                                   |
| `bunx nx test tool-devsync --skip-nx-cache` (before commit 1)                                                             | `201 pass, 0 fail, 565 expect() calls, Ran 201 tests across 18 files [32.08s]`                                                                                                       |
| `bunx nx run tool-wiki:lint:source --skip-nx-cache` (before commit 1)                                                     | `Successfully ran target lint:source for project tool-wiki`                                                                                                                          |
| `bunx nx run tool-wiki:typecheck --skip-nx-cache` (before commit 1)                                                       | `Successfully ran target typecheck for project tool-wiki`                                                                                                                            |
| `bunx nx format:check --all`                                                                                              | exit 0, no output, before each commit                                                                                                                                                |
| `git diff --check`                                                                                                        | no output, before each commit                                                                                                                                                        |
| `bun tools/tool-wiki/src/cli.ts check-indexes working . HEAD` (after the policy edits)                                    | exit 0, empty stderr                                                                                                                                                                 |
| `bash bin/tool-wiki-lint.sh working . HEAD` (after the policy edits)                                                      | exit 0, `{"schemaVersion":1,"status":"inactive","certified":false,"reason":"external activation root is not provisioned"}` — no activation is provisioned locally                    |
| `bunx nx test tool-wiki --skip-nx-cache` (after the policy edits)                                                         | `610 pass, 0 fail, 5453 expect() calls, Ran 610 tests across 31 files [922.35s]`; `Successfully ran target test for project tool-wiki`, 15m 22s                                      |
| `bunx nx test tool-devsync --skip-nx-cache` (after the policy edits)                                                      | first run `199 pass / 2 fail` — the untracked `verify.md` and the legacy-occurrence pin; after re-pinning to 253/102 with digest `d0b34171…`, `201 pass, 0 fail, 565 expect() calls` |
| `bunx nx run tool-wiki:lint:source --skip-nx-cache` (after the policy edits)                                              | `Successfully ran target lint:source for project tool-wiki`                                                                                                                          |
| `bunx nx run tool-wiki:typecheck --skip-nx-cache` (after the policy edits)                                                | `Successfully ran target typecheck for project tool-wiki`                                                                                                                            |
| `bun test --preload ../test/scratch/preload.ts src/policy/pilot-policy.test.ts` (target form, after the standing oracles) | `20 pass, 0 fail, 273 expect() calls, Ran 20 tests across 1 file [219.78s]`                                                                                                          |
| `bunx nx test tool-devsync --skip-nx-cache` (after the standing oracles)                                                  | re-pinned to 257/106 with digest `fe5c29e2…`, then `201 pass, 0 fail, 565 expect() calls`                                                                                            |
| `bunx @fission-ai/openspec@1.3.0 validate --all --json`                                                                   | 84 items, 84 passed, 0 failed                                                                                                                                                        |
| `bin/h2puni-gate.sh 56b591f4e723322a8b0a8db6e36bdf78b1d18631` (on h2puni)                                                 | exit 0 — output below                                                                                                                                                                |

The observe-mode experiment from the design's Q5, reproduced through the production CLI with the
`pilot-policy.test.ts` harness (`createCandidate` + `createExternalTrust` over the bootstrap policy,
mapping and a synthetic observe authority, then `lint-local observe committed`):

```
"deterministicChecks":[{"kind":"inventory",…},{"kind":"classification",…},{"kind":"schema",…},
{"kind":"metadata-links",…},{"kind":"selector-input-coverage",…}],
"refusals":[{"kind":"mode","reason":"observe cannot lower enforce policy"}],
"certified":false,"accepted":false
```

With `relationships.bootstrap.json` reverted to its pre-edit facts the same run reported instead:

```
fact check.core.test authority-selector mismatch: expected {"cache":true,…,"options":{"command":"bun test src --coverage --coverage-reporter=lcov","cwd":"libs/core"},…}; received <unresolved>
```

So all three edits are load-bearing and C8–C12 pass with them; the single remaining refusal is the
expected `observe cannot lower enforce policy`, which is the mode the harness runs in and not a
policy defect.

The canonical h2puni gate ran on the branch head `56b591f4` and exited 0 (log `~/gate-56b591f4.log`,
exit file `~/gate-56b591f4.exit` = 0 on h2puni):

```
h2puni gate: running on 56b591f4e723322a8b0a8db6e36bdf78b1d18631
openspec 84 valid
format:check clean
Successfully ran targets test, lint, typecheck, build for 31 projects
Successfully ran targets test, typecheck for project tool-wiki
Successfully ran target lint:source for project tool-wiki
Successfully ran target solver-image-smoke for project wbs-be-01
```

---

## 6. Implementation Signal

- [x] No unstaged files in the worktree
- [ ] Relevant commits pushed — the branch is local to `/home/df/wd/puni/wbs-tool-v1-w5`; pushing
      is the controller's call.

**Commit range**: `4dc797cb..56b591f4`, plus the commit carrying this gate record — documentation
and one `Proof:` comment beside the R19 absent branch, so it needs its own gate run before archive.

| Commit     | What                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| `9f65eb42` | `docs(tool-wiki): relocation activation procedure` — slice 3                                            |
| `50021ae3` | `docs(wiki-policy): relocation selectors, mapping and facts for the moved pilot boundaries` — slice 4.1 |
| `3afd09e0` | `docs(openspec): trusted-activation-relocation verify` — slice 4.3                                      |
| `a17ca7cd` | `test(tool-wiki): pin the relocation anchor and the bootstrap facts` — review fixes                     |
| `56b591f4` | `docs(openspec): trusted-activation-relocation spec and verify match the pins` — the gated head         |

---

## Decision

- [ ] ✅ PASS
- [x] ⚠️ PASS WITH WARNINGS — the committed work is verified and the canonical h2puni gate
      passed on `56b591f4`, but three items stay open: (1) task 4.2, the operator activation run, because the `AuditReview` record must come
      from a trusted review harness run for this exact branch head, that harness is operator-run
      and outside this repository, and the command refuses any record that does not bind the
      candidate; (2) `trusted-wiki` stays red on this branch until 4.2 lands, and because one
      authority certifies one commit it will then be green only for the exact SHA the activation
      was prepared from — every other head, the merge commit included, stays red; (3) this gate
      record is itself an ungated commit on top of `56b591f4`.
- [ ] ❌ FAIL

Four reviewer observations are parked rather than fixed here, recorded so they are not lost:

- **R18's message overstates its check.** It refuses a validator entry no boundary selects, while
  the message says "outside the enforced boundary". An entry under an adopted-but-not-enforced
  boundary is accepted. Harmless today (the bootstrap policy enforces one boundary), wrong the
  moment a second is adopted; fix the message or the check together.
- **R4 strips the whole `relationshipRequest`.** A relocation candidate may therefore also
  re-point `relationshipRequest.declarationPaths`, not only `typescript`. That is what the design
  specifies, and the declarations file is still digest-pinned through the policy, but it is more
  latitude than "selectors and the relationship request" suggests at a glance.
- **`deriveCheckCommands` lets a later declarations file win.** With several
  `declarationPaths`, a duplicate `factId` in a later file overrides the earlier one instead of
  refusing the ambiguity. One path is declared today, so nothing exercises it.
- **`.sort()` versus admission's `compareText`.** The planner sorts paths with the default
  comparator where admission uses a byte comparator. Identical for the ASCII repository paths in
  play; a non-ASCII path would diverge.

**Next step**:

An operator with repository admin runs the review harness for this branch head, runs
`prepare-relocation-activation-cli.ts` with that record (see
`docs/runbook-tool-wiki-activation.md#relocation`), publishes the archive, sets the three
`TOOL_WIKI_ACTIVATION_*` variables, records the `trusted-wiki` run id here, and merges with a merge
commit.
