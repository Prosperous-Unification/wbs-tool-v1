# Verification Report

**Change**: `wiki-release`
**Verified at**: `2026-09-16 — branch change/wiki-release, head cbbee6a0 (base 84a4fd63)`

> The whole-suite run above was made at `cbbee6a0` itself. The three foreground runs and the other
> checks were made at `d7a0f14e`, whose tree differs from `cbbee6a0` only in this file's head
> references.
> **Verifier**: Claude Fable 5.1, under the W7 controller

> Partial. Slices 1-5 are implemented and verified here. Slice 6 is operator work Dany runs against
> a real consumer repository; its rows stay empty until then. This change is not archivable until
> slice 6 is recorded.

---

## 1. Structural Validation

- [x] `openspec validate --all --json` — all items `"valid": true`

```
{"totals": {"items": 86, "passed": 86, "failed": 0}}
```

| Item           | Type   | Issues |
| -------------- | ------ | ------ |
| `wiki-release` | change | none   |

---

## 2. Task Completion

- [ ] Every `- [ ]` in tasks.md is now `- [x]`

| Task                   | Reason incomplete                                             | Blocks archive? |
| ---------------------- | ------------------------------------------------------------- | --------------- |
| 6.1 operator procedure | Dany tags, releases and adopts the toolkit in a real consumer | yes             |

---

## 3. Delta Spec Sync

| Capability     | Sync status | Note                                                    |
| -------------- | ----------- | ------------------------------------------------------- |
| `wiki-release` | ✗ pending   | ADDED requirements sync at archive, after slice 6 lands |

---

## 4. Failure Proofs

