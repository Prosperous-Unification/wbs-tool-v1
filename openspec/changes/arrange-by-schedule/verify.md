# Verify

Implementation landed 2026-09-11 on `docs/arrange-by-schedule-design`. Commands and
measurements below are this machine's (macOS, Chromium via Playwright); CI is the gate.

## Commands

| Command                                                                          | Result                                   |
| -------------------------------------------------------------------------------- | ---------------------------------------- |
| `bunx nx run-many -t test lint typecheck -p domain`                              | pass — 640 tests                         |
| `bunx nx run-many -t test lint typecheck -p core`                                | pass — 410 tests                         |
| `bunx nx run-many -t test lint typecheck -p contracts store-sqlite store-memory` | pass — contracts 378, store-sqlite 653   |
| `bunx nx run-many -t lint typecheck -p fe-01`                                    | pass                                     |
| `bunx nx run-many -t test lint typecheck -p mcp-01`                              | pass — after the arity pin below         |
| `bunx vitest run --root apps/fe-01`                                              | 2606 pass / 11 fail — **equal to main**  |
| `bunx nx run be-01:test`                                                         | 1035 pass / 0 fail, exit 1 — **as main** |
| `E2E_PORT_SHIFT=1900 bunx nx run fe-01:e2e` (new spec)                           | 4 passed                                 |
| `E2E_PORT_SHIFT=1900` … both toolbar budgets                                     | 2 passed                                 |
| `E2E_PORT_SHIFT=1900 bunx nx run fe-01:e2e` (whole gate, run 1)                  | 334 passed / 2 failed → both re-measured |
| `…` (whole gate, run 2)                                                          | 335 passed / 1 failed — a flake, below   |
| `…` (whole gate, run 3)                                                          | **336 passed / 0 failed**                |
| `OPENSPEC_TELEMETRY=0 openspec validate arrange-by-schedule --json`              | `"valid": true`                          |

### The two results that are not green, and why they are not this change's

Both were measured on `origin/main` in a throwaway worktree before being accepted.

- **fe-01, 11 failing tests in 4 files** — `plan-mermaid`, `short-date`, `deadline-copy`,
  `test-tiers`. Identical set and count on main. Timezone (this box is UTC+3) and tier
  bookkeeping.
- **`be-01:test` exits 1 with 0 failures** — two `DrizzleQueryError`s between tests, on
  `solver_slot` and `solver_queue`, a teardown race. Same two on main, same exit code.

## Measurements

| Figure                                                                    | Before       | With the control  | Pin                    |
| ------------------------------------------------------------------------- | ------------ | ----------------- | ---------------------- |
| folded toolbar, 1280×900 (`layout.spec.ts`)                               | 1552.73      | unchanged, passes | 1600                   |
| `[data-toolbar]` laid out, 1280 (`project-settings.spec.ts`)              | 1268.47      | **1303.27**       | 1303.5 (was 1268.5)    |
| `[data-toolbar]` laid out, 1280 with the cue (`optimization-cue.spec.ts`) | 1565.88      | **1600.67**       | 1601 (was 1566)        |
| toolbar rows at 1280                                                      | 2            | **2**             | 2                      |
| wrap window at which `Reset layout` adds a row (`gantt.spec.ts`)          | included 768 | **775–785**       | viewport 780 (was 768) |

**The second pin moved, and that is the one thing in this change a reader should look at.**
`project-settings.spec.ts` carried "a named margin for exactly one more control"; this is
that control, and it cost 34.77px. The row count — the figure `gantt.spec.ts:2605` depends
on — is unchanged at 2, so the bar wraps no further than it already did. The margin is now
spent: the next control to reach this bar has to take width from something.

Re-pinning a ceiling means re-proving the check under it. The recorded fault (two extra
labelled buttons) **no longer reaches this assertion** — the wider bar overshoots the looser
`BEFORE` pin first, `Expected: <= 1447.33 · Received: 1466.015625`. **One** extra labelled
button is the fault this pin is for, and it was watched failing on `Expected: <= 1305.5 ·
Received: 1369.96875`.

**Three measured constants moved, not one**, and the whole browser gate is what said so —
334 passed, 2 failed on the first full run, both about this bar. The third is the one worth
reading twice: `gantt.spec.ts`'s wrap case ran at a 768px viewport chosen because the bar
took a second row only once `Reset layout` joined it. With one more icon the bar is already
two rows at 768 before the drag, so the case could no longer observe the thing it exists
for — and its own non-vacuity guard caught that rather than passing quietly: `the toolbar
did not take a second row, so this is the 1400px case at a narrower window · Expected: > 104
· Received: 104`. Re-measured across 770–790 and moved to 780, in a window **ten pixels
wide**. One more control on this bar closes it.

