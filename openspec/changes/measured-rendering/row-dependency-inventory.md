# The row and cell dependency inventory

Task 2.1's first half. Read at `4179515d`, 2026-09-08, over
`apps/fe-01/src/components/wbs/{plan-live.ts,wbs-table.tsx,plan-cell-props.ts,plan-columns/*}`.

`PlanLiveValues` (`plan-live.ts:37`) is the cells' whole contract: **87 fields**, built once per
render as `liveNow` (`wbs-table.tsx:868`) and published through a ref (`wbs-table.tsx:958`).
Column families are handed `{ live }` and nothing else (`plan-columns/columns.ts:25`), so every
read below is a `live.current.<field>` inside a `cell:` body. The `columns` memo depends on
exactly `[steps, unfoldedSteps, hiddenColumnIds]` and adding a fourth entry remounts every cell.

This file is the inventory task 2.2 has to replace with explicit render inputs. It is a reading
of the code, not a claim about behaviour; the behaviour is asserted in
`apps/fe-01/src/components/wbs/plan-row-dependencies.test.tsx`.

## The seven kinds

| Kind         | What it is                                                                   | What must happen when it changes                                          |
| ------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `committed`  | derived from the server-held plan — a **peer's** edit changes it             | the displayed value changes, and an unrelated open editor keeps its text  |
| `editor`     | local editing state: a draft, an open picker, a mention list, an editing day | only the cells that draw it change; the editor itself is never remounted  |
| `directory`  | teams, tags, services, types, people, priority bands, external systems       | pickers and labels see the new entry without a remount                    |
| `geometry`   | DOM handles and layout the cells read                                        | no cell identity changes                                                  |
| `writer`     | a function that issues a write                                               | identity may change freely; cells call it, never depend on it for display |
| `filter`     | `matchIds`, `filtering`                                                      | the Name and Number cells re-mark without touching any editor             |
| `structural` | `steps`, `unfoldedSteps`, `hiddenColumnIds` — **not** in `PlanLiveValues`    | the column set is rebuilt and every cell is legitimately remounted        |

## The 87 fields

Identity: **ref** = stable forever; **set** = a React setter, stable forever; **cb** = a
`useCallback`, fresh when its deps change; **value** = replaced by each server read.

