## Status

R10 starts from the pre-optimization source preserved by93259b43. Approved refactoring plan§67R10 is authority. The complete latency/render-count matrix and bounded Gantt stress observations are measured below. Budgets are published in proposal.md; independent re-review approved their corrected derivation and protocol scope with no Critical or Important findings. Final review reopened Tasks4.2 and5.2 for direct evicted-editor behavior coverage and a fully provisioned workspace gate.

Locked Bun install passed after sandbox temp/cache permission escalation (102packages,1.95s). Browser skill was read and runtime initialized; `agent.browsers.get("iab")` reported unavailable and documented discovery returned an empty list. Interactive in-app browser is unavailable. Parent confirmed canonical Playwright Chromium is appropriate for repeatable measurements. Measurement ports5500/5600/6600 are assigned to this worker, subject to actual listener verification. Parent must grant a quiet heavy-check window before timed runs.

## Commands and measurements

`bun run dev:setup` passed, using repository example configuration. No private environment was copied. FE root typecheck passed after correcting dataset index access; fixture ESLint passed after correcting numeric template interpolation and unknown JSON boundary typing. The later eight-step geometry addition passed the same checks in the fresh verification recorded below.

Canonical smoke: `bin/with-heavy-lock.sh -- env CI=1 E2E_PORT_SHIFT=2400 R10_BASELINE=1 R10_BASELINE_SMOKE=1 bunx playwright test --config apps/fe-01/playwright.config.ts apps/fe-01/e2e/rendering-baseline.spec.ts --grep '100 rows / 2 steps / sparse'`. Initial run failed on the fixture's accessible-name locator: `Name of 010` matched the hundred-row number0100, receiving Row0009 instead of Row0000. Readiness now uses the exact seeded row identity. Repeated smoke passed:1test8.5s, stack-inclusive20.0s. No measurements from the failed smoke are accepted.

Full matrix command omitted the smoke option and grep, attempting3cold contexts+7warm reloads per configuration. Parent held all other heavy checks. Application source remained35576d79. Five cases passed in11.0minutes;500/2/dense was deliberately interrupted after2.1minutes to release the shared measurement window, process exit130. It is unmeasured, not a passed case. Six later configurations did not run. Listener verification found no remaining listeners on5500/5600/6600 after shutdown.

Raw completed observations are retained under [evidence/baseline](evidence/baseline). Environment: Chromium151.0.7922.34, Darwin25.5.0 arm64, Apple M1 Pro,1400×900, UTC/en-US, no throttling, warm Vite/backend with fresh browser contexts. Paint times are double-rAF opportunities; latency samples use readiness/long-task observers but no precise-coverage profiling. Coverage counts come from a separate instrumented pass.

| Configuration | Completed samples | Mounted cells, folded | Mounted cells, unfolded | Test duration |
| ------------- | ----------------- | --------------------- | ----------------------- | ------------- |
| 100/2/sparse  | 3cold+7warm       | 1500                  | n/a                     | 26.1s         |
| 100/2/dense   | 3cold+7warm       | 1500                  | n/a                     | 31.3s         |
| 100/8/sparse  | 3cold+7warm       | 2100                  | 5300                    | 48.3s         |
| 100/8/dense   | 3cold+7warm       | 2100                  | 5300                    | 52.0s         |
| 500/2/sparse  | 3cold+7warm       | 7500                  | n/a                     | 6.2m          |

The500-row case records warm ready-paint opportunities15.8–18.5seconds and broad Find2.78–3.56seconds. This development-build evidence justifies addressing scaling; it is not a production-build performance claim. Initial remaining matrix cases will use1cold+1warm to keep measurement windows bounded. No percentile or robust variance claims will be made from those limited samples. Budgets await the complete configuration matrix and first-slice review.

### Completed Linux matrix extension — 2026-09-08

The missing seven configurations were run separately from clean detached pre-optimization source
`93259b4321febfcd23e56705a007d32ef0acf595`. That commit preserves the measurement harness without
application optimization; the vanished pre-squash hash named above cannot be checked out, so it was
not guessed. Raw complete phase files are retained under
[`evidence/baseline-linux-i7`](evidence/baseline-linux-i7). Every accepted file reports clean source,
fixture SHA256 `4c143faa215b32010294252384a17cc0a9c5870b4b7f96f0692f289745b43155`,
Chromium153.0.8010.12, Linux7.0.11 x64, Intel i7-12800HX,1400×900, UTC/en-US, no
throttling, trace off and `measurementUse=baseline-limited`. Each latency case is1cold+1warm; no
percentile or variance claim is made.

| Configuration | Setup ms | Ready paint cold/warm ms | Broad Find cold/warm ms | Mounted cells | Style calls |
| ------------- | -------: | -----------------------: | ----------------------: | ------------: | ----------: |
| 500/2/dense   |   17,693 |            15,860/15,131 |             3,811/4,068 |         7,500 |      15,030 |
| 500/8/sparse  |   20,058 |            19,015/16,075 |             5,011/4,093 |        10,500 |      21,042 |
| 500/8/dense   |   31,224 |            19,438/19,084 |             4,798/5,045 |        10,500 |      21,042 |
| 1000/2/sparse |   12,267 |            50,547/59,420 |           13,368/14,711 |        15,000 |      30,030 |
| 1000/2/dense  |   59,350 |            61,873/60,804 |           15,940/15,596 |        15,000 |      30,030 |
| 1000/8/sparse |   58,135 |            57,340/56,522 |           14,926/14,896 |        21,000 |      42,042 |
| 1000/8/dense  |  101,540 |            59,060/60,752 |           15,556/15,738 |        21,000 |      42,042 |

All seven latency and coverage cases exited0. The four combined runs completed3/3 in3.1m
(500/2/dense),7.7m (500/8/sparse),9.1m (500/8/dense) and10.8m (1000/2/dense).
The separately run1000/8 latency cases passed in4.9m sparse and5.9m dense; coverage passed in3.0m
sparse and3.7m dense. Vite logged WebSocket `EPIPE`/`ECONNRESET` while measured pages closed; the
tests and required backend requests completed.

Open Gantt retained the same full-table mounted-cell counts. At500/8, unfolding all eight groups
raised10,500 folded cells to26,500; both sparse and dense cases recorded complete left/right
geometry. The1000/8 sparse Gantt stress reached its folded21,000-cell checkpoint, then the default
run failed on `Test timeout of 600000ms exceeded`. A diagnostic harness-only commit extended only
the overall ceiling; the unchanged workload then failed while clicking `Unfold Step 5 estimates`
on `locator.click: Timeout 120000ms exceeded` after11.6m. The partial files remain rejected. The
diagnostic change was removed and no dense duplicate was run: dependency density does not change
the column geometry, while repeating a known more-than-two-minute UI action would not complete the
required matrix observation. This bounded failure is the1,000-row unfolded stress observation.