## Failure proofs

Every row was watched failing with the fault in and green with it out.

| Check (file)                           | Fault injected                                              | Test that observed the failure                           | Result                                                                                    |
| -------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `derive-numbers.ts` label shortage     | `labelsFor` returns `labels.slice(1)`                       | `numbers roots in tens`                                  | `error: a sibling group of 3 ran out of labels` (11 fail)                                 |
| `derive-numbers.ts` skips held labels  | the `.filter((label) => !held.has(label))` dropped          | `never gives two siblings the same label`                | `run 1: 010, 050, 020, 030, 040, 050, 060 · Expected: 7 · Received: 6`                    |
| `tree-order.ts` id tie-break           | the `id` comparison deleted from `siblingGroupsOf`          | `answers the same order however the rows are handed`     | `Expected: [ "abe", "zed" ] · Received: [ "zed", "abe" ]`                                 |
| `tree-order.ts` `byTreeOrder` throw    | the throw replaced by `?? 0`                                | `refuses a row the order does not hold`                  | `Received function did not throw · [ { id: "stranger", … } ]`                             |
| `arrange-siblings.ts` stable tie       | `\|\| left.id.localeCompare(right.id)` appended             | `keeps the order two work items already read in`         | `Expected: [] · Received: [ { "id": "a", … } ]`                                           |
| `arrange-siblings.ts` `moved`          | `moved` filled from every placement                         | `names as moved only the work items whose place changed` | `Expected: [ 'last', 'middle' ] · Received: [ 'held', … ]`                                |
| `arrange-siblings.ts` missing start    | the throw replaced by `?? Infinity`                         | `refuses a work item the schedule has no start for`      | `did not throw · { placements: [], moved: [] }` — a silent no-op                          |
| `schedule.ts` `goesFirst` tree order   | `places` rebuilt by sorting `deriveNumbers` byte-wise       | `gives the person to the work item that reads first`     | `Expected - 2 · Received + 18`, `earliestStart: 2, boundBy: "person"` (629 pass / 2 fail) |
| `work-item.service.ts` no-op return    | `placements.length === 0` early return deleted              | `writes nothing at all when the plan already reads…`     | `Expected: 2 · Received: 3`                                                               |
| `work-item.ts` (sqlite) revision split | `bumping.has(…) ? … : {}` → unconditional bump              | `bumps the revision of moved rows only`                  | `Expected: 0 · Received: 1` (652 pass / 1 fail)                                           |
| `wbs-table.tsx` handler                | wired to `api.freezeProject`                                | e2e `puts the row whose bar starts first at the top`     | `Expected: ["Idle","First","Waits"] · Received: ["Waits","Idle","First"]`                 |
| `work-item.service.ts` read order      | `byTreeOrder(treeOrder(rows))` → the number-string sort     | e2e `moves a frozen row and leaves the number alone`     | fails in `arrangeAndSettle` — the rows never settle into arranged order                   |
| `project-settings.spec.ts` width pin   | one extra labelled toolbar button                           | `the toolbar keeps its 1280 budget`                      | `Expected: <= 1305.5 · Received: 1369.96875`                                              |
| `optimization-cue.spec.ts` width pin   | the cue's width widened to `44rem`                          | `lays the 1280 toolbar out inside its budget`            | `Expected: <= 1603 · Received: 2120.671875`                                               |
| `gantt.spec.ts` wrap viewport          | none needed — the case's own guard fired on the shipped bar | `re-measures the room when the toolbar wraps`            | `Expected: > 104 · Received: 104`                                                         |

- [x] Every check in this change has a row
- [x] Each negative test reaches the production call path
- [x] No row relies on an exit code

## One flake, characterised rather than assumed

`header.spec.ts` › `grows page links to phone touch targets only below the card breakpoint`
failed once, on `the larger phone targets make the page scroll sideways · Expected: 0 ·
Received: 25`, and once more in isolation. It is **not** this change:

| Run                                      | Result               |
| ---------------------------------------- | -------------------- |
| whole gate, run 1 (this branch)          | pass                 |
| whole gate, run 2 (this branch)          | **fail**, 25px       |
| isolated, this branch                    | fail once, then pass |
| isolated, this branch, `--repeat-each=5` | 5 / 5 pass           |
| isolated, `origin/main`                  | pass                 |

