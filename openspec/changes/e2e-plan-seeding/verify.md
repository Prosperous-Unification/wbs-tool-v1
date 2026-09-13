## Section 1 fixture boundary

Baseline reviewed at `c61b370dba618f00a875599d2d3a2aadb39f2f79`. The completed measured-rendering prerequisite `f66f73e8` is an ancestor of this checkout.

### Setup and tested gestures

- `rendering-fixture.ts` owns prerequisite setup: it signs in through the existing browser session, creates and names a project through the header, leaves the plan page while batches are authored, verifies the stored tree, and returns row identities. It does not take a rendering sample. `rendering-baseline.spec.ts` owns logical readiness (`aria-rowcount === rows + 1`), `renderingGeometry`, acceptance ceilings, and its existing malformed-identity and zero-geometry fault proofs.
- `plan-surface.spec.ts`'s `seedPlan` owns static prerequisites: project creation, row creation, and the persisted estimate needed to make the chart non-empty. The cases themselves own their defining gestures: opening the chart, table and chart wheel scrolling, keyboard traversal, horizontal-scroll isolation, and the corresponding geometry reads.
- The Section 2 allowlist remains `rendering-fixture.ts` and static setup in `plan-surface.spec.ts`. `layout.spec.ts`, `keyboard.spec.ts`, `mobile.spec.ts`, `priority-ramp.spec.ts`, `slack-cell.spec.ts`, `gantt.spec.ts`, `hints.spec.ts`, and `project-picker.spec.ts` retain their UI setup. `create-project.ts` remains the boundary that waits for the real header create to arm rename, verifies focus and selection, and settles the header; its consumers are unchanged in Section 1.

Retained measurement artifacts remain historical observations of their recorded fixture hash. This change does not relabel them after harness changes.

### Evidence

- `CI=1 E2E_PORT_SHIFT=2400 bunx playwright test --config apps/fe-01/playwright.config.ts apps/fe-01/e2e/project-picker.spec.ts --grep "abandoning the new project’s rename keeps the project"` — 1 passed. The real create still armed rename and Escape retained the project.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run fe-01:typecheck --skip-nx-cache` — passed.
- `bunx prettier --check openspec/changes/e2e-plan-seeding/{tasks,verify}.md` — passed.
- `git diff --check` — passed.
- `bunx @fission-ai/openspec@latest validate e2e-plan-seeding --strict --json` — valid, 1 passed and 0 failed.

The remaining Section 1 tasks are intentionally unmarked and unimplemented at this checkpoint.

## Section 1 implementation

`plan-fixture.ts` now validates recipes before writes, names project and
directory records with run/worker/test identity, resolves references across
real 200-command batches, validates every public response through the shared
contract client, and independently rereads row order, estimates and tag links.
`rendering-fixture.ts` uses the same generated-shape Page transport; its former
unconstrained generic response cast is gone.

The first browser run reached the isolated three-server stack but Playwright's
Node loader could not resolve Ajv's ESM subpath `ajv/dist/2020`. Naming the
existing module as `ajv/dist/2020.js` exposed the same validator without
changing any schema or acceptance rule. The next focused boundary run passed
5/5; the expanded final fixture and rendering-boundary run passed 10/10.

R5 reversals exercised the public routes: the second 201-row creation batch was
changed from its resolved `afterId` back to the earlier batch's local
`afterRef`, and be-01 refused command zero as
`createWorkItem/unknown_ref` before the fixture tree read. A duplicate row ref
failed before the observed project POST. A real missing-project command
refusal surfaced at setup. Removing the first result id from an intercepted
HTTP 200 failed at response identity validation. Removing exactly one
`setEstimate` while the tag write succeeded failed on stored `row/Dev`; removing
exactly one tag patch through a successful empty real batch failed on the
stored tag ids for `row`.

Fresh checks:

- `CI=1 E2E_PORT_SHIFT=2500 bunx playwright test --config apps/fe-01/playwright.config.ts apps/fe-01/e2e/plan-fixture.spec.ts apps/fe-01/e2e/rendering-fixture.spec.ts --workers=1` — 10 passed, 0 failed.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t typecheck -p fe-01,contracts --parallel=2 --skip-nx-cache --output-style=static` — both passed.

## Section 2 selected adoption

The rendering fixture now shares the generated-shape Page client while keeping
the table unmounted during bulk writes and retaining its independent final-tree
checks. The six plan-surface scenarios now create their static rows and initial
estimate through the fixture, select the exact project through the real picker,
then perform the same chart, wheel, keyboard, and geometry gestures as before.
No nonallowlisted E2E seed changed.