| Field                     | Read by                                                   | Kind                  | Scope    | Identity                   |
| ------------------------- | --------------------------------------------------------- | --------------------- | -------- | -------------------------- |
| `focusIntent`             | `name.tsx:135`                                            | editor                | table    | ref                        |
| `gridElement`             | `name.tsx:138`                                            | geometry              | table    | ref                        |
| `startFloor`              | `plan-cell-props.ts:217`, `start.tsx:19`                  | committed             | per row  | ref, contents replaced     |
| `api`                     | `actions.tsx:45`, `depends.tsx:464`                       | writer                | table    | value                      |
| `projectId`               | **no cell**                                               | identity              | table    | value                      |
| `run`                     | `actions.tsx:45`, `depends.tsx:463`                       | writer                | table    | cb                         |
| `busy`                    | `actions.tsx:15`                                          | writer                | table    | value                      |
| `duplicateRow`            | `actions.tsx:35`                                          | writer                | per row  | cb                         |
| `deleteRow`               | `actions.tsx:61`                                          | writer                | per row  | cb                         |
| `commitNameCell`          | `name.tsx:149`                                            | writer                | per row  | cb                         |
| `onKeyDown`               | `name.tsx:158`                                            | editor                | per row  | cb                         |
| `onTabKey`                | 13 cells                                                  | editor                | per cell | cb                         |
| `onArrowKey`              | `estimates`, `in-parallel`, `name`, `priority`            | editor                | per cell | cb                         |
| `onAltMove`               | 15 sites                                                  | editor / writer       | per cell | cb                         |
| `onCommandKey`            | 16 sites                                                  | editor / writer       | per cell | cb                         |
| `armedDelete`             | **row shell** `wbs-table.tsx:1739`, `:1825`               | editor                | table    | fresh object per arm       |
| `setDragging`             | `drag.tsx:30`                                             | editor                | table    | set                        |
| `setDropHint`             | `drag.tsx:34`                                             | editor                | table    | set                        |
| `dependenciesOf`          | `depends.tsx:30`, `plan-cell-props.ts:82,105,117`         | committed             | per row  | cb(`[flat]`)               |
| `dependOn`                | `depends.tsx:635`                                         | writer                | per row  | cb                         |
| `hasSchedule`             | `finish.tsx:19`, `float.tsx:17`                           | committed             | table    | cb                         |
| `showSchedule`            | **no cell** (inside `spanOf`)                             | committed             | table    | cb                         |
| `depPicker`               | `depends.tsx:34`, `plan-cell-props.ts:105,117`            | editor                | table    | state object               |
| `setDepPicker`            | `depends.tsx` ×5                                          | editor                | table    | set                        |
| `depLights`               | `depends.tsx` ×11, `plan-cell-props.ts:83,122`, row shell | editor                | per row  | ref, stable                |
| `openMenuRowId`           | `actions.tsx:14`                                          | editor                | table    | state                      |
| `setOpenMenuRowId`        | `actions.tsx:17,23`                                       | editor                | table    | set                        |
| `depEntriesFor`           | `depends.tsx:35,542`                                      | committed / filter    | per row  | cb(`[flat]`)               |
| `pickDependency`          | `depends.tsx:628,726`                                     | writer                | per row  | cb                         |
| `moveDepHighlight`        | `depends.tsx:597`                                         | editor                | per row  | cb                         |
| `estimateValue`           | `estimates.tsx:700`                                       | committed / editor    | per cell | cb                         |
| `trioProblemFor`          | `estimates.tsx:640`                                       | editor                | per cell | cb                         |
| `commitEstimate`          | `estimates.tsx:706`                                       | writer                | per cell | cb                         |
| `combinedValue`           | `estimates.tsx:376`                                       | committed / editor    | per cell | cb                         |
| `combinedProblem`         | `estimates.tsx:78`                                        | editor                | per cell | cb                         |
| `commitCombinedEstimate`  | `estimates.tsx:378`                                       | writer                | per cell | cb                         |
| `mention`                 | `estimates.tsx:147`                                       | editor                | table    | state object               |
| `enterFoldedCell`         | `estimates.tsx:330`                                       | editor                | per cell | cb                         |
| `readFoldedCell`          | `estimates.tsx:230`                                       | editor                | per cell | cb                         |
| `closeMention`            | `estimates.tsx:273`                                       | editor                | table    | cb                         |
| `leaveFoldedCell`         | `estimates.tsx:190`                                       | editor                | table    | cb                         |
| `mentionOptions`          | `estimates.tsx:126`                                       | editor / directory    | per cell | cb                         |
| `openCard`                | `depends`, `estimates`, `name`, `refs`, `start`           | editor                | table    | derived value              |
| `setHoveredCell`          | 7 cells, `plan-cell-props.ts` ×4                          | editor                | table    | set                        |
| `setFocusedCell`          | `estimates.tsx:194,343`                                   | editor                | table    | set                        |
| `setNotBefore`            | `not-before.tsx:132`                                      | writer                | per row  | cb                         |
| `setNotBeforeReason`      | `not-before.tsx:52`                                       | writer                | per row  | cb                         |
| `setDeadline`             | `deadline.tsx:58`                                         | writer                | per row  | cb                         |
| `setPriority`             | `priority.tsx:33,38`                                      | writer                | per row  | cb                         |
| `priorityBands`           | `priority.tsx:31`                                         | directory             | table    | value                      |
| `setParallelism`          | `in-parallel.tsx:149`                                     | writer                | per row  | cb                         |
| `effectiveTeamLabelOf`    | `team.tsx:24`                                             | committed / directory | per row  | cb, no per-row cache       |
| `effectiveTagLabelOf`     | `tag.tsx:26`                                              | committed / directory | per row  | cb, no per-row cache       |
| `effectiveServiceLabelOf` | `service.tsx:31`                                          | committed / directory | per row  | cb, no per-row cache       |
| `editingNotBefore`        | `not-before.tsx:28`                                       | editor                | table    | state                      |
| `openNotBefore`           | `not-before.tsx:31`                                       | editor                | per row  | cb                         |
| `closeNotBefore`          | `not-before.tsx:34`                                       | editor                | per row  | cb                         |
| `editingDeadline`         | `deadline.tsx:22`                                         | editor                | table    | state                      |
| `openDeadline`            | `deadline.tsx:24`                                         | editor                | per row  | cb                         |
| `closeDeadline`           | `deadline.tsx:27`                                         | editor                | per row  | cb                         |
| `startDate`               | `deadline.tsx:19`, `not-before.tsx:27`                    | committed             | table    | value                      |
| `teams`                   | `team.tsx:37`, `estimates.tsx:756`                        | directory             | table    | value                      |
| `tags`                    | `tag.tsx:43`                                              | directory             | table    | value                      |
| `services`                | `service.tsx:81`                                          | directory             | table    | value                      |
| `workItemTypes`           | `type.tsx:36`                                             | directory             | table    | value                      |
| `externalSystems`         | `refs.tsx:29,109`                                         | directory             | table    | value                      |
| `setRefsEditing`          | `refs.tsx:61`                                             | editor                | table    | set                        |
| `people`                  | `estimates.tsx:731,747`                                   | directory             | table    | value                      |
| `setTeamOf`               | `team.tsx:40`                                             | writer                | per row  | cb                         |
| `setTagsOf`               | `tag.tsx:46`                                              | writer                | per row  | cb                         |
| `setServicesOf`           | `service.tsx:85`                                          | writer                | per row  | cb                         |
| `setTypesOf`              | `type.tsx:38`                                             | writer                | per row  | cb                         |
| `setExternalRefsOf`       | **no cell** (`wbs-table.tsx:2003`, the modal)             | writer                | per row  | cb                         |
| `createTeamFor`           | `team.tsx:41`                                             | writer                | per row  | cb                         |
| `createServiceFor`        | `service.tsx:87`                                          | writer                | per row  | cb                         |
| `createTagFor`            | `tag.tsx:47`                                              | writer                | per row  | cb                         |
| `createTypeFor`           | `type.tsx:39`                                             | writer                | per row  | cb                         |
| `assignTo`                | `estimates.tsx:762,768`                                   | writer                | per cell | cb                         |
| `createPersonFor`         | `estimates.tsx:765`                                       | writer                | per cell | cb                         |
| `toggleStep`              | `estimates.tsx:60` (the fold `<th>`)                      | structural writer     | table    | cb                         |
| `spanOf`                  | `start.tsx:18`, `finish.tsx:10`, `plan-cell-props.ts:217` | committed             | per row  | cb, no per-row cache       |
| `assigneeOn`              | `estimates.tsx:122,729`                                   | committed / directory | per cell | cb, linear `people.find`   |
| `anyAssigneeOn`           | `estimates.tsx:525`                                       | committed             | per step | cb, `flat.some` per cell   |
| `nonOwnerNoteOf`          | `service.tsx:39`                                          | committed / directory | per row  | cb, linear `services.find` |
| `waitsFor`                | **no cell** (`wbs-table.tsx:1467`, the cards)             | committed             | per row  | cb                         |
| `matchIds`                | `name.tsx:27`                                             | filter                | table    | `useMemo`                  |
| `filtering`               | `number.tsx:57`                                           | filter                | table    | value                      |