A probe that listed every element whose right edge passes the viewport, run at the moment of
the assertion, found **none** and reported `overflow=0`. The measurement is taken directly
after `setViewportSize`, so the likely mechanism is a resize the layout has not settled
after. Left alone rather than patched: it is a pre-existing race in a file this change does
not touch, and 25px with nothing overflowing is not a claim about the plan toolbar.

## The pin that caught what a by-name gate missed

`mcp-01:test` pins the number of command kinds the batch tool describes, "so a command kind
cannot arrive in be-01 without a model being told about it". It did exactly that here: the
change was run by name against `domain`, `core`, `contracts`, `store-sqlite`, `store-memory`
and `be-01`, all green, and `mcp-01` — which was not on that list — went red on `Expected
length: 36 · Received length: 37`. Bumped to 37, with `arrangeBySchedule`'s own
`describe` text as the thing the loop beneath it checks is readable.

This is `dual-optimized-scheduler`'s lesson repeating: run the projects you changed **by
name**, and remember that a generated surface is a project you changed.

## Three checks that could not fail, found and replaced

**1. The tie-break's planned negative (task 2.6).** Reversing `treeOrder` was meant to turn
the eight golden-corpus plans red. Watched **passing**, and so was the whole domain suite —
629 tests, every work item's place inverted. `goesFirst`'s sixth rule is reached only by two
slices tying on slack, deadline, priority, CPM start and float while competing for one
person, and no corpus plan holds such a pair; a consistent reversal is also still a total
order, so the determinism cases cannot see it either. R5 #28's lesson, second outing. Its
replacements are the new pair in `schedule-priority.test.ts` and the recategorised
`canonicalScheduleInput` case, both watched on `629 pass / 2 fail`.

**2. The fixed point (task 4.7).** Written over the corpus as authored, it passed for all
eight — and the non-vacuity case beside it said why: `Expected: > 0 · Received: 0`. Every
corpus plan is already written in schedule order, so the first press wrote nothing and the
property held over eight plans nobody had arranged. Each case now starts from its own plan
with every sibling group **reversed**, which is the state a reader actually presses the
control in. Nine cases, all green, and the non-vacuity assertion is kept.

**3. The browser bar measurement (task 6.2).** Two wrong oracles before the third worked.
`.first()` on a row's bars returns whichever the DOM holds first, which was a QA slice — it
made the top row look like the latest work in the plan (`[343, 203, 343]`). And the
measurement was taken **before the arrangement landed**, so it read the pre-press chart
twice with different answers (`[287.5, 203, 343]`, then `[344, 204, 204]`). The fix is a
settle-wait shared by every case and the **least** x across a row's bars.

## Fixed point (D10)

Eight corpus plans, each reversed, arranged, rescheduled through Fast over the new positions
and arranged again. Zero placements on the second press in all eight. No counterexample.

## Numbering drift (task 2.2)

**Not run.** The measurement of which live work items change number under the new rule wants
dev's database and has not been taken. Plans whose frozen labels ascend along position are
byte-identical, proved by the corpus and by every derive-numbers fixture; the population that
moves is work items holding a _fitted_ label (`0105`, `011` between two anchors), which
become the next free natural. **This must be measured and announced before a deploy**, as ADR
0016 did for the tie order.

## Not done

| Task                                              | Why                                                                                                |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 2.2 drift measurement                             | needs dev's database; see above                                                                    |
| 6.3 `e2e/keyboard.spec.ts` Alt+Up on a frozen row | jsdom covers it (`plan-keyboard.test.tsx`); the browser case is unwritten                          |
| 6.4 `e2e/hints.spec.ts` ring and fact             | the sweep in `hints.spec.ts` already covers "never both"; the wait case is unwritten               |
| 6.5 optimized plan with the local solver          | needs `bun run dev:local-solver`; deliberately not stubbed                                         |
| 8.1 whole-workspace gate                          | the browser gate ran; `bunx nx run-many -t test lint typecheck build` across every project has not |

## Decision

⚠️ **PASS WITH WARNINGS** — the feature is implemented, proved in a browser, and the whole
browser gate is green: **336 passed, 0 failed**, third run. Every project it touches is
green by name, including `mcp-01`. Three things are outstanding and none blocks review: the numbering
drift measurement (before deploy, not before merge), three unwritten browser cases, and the
whole-workspace gate, which is CI's job and is not bypassable.