Two browser contexts concurrently seeded recipes with the same logical project,
row, and tag labels. Their run/worker/test-qualified project names and every
returned project, row, and tag id differed; each exact project was then selected
through its own picker. Removing worker/test identity made the real directory
writes collide on the shared tag, so the isolation proof is non-vacuous.

- `CI=1 E2E_PORT_SHIFT=4900 bunx playwright test --config apps/fe-01/playwright.config.ts apps/fe-01/e2e/plan-fixture.spec.ts apps/fe-01/e2e/plan-surface.spec.ts --workers=1` — 14 passed, 0 failed in 39.1s.
- The first attempt at shift 2500 was refused because port 5700 remained owned by an earlier interrupted process; no server was reused. Two picker-path defects were observed and fixed before the green run: an unescaped bracketed name threw a regular-expression error, then a word boundary after the closing bracket could never match.

## Section 3 concurrency audit

The all-E2E listing audit found one account-wide project read in the mobile
long-dependency setup and first-entry measurements in the header picker. The
mobile setup now reads the page's exact selected project id. Its case creates
and promotes a rival project first, proving that the global first project is
different; substituting that global id failed the real case at
`no 020 in the seeded plan`. Header measurements now locate the selected
project option by its exact project id.

The first exploratory four-worker run made the header fault concrete:
`CI=1 E2E_PORT_SHIFT=5500 bun run e2e --workers=4` ran with zero retries and a
fresh database, then finished 354 passed, 37 skipped and 2 failed in 8m54s.
Both failures measured another worker's first `New project` option and reported
`entryOverflow 0`, while the exact long-name option was present later in the
same rendered list. After exact-id scoping,
`CI=1 E2E_PORT_SHIFT=6100 bunx playwright test --config apps/fe-01/playwright.config.ts apps/fe-01/e2e/header.spec.ts apps/fe-01/e2e/mobile.spec.ts --grep 'widest entry|entry is clipped|short entry|dependency search' --workers=2`
passed 4/4. The remaining count assertions are scoped to a current plan,
dialog, listbox or rendered surface; the positional project options used only
as geometry anchors do not claim global membership or count.

## Section 3 measured concurrency

All six planned attempts used the frozen checkout
`de2293a9bc6288b80db5539b0bd74fa44df6565b`, zero retries, a fresh database
from the normal E2E startup, and three checked, run-owned ports. The timing is
`/usr/bin/time -p` wall time. A refusal count covers backend or POST refusal;
the lock count covers `SQLITE_BUSY` and `database is locked`.

| Planned sample | Shift (ports)            | Outcome                                                                                         | Wall time | Locks | Refusals | Vite `write EPIPE` |
| -------------- | ------------------------ | ----------------------------------------------------------------------------------------------- | --------: | ----: | -------: | -----------------: |
| one worker 1   | 5500 (8600/8700/9700)    | 356 passed, 37 skipped                                                                          |  1144.60s |     0 |        0 |                644 |
| one worker 2   | 6100 (9200/9300/10300)   | failed: case 42 did not arm project rename within 30s; manually stopped after case 45, exit 130 |   209.17s |     0 |        0 |                 62 |
| one worker 3   | 6700 (9800/9900/10900)   | 356 passed, 37 skipped                                                                          |  1189.73s |     0 |        0 |                734 |
| four workers 1 | 7300 (10400/10500/11500) | 356 passed, 37 skipped                                                                          |   453.41s |     0 |        0 |                668 |
| four workers 2 | 7900 (11000/11100/12100) | 356 passed, 37 skipped                                                                          |   445.62s |     0 |        0 |                642 |
| four workers 3 | 8500 (11600/11700/12700) | 356 passed, 37 skipped                                                                          |   430.96s |     0 |        0 |                654 |

The 209.17s for one-worker sample 2 is elapsed time for that failed,
manually interrupted attempt. The three four-worker runs have a 445.62s median. There is no valid
three-run one-worker median because planned sample 2 failed; the two completed
one-worker observations were 1144.60s and 1189.73s. The `write EPIPE` lines
were Vite websocket proxy noise observed without a Playwright failure in five
completed runs; they are retained rather than counted as lock or backend
refusals.

The acceptance rule refuses the four-worker configuration because all six
planned runs were not green. `playwright.config.ts` therefore remains unchanged
at `workers: 1`, even though the valid four-worker median is much faster than
the two completed one-worker observations.

