## Verification

Baseline: origin/main at `0dc0a831`. Isolated worktree: `.worktrees/drag-number-spacing`.

`HEAVY_LOCK_WAIT_SECONDS=1200 bin/with-heavy-lock.sh -- bunx nx run fe-01:test:unit`: 30 files, 507 tests passed. Existing Vite native-config and FORCE_COLOR/NO_COLOR warnings were emitted.

The in-app browser reported no available browser. Repository Chromium supplies real geometry assertions and screenshots, with `CI=1 E2E_PORT_SHIFT=3900` starting this worktree's stack on API 7000, gateway 7100 and frontend 8100. No existing dev server was reused.

The new Chromium regression was run against the original implementation:

```sh
CI=1 E2E_PORT_SHIFT=3900 HEAVY_LOCK_WAIT_SECONDS=1200 bin/with-heavy-lock.sh -- bun run e2e -- --grep 'keeps the drag handle close'
```

One test failed at the spacing assertion: `Expected: 28`, `Received: 36`, difference `8`. The glyph's nonzero size, containment and draggable attribute passed before that assertion. The baseline screenshot was inspected and preserved at `/private/tmp/drag-number-spacing-before.png`.

`OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate drag-number-spacing --strict`: change is valid. Telemetry is explicitly disabled using the CLI's supported opt-out because this sandbox cannot reach its optional telemetry endpoint.

Whole-workspace OpenSpec validation also passed all 64 entries. The command used `set -o pipefail` and parsed `.summary.totals` with `jq -e` to require zero failed and a positive passed count; observed `items: 64, passed: 64, failed: 0`.

The before and after Chromium screenshots were inspected side by side at the same 1400px viewport. Root numbers move left by 8px, leaf and parent numbers remain aligned, and the drag glyph and parent expander remain visible. The after image is preserved at `/private/tmp/drag-number-spacing-after.png`. This visual check does not by itself prove pointer dragging.

## Implementation checks

Implementation commit: `ba2e5048`.

| Check                                 | Command                                                                                                                                                                                                                                                                                                      | Observed outcome                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Affected frame/components             | From `apps/fe-01`: `HEAVY_LOCK_WAIT_SECONDS=1200 ../../bin/with-heavy-lock.sh -- bunx vitest run src/components/wbs/table-frame.test.ts src/components/wbs/plan-layout.test.tsx --no-file-parallelism --maxWorkers=1`                                                                                        | 2 files, 123 tests passed                                                |
| Frontend node units                   | From `apps/fe-01`: `TZ=UTC HEAVY_LOCK_WAIT_SECONDS=1200 ../../bin/with-heavy-lock.sh -- bunx vitest run --config vitest.node.config.ts`                                                                                                                                                                      | 30 files, 507 tests passed                                               |
| Related browser geometry/interactions | `CI=1 E2E_PORT_SHIFT=3900 HEAVY_LOCK_WAIT_SECONDS=1200 bin/with-heavy-lock.sh -- bun run e2e -- --grep 'keeps the drag handle close\|lines up the number\|holds a number still\|puts the pinned columns exactly\|holds the pinned columns there\|widens a column by dragging\|a row drag at the frame edge'` | 8 tests passed                                                           |
| Hidden Links pinning                  | Same browser command prefix with `--grep 'takes the hidden Links width out'`                                                                                                                                                                                                                                 | 1 test passed after updating its second fixed offset                     |
| Frontend types                        | `HEAVY_LOCK_WAIT_SECONDS=1200 bin/with-heavy-lock.sh -- bunx nx run fe-01:typecheck`                                                                                                                                                                                                                         | Exit 0; target succeeded, no cache hit                                   |
| Changed code lint/format              | `bunx eslint` and `bunx prettier --check` on the four changed production/test files                                                                                                                                                                                                                          | Exit 0, no ESLint diagnostics; Prettier clean                            |
| Workspace format                      | `NX_DAEMON=false HEAVY_LOCK_WAIT_SECONDS=1200 bin/with-heavy-lock.sh -- bunx nx format:check --all`                                                                                                                                                                                                          | Exit 0                                                                   |
| Commit hooks                          | Normal `git commit`                                                                                                                                                                                                                                                                                          | Secrets, formatting, lint and author-trailer hooks passed; none bypassed |

The browser cases cover root spacing, parent/leaf alignment, collapse/open, frozen numbers, pinning before/after horizontal scrolling, column-resize dragging and the existing synthetic `dragstart` case. No real-pointer row-reorder test is claimed. Existing Vite WebSocket `EPIPE` shutdown noise appeared in otherwise passing browser output.

A sandboxed browser attempt could not bind port 7000 and did not collect tests; the permitted rerun started the isolated stack and passed. An Nx `lint:fast` attempt lost its final session output after daemon/socket fallback and is not counted as evidence; the direct changed-file ESLint run above is the verified lint check.

Independent task review passed spec compliance and code quality with no critical or important finding. The only minor limitation is the unverified real-pointer row reorder described above.

After implementation, the production drag width was explicitly restored to 24px with the same browser command. It failed at the intended spacing assertion (`Expected: 28`, `Received: 36`, difference `8`); restoring 16px passed 1/1. The production/test diff was empty afterward, matching `ba2e5048`.

While this work was in progress, PRs #365/#366 merged into `main`. Their current main head `a82d437f` was integrated without conflicts. The earlier local results above describe the spacing implementation before that integration; final PR CI verifies the composed tree.