The published fixed-viewport budgets follow the measured fault shape: old work grows linearly to
21,000 mounted cells and42,042 style calls while only450 cells intersect the folded viewport.
The independent DOM readings establish30 intersecting rows at1400×900 without Gantt. Every sampled
flat row is26.1875px high. A300px vertical overscan therefore admits at most
`ceil(300 / 26.1875) = 12` extra flat rows per side. One complete extra row is the active-editor
allowance: `30 + 12 + 12 = 54` ordinary mounted rows plus that separate complete row.

The folded eight-step fixture has21 columns, so its derived maximum is `54 × 21 + 21 = 1,155` cells,
rounded upward to the **1,200-cell** ceiling. The unfolded Gantt observation independently measured
384 intersecting cells across16 rows, hence24 intersecting columns. The narrowest scrolling data
column is32px;256px horizontal overscan admits at most8 columns per side. The ordinary viewport
maximum is `54 × (24 + 8 + 8) = 2,160` cells. The unfolded table has53 columns, so one complete
offscreen editor row raises that to2,213, rounded upward to the **2,250-cell** ceiling. A broad Find's
**2,250-call** ceiling deliberately permits every mounted cell to perform layout once; Task3.2's
two filter-sensitive cells per row are a stronger current observation, not an assumption the
structural budget needs in order to pass. All counts come from DOM intersections rather than a
virtualizer range and remain independent of total project rows.

The retained100-row Darwin samples observed input-paint opportunities through222.4ms; the **250ms**
ceiling rounds that measured fixed-viewport maximum upward by27.6ms. The **10s** ready-paint and
**5s** filter-completion ceilings are generous development-stack regression limits below roughly
one sixth of the worst ready-paint sample and one third of the worst broad-Find sample. They require
every optimized sample to pass; they are not averages or production claims. The Darwin/Chromium151 traced baseline
and Linux/Chromium153 trace-off baseline are separate protocols. Optimized samples may claim a
relative change only against a baseline rerun under their exact protocol and environment; either
protocol may independently demonstrate the absolute ceilings.

Independent review first refused this slice because the published ceilings lacked the explicit
overscan/editor arithmetic and because the proposal treated the two incompatible measurement
protocols as one comparison environment. After the corrections above, final re-review found no
Critical or Important issues and verified the arithmetic, the222.4ms source for250ms, direct DOM
intersection counts and limited-sample language. Its sole Minor finding was the stale eight-step
type/lint sentence corrected in the command summary above.

## Failure proof table

### Split-phase correctness execution

The first runtime attempt failed before tests: Playwright refused trace inside a describe group because it changes worker fixtures. The option now lives at file scope. The subsequent100/2/sparse run passed all three phases in17.6s: latency5.8s, coverage4.3s, Gantt3.2s. Parent checks could run concurrently; all emitted evidence is explicitly measurementUse=correctness-only and is not an accepted timing baseline.

Independent reads of the three JSON files confirmed complete status, exact stage lists (cold-context/warm-reload; precise-coverage; gantt-open), source35576d79 and the same exact fixture SHA256. They are preserved under evidence/correctness-phases. These files survive later Playwright test-results replacement. The previously observed omitted-flush and suppressed-write faults establish that the checkpoint writer can fail; this run establishes all three measurement phase callers actually persist their observations.

Next quiet-window proposal: latency /100rows /2steps /sparse only,3cold+7warm, first R10_BASELINE_TRACE=1 then0, R10_MEASUREMENT_USE=trace-characterization. Allow at most60seconds wall-clock per leg,120seconds total, including fresh stack startup/shutdown. Estimated20–40seconds per leg from the original repeated100-row case; this remains an estimate. Preserve each completed JSON before launching the next leg, require matching fixture hash/source, and keep source frozen between legs. An incomplete leg remains incomplete and cannot support an A/B conclusion. No such characterization has run yet.

### Interrupted 1000-row attempt and measurement protocol revision

The single1000/2/sparse case ran in a confirmed quiet window starting2026-09-06 13:52:26UTC. Backend setup verified in13.496s. It was deliberately interrupted before the six-minute wall deadline: exit130,1interrupted,5.7minutes test duration. By13:58:25UTC all reserved listeners were absent and the window was released. No measurements.json completed; this configuration remains unmeasured. Trace inspection located the interrupted stage: clearing selective Find before the separate coverage pass, after both timing sample operations had reached their final read. No trace-recovered timing values are accepted.

Canonical trace=retain-on-failure records during measurements; this attempt's browser trace was35,171,132bytes. Earlier timings are therefore traced development observations, not directly comparable with future trace-disabled samples. Their structural mounted counts remain direct DOM observations. The overhead itself is unmeasured. All earlier raw files lack an exact fixture hash and retain legacy status; do not infer that hash from the revised fixture.

The fixture now declares separate latency/coverage/Gantt cases for every configuration, defaults measurement tracing off, and enables it explicitly through R10_BASELINE_TRACE=1 for A/B characterization. Every checkpoint includes source HEAD, git status, SHA256 over the exact measurement files, phase, trace mode, environment and last completed stage. Each sample is flushed before later work; overall status remains running until the complete phase finishes. Partial files cannot claim a completed phase or configuration. Normal browser gates skip these36 exploratory cases; fixture correctness cases run normally.

Checkpoint tests first failed collection on the absent implementation, then passed2/2 in5.0s. Omitting the sample flush failed on expected cold-context/received setup. Suppressing the initial filesystem write error failed because the promise resolved instead of rejecting ENOENT. Both faults were restored before Proof comments were retained; restored2/2 passed3.1s. Scoped ESLint passed after import sorting and replacing empty fixture patterns. FE root typecheck passed for the phase split and evidence helper. Split phase browser execution and traced/trace-disabled A/B characterization remain pending; no revised latency measurements have been accepted.

Correctness runs used the canonical heavy lock, CI=1, E2E_PORT_SHIFT=2400 and `apps/fe-01/e2e/rendering-fixture.spec.ts`. Initial3/3 passed7.1s. All three guards were removed together:3/3 failed, exit1. The identity fault initially also intercepted later malformed estimate commands, producing an incidental route assertion; interception was narrowed to createWorkItem batches and this guard was removed alone for a clean repeated proof. Restored3/3 passed6.9s, exit0. Proof comments were written from the observed output. No performance samples were accepted during these runs; parent checks were active.

| Guard                     | Injected fault                                                               | Observed failure                                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP setup refusal        | Remove response.ok rejection                                                 | `rendering setup reports an actual backend refusal`: promise resolved to actual API `{error:"not_found",at:0,kind:"createWorkItem"}` instead of rejecting |
| Batch row identity        | Remove index/ref/id guard; actual successful create response has IDs removed | `rendering setup refuses a successful batch without its row identity`: expected missing row identity0, received downstream real setEstimate400 missing_id |
| Nonzero measurement frame | Remove positive area guard; actual frame display:none                        | `rendering measurement refuses a frame with no layout area`: promise resolved with width0/height0 instead of rejecting                                    |

