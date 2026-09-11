# Verify — Automatic dev solver binding

No implementation evidence yet. All builds and automated tests run on h2puni or
in CI, never on the queue worker host.

## Structural validation

At `3c98fec8`, on h2puni in detached worktree
`/dev/shm/t326-spec-3c98fec8`:

```text
bunx @fission-ai/openspec@1.3.0 validate --all --json
40 items, 40 passed, 0 failed; automatic-dev-solver-binding valid
```

The first attempt used the repository's unqualified `openspec` command and
failed with exit 127 because h2puni has no global binary. No validation was
claimed from it; the pinned package command above is the accepted gate.

The terminal proof must include:

| proof                  | required failure control                      | evidence                                               |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------ |
| compatibility identity | solver byte changed / unrelated byte changed  | `99810aa`: mutant failed only unrelated-source control |
| target-pinned runner   | import available only in old live checkout    | `99810aa`: 8/8 focused cases green                     |
| pre-reset ordering     | omit each prepare/verify phase                | `d9eeb611`: 75/75; preflight omission failed 2 cases   |
| exclusion              | two different targets overlap                 | `cc6c050d`: overlap refused before second publish      |
| interrupted retry      | stop after publish and during install         | `3017d066`: digest reused; premature completion red    |
| target build tree      | narrow archive / old live working directory   | run 4: behavioral red, then 79/79 green on h2puni      |
| live solver change     | poll target differs under `libs/solver-py`    | live refusal; checkout/served SHA stayed `12302b8d`    |
| alarm backstop         | ten consecutive injected preparation failures | alarmed at 10; stayed healthy below threshold at 11    |

## Identity and target runner

At `99810aa385f240f1f3cb313eec2b83ec6a7aaa9c`, the clean detached h2puni
worktree `/dev/shm/t326-r3-red-76e9ca4f` resolved 78 declared dependencies with
`BAD_COUNT=0`. The target-pinned state suite passed 8/8 cases (16 assertions),
the whole `tool-devsync` project passed 72/72 cases (197 assertions), and its
TypeScript build, ESLint, and Prettier checks passed. The lint output warned
that its standalone invocation had no cached Nx project graph; the full Nx
project test subsequently built that graph and passed.

The initial test-only tree failed because `solver-preparation` did not exist.
After implementation, a control replaced the compatibility path contribution
with the full commit SHA: the unrelated-source case failed at `toBe` while the
other seven cases stayed green. Restoring the production source returned 8/8.
The state and runner cases separately require the host command ledger to stay
empty for old-live-tree code, absent or partial state, a non-digest image, a
a malformed source SHA, and a different compatibility identity.

## Pre-reset preparation ordering

At `d9eeb611f8d291a99a8ed34b1de1ae457cbb6248`, the same clean detached h2puni
worktree passed all 75 `tool-devsync` cases (213 assertions), TypeScript,
ESLint, and Prettier, with all 78 declared dependencies still valid. The
focused preparation suite passed 11/11 cases (32 assertions).

The test-only tree initially failed because
`prepareSolverBindingBeforeReset` was not exported. After implementation, a
control removed the awaited preflight call: the happy-path phase-order case
and the injected preflight-failure case both failed, while the other nine
cases stayed green. Restoring the exact source returned 11/11. The same table
test injects failures at publish, materialize, install, and preflight and
requires the reset ledger to remain empty for every phase.

## Binding exclusion

At `cc6c050d4e2427e047f61f98b5b233597487f5ce`, the exact-head h2puni
`tool-devsync` gate passed 76/76 cases (217 assertions), ESLint, TypeScript,
and Prettier. The focused preparation suite passed 12/12 cases (36
assertions). Its overlap case blocks the first target in publish, submits a
different target, and requires the second target to reach none of publish,
materialize, install, preflight, or reset while the first lease remains held
through reset.

A control replaced the nonblocking acquisition with an unconditional lease.
The overlap case failed because the different target completed instead of
being refused; the other 11 focused cases stayed green. Restoring the exact
source returned 12/12.

## Interrupted binding retry