## Five fields no cell reads

`projectId`, `showSchedule`, `waitsFor`, `setExternalRefsOf` and `armedDelete` are on the cells'
contract and read by nobody under `plan-columns/`. Three have another reader that is **not** a
cell — the row shell (`armedDelete`), the refs modal (`setExternalRefsOf`) and the cards
(`waitsFor`) — one is internal to `spanOf` (`showSchedule`), and `projectId` has no reader at all.
They are not removed here: this slice adds no production change. Task 2.2 owns the removal, and
each removal is its own compiler proof.

## What is recomputed per row per render, and is not cached

Every entry below runs once per row (some twice) on **every** render of `WbsTable`. The enclosing
`useCallback` keeps the function's identity, which does nothing about the work inside it.

- `spanOf(row)` — allocates a `Date` and two `printedDay` calls per row, and is called 2–3× per
  row: the Start cell, the Finish cell, and again inside `readStartSentence`, which itself runs
  once for the `<td>`'s props (`wbs-table.tsx:1790`) and once in `start.tsx:19`.
- `dependenciesOf(ids)` — `flat.find` per dependency id, so O(deps × rows), and called up to four
  times for one pointer enter on a Depends cell (`plan-cell-props.ts:82,105,117` and
  `depends.tsx:30`).
- `depEntriesFor(row, typed)` — rebuilt from `flat` per render, by its own JSDoc.
- `assigneeOn(row, stepId)` — linear `people.find`, called twice per step per row unfolded.
- `anyAssigneeOn(stepId)` — `flat.some(...)` evaluated per cell, for an answer that is per step.
- `nonOwnerNoteOf(row)` — linear `services.find` per unowned id.
- `effectiveTeamLabelOf` / `effectiveTagLabelOf` / `effectiveServiceLabelOf` — map lookups and two
  fresh arrays per row each.
- `refMarksOf(row.externalRefs, externalSystems)` (`refs.tsx:29`) — not memoised.

Memoised already: `startFloor`'s map (`plan-chart-input.ts:199`), `matchIds` and `filtering`
(`use-plan-filter.ts:337,349`), and `shownRows` (`wbs-table.tsx:1016`).

## The asymmetry 2.2 must resolve

The Start sentence and the Depends cell's dependency list are each read **twice per render** on
two independent paths — once in the `<td>` props builder outside the registry
(`plan-cell-props.ts`) and once in the cell body. Explicit render inputs have to feed both, or
the two disagree within one render.