Scoped ESLint of all three rendering fixture/spec files passed. `bunx tsc --build --force apps/fe-01/tsconfig.json` passed, including the latest geometry and fixture regression changes. An earlier attempt named a nonexistent tsconfig.root.json and exited TS5058; it compiled nothing and is not accepted type evidence. Correctness logs: `/private/tmp/r10-fixture-green.log`, `/private/tmp/r10-fixture-fault.log`, `/private/tmp/r10-fixture-identity-fault.log`, `/private/tmp/r10-fixture-restored.log`. Logs are local execution evidence, not portable artifacts; the observed failure table above is retained in the change.

## PR preservation check — 2026-09-07

The measurement plan, harness and evidence were moved without production changes onto
`change/measured-rendering-plan`, then rebased onto `origin/main` at `f5c919d2`. Fresh checks
under the repository-pinned Bun1.4.2 passed: `fe-01:typecheck`; `fe-01:lint`;
`tool-git-hooks:lint`; repository `format:check --all`; strict validation of this OpenSpec
change; and the five rendering evidence/fixture browser cases in11.9seconds.

The first two browser launches were refused before test collection because the execution
sandbox denied loopback binds while Bun reported `EADDRINUSE`. A minimal Bun server and
`curl`/`nc` reproduced that boundary. The identical locked command passed with local-network
permission; neither refused launch is test evidence.

The first install after the toolchain merge used the host's stale Bun1.3.14 and omitted
ESLint's nested Ajv6, so lint stopped before reading a source file. Bun1.4.2 reinstalled the
same lockfile with that dependency present. The first Playwright1.63 run then passed the two
non-browser cases and refused the other three before their bodies because Chromium revision
1243 was absent. Installing that revision made the unchanged five-case command pass; the
failed launch is dependency setup evidence, not a test failure.

## Skipped / pending

Final independent implementation review and OpenSpec validation remain pending. The original12 experiments are now36 separate opt-in phase cases that intentionally skip in normal browser gates. The two1000/8 baseline Gantt phases are bounded stress failures as recorded above, not complete baseline evidence files. In-app browser inspection was unavailable as recorded above. The final workspace gate's solver image smoke did not run because the chained Nx gate stopped first on the two explicitly recorded unrelated failures; no success is claimed for that smoke.

## 4.2 — active cells and offscreen navigation, 2026-09-08

The viewport now retains the focused cell's row and column outside both ordinary windows. The
same textarea/input node, its half-typed value, focus and selection survive programmatic scrolling
from one end of a100-row plan to the other and across an eight-step unfolded plan. Existing live
field behavior remains on that same node, so commit, Escape and refused-draft ownership do not gain
a virtualization-specific copy. A requested logical destination is pinned first, then focused only
after the committed grid contains it; Tab, arrows, command movement, Cmd+Enter and structural
focus intents all use that attachment boundary.

The first keyboard negative was vacuous because Playwright's `focus()` scrolled the last overscan
row into view, mounting its successor before the key arrived. The proof now calls DOM
`focus({preventScroll:true})`, checks the target is still absent, and only then presses Ctrl+J.
The two normal Chromium acceptance cases passed together in22.2s. The viewport pure suite passed
5/5 in0.58s, and the keyboard/live-editing group passed251/251 in56.65s. FE typecheck and scoped
ESLint passed; full gates remain Task5 work. Read-only dconf diagnostics and Vite WebSocket EPIPEs
after page closure were the only warnings.

### Failure proof table

| Check                                          | Injected fault                                          | Observed failure                                                |
| ---------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------- |
| Active row survives vertical eviction          | Remove the focused cell from pinned cells               | `Expected: "Row 0000 half-typed" · Error: element(s) not found` |
| Active column preserves node identity          | Remove the focused cell from pinned cells               | `Expected: true · Received: false`                              |
| Command movement crosses an unmounted boundary | Return false when the logical target is absent from DOM | `Expected: focused · Error: element(s) not found`               |
| A pinned column is not also omitted space      | Count a pinned offscreen column in the omitted width    | `afterPx: expected 100, received 200`                           |

All faults were removed before the restored browser and unit runs.

## 4.3 — viewport geometry, drag and alternate face, 2026-09-08

Measured row-height changes above the visible interval now adjust `scrollTop` after the replacement
spacer extent commits, retaining the same visible logical row and pixel offset. Frame-edge dragover
events advance one fixed Gantt-row step, causing new logical destinations to mount; the ordinary row
drop-zone handler then marks the newly reached row. Zebra parity and `aria-rowindex` use each entry's
full logical index, while `aria-rowcount` continues to name the complete filtered/expanded grid.
Pinned Name geometry stays fixed during horizontal window changes, and the card renderer remains
outside table windowing.

The four viewport acceptance cases passed together in31.8s. Focused browser preservation checks for
pinned columns, both stripe states in both palettes, and the mobile card surface passed6/6 in23.6s.
The viewport/drag/scroll-link unit group passed51/51 in11.04s. FE typecheck passed. Full gates remain
Task5 work; read-only dconf and page-close WebSocket EPIPE diagnostics were the only warnings.

### Failure proof table

| Check                                                 | Injected fault                           | Observed failure                                  |
| ----------------------------------------------------- | ---------------------------------------- | ------------------------------------------------- |
| Height growth above the viewport preserves its anchor | Remove the post-commit scroll adjustment | `Expected: > 2046 · Received: 2046`               |
| Edge dragging reaches a previously unmounted target   | Remove the frame dragover scroll path    | `Expected: visible · Error: element(s) not found` |
| ARIA position and parity use logical order            | Pass mounted sequence index to the row   | `aria-rowindex Expected: "101" · Received: "36"`  |

The first drag-test attempt used a guessed `Reorder 0001` label and timed out before reaching the
behavior; the fixture actually numbers its first row0010. The selector now identifies the first real
row handle, and the recorded fault comes only from the intended missing autoscroll path. All faults
were removed before the restored runs.

## 4.4 — complete Gantt against a windowed table, 2026-09-08

The scroll link now receives the viewport's complete logical row placement rather than enumerating
the table's mounted `<tr>` nodes. Table-to-chart and chart-to-table movement therefore address the
same logical index while the table remains windowed and the chart retains all100 labels. The
acceptance case crosses two mid-plan window boundaries in opposite directions, repeats after both
viewport dimensions change, measures the chart's28px row step, follows a label hover back to the
corresponding mounted table row, and downloads an SVG containing both the first and last logical
names.

The completed acceptance case passed in5.5s. The existing standalone-SVG geometry case and
keyboard-follow surface case passed2/2 in17.5s. The pure viewport and scroll-link suites passed27/27
in0.68s. FE typecheck and scoped ESLint passed. The initial bottom-edge version of the test was
correctly discarded: the chart and table have different viewport heights, so one can reach a later
first row at its maximum than the other can reproduce. Reachable mid-plan offsets now isolate the
link's logical-row contract.

### Failure proof table

| Check                                          | Injected fault                                                  | Observed failure                                          |
| ---------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| A windowed table links by complete logical row | Omit the complete placement and restore mounted-DOM enumeration | table index53, Gantt index0: `Expected: 53 · Received: 0` |

The fault was removed before the restored browser run.