At `3017d06600b64700982c51c3fa92ed022cfebf74`, the exact-head h2puni
`tool-devsync` gate passed 78/78 cases (226 assertions), ESLint, TypeScript,
and Prettier. The focused preparation suite passed 14/14 cases (45
assertions). It records `published` immediately after the immutable digest is
known, retries an interrupted install from that target-matching checkpoint
without publishing again, and records `complete` only after materialization,
install, and preflight succeed.

A control wrote `complete` before the interrupted install. The retry case
failed on the unexpected complete checkpoint while the other 13 focused cases
stayed green. Restoring the exact source returned 14/14. That original
same-identity/different-commit refusal was later superseded by the terminal
review repair below: compatibility identity owns image reuse, while the new
full source SHA is durably rebound before host mutation.

## Complete target build tree

At 2026-09-08T02:39:30Z, the run-4 candidate-boundary patch was overlaid on
`533b67f4fb79547e207d8fddb59246640f044b42` in the h2puni worktree
`/dev/shm/t326-r4-red.XHeZSa`. Its behavioral case requires both the target's
backend Dockerfile, publisher, supervisor unit, and lockfile and a working
directory rooted at that candidate. Before the loader change it failed with
the candidate child exiting 1. After broadening the exact-commit archive and
running from the candidate root, that case passed.

The full `tool-devsync` project then passed 79/79 cases (228 assertions), its
Nx lint and TypeScript targets passed, the changed TypeScript file passed
Prettier, and `dev-poll-sync.sh` passed ShellCheck. The first formatting command
also named the shell file and failed because Prettier has no shell parser; no
format result is claimed from that invocation. Dependency manifests resolved
through `/dev/shm/t326-r3-red-76e9ca4f/node_modules` before and after the gate:
78 declared, 0 bad. `/dev/shm` was at 75% of the monitored per-user quota, so a
new install was correctly refused and the already-proved dependency tree was
reused only after the manifest check passed.

At 2026-09-08T02:50:28Z, the candidate was tightened from a plain archive to
an atomically renamed, shared, detached clone. The extended behavior first
failed because the archive had no Git identity. It now requires the candidate
HEAD to equal the requested full SHA and `git status --porcelain` to be empty;
the borrowed `node_modules` symlink is excluded only in that clone's private
Git metadata. The full poller suite passed 12/12 cases (37 assertions),
including different-target and same-target overlap, and the Nx lint and
TypeScript targets, changed-test Prettier, and ShellCheck passed on h2puni.

## Host input decoders

At 2026-09-08T02:59:48Z, the test-only host-input suite failed because
`solver-binding-host.ts` did not exist, then passed 3/3 cases (9 assertions).
The decoders accept exactly one non-empty `REGISTRY_PASS` without ever logging
its value, require the one-tier publish manifest to carry the requested full
SHA and its registry-returned digest, and preserve both installed prod image
rules only when each solver image equals its authenticated caller image.
Malformed, mismatched, tag-only, empty, missing, and duplicate inputs refuse.

With those files overlaid on `4ac18c6c`, the full `tool-devsync` suite passed
82/82 cases (237 assertions), and its Nx lint and TypeScript gates passed.
Prettier initially reported both new files and passed after formatting on
h2puni; the worker-host formatter could not load the repository's Tailwind
plugin, so no local formatting result is claimed. The post-gate dependency
check remained 78 declared, 0 bad.

## Host transition composition

At 2026-09-08T03:07:12Z, the host-transition tests first failed in two
independent ways: the composition export was absent, and a completed durable
checkpoint skipped current host preflight before reset. The implementation
validates installed prod mappings before publish, reads the protected registry
credential only if publish is actually needed, checkpoints the immutable
digest before materialization, then installs, preflights, checkpoints complete,
and resets. A completed retry now rechecks host readiness without republishing.

The focused pair passed 19/19 cases (59 assertions). The full h2puni
`tool-devsync` suite passed 84/84 cases (242 assertions); Nx lint and TypeScript
and changed-file Prettier passed after replacing four unbound method references
with explicit forwarding closures. No production host mutation ran in this
slice.

## Production runtime adapter