The composed head `46955134` was then checked locally with the related-browser command above plus the hidden-Links case and `NX_DAEMON=false`: all 9 tests passed in 38.3 seconds, using a fresh isolated stack. The final whole-branch reviewer found no critical or important issue and approved the code conditional on full green CI, retaining the explicit nonblocking real-pointer coverage limitation.

Complete CI and merge remain pending. Full workspace test/lint/typecheck/build and the complete Chromium suite will be checked by the PR's `gate` and all four `pixels` shards before merge; the focused checks above do not replace them. Delivery evidence belongs to the PR checks and merge record so this pre-merge verification snapshot does not claim a future result.

## Full-gate follow-up

PR #367 run `34345854884` at `620d2e5c` exposed a missed derived-width expectation in `e2e/steps.spec.ts:201`. The test waited for `3 steps need ≥1303px`; the retained DOM snapshot showed `3 steps need ≥1295px`. The 8px difference is the intended shared drag-width reduction, also consumed by the steps dialog through `foldedTableMinWidth`. Shard 4 finished with 50 passed, 1 failed and 36 skipped opt-in rendering benchmarks. The failure is not waived or retried unchanged; the remaining affected expectations and the full frontend suite are being verified before the next push.

The complete run was retained rather than cancelled. Its only failed Nx target was `fe-01:test`: 2593 passed and 5 failed, all old width literals (`1711→1703`, `1459→1451`, `1207→1199` twice, `1111→1103`). The other browser shards passed 98, 118 and 54 tests, including the new spacing regression on Linux. The failed Nx stage meant subsequent smoke/lock/secrets/docs/compose/migration/corpus/OpenSpec CI stages did not run; the corrected push must earn those verdicts too.

The browser suite's existing skips were unchanged: 36 opt-in `R10_BASELINE` experiments and the recorded Gantt `dragging up moves the boundary up` `test.fixme`. The pointer-driven row-reorder coverage limitation remains separate from those skips.

Correction `dd94a30d` changes only the four affected frontend test files, retaining independent literal expectations and historical Proof output. All five failures were reproduced in focused component runs before the correction; afterward all 152 affected component tests passed. Later assertions in the two plan tests were corrected too, rather than stopping at their first failure.

The full frontend target was then run, not only its node-unit subset:

```sh
NX_DAEMON=false HEAVY_LOCK_WAIT_SECONDS=1200 bin/with-heavy-lock.sh -- bunx nx run fe-01:test
CI=1 E2E_PORT_SHIFT=3900 NX_DAEMON=false HEAVY_LOCK_WAIT_SECONDS=1200 bin/with-heavy-lock.sh -- bun run e2e -- steps.spec.ts
```

`fe-01:test` passed all 102 UTC files / 2598 tests and both Pacific/Auckland files / 3 tests, exiting 0 in 6m35s. The complete steps browser file passed all 7 Chromium cases in 20.1s. Changed-file lint/format and normal commit hooks passed. Vite's existing between-case WebSocket `EPIPE` noise remained visible. The corrected PR still requires a new full CI verdict before merge.

The next PR run, `34348412528`, passed the full workspace gate and browser shards 1, 2 and 4, then exposed an existing test-cleanup race in shard 3. The retained trace for `asks be-01 for the schedule the reader picked` shows a routed plan GET beginning before its payload assertion passed, context teardown beginning while that refetch was still active, and the callback later reaching `apiResponse.json()` after Playwright had disposed its `APIResponse`. The observed failure was `apiResponse.json: Response has been disposed`; it was not a spacing failure.

PR #374 / commit `0d2c3c5c` subsequently landed the six-line test-only cleanup on main: the `optimization-cue.spec.ts` describe now awaits `page.unrouteAll({ behavior: 'wait' })` in `afterEach`, matching Playwright's contract to drain active route handlers before page disposal. This records the landed fix, not a landed negative proof. A local temporary experiment held a route for 500ms after `route.fetch()` and returned from its test on the old path; it passed 1/1 while emitting Vite's teardown `EPIPE`, did **not** reproduce `Response has been disposed`, was removed, and is not proof of the cleanup.

Current main `634656b4` was integrated into the corrected branch as composed head `412654d7`. Fresh isolated-browser verification used API 7000, gateway 7100 and frontend 8100:

```sh
CI=1 E2E_PORT_SHIFT=3900 NX_DAEMON=false HEAVY_LOCK_WAIT_SECONDS=1200 bin/with-heavy-lock.sh -- bun run e2e -- optimization-cue.spec.ts steps.spec.ts
CI=1 E2E_PORT_SHIFT=3900 NX_DAEMON=false HEAVY_LOCK_WAIT_SECONDS=1200 bin/with-heavy-lock.sh -- bun run e2e -- layout.spec.ts --grep 'keeps the drag handle close'
```

The complete optimization-cue and steps files passed all 15 Chromium cases in 44.1s; Nx exited 0 in 44.6s. That includes the formerly failing schedule-selection case and the corrected three-step width case. The focused drag-spacing regression passed 1/1 in 12.1s; Nx exited 0 in 12.6s. Existing Vite WebSocket `EPIPE`/`ECONNRESET` teardown noise appeared during the combined run without a Playwright failure. A new full CI verdict and merge remain pending; these focused local runs do not replace them.

## Failure-proof table

| Check                  | Injected fault                                         | Observed outcome                                                                         |
| ---------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Drag-to-number spacing | Original 24px drag width restored after implementation | Chromium failed on Expected 28 / Received 36 (difference 8px); restoring 16px passed 1/1 |