## 3.2 — filter-sensitive cell rendering, 2026-09-08

Filter state no longer sits in every `PlanRowReadings`. Number and Name receive it through an
explicit cell provider, and a complete body-cell boundary now owns `<td>` attributes, layout and
content. Its comparator varies filter readings only for those two columns, and only asks Number
about filtering when that row can expand. Header layout and `FrameLayoutState` identities are
stable until their actual inputs change. A broad query that preserves all rows therefore performs
layout work only for Name on these flat fixtures; selective queries still replace the shown row
set normally.

The jsdom negative first failed on **60** layout calls for three rows. The finished five-case
render-cost suite passed in4.76s. After the final complete-cell and heading boundaries, the
broader filter/keyboard/cell/read-write group passed **314 tests** in two focused runs: **168**
in45.28s and **146** in77.71s. Chromium's production precise-coverage counter measured **200**
`flexibleCellStyle` calls for100 unchanged rows, down from the intermediate430 (Name, Number and
headings) and the measured pre-optimization3,030 for this15-column fixture.

A normal, non-opt-in Chromium gate now seeds100 rows and requires at most two filter-sensitive
cell calls per row. Its final run passed in10.3s after restoration. The optimized limited latency rerun
(Chromium153, Linux7.0.11, i7-12800HX,1400×900, UTC/en-US, no throttle, trace off) separately
recorded:

| Sample | Ready paint ms | Broad input/filter ms | Selective input/filter ms |
| ------ | -------------: | --------------------: | ------------------------: |
| cold   |        1,973.5 |          21.0 / 296.9 |               18.8 / 51.7 |
| warm   |        1,676.3 |          16.6 / 162.8 |               19.3 / 52.0 |

All are beneath the published10s ready,250ms input-paint and5s filter-completion ceilings. This
is one cold and one warm development-stack checkpoint, not a variance or production claim.

### Failure proof table

| Check                                                          | Injected fault                                                                       | Observed failure                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------- |
| Broad unchanged rows render no more than two filter cells each | Put `filtering` and `matched` back into the parent-wide `PlanRowReadings` projection | Chromium: `Expected: <= 200, Received: 3000` |

The fault was removed before the10.1s restored run. The host-specific heavy-lock wrapper was
unavailable because `/home/puni1/.cache` does not exist on this machine; all browser runs instead
used an owned stack at `E2E_PORT_SHIFT=2500`. Vite's socket-close `EPIPE` diagnostics appeared
after measured pages closed; tests and required requests completed.

## 3.1 — urgent Find ownership and deferred criteria, 2026-09-08

`PlanToolbar` now owns the text visible in Find. `useDeferredValue` publishes a lower-priority
query to `usePlanFilterState`, so an urgent keystroke rerenders the toolbar rather than the
component that constructs the table's cells. Applying and saving a named view uses the toolbar's
current text; counts, matches and no-match wording use the deferred criteria that produced them.
Facet criteria remain immediate and are now project-owned. Both deferred query and facets read as
empty as soon as a different project is rendered, and a deferred callback names its owner so a
late old-project effect is refused. The toolbar is keyed by project so its urgent text cannot
cross that boundary either.

The new project-switch case failed first on `expected 'skirting' to be ''`. With the split in
place, the complete filter and toolbar suites passed: **87 tests**,15.29s. Those suites include
facets, saved-view save/apply, peer row and directory updates, Escape, collapse overlays and
filtered exports. FE source typecheck, scoped ESLint and Prettier passed.

### Failure proof table

| Check                                  | Injected fault                     | Observed failure                                                                                     |
| -------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Urgent Find text cannot cross projects | Remove `PlanToolbar`'s project key | `a project switch cannot show or apply the previous project’s query`: `expected 'skirting' to be ''` |

The key was restored and the focused case passed. The existing read-only dconf diagnostics were
the only warnings; no test was skipped from the complete two-file run.

## 2.3 — committed logical editable grid, 2026-09-08

Every visible column now declares its row editability beside the control it renders. The full
filtered and expanded TanStack row order and the structurally visible column order produce
`CellRef`s independently of mounted inputs. `WbsTable` publishes that model in a layout effect,
after React has committed the corresponding surface; Tab, arrows, command movement and next-row
Name movement use it to choose a destination. `editable-grid.ts` now only attaches that chosen
cell to committed DOM. Mobile cards keep their existing focus attachment and do not wire grid
movement.

The pure ragged-grid case first failed collection because `logical-grid.ts` did not exist, then
passed. The complete keyboard suite plus the pure case passed: **96 tests**,53.89s. The existing
filtered-row production case, `the arrows walk the rows a search left on screen`, passed alone in
3.78s. FE source typecheck passed. Scoped ESLint and Prettier passed after removing an obsolete
`editableGrid` import and formatting the migrated handler.

### Failure proof table

| Check                                               | Injected fault                                                | Observed failure                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| A parent omits its non-rendered People-at-once cell | Declare that column editable for every row                    | `Shift+Tab steps over a parent’s read-only estimate boxes`: `expected true to be false` |
| DOM cannot extend logical navigation order          | Restore Tab's destination list from `editableGrid(container)` | `a stray committed input cannot extend the logical grid`: `expected false to be true`   |

Both faults were restored. The focused parent case and the complete keyboard suite were rerun
green. The warnings were the repository's existing read-only dconf and React `act` diagnostics;
neither run skipped a test.

## 2.2 — first explicit row-reading slice, 2026-09-08

`PlanRenderRow` now attaches immutable per-render readings recursively to every TanStack row.
The End and Slack cells take the printed finish and schedule-presence value from that row rather
than from the mutable `PlanLive` ref; chart input, on-screen export and toolbar contracts name the
richer row type. Event capabilities remain behind `PlanLive`. Task2.2 remains open until every
render-time cell dependency and stable component identity has moved.

The projection test first failed collection because `plan-render-rows` did not exist, then passed.
The first assertion incorrectly required parent-before-child evaluation and failed on
`expected [ 'child', 'root' ] to deeply equal [ 'root', 'child' ]`; evaluation order is not part
of the contract, so the test now checks the one-reading-per-row set and the preserved tree.

The production negative cached each explicit Finish by row id, omitting the date dependency while
leaving the two-row surface reachable. `a committed schedule reading reaches the peer’s End cell`
then failed at its intended assertion on `Expected element to have text content: 10 Sep / Received:
0 ?`; the stale cache was removed and the five peer/focus cases plus the projection and render-cost
cases passed (**9 tests**,9.96s). FE source typecheck passed. Scoped ESLint passed after its
import-sort fix; scoped Prettier passed. Full frontend/browser/workspace gates are deferred until
the complete2.2 slice.

## 2.1 — the row and cell dependency inventory and its regressions, 2026-09-08

Read at `4179515d`. The inventory is
[`row-dependency-inventory.md`](row-dependency-inventory.md): all **87** `PlanLiveValues`
fields, the seven kinds of dependency, which cell reads each one, whether it is per-row or
table-wide, and whether its identity is stable. Counted rather than claimed:
`awk '/^export interface PlanLiveValues/,/^}/' plan-live.ts | grep -cE '^  [a-zA-Z]+[?]?:'` → 87.