At 2026-09-08T03:14:53Z, the runtime-adapter test failed on the missing module
and then passed 1/1 case (13 assertions). It proves the protected registry
value appears only in the publisher child's environment and in no argv. The
explicit command ledger acquires the canonical heavy-work lock, publishes only
be from the target clone, materializes while preserving blue and green, builds
the supervisor bundle on h2puni, executes the existing installer, runs the
installed bundle preflight, atomically checkpoints both phases, and resets the
live checkout last.

With the runtime files overlaid on `bf37b632`, the full `tool-devsync` suite
passed 85/85 cases (255 assertions). The focused test and Nx lint and TypeScript
targets passed after mechanical import/test lint fixes. The production adapter
was not invoked against the live host in this slice.

## Sync target routing

At 2026-09-08T03:24:11Z, the sync-routing test first failed because
`deploySolverTarget` did not exist. The implementation now compares the live
checkout with the fetched target and keeps source-unrelated targets on the
existing preflight-then-reset path. A solver-compatible-tree change instead
derives the target identity from the target clone, reads that identity's
bounded durable state, and delegates the entire transition (including the
last reset) to the production binding runtime. The deployed-HEAD proof still
runs only after either route completes.

The first implemented focused run exposed a test-only source-order search that
matched a helper's earlier `rev-parse HEAD`; constraining the search to the
post-routing region returned the focused suite to 29/29 cases (80 assertions).
The full h2puni `tool-devsync` suite passed 86/86 cases (259 assertions), Nx
lint and TypeScript passed, and both changed files passed Prettier. An earlier
remote lint attempt had no scratch `node_modules` link and its uncached
`bunx eslint` failed loading `@eslint/js`; it did not change tracked files.
After revalidating the existing dependency tree (78 declared, 0 bad) and
restoring the scratch-only link, all gates passed and the post-gate dependency
check remained 78 declared, 0 bad. No live-host transition ran in this slice.

## Runbook and candidate installation

At 2026-09-08T03:28:40Z, the dev runbook was changed from a manual publish and
install prerequisite to the implemented target-revision route. It now records
the detached clean candidate, complete Dagger build context, target identity,
single exclusion, immutable publish checkpoint and retry, production mapping
preservation, installed preflight, reset-last rule, credential boundary, and
manual recovery commands. OpenSpec task 6 is closed. With these documentation
changes overlaid on the h2puni candidate, OpenSpec 1.3.0 validation passed all
54 items (54 passed, 0 failed). No build or autotest ran for this docs-only
slice, and no live host state changed.

## Missing installed-config bootstrap

At 2026-09-08T04:02:29Z, a read-only h2puni probe confirmed the first live
automatic transition had no installed supervisor config and no preparation
checkpoint. The protected registry environment existed at mode 0600 and its
contents were not read. Prod's host-owned Docker state had exactly
`be-01-blue` (stopped) and `be-01-green` (running), each configured with a
distinct digest-pinned `wbs-be-01` image; the rendered Compose artifacts named
the same two images. Prod state recorded green active at deployed source
`0afc77758131bc4257dcaa78f0b26bc97ffd92dc`.

The preparation test removed the installed config and first failed before any
publish with `TypeError: undefined is not an object` in
`decodeInstalledProdImages` while the other three cases stayed green. The
runtime production-path test then failed because it tried to read the absent
config rather than inspect the exact prod containers. The implementation now
distinguishes absence from unreadability: absence queries only bounded Docker
fields (`Name`, `State.Running`, `Config.Image`), accepts exactly one blue and
one green caller with digest-pinned images, and uses them as the bootstrap
baseline. A present but unreadable config still propagates its read failure;
mutable, incomplete, duplicate, malformed, or oversized inspection output
refuses before publish.

On h2puni, the focused bootstrap pair passed 7/7 cases (34 assertions). The
canonical `tool-devsync:test` Nx target passed 88/88 cases (267 assertions),
and its lint and TypeScript targets plus changed-file Prettier passed. A raw
`bun test tools/tool-devsync/src` attempt was noncanonical: it ran the suite
from the repository root instead of the project's declared cwd and reported
39 fixture/path failures, so it is recorded but not counted as a gate.
Dependency manifests before and after resolved 78 declared, 0 bad. A fresh
dependency install was unavailable because the monitored `/tmp` quota was
already 66% (above the 65% pre-install ceiling); the previously proved
task-private dependency tree was reused after validation. The post-gate sample
was `/dev/shm` 59%, `/tmp` 69%, below the 85% hard alert. No live host mutation
ran in this slice.