Two full one-worker diagnostics are excluded from the planned matrix because
they overlapped other host work. The first passed 356 with 37 skipped in
1202.10s. The post-failure diagnostic also passed 356 with 37 skipped in
1178.68s, with zero locks/refusals and 700 Vite `write EPIPE` lines. Neither
replaces failed planned sample 2.

- `bunx vitest run playwright-config.test.ts --no-file-parallelism --maxWorkers=1`
  from `apps/fe-01` — 9 passed, confirming the retained configuration. The
  sandboxed attempt reached 8 passes and failed only because its authentication
  probe could not spawn Bun (`spawnSync bun EPERM`); the same command passed
  outside that process sandbox.

## Section 3 local final checks

The measurement commits were rebased without conflict onto `b84e0713`, whose
only intervening change hardens the agent-trailer hook and its test. No E2E
implementation or configuration changed during integration, so the six-run
matrix was not repeated.

- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t test lint typecheck -p fe-01 contracts --skip-nx-cache --output-style=static`
  — all six targets passed. `fe-01:test` passed 2,698 UTC tests across 105
  files and 3 zoned tests across 2 files; `contracts:test` passed 380 tests
  across 41 files. Both projects' lint and typecheck targets passed.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@latest validate --all --strict --json`
  — 82/84 items passed. The workspace-wide check exits 1 because unrelated
  changes `local-solver-development` and `stale-solver-seat-masks-failure`
  each have no delta and do not declare `skip_specs: true`.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@latest validate e2e-plan-seeding --strict --json`
  — this change passed 1/1 with no issues.

Task 3.4 remains unchecked. The canonical `bin/h2puni-gate.sh <sha>` host-wide
gate was not run under the coordinator's explicit sequencing instruction, and
the strict all-change validation remains red on the two unrelated changes
named above.

## Terminal review repair

Candidate `c30d9547` correlates every successful fixture batch with the exact
submitted command count, ordered index and ref, requiring an id only for
identity-producing commands. Plan recipes now compile omitted predecessors as
ordered appends before the first write, including across a 200-command boundary,
and directory tags use the same 200-command cap. Rendering verification compares
every stored estimate value and dependency endpoint with its declared recipe.

The restored focused browser run used fresh owned ports 12700/12800/13800:

- `CI=1 E2E_PORT_SHIFT=9600 bunx playwright test --config apps/fe-01/playwright.config.ts apps/fe-01/e2e/plan-fixture.spec.ts apps/fe-01/e2e/rendering-fixture.spec.ts apps/fe-01/e2e/plan-surface.spec.ts --workers=1`
  — **27 passed, 0 failed** in 55.3s.

Every temporary fault below was applied separately to `c30d9547`, exercised
through the real Playwright server stack on fresh databases and owned shifted
ports, then restored before the next fault:

- Removing the authored-batch correlation and running the four
  `refuses an authored HTTP200` cases at shift 9000 made all four fail because
  `seedPlan` resolved; each had reached exactly one authored batch and the
  faulted response otherwise remained HTTP 200.
- Defaulting every omitted predecessor to null and running both
  `implicit recipe order` cases at shift 9100 made the two-row and 201-row
  exact persisted-id orders fail.
- Sending all 201 tag commands together and running
  `chunks 201 directory identities` at shift 9200 reached the real backend
  refusal `too_many_commands` at command 200. Restored code observes [200, 1].
- Removing rendering authored-result correlation and running the wrong-index
  case at shift 9300 made `seedRenderingPlan` resolve after index 999.
- Removing exact estimate comparison and running the altered-value case at
  shift 9400 made the stored 8/9/10 estimate resolve successfully.
- Removing exact dependency comparison and running the redirected-edge case at
  shift 9500 made stored edge 10→0 resolve where 10→9 was declared.
- Removing the creation-id guard and running the missing-identity case at shift
  9600 moved failure from the named creation boundary to a later real
  `setEstimate/missing_id` refusal, so its exact phase assertion failed.
- Removing the geometry guard and running the zero-layout case at shift 9700
  returned a complete snapshot whose widths, heights and mounted counts were
  zero, so the required setup/layout refusal test failed.

The six API-seeded plan-surface cases each received their own production fault:

- `GANTT_DOCK_SLACK.flex: 0 0 0` made the short-plan assertion report 323px
  below the chart at shift 9800.
- `TABLE_FRAME.flex: 0 0 auto` made the tall-plan non-vacuity assertion report
  zero rows past the frame at shift 9900.
- Suppressing `onFrameScroll` left table and chart 8.554 rows apart at shift 9000.
- Suppressing `onPanelScroll` left the table at row zero at shift 9100.
- Mapping Ctrl+J to no command left the keyboard case at row zero at shift 9200.
- Copying the follower's horizontal offset into its driver reset the table to
  scrollLeft zero at shift 9400. An earlier follower-copy experiment stayed
  green and is excluded as a vacuous mutation; it was replaced rather than
  claimed as proof.

The six full-suite timing samples were not repeated. These repairs change
fixture response refusal, recipe normalization and only the >200-tag request
shape; they do not change Playwright workers, retries, application write
coordination or any recipe used in the measured full suite. The final focused
run covers the effective behavior change while the prescribed workers=1
decision and its original six-sample evidence remain intact.

Fresh owning checks after the repair:

- `bunx vitest run src/test-tiers.test.ts src/testing/plan-fixture-command-results.test.ts --no-file-parallelism --maxWorkers=1`
  from `apps/fe-01` — 11 passed. The first full frontend run found the new
  DOM-free suite missing from `NODE_SUITES`: 2 tier-census tests failed while
  2,702 passed. Adding the suite to the explicit fast tier made this focused
  proof green.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run fe-01:test --skip-nx-cache --output-style=static`
  — 2,704 UTC tests and 3 zoned tests passed after the tier fix.