Two findings the inventory records and this slice does **not** act on, because it makes no
production change:

- **Five fields no cell reads** — `projectId`, `showSchedule`, `waitsFor`, `setExternalRefsOf`
  and `armedDelete`. Verified with `grep -rn "current\.<field>" plan-columns/ plan-cell-props.ts`,
  which returns 0 lines for each. Three have a non-cell reader (the row shell, the refs modal,
  the cards), one is internal to `spanOf`, and `projectId` has no reader at all. Task 2.2 owns
  the removals, each with its own compiler proof.
- **The Start sentence and the Depends list are read twice per render on two independent
  paths** — the `<td>` props builder outside the column registry (`plan-cell-props.ts:82,105,117`
  and `:217`) and the cell body (`depends.tsx:30`, `start.tsx:19`). Explicit render inputs have
  to feed both.

The regressions are `apps/fe-01/src/components/wbs/plan-row-dependencies.test.tsx`: four cases,
each landing a **peer's** write through the subscription while this reader's Name editor on
another row is open, focused and half-typed. The peer's value is asserted first and the untouched
editor second — the other order is satisfied by the render before the answer arrives.
`TZ=UTC bunx vitest run src/components/wbs/plan-row-dependencies.test.tsx`: **4 passed**, 8.4s.
`bunx eslint` on the file and `bunx tsc --build --force apps/fe-01/tsconfig.json`: both clean.

### Failure proof table

The injected fault is the shape a missed row dependency has: `useTable`'s `data` handed a copy
reused for as long as the row **count** holds, so the two-row setup still works and only the
peer's edit is lost. The first form of it — the rows pinned from the first render — was watched
**passing nothing**: it pinned the _empty_ tree, so the setup never found `Name of 010` and all
four cases failed at the locator instead of at their assertion. A fault that takes the surface out
of the test's reach is not evidence about the assertion, so it was replaced.

| Case                                       | Injected fault                        | Observed failure                                               |
| ------------------------------------------ | ------------------------------------- | -------------------------------------------------------------- |
| a committed name reaches the peer's row    | rows reused while the row count holds | `expected '' to be 'Renamed by a peer'`                        |
| a committed day, on both of its read paths | the same                              | `expected '—' to be '9 Sep'`                                   |
| a committed estimate reaches the figure    | the same                              | `expected '' to be '2/3/10'`                                   |
| a directory entry a peer created           | the same                              | `Unable to find role="button" and name "Remove Platform team"` |
| a directory entry a peer created           | `teams` pinned to the first render    | the same failure — the cell reads both, and both are covered   |

All faults were restored (`git diff` on `wbs-table.tsx` empty) and the four cases re-run green.

## 2.2, first part — the contract loses what nobody reads, 2026-09-08

Task 2.2 stays **open**: stable cell component identities and explicit per-row render inputs are
not here. What is here is the two things 2.1's inventory found, so that the explicit inputs are
written against a contract that says only what a cell actually reads.

**Six fields left `PlanLiveValues`** — `projectId`, `showSchedule`, `waitsFor`,
`setExternalRefsOf`, `armedDelete` and `startFloor`. The first five were read by no cell
(`grep -rn "current\.<field>" plan-columns/ plan-cell-props.ts` → 0 lines each); three keep a
non-cell reader as a local (the row shell, the refs modal, the cards), one was internal to
`spanOf`, and `projectId` had no reader at all. `startFloor` had exactly one cell-side reader,
`readStartSentence`, and loses it below. **87 fields → 82.** The contract is compiler-enforced,
so a missed reader is a type error rather than a runtime `undefined`; `bunx tsc --build --force
apps/fe-01/tsconfig.json` is clean and `nx run fe-01:test` is green over the whole table.

**The Start sentence is worked out once per row per render.** Three readers asked for it — the
`<td>`'s props (`startCellProps`), the `cursor: help` decided beside them, and the Start cell —
and each call allocated a `Date` inside `spanOf` and walked the floor map. `readStartSentence` is
a pure function of `(row, spanOf, startFloor)` now, `WbsTable` holds a per-render `Map` in front
of it, and both the `<td>` builder and the cell read the one answer through
`live.current.startSentence`.

### Failure proof table

| Check                                                                 | Injected fault                                   | Observed failure     |
| --------------------------------------------------------------------- | ------------------------------------------------ | -------------------- |
| `works the Start sentence out once per row, however many readers ask` | `saidByRow`'s lookup bypassed in `wbs-table.tsx` | `expected 9 to be 3` |

The count is a **rate**, not a pin: the case reads the rows and columns off the DOM, divides the
`flexibleCellStyle` calls by `(rows + 1) × columns` to learn how many renders the gesture actually
cost, and asserts one sentence per row per render. A pinned number would have to be re-guessed
every time a column is added, and would pass for the wrong reason the first time one was.

## 2.2, second part — the two scans of the whole plan that ran per cell, 2026-09-08

Still not 2.2 itself. Two of the per-row readings the inventory listed as "no per-row cache"
were worse than that: each was a scan of **every row on the plan**, run once per cell.

- `dependenciesOf(ids)` did `flat.find` per dependency id, and every Depends on cell calls it
  once per render. Rows × dependencies × rows per render — eight million comparisons to draw one
  column on a thousand-row plan whose rows wait for eight others.
- `anyAssigneeOn(stepId)` did `flat.some(...)`, and every **folded step cell** calls it. Rows ×
  steps × rows per render, to decide whether the column reserves an assignee slot.

Both are one pass per tree read now, through `plan-indexes.ts`: `indexRowsById(flat)` and
`assignedSteps(flat)`, each behind a `useMemo` on `flat`. They live in a module of their own
rather than in the hooks that use them, and that is load-bearing for the check below —
`vi.mock` replaces a module's exports for its **importers**, so a pure function called from
inside the file that declares it cannot be counted. The first form of this check mocked
`./use-plan-dependencies` and `./use-reference-sets`, and the counter never moved.

`assignedSteps` returns `{ everyStep, named }` rather than a bare set, because `doesEveryStep`
staffs a step **no row lists by id** — a set of named steps alone would answer `false` for it.

### Failure proof table

| Check                                                               | Injected fault                                                       | Observed failure      |
| ------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------- |
| `rebuilds no index over the plan for a gesture that changes no row` | `indexRowsById`'s `useMemo` dropped, rebuilt inside `dependenciesOf` | `expected 1 to be +0` |
| the same case                                                       | `assignedSteps`' `useMemo` dropped, rebuilt inside `anyAssigneeOn`   | `expected 8 to be +0` |

Two things the case had to be given before either fault could reach it, and both were watched
failing at the **wired-check** rather than at the assertion first:

- The plan needs a **dependency**. With none, `dependenciesOf` maps over an empty list and the
  faulted rebuild inside it is never reached, so `toBe(0)` was true for the wrong reason. The
  fixture adds one through `api.addDependency`; setting `row.dependsOn` on the view does not
  work, because the fake derives that field from its own edge list.