| Check (file:line)                                               | Fault injected                                                                   | Test that observed the failure                                                                                                         | Result                                                                                                       |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| manifest join, `trusted-wiki.yml` / `ci.yml` provisioning       | join `if` deleted from both steps                                                | `activation provisioning refuses an archive the configured version does not name`                                                      | exit 0, root exported for a foreign archive                                                                  |
| selection shape, both provisioning steps                        | shape `if` deleted; `selected.json` directory `../decoy` with a planted manifest | `activation provisioning refuses a selection that leaves the extracted archive root`                                                   | exit 0, joined a manifest the pinned archive never carried                                                   |
| `bin/tool-wiki-lint.sh:38` runtime absence                      | refusal replaced by a non-failing assignment                                     | `the archived runtime closure is the launcher default and its absence is refused`                                                      | exit 0, route ran with no TypeScript closure                                                                 |
| `trusted-wiki.yml` `Install archived launcher` descriptor shape | shape `if` deleted; descriptor `../decoy-launcher.sh` with a real decoy          | `the trusted workflow installs the launcher its archive root names`                                                                    | exit 0, installed the decoy as the admission entrypoint                                                      |
| `release.ts` `assertReleaseTag` (T1)                            | `if (false && …)`                                                                | `refuses a tag that is not at HEAD, unknown, or malformed`                                                                             | packed an archive at exit 0                                                                                  |
| `release.ts` `assertTagAtHead` T2                               | `if (false && …)`                                                                | same case                                                                                                                              | refused as `not at HEAD: undefined != <head>`                                                                |
| `release.ts` `assertTagAtHead` T3                               | `if (false && …)`                                                                | same case                                                                                                                              | packed the wrong commit's bytes at exit 0                                                                    |
| `release.ts` `assertCleanCheckout` T4                           | `if (false && …)`                                                                | `refuses a checkout whose bytes are not the ones the tag names`                                                                        | packed an edited launcher at exit 0                                                                          |
| `release.ts` `assertReleaseRuntime` T5                          | `if (false && …)`                                                                | `refuses an operator runtime and a destination it cannot honestly use`                                                                 | packed under a drifted `bunVersion` at exit 0                                                                |
| `release.ts` `assertDestinationFree` T8                         | `if (false && …)`                                                                | same case                                                                                                                              | second run wrote into an occupied destination at exit 0                                                      |
| `release-cli.ts` T6 non-standalone bundle                       | none — see the comment at the throw site                                         | none                                                                                                                                   | **no observed negative**; `Bun.build` cannot reach it here                                                   |
| `relocation-activation.ts` R21 toolkit message                  | `riskStratum ?? 'risk.public-admission'`                                         | `a strata file that stratifies no policy review refuses by name`                                                                       | invented the stratum and prepared an activation                                                              |
| `prepare-activation-cli.ts` toolkit role digest                 | `if (false && …)`                                                                | `a toolkit role altered after packing refuses before anything is prepared`                                                             | reached a later, unrelated failure instead of the name                                                       |
| `gate-entrypoints.test.ts` consumer template byte identity      | a comment appended to the template                                               | `Nx, host gate, CI and lefthook select the whole tree without caching`                                                                 | the two texts printed side by side                                                                           |
| same, `wiki-release.yml` `contents: write` scope                | narrowed to `contents: read`                                                     | same case                                                                                                                              | permission pin failed                                                                                        |
| same, release action refs 40-hex                                | `softprops/action-gh-release@v2`                                                 | same case                                                                                                                              | ref pin failed                                                                                               |
| five rewritten `trusted-wiki.yml` pins                          | the pre-7.2 workflow text                                                        | same case                                                                                                                              | each literal failed                                                                                          |
| step-order pin                                                  | guard step moved after provisioning                                              | evaluated against the mutated text                                                                                                     | FAIL as required                                                                                             |
| `bun-version` equals `.bun-version`                             | compared against a drifted `1.3.9`                                               | evaluated against the mutated value                                                                                                    | FAIL as required                                                                                             |
| `jq --exit-status` type test, both provisioning steps           | `jq --raw-output` restored                                                       | `activation provisioning refuses a malformed selection or manifest by name`                                                            | rc 2 "Could not open …/null/manifest.json", not a named 78                                                   |
| canonical containment, both provisioning steps                  | textual containment only                                                         | `activation provisioning refuses a selection that resolves outside the archive root`                                                   | exit 0, root exported for a manifest outside the archive                                                     |
| `bin/tool-wiki-push-audit.sh` launcher-root rule                | descriptor joined only when relative, refusal limited to the candidate           | `push audit refuses a launcher descriptor that leaves its activation root`                                                             | `../outside-launcher.sh` ran, exit 0 (captured directly)                                                     |
| `assertMappingOwnership` in toolkit mode (R14)                  | re-guarded behind the base arm                                                   | `toolkit mode keeps the refusals that measure the candidate alone`                                                                     | a mapping covering no boundary reached the review join                                                       |
| `readToolkit` closure identity                                  | `if (false && …)`                                                                | `a toolkit whose runtime closure or Bun drifted refuses before anything is prepared`                                                   | an altered `typescript/package.json` was copied in and self-certified                                        |
| `readToolkit` Bun comparison                                    | `if (false && …)`                                                                | same case                                                                                                                              | bound a bundle digest the consumer's runner cannot reproduce                                                 |
| `assertDestinationOutside` (T7)                                 | `if (false && …)`                                                                | `refuses an operator runtime and a destination it cannot honestly use`                                                                 | wrote the toolkit inside the checkout it had verified clean                                                  |
| `assertDestinationFree` archive path (T8)                       | `if (false && …)`                                                                | same case                                                                                                                              | overwrote an existing `wiki-v0.0.1.tar` at exit 0                                                            |
| refusal order in `planRelocationChecks`                         | R14 before R11-R13; and lineage before R10                                       | `refuses a module lineage the base activation cannot resolve`, `refuses a candidate whose selector still names the pre-move directory` | each earned the opaque R14 instead of its own named refusal                                                  |
| `assertPinnedTypeScript` (T9)                                   | `if (false && …)`                                                                | `refuses an installed TypeScript that is not the one the tag pins`                                                                     | packed a stale closure under a `toolkit.json` claiming the tag, with a clean tree                            |
| `assertDestinationOutside` canonical path                       | destination compared unresolved                                                  | `refuses an operator runtime and a destination it cannot honestly use`                                                                 | packed into the checkout through a symlink, exit 0                                                           |
| `trusted-wiki.yml` archived-launcher containment                | textual containment only                                                         | `the trusted workflow installs the launcher its archive root names`                                                                    | installed a symlinked decoy as the admission entrypoint, exit 0                                              |
| `bin/tool-wiki-lint.sh` archive-root default                    | default removed from the launcher                                                | `a consumer prepares and certifies its own first activation with no base activation`                                                   | the whole preparation failed `not provisioned`; the self-check now scrubs the override instead of setting it |

