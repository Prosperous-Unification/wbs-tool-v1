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

## Failure-proof table

| Check                  | Injected fault                                         | Observed outcome                                                                         |
| ---------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Drag-to-number spacing | Original 24px drag width restored after implementation | Chromium failed on Expected 28 / Received 36 (difference 8px); restoring 16px passed 1/1 |