- The Depends on column has to be **on screen**; it is not in the default set.

Each case asserts the counter moved during setup before asserting it is still zero after the
gesture. Without that, a mock that never ran satisfies the assertion.

## 2.2, third part — the directory lookups behind the two markers, 2026-09-08

`indexById(items)` joins `plan-indexes.ts`, and the three lookups `useReferenceSets` already
built by hand use it. `usePlanAssignments` — a separate hook with its own arguments — gains its
own three, and the two markers stop scanning a directory per row: `nonOwnerNoteOf` did
`services.find` per unowned service, `assigneeOn` did `people.find` per call (once per step per
row), and `teamNamesOn`, which both of them call, did `teams.find` per team on the row.

### Failure proof table

| Injected fault                           | Observed failure      |
| ---------------------------------------- | --------------------- |
| `teamsById` rebuilt inside `teamNamesOn` | `expected 2 to be +0` |

**Two forms of that fault were watched passing first, and both are the same mistake: injecting
where the code does not go.** The first put `indexById(teams)` inside `teamNamesOn`'s `.map`
callback — a plan whose rows carry no team maps over an empty list, so the rebuild was never
reached. The second moved it out of the map but left the fixture with nobody assigned, and
`teamNamesOn` is only ever called from inside the two markers, both of which return before it on
a plan nobody is named on. The fixture now assigns a person through `api.addPerson` and
`api.assignPerson`, and the fault is hoisted above the map.

### Still open in 2.2

`spanOf(row)` is called three times per row per render — the Start cell, the Finish cell, and
once inside the Start sentence — and allocates a `Date` and two `printedDay` calls each time. It
is not memoised here: the per-render `Map` that would do it has to live where `spanOf` is built,
and the counting seam for its negative does not exist yet. Named so the next slice does not have
to find it again. The three `effective*LabelOf` readings are called once per row and allocate two
arrays each; that is a per-row cost 2.2's explicit render inputs are meant to own, not another
memo.

## 2.2, fourth part — one row, one span, 2026-09-08

The last of the repeated per-row readings named in the inventory. `spanOf(row)` was worked out
three times per row per render — the Start cell, the Finish cell and the Start sentence — and
each call allocated a `Date` and two `printedDay`s.

`spanOfRow(row, showSchedule)` is a pure function in `plan-span.ts` now, `usePlanSchedule`'s
`spanOf` calls it, and `WbsTable` holds the same kind of per-render `Map` in front of it that the
sentence already had. The chart keeps the **unmemoised** `spanOf`: it lays out in a `useMemo` of
its own and may render on a commit this map was not rebuilt for. One side effect is a small
consistency gain — `today` is now one moment per row per render rather than one per reader.

The module is not decoration. `spanOfRow` first lived beside `usePlanSchedule` in
`plan-chart-input.ts`, and the check was watched failing on `expected +0 to be 3`: `vi.mock`
replaces a module's exports for its **importers**, so the hook's call to a function declared in
its own file was invisible. That is the third time this session; it is now a rule for this
change — **a pure function that has to be counted lives in a module of its own.**

### Failure proof table

| Check                                                                 | Injected fault                | Observed failure     |
| --------------------------------------------------------------------- | ----------------------------- | -------------------- |
| `works the Start sentence out once per row, however many readers ask` | `spanByRow`'s lookup bypassed | `expected 9 to be 3` |

### What 2.2 still owes

Its headline, and only its headline: explicit per-row render inputs and stable cell component
identities. Every repeated reading the inventory named is now one per row per render or one per
tree read; what is left is the contract change itself, which is where the `columns`-memo landmine
and the `live` ref actually get replaced.

## 2.2, fifth part — the open cell card leaves the table still, 2026-09-08

The five cardable cells now subscribe to `CellCards` for their own boolean reading. The two
`<td>` attributes that also depend on that reading live in `PlanCell`; `WbsTable` does not
subscribe. Moving the pointer onto a folded estimate therefore renders the card and its cell
shell without reconstructing any unrelated row or heading.

### Failure proof table

| Check                                                     | Injected fault                             | Observed failure       |
| --------------------------------------------------------- | ------------------------------------------ | ---------------------- |
| `opens one cell card without rendering any unrelated row` | `WbsTable` subscribed to `cellCards` again | `expected 60 to be +0` |

The check first proves its `flexibleCellStyle` counter moved during setup, then resets it and
opens a real folded estimate card through the production pointer path. The tooltip assertion
makes the tested window explicit; a zero from a hover that opened nothing cannot satisfy it.

## 2.2, sixth part — explicit row readings and stable cell identities, 2026-09-08

Every value a table cell renders outside its `TreeRow` is now attached as a typed
`PlanRowReadings` projection. `PlanLive` retains event capabilities and the three external stores;
the column family has no render-time getter through the ref. Estimate readings are discriminated
by folded/unfolded layout, and missing visible-step or mismatched-layout values throw rather than
becoming empty UI. Hidden steps are not projected.

The projection is memoised from its complete input list. `PlanCellContent` is a stable memo
boundary comparing the explicit row identity plus the two TanStack expansion readings used by
Number. The Start sentence is the sole cyclic input: its Gantt floor is computed after TanStack's
shown-row model exists, so it crosses the same boundary through `StartSentenceProvider` rather
than returning to `PlanLive`. Each Start row now asks for the sentence once, not three times.

### Failure proof table

| Check                                                                   | Injected fault                                               | Observed failure                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------- |
| `keeps explicit unchanged cells behind their stable component boundary` | replace memoised `PlanCellContent` with its view             | `expected 4 to be +0`                                           |
| unchanged row projection rebuilds no spans                              | add toolbar-only `freezeMenuOpen` to projection dependencies | `expected 3 to be +0`                                           |
| Start cannot render without its explicit late Gantt reading             | omit `StartSentenceProvider` at the production cell boundary | `Start cell rendered without its sentence`; Name 010 was absent |

Fresh focused verification:

- Explicit boundary, estimates, dependency peer update, focus/read-write, cell and layout suites:
  **6 files / 299 tests passed**, 84.94s.
- Estimate/dependency/read-write subset before the late Start input moved:
  **4 files / 125 tests passed**, 36.09s.
- `bunx nx typecheck fe-01`: passed. Nx used its documented in-process plugin fallback because
  this sandbox denies its worker socket.
- Scoped ESLint and Prettier: passed after import sorting.

Fresh verification on this branch:

- `TZ=UTC bunx vitest run src/components/wbs/plan-row-render-cost.test.tsx
--no-file-parallelism --maxWorkers=1`, from `apps/fe-01`: **3 passed**, 4.45s. The sandbox
  emitted its existing read-only dconf warnings and Vite's existing native-config warning.
- `TZ=UTC bunx vitest run --no-file-parallelism --maxWorkers=1`, from `apps/fe-01`:
  **98 files / 2522 tests passed**, 382.30s. Run outside the socket-restricted sandbox after
  the sandboxed wrapper stranded with no remaining Vitest process; Vite emitted the existing
  native-config warning.