- [x] Every check in this change has a row
- [x] Each negative test reaches the production call path, not a copy of it
- [x] Where code distinguishes filesystem state, both absence AND unreadability were tested
      (the launcher's runtime default covers absence; the toolkit role digest covers alteration)
- [x] No row relies on an exit code alone; each names the observed wrong behaviour

**Honest exception**: T6 has no observed negative. `Bun.build` with no `external` configuration
either inlines every bare specifier or fails the build, so this repository cannot currently emit a
bundle that reaches the check. It is recorded as a contract guard at its throw site and as incident
`R5-28` in `docs/findings/checks-that-cannot-fail.md`, not claimed as proven. The bundle it guards
is separately proven to run standalone: `the bundled preparer runs standalone from a neutral cwd`
executes it from an empty cwd with only `PATH` and `HOME`.

---

## 5. Gate Output

CI is the merge gate; locally the wiki project's own targets plus the entrypoint suites were run.

Background log files in this environment are truncated to their first few lines within seconds of
a command completing, and an earlier partial read of one produced a false green in this change. So
every figure below comes either from a foreground run whose output was read in full, or from a
watcher gated on the command's own literal last line (`NX_EXIT=` / `BUN_EXIT=`), which cannot fire
against a partially written file. Nothing here rests on a piped exit code: a failing `nx` inside a
pipeline without `pipefail` reports the exit status of `tail`.

```
bunx nx test wiki-cli --skip-nx-cache   head=cbbee6a0  nx_exit=0
  (one canonical line carrying head,    637 pass, 0 fail, Ran 637 tests across 32 files
   exit code and summary together,
   written only after nx exited)

# and, read in full in the foreground, the same 32 files as three invocations:
src/policy/                                                    → 183 pass, 0 fail (6 files), exit 0
src/{admission,contracts,evidence,experiments,indexes,inventory}, src/cli.test.ts
                                                               → 335 pass, 0 fail (20 files), exit 0
src/{relationships,review}                                     → 119 pass, 0 fail (6 files), exit 0
                                        183 + 335 + 119 = 637, the single run's own total
src/policy/{gate-entrypoints,pilot-policy}.test.ts             → 0 fail (2 files)
src/policy/trusted-policy.test.ts                              → 55 pass, 0 fail (1 file)

bunx nx run wiki-cli:lint:source --skip-nx-cache → Successfully ran
bunx nx run wiki-cli:typecheck --skip-nx-cache   → Successfully ran
bunx nx test tool-devsync --skip-nx-cache        → Successfully ran
bunx nx test tool-git-hooks --skip-nx-cache      → Successfully ran
bash bin/h2puni-gate.test.sh                     → all cases passed
bunx nx format:check --all                       → exit 0
git diff --check                                 → exit 0
bunx @fission-ai/openspec@1.3.0 validate --all --json → 86/86
nx show projects --affected --files=apps/wiki/consumer/README.md        → includes wiki-cli
nx show projects --affected --files=.github/workflows/wiki-release.yml  → includes wiki-cli
nx show projects --affected --files=.github/workflows/ci.yml            → includes wiki-cli
diff .github/workflows/trusted-wiki.yml apps/wiki/consumer/trusted-wiki.yml → empty
```

Every command with its result line is in
`.superpowers/sdd/2026-09-15-agentic-scalability-plan/task-7.1-report.md`.

---

## 6. Implementation Signal

- [x] No unstaged files in the worktree at each commit
- [ ] Relevant commits pushed — the controller pushes and opens the PR

**Commit range**: `84a4fd63..HEAD` on `change/wiki-release`; the suite was verified at `cbbee6a0`

---

## Decision

- [ ] ✅ PASS
- [x] ⚠️ PASS WITH WARNINGS — slices 1-5 are verified; slice 6 is operator work and T6 carries no
      observed negative. Neither blocks review; both block archive.
- [ ] ❌ FAIL

**Next step**: controller review, then the exact-head h2puni gate, then Dany decides whether to tag
`wiki-v0.0.1` and adopt the toolkit in a consumer repository. This session created no tag and no
release.
