# Verify

Implementation landed 2026-09-12 on `change/work-item-status-and-facts`. Commands and
measurements below are this machine's (macOS, UTC+3, Chromium via Playwright); CI is the gate.

## Commands

| Command                                                                                                      | Result                                                                 |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `bunx nx run-many -t typecheck -p domain core contracts store-sqlite store-memory conformance be-01 mcp-01`  | pass                                                                   |
| `bunx nx run fe-01:typecheck`                                                                                | pass                                                                   |
| `bunx nx run-many -t test -p domain contracts`                                                               | pass                                                                   |
| `bunx nx run core:test`                                                                                      | pass — 418 (after the rename the boundary lint sorted one import)      |
| `bunx nx run store-sqlite:test`                                                                              | pass — 0 fail, nine ledgers extended both ways                         |
| `bunx nx run-many -t test -p mcp-01 be-01`                                                                   | pass after the two identity oracles lifted `factStart`/`factEnd`       |
| `bunx nx run-many -t lint -p domain core contracts store-sqlite store-memory conformance be-01 mcp-01 fe-01` | one finding, `type` → `interface` in the new controller test; fixed    |
| `bunx nx format:check --all`                                                                                 | pass                                                                   |
| `OPENSPEC_TELEMETRY=0 bunx openspec validate --all --json`                                                   | 80 passed, 0 failed                                                    |
| `bunx vitest run` (fe-01, whole suite, under load)                                                           | 16 failed — see below; every one re-run alone is green or pre-existing |
| `E2E_PORT_SHIFT=1900 bunx playwright test … apps/fe-01/e2e/status.spec.ts`                                   | **1 passed** (run 3, Saturday: the bar stops in Friday's cell)         |

### The fe-01 results that were not green on first run, and why

- **`plan-mermaid.test.ts`, 2 cases in `a real Mermaid parse (M5)`** — pre-existing on this
  UTC+3 machine (UTC-midnight fixtures against Mermaid's local-time parse); green in CI.
- **`plan-chart-seam.test.tsx` (3), `plan-dependencies.test.tsx` (1), `plan-layout.test.tsx`
  `offers the reset only while there is a width to reset`** — 5 s timeouts while lint, the
  browser gate and the whole suite ran at once. `plan-dependencies` + `plan-chart-seam` alone:
  **90 passed (90)**.
- **Baselines that hid only the old default columns** — `plan-layout`'s `threeRoots`,
  `plan-table`'s Links case, and the stored hide-lists three tests assert — read as a reader's
  own choice once `INITIAL_HIDDEN_COLUMNS` grew three members, which is what offers `Reset
layout`. Each baseline now names all eight.
- **`plan-keyboard.test.tsx` (5)** — the Tab walk gained three cells: Status, Fact start and
  Fact end are editable with or without a calendar, so they follow the last step's cell and
  the last row's Fact end is the grid's last cell.
- **`test-tiers.test.ts` (2)** — the new DOM-free `plan-chart-input.test.ts` had to be listed
  in `vitest.node-suites.ts`.

## Measurements

The 1280px folded budget did not move: all three columns ship in `INITIAL_HIDDEN_COLUMNS`,
so `foldedTableMinWidth` over the default set is what it was. With every column shown the
laid-out table is 284px wider (Status 88, two dates at 98).

The browser run's screenshot is attached to the passing test (`the done row and its bar`):
the number struck through, `Status` reading `Done`, `Fact end` reading `12 Sep`, and one
slate bar with a white tick stopping in Friday 11 September's axis cell — today is a Saturday,
and `factEndStopOf` rolls back.

## Failure proofs

Every row was watched failing with the fault in and green with it out.

| Check (file)                                | Fault injected                                                 | Test that observed the failure                                                            | Result                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `work-item.service.ts` `setStatus` no-op    | `steps.length === 0` return deleted                            | `writes nothing when nothing would change`                                                | `Expected: 0 · Received: 1` — an empty batch journalled                                |
| `work-item.service.ts` `setStatus` fill     | `if (row.factEnd !== null) continue;` deleted                  | `keeps a fact end somebody typed`                                                         | `Expected: "2026-09-10" · Received: "2026-09-12"`                                      |
| `work-item.service.ts` `duplicate`          | `factStart: null, factEnd: null` dropped from the copy literal | `a duplicate has no facts, exactly as it has no statements`                               | `Expected - 2 · Received + 2` — the copy carrying the original's days                  |
| `work-item.ts` (sqlite) no-field guard      | the two `patch.fact… === undefined` lines deleted              | `writes both fact dates and reads them back, and clears them with nulls`                  | `Expected - 2 · Received + 2` — `ok` answered, nothing written                         |
| `work-item.ts` (sqlite) `WORK_ITEM_COLUMNS` | `factStart`/`factEnd` removed from the projection              | `restores the fact dates of a deleted work item, against the real cascade`                | `Expected - 2 · Received + 2` — the branch back without its dates                      |
| `work-item.service.ts` `fieldsOf`           | the two `fact…` lines deleted                                  | `puts a cleared fact end back, and takes a first one away again`                          | `refused: stale_undo — “Strip” has changed since then`                                 |
| `work-item.routes.ts` `parseStatus`         | replaced by `status as SettableStatus`                         | `refuses a status outside unknown and done, in_progress and not_started included`         | `Expected - 3 · Received + 1` — `in_progress` answered 200                             |
| `workday.ts` `isoDateOfInstant`             | the finite guard deleted                                       | `refuses a stamp that is not an instant`                                                  | `RangeError: Invalid time value` out of `toISOString`                                  |
| `gantt-geometry.ts` done bar stop           | `row.factEndStop ?? latest` → `latest`                         | `draws one bar for the leaf, stopping at the fact end where the estimate reaches past it` | `expected [ 8, 15, 7, true, true ] to deeply equal [ 8, 12, 4, true, true ]`           |
| `gantt-geometry.ts` done bar clamp          | the `wanted < stop` clamp deleted                              | `draws the fact’s one day when the whole plan drifted past it`                            | `expected [ 20, 12, -8 ] to deeply equal [ 11, 12, 1 ]` — negative width               |
| `gantt-geometry.ts` bar registrations       | registered under the first slice id alone                      | `answers a person link by any of the leaf’s slice ids`                                    | `expected [] to deeply equal [ [ 'strip-qa', 12 ] ]` — the hand-off dropped            |
| `gantt-geometry.ts` `reachedSpanOf`         | the `barBySliceId` lookup removed                              | `leaves the arrow from the done bar’s stop, not from the slice’s finish`                  | `expected [ [ 11, 15 ] ] to deeply equal [ [ 8, 12 ] ]`                                |
| `gantt-panel.tsx` `data-done`               | the `data-done` spread dropped from the rect                   | `is painted as done and never as assumed, and says so in its name`                        | `expected null to be 'true'`                                                           |
| `use-plan-fields.ts` `setStatus` sends `on` | `isoToday(new Date())` replaced by `''`                        | `choosing Done sends the reader’s day, strikes the row and fills the fact end`            | `MalformedDayError: "" is not a YYYY-MM-DD calendar day` before the cell could be read |
| `plan-chart-input.ts` `factEndStopOf`       | `deadlineOffsetOf` replaced by `workdaysBetween`               | `rolls a weekend fact end back to the Friday, never forward to the Monday`                | `expected 6 to be 5` — the Saturday rolled forward to Monday                           |
| `wbs-table.tsx` `data-row-done`             | `data-row-done` dropped from the `<tr>`                        | `choosing Done sends the reader’s day, strikes the row and fills the fact end`            | `expected null to be 'true'`                                                           |

### A watch that was not red, and what replaced it

`setStatus` records its inverse as a `batch` whose steps are **reversed**, by
`recordCollected`'s convention. Recording them unreversed was watched **passing** `one undo
puts every statement back and empties the fact ends it filled`: every step the method builds
touches its own (leaf, step) pair or its own work item's fact end, so no order of the
inverses changes what they restore. The reversal stays as convention; the method's JSDoc and
the test say so in place of a `Proof:` naming a red nobody saw.

- [x] Every check in this change has a row
- [x] Each negative test reaches the production call path
- [x] No row relies on an exit code