- `TZ=Pacific/Auckland bunx vitest run --config vitest.zoned.config.ts
--no-file-parallelism --maxWorkers=1`, from `apps/fe-01`: **2 files / 3 tests passed**, 3.51s.
  Vite emitted the existing native-config warnings.
- `CI=1 E2E_PORT_SHIFT=1900 bunx playwright test --config
apps/fe-01/playwright.config.ts apps/fe-01/e2e/hover-cards.spec.ts`, under
  `with_heavy_lock /tmp/wbs-r10-heavy-work.lock`: **28 passed**, 1.6m, on this checkout's
  5000/5100/6100 stack. The production `bin/with-heavy-lock.sh` wrapper was unavailable in this
  container because its Linux path is `/home/puni1/.cache`, which does not exist for user `df`;
  the same lock library's explicit-path seam provided the mutex. Vite logged closed-page WebSocket
  proxy `EPIPE`s between passing cases; no assertion failed.

## 4.1 — measured viewport intervals, 2026-09-08

`usePlanViewport` owns the table frame's scroll rectangle,300px vertical and256px horizontal
overscan, and a measured height map. Rows begin at the baseline's26.1875px and replace it with
their attached `<tr>` height through one `ResizeObserver`. Spacer rows retain the complete vertical
extent. Scrolling columns retain all four pinned identity columns; contiguous omitted runs become
`colSpan` spacers against the unchanged complete `<colgroup>`, so native table width and sticky
offsets still have one source.

The interval module first failed collection because `plan-viewport.ts` did not exist, then passed
**3 tests** covering a variable-height row interval, the unmeasured estimate and a horizontally
scrolled interval with pinned columns. Column windowing stays dormant where no real frame geometry
exists, so jsdom keeps its full deterministic table; the keyboard/cell/read-write group passed
**247 tests** in88.19s and the layout/filter/render-cost/interval group passed **143 tests** in
49.59s. `fe-01:typecheck` passed through Nx's documented in-process sandbox fallback.

Two normal Chromium cases count actual `[data-column]` cells through `renderingGeometry`, not the
interval's answer. The100-row folded case traversed from first to last row within the1,200-cell
ceiling; the100-row eight-step case unfolded all groups, observed Actions absent at the left edge,
scrolled right until they mounted, and stayed within2,250 cells at both edges. The restored pair
passed in19.1s. Vite emitted the existing closed-page WebSocket `EPIPE`/`ECONNRESET` noise after
passing assertions.

### Failure proof table

| Check                                            | Injected fault                       | Observed failure                    |
| ------------------------------------------------ | ------------------------------------ | ----------------------------------- |
| folded cells stay within the independent budget  | render all100 shown rows             | `Expected: <= 1200, Received: 1500` |
| an offscreen unfolded column is initially absent | mount every leaf column in every row | `Expected: 0, Received: 43`         |

## 4.5 — optimized Chromium matrix, 2026-09-08

The complete optimized Linux/i7 matrix is retained in `evidence/optimized-linux-i7/`: all36
row/step/density/phase combinations, one cold-context and one warm-reload latency sample per
configuration, one precise-coverage sample, and one Gantt sample. The run also included the five
normal acceptance cases in this file: **41 passed in21.3minutes**. Every JSON says `complete`; a
single slurped `jq -e` assertion over all36 files returned `true` for every budget.

| Maximum across the optimized matrix  |  Observed |  Ceiling |
| ------------------------------------ | --------: | -------: |
| cold/warm ready paint                | 1,804.1ms | 10,000ms |
| broad Find input paint               |   115.4ms |    250ms |
| broad Find settled filter paint      |   229.9ms |  5,000ms |
| broad Find `flexibleCellStyle` calls |        86 |    2,250 |
| folded mounted cells                 |       688 |    1,200 |
| eight-step unfolded mounted cells    |       840 |    2,250 |

The retained same-host baseline has matching evidence for18 of those36 phase/configuration cases.
Its maxima were61,873.1ms ready paint,15,940ms broad-input paint,42,042 cell-style calls,21,000
folded cells and26,500 unfolded Gantt cells. Exact matched examples are more honest than an
aggregate percentage: the1,000-row/two-step/dense latency case moved from61,873.1ms and15,940ms
to1,659.7ms and98.8ms; its folded cells moved from15,000 to645. The1,000-row/eight-step/dense
coverage pass moved from42,042 calls to86, and its latency mount moved from21,000 cells to688.

This is a development-stack result, not a production percentile. Fixture setup remains excluded
and is now the dominant cost (the1,000-row/eight-step/dense fixtures took118–122seconds each),
while complete Gantt labels and SVG export intentionally remain proportional to logical plan size.
The table trades full-DOM browser findability for logical accessibility metadata and explicit
mount-on-navigation; the active editor is the only complete row allowed outside the viewport.
The evidence records source head `067d9f2d` plus the measurement-spec-only dirty status and exact
fixture hash `14ecabb8…`: the harness had to stop treating complete logical rows as mounted rows.

### Failure proof table

| Check                      | Injected fault                                       | Observed failure                         |
| -------------------------- | ---------------------------------------------------- | ---------------------------------------- |
| fixed-viewport cell budget | restore all100 shown rows                            | `Expected: <= 1200, Received: 1500`      |
| logical readiness observer | wait for `rows + 2` instead of the grid's `rows + 1` | `table readiness paint was not observed` |

The full-mount fault is the same production browser run recorded under4.1: it was performed after
windowing landed and is the deliberate negative4.5 asks for, so it was not repeated merely to
manufacture a second identical failure. The readiness proof guards the optimized harness change;
the repaired100-row/two-step/sparse smoke then passed with cold and warm samples before the matrix
was trusted.

## 5.1–5.2 — frozen integration verification, 2026-09-08

Two integration regressions surfaced only in the complete frontend run. Attaching immutable row
readings replaced TanStack row wrappers, so the Gantt recomputed for a toolbar-only commit even
though its structural rows had not changed. `useShownPlanRows` now retains the committed chart row
array while the projected wrappers' source rows, depth and leaf state are unchanged. The late Start
sentence is memoised from its schedule maps after chart projection, so a Freeze-numbering commit
does not recalculate it. Three DOM-free pure suites newly created by R10 are also named in
`vitest.node-suites.ts`; the test-tier guard can now see them.

The three complete-browser failures from the first integration run were fixture assumptions exposed
by honest windowing, not product failures. Gantt and earliest-start fixtures now scroll the target's
persistent heading before asking for the windowed body cell. The platform-toolbar width budget is
1268.5px, rounded from the shipped bar's measured1268.46875px; giving the two folded controls their
text labels back measured1427.21875px and failed the ceiling.

### Fresh checks on the frozen source

- `bunx nx format:check --all`: passed.
- `bunx nx run-many -t lint typecheck --projects=fe-01 --skip-nx-cache`: passed both targets in
  37.9s. Nx used its documented in-process plugin fallback because the sandbox denied its worker
  socket.