## Live solver-affecting transition

At 2026-09-08T04:09:46Z, before attempt 1, dev was still at
`12302b8d63757c6ca47a0138b33540deeb7f7160`, the installed config and
preparation checkpoint were absent, and the independent alarm reported 180
consecutive failed poll ticks. The exact pushed target `08524d31` entered the
new missing-config path and reached the immutable publisher, proving the live
prod-container baseline decoded before any mutation. Publication then refused
on its existing capacity guard: 9,697,058,816 bytes of memory were available,
but combined `/tmp` and `/dev/shm` occupancy was 8,444,461,056 of
16,361,123,840 bytes, above the 25% ceiling. No image, config, checkpoint, or
checkout reset was produced. The 04:17 UTC scheduled aged-`/tmp` reclaim is the
first safe retry opportunity; the guard was not bypassed and no unattended
cleanup was run.

## Terminal review repair

At `8b7a4452`, the h2puni watched-red pair failed three independent controls:
same-identity retry refused an unrelated successor SHA, an overwritten complete
binding propagated its first failed preflight instead of repairing, and runtime
preflight omitted the service and socket checks. At exact pushed head
`8c676bc90c4e28c10efcc8e412e3b48c222eebda`, the replacement controls and full
remote gates are green: `tool-devsync` 91/91 tests (275 assertions),
`tool-remote-scripts` 275 passing with one Docker-only skip, both projects'
TypeScript and ESLint targets, changed-file Prettier, and OpenSpec 55/55.
Dependency integrity was 78 declared, 0 bad before and after.

The implementation reuses an identity-pinned image across unrelated successor
commits while checkpointing the new source SHA before host mutation, repairs a
stale completed binding once, and checks service, socket, and mapping before
reset. Config publication through post-install readiness is held by the real
production `flock`; its holder attribution is inherited from the canonical
lock implementation. ADR 0018 and the dev runbook record the brief production
solver interruption and exclusion contract. This closes accepted peer findings
C1, C2, I1, I3, M1, and M6; live capacity proof I4 remains open.

## Target-owned automatic loader

Live attempt 2 exposed a bootstrap gap before publication: h2puni's installed
loader was the older narrow-archive generation, so it produced a candidate with
no `.git` and target `sync.ts` failed its first exact-tree `git rev-parse`.
Nothing published, installed, checkpointed, or reset. The narrow candidate was
moved to an explicit recovery name rather than deleted.

At watched-red head `f9238345`, the poller source-shape control failed because
the automatic tick still invoked `"$BIN/dev-poll-sync.sh"`. At `6ccd51d3`, it
passed 12/12 focused cases after the installed poller began streaming the
target commit's loader with `git show`; ShellCheck, project ESLint, and
TypeScript also passed on h2puni. A streamed live attempt then built a complete
Git candidate and reached the publisher. One overlapping automatic tick first
returned the documented deploy-lock skip; the uncontended retry refused before
mutation because available memory was 8,465,108,992 bytes, 124,825,600 below
the 8 GiB floor. The 05:47 UTC scheduled tmpfs gate reclaim is the next safe
retry opportunity; no guard was bypassed and no scratch tree was deleted.

The live target crossed the real compatibility diff from `12302b8d` and ran
the exact target-owned preparation code. Its capacity refusal left image,
config, checkpoint, checkout SHA, and served SHA unchanged; this is AC #2's
explicit refusal branch, not a claimed deploy. The existing heartbeat alarm was
then exercised on h2puni with ten injected copies of that preparation-failure
marker: default `--max 10` exited 1 and named the stuck SHA and tmpfs cause,
while the identical ten at `--max 11` exited 0. `notes/heartbeat.md` places that
command in the owner-visible rotation. Thus a real solver-affecting refusal
remains before mutation and reaches an owner within one ten-tick alarm period.
