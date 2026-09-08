## Status

R10 starts from the pre-optimization source preserved by93259b43. Approved refactoring plan§67R10 is authority. The complete latency/render-count matrix and bounded Gantt stress observations are measured below. Budgets are now published in proposal.md; independent review remains pending.

Locked Bun install passed after sandbox temp/cache permission escalation (102packages,1.95s). Browser skill was read and runtime initialized; `agent.browsers.get("iab")` reported unavailable and documented discovery returned an empty list. Interactive in-app browser is unavailable. Parent confirmed canonical Playwright Chromium is appropriate for repeatable measurements. Measurement ports5500/5600/6600 are assigned to this worker, subject to actual listener verification. Parent must grant a quiet heavy-check window before timed runs.

## Commands and measurements

`bun run dev:setup` passed, using repository example configuration. No private environment was copied. FE root typecheck passed after correcting dataset index access; fixture ESLint passed after correcting numeric template interpolation and unknown JSON boundary typing. The later eight-step geometry addition still needs types/lint.

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
Budgets allow explicit overscan and a pinned editor but remain independent of total project rows.
Latency ceilings are generous development-stack regression limits below roughly one sixth of the
worst ready-paint sample and one third of the worst broad-Find sample. They require every optimized
sample to pass; they are not averages or production claims.

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

Optimization, structural/latency gates, full workspace/Chromium gates and independent review remain pending. The original12 experiments are now36 separate opt-in phase cases that intentionally skip in normal browser gates; future acceptance tests must run normally. The two1000/8 Gantt phases are bounded stress failures as recorded above, not complete evidence files. In-app browser inspection unavailable as recorded above.

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