- `bunx nx test fe-01 --skip-nx-cache`: the main suite passed **101 files / 2534 tests** in357.81s;
  the Pacific/Auckland suite passed **2 files / 3 tests**. Nx completed successfully in6m01s.
- `CI=1 E2E_PORT_SHIFT=2500 bunx playwright test --config
apps/fe-01/playwright.config.ts`, under `with_heavy_lock
/tmp/wbs-r10-heavy-work.lock`: **305 passed / 37 intentional opt-in measurement skips / 0
  failed** in22.0m, Chromium153, one worker and zero retries. This includes the shared CSS,
  keyboard, names/references, hover, drag, mobile, marker, Gantt and viewport cases. The production
  lock wrapper remained unavailable because this host has no `/home/puni1/.cache`; the lock
  library's explicit-path seam held the same mutex contract. Vite logged page-close WebSocket
  `EPIPE`/`ECONNRESET` diagnostics between passing cases.
- Frozen workspace command: `bunx nx format:check --all && bunx nx run-many -t test lint typecheck
build --parallel=2 --skip-nx-cache && WBS_RUN_SOLVER_ORPHAN_PROC=1 bunx nx run
be-01:solver-image-smoke`. The formatting leg passed. Nx completed **86/88 targets** in7m02s;
  every frontend target, including its full test suite, passed. `solver-py:test` failed at import
  with ten errors because this host's Python lacks `ortools` and `jsonschema`. `gw-01:test` retained
  three five-second socket integration timeouts. Because the command is chained, the solver-image
  smoke did not run.
- The gateway ownership diagnostic used a detached `origin/main` worktree at `5b7fc983` and ran
  `bun test src/request-deadline.integration.test.ts`: the identical six cases passed and the same
  three cases timed out in19.54s. No gateway source differs on this branch, so those timeouts
  predate R10 rather than being waived branch regressions.
- Focused `solver-py:test` repeated the ten import errors in5.7s: `ModuleNotFoundError: No module
named 'ortools'` and `ModuleNotFoundError: No module named 'jsonschema'`. This is unavailable host
  setup, not accepted solver test evidence.

### Integration failure proof table

| Check                                                    | Injected fault                                                                     | Observed failure                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------- |
| chart input survives reading-only wrapper changes        | return the freshly projected row array instead of retaining structural source rows | `expected 1 to be +0`                        |
| toolbar-only commits do not recalculate Start sentences  | add a fresh object to the Start-sentence memo dependencies                         | `expected 6 to be +0`                        |
| the folded toolbar stays inside its shipped width budget | restore `Expand all` and `Collapse all` text labels                                | `Expected: <= 1268.5 · Received: 1427.21875` |

All three faults were removed before the focused, complete frontend and complete Chromium runs.
The exact first two outputs are retained in adjacent `Proof:` comments on their production-path
tests; the width proof is adjacent to the browser assertion.

## 4.2 review closure — evicted editor outcomes, 2026-09-08

The independent implementation review found that node/selection retention and logical navigation
did not directly prove what happens when an editor is left after its row has crossed the viewport
window. A real-browser case now exercises all three outcomes on the first row of a100-row plan:
the Name commits after scrolling to the last row and survives reload; an earliest-start edit is
abandoned with Escape while its row is outside the ordinary window; and a priority be-01 refuses
is restored when that cell remounts. The refusal arm waits for and inspects the real
`POST …/commands` answer before asserting the toast and remounted value, so it cannot pass before
the round trip it describes.

- Focused Chromium after restoration: **1 passed**,13.1s.
- With `heldRefusals.set(this.cellKey, text)` deleted from the production landing path, the same
  case failed after the refused cell remounted on `Expected: "0" · Received: "50"`.
- The write was restored and the same case passed again: **1 passed**,13.1s.

The first attempted refusal used a work-item name made only of spaces. The live backend accepted
that patch and answered `{"results":[{"index":0}],…}`; that premise was removed rather than
turning a successful write into a counterfeit refusal. Priority zero is already a modeled
work-item refusal and exercises the shared `LiveField` retention path the task is about.

## 5.2 provisioned local-gate diagnosis, 2026-09-08

This host initially ran Bun1.4.0 although `.bun-version` pins1.4.2, and its Python3.14 environment
lacked the solver packages. A temporary Python3.14.7 environment was installed from the
hash-verified `requirements.lock`; `solver-py:test` then passed **202 tests** in34.135s. A temporary
Bun1.4.2 executable was placed first on `PATH`; under that actual child runtime `gw-01:test` passed
**123 tests / 0 failed** in4.04s, including the three request-deadline cases that consistently
timed out under1.4.0.

The whole frontend suite on this workstation still exceeded five-second per-test budgets in five
files after hundreds of preceding cases (**2528 passed / 6 failed**). The six reported cases were
then run together as the only selected cases and all passed in13.46s; the single deterministic
style assertion passed alone in2.96s. This is diagnostic evidence, not a gate waiver: task5.2
stays open until the canonical provisioned host runs the complete frozen command and image smoke.

The image leg was also run independently with Bun1.4.2 and
`WBS_RUN_SOLVER_ORPHAN_PROC=1`: `be-01:solver-image-smoke` built the pinned Bun/Python image,
authenticated and bound the solver supervisor, and passed **3 tests / 0 failed** across the
real-Docker orphan and lifecycle suites in1m05s. The canonical combined gate remains required;
this result closes only the image-smoke evidence that the earlier chained command never reached.

## 5.2–5.3 — canonical integration and final review, 2026-09-08

GitHub Actions run
[`34249944955`](https://github.com/Prosperous-Unification/wbs-tool-v1/actions/runs/34249944955)
tested PR #353's exact implementation head `4c2c3b1e7d8868f8a6e8505f25202d3ef47965c0` on the
canonical provisioned runners. The workspace `gate` passed in13m42s, all four Chromium pixel
shards passed (12m45s,11m44s,5m14s and4m33s), and their aggregate passed. This supersedes the
workstation-pressure diagnosis above: the required complete frozen command, solver dependencies,
solver image smoke and browser coverage all ran successfully in the repository's own gate.

Independent final review found no Critical or Important issues. It initially reopened4.2 because
the existing browser coverage did not directly exercise editor outcomes after viewport eviction;
the direct commit, Escape and refused-draft-remount case above closed that finding. The reviewer
then confirmed that the new Chromium case fully covers the task and reported no remaining blocker.

### Final verification scorecard

| Dimension    | Result | Evidence                                                                                 |
| ------------ | ------ | ---------------------------------------------------------------------------------------- |
| Completeness | 17/17  | Every ordered task is checked; the direct4.2 closure and canonical5.2 gate are recorded. |
| Correctness  | 5/5    | All five delta-spec requirements and all seven scenarios have production-path evidence.  |
| Coherence    | Pass   | Implementation follows the design's row readings, logical identity and bounded windows.  |

The documentation-only closure commit is subject to the same PR checks before the authorized
merge. No implementation or evidence artifact changes after the exact implementation head above.