- The owning Nx matrix passed contracts' 380 tests and both projects' lint and
  typecheck. Its first two sandboxed invocations were refused by Nx's recursive
  task detector while nested targets shared the process sandbox; running it
  outside that sandbox executed the targets normally.
- Strict `e2e-plan-seeding` OpenSpec validation passed 1/1. Strict workspace
  validation remains 82/84 because the unrelated `local-solver-development`
  and `stale-solver-seat-masks-failure` changes still have no delta or
  `skip_specs: true`.

## Latest-main integration

Merge commit `530a20ac` joins accepted E2E head `6591db1f` with fetched
`origin/main` `9b13f98e`. The merge was textually clean. Its behavioral overlap
includes main's table layout, status, completion, deadline, steps, keyboard and
browser changes; the fixture compiler, batch correlation, exact rendering
checks and their permanent negatives remained intact.

- `bunx vitest run src/testing/plan-fixture-command-results.test.ts src/components/wbs/actions-menu.test.tsx src/components/wbs/completion-prompt.test.tsx src/components/wbs/plan-layout.test.tsx src/components/wbs/table-frame.test.ts src/components/wbs/plan-cards.test.tsx --no-file-parallelism --maxWorkers=1`
  from `apps/fe-01` — 296 passed across six files.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t lint typecheck -p fe-01,contracts --parallel=2 --skip-nx-cache --output-style=static`
  — all four targets passed.
- After confirming ports 12100, 12200 and 13200 were free,
  `CI=1 E2E_PORT_SHIFT=9000 bunx playwright test --config apps/fe-01/playwright.config.ts apps/fe-01/e2e/plan-fixture.spec.ts apps/fe-01/e2e/rendering-fixture.spec.ts apps/fe-01/e2e/plan-surface.spec.ts apps/fe-01/e2e/deadline.spec.ts apps/fe-01/e2e/keyboard.spec.ts apps/fe-01/e2e/layout.spec.ts apps/fe-01/e2e/status.spec.ts apps/fe-01/e2e/steps.spec.ts --workers=1`
  — 113 passed in 5.3 minutes on a fresh database.

The performance matrix was not repeated: the merge changes rendered plan,
status, deadline and solver behavior, while Playwright worker/retry settings,
fixture write coordination and accepted recipe compilation paths are unchanged.
The workers=1 refusal therefore continues to use the preserved frozen matrix.

## Task 3.4 closeout on current main

The branch was clean and `a9a19aa6` was an ancestor of fetched `origin/main`
`8779208a`; it was fast-forwarded to that exact main commit before the closeout
checks. The performance matrix and fault-injection output above are the actual
change evidence and were preserved without claiming new runs. The worker
decision remains one because the recorded six-attempt acceptance matrix did not
produce six green samples.

- `bunx nx run-many -t test lint typecheck -p fe-01 contracts` — all 6 targets
  passed outside the process sandbox in 7m 6s, with 0 cache hits. A preceding
  sandboxed invocation exited zero after Unix-socket `EPERM` warnings without
  scheduling targets; that non-execution is explicitly rejected as evidence.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json`
  — 83/83 items passed: 72 changes and 11 specs.

The canonical full workspace gate is recorded below after this evidence is
committed, because `bin/h2puni-gate.sh` accepts an exact commit SHA.
