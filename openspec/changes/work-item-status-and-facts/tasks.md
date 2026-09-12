<!-- Ordered TDD slices. Only `- [ ]` checkboxes are tracked by the apply phase. -->

Every negative below is watched failing **before** the production line is believed, and its
observed output goes into the adjacent `Proof:` comment and into `verify.md`'s table. One
branch, `change/work-item-status-and-facts`; one PR.

## 0. Words first

- [x] 0.1 `CONTEXT.md`: **Progress**, **Status**, **Fact start**, **Fact end** after **Hours
      fact**; **Done bar** after **Assumed span** — test: none.
- [x] 0.2 `docs/adr/0024-a-done-work-item-draws-its-facts-not-its-slices.md`, accepted — test:
      none. Linked from `statusOf`, `WorkItemService.setStatus` and the done-bar assembly.

## 1. The rename (D1)

- [x] 1.1 `libs/domain/src/progress.ts`: `WorkItemStatus`, `statusOf`, `UNKNOWN = 'unknown'`;
      `progress.test.ts` follows — test: `statusOf` › `reads an empty collection as unknown,
never as vacuously done`.
- [x] 1.2 `libs/core`: `roll-up.ts` (`rollUpWorkItemStatuses`), `numbered-work-item.ts`
      (`status`), `work-item.service.ts` read, JSDoc in `compensating.ts`, `work-item.routes.ts`,
      `command-journal-store.ts`; `libs/store-sqlite/src/schema.ts` JSDoc;
      `libs/contracts/src/http/work-item-response.ts` (`status: "'unknown' | 'in_progress' |
'done'"`); fe-01 fakes; every test naming the old words — test: `bunx nx run-many -t test
typecheck -p domain core contracts store-sqlite store-memory be-01` green; fe-01 typecheck.

## 2. Storage (D3)

- [x] 2.1 `apps/be-01/drizzle/20260912120000_add_work_item_facts/{migration,down}.sql`,
      `schema.ts` columns + JSDoc, `WorkItem`, `WorkItemPatch`, `WORK_ITEM_COLUMNS`, the sqlite
      patch guard, `memory-work-item-fixture.ts`, `workItemRow()` — test:
      `work-item.db.test.ts` › `writes both fact dates and reads them back`; negative: the two
      lines dropped from the patch guard, watched with the patch taken as naming no field.
- [x] 2.2 The nine ledger tests gain `WORK_ITEM_FACTS` at the tail of every ascending list and
      the head of every descending one — test: `bunx nx run store-sqlite:test` green;
      `pragma_table_info('work_item')` contains `fact_start` and `fact_end`.
- [x] 2.3 Undo of a delete puts the facts back — test: `undo.db.test.ts` › `restores a deleted
row's fact dates`; negative: `fact_start` removed from `WORK_ITEM_COLUMNS`, watched
      restoring `null`.

## 3. Facts on the wire (D3)

- [x] 3.1 `workItemPatch` shape, `numberedWorkItem`/`workItemTree` shapes, route
      `asOptionalDate` per field, `fieldsOf`, `revertTo` — test: controller › `writes a fact end
and undoes it`, `refuses a fact start that is not a date`; negatives: the `fieldsOf` line
      deleted (watched `stale_undo`), the `revertTo` line deleted (watched the undo restoring
      nothing).
- [x] 3.2 `duplicate` nulls both; `saved-plan-input.ts` records the omission — test:
      `work-item.service.test.ts` › `a duplicate has no facts and no statements`; negative: the
      two nulls dropped from the copy literal, watched copying the dates.

## 4. `setStatus` (D2, D4)

- [x] 4.1 Contracts: the arm, `PlanCommand`, `EVERY_KIND`, refusal codes `invalid_status`,
      `on_must_be_a_date` in `refusal.ts` + `refusal-status.ts` — test:
      `plan-command-shapes.test.ts` arm count 38; `mcp-01` pins moved (`openapi-tools.test.ts`).
- [x] 4.2 Route parse — test: controller › `refuses a status outside unknown and done`,
      `refuses an on that is not a date`; negative: `parseStatus` replaced by a cast, watched
      `in_progress` reaching the service.
- [x] 4.3 `WorkItemService.setStatus` + dispatch — tests in `libs/core/src/service/progress.test.ts`:
      `marks every step of a leaf done`, `marks every leaf beneath a parent`, `does not rewrite
a step already done`, `fills an empty fact end with on`, `keeps a typed fact end`, `takes
the UTC day of the stamp when on is absent`, `writes nothing when nothing changes`, `unknown
clears every statement and leaves the facts`, `one undo restores every statement and empties
the filled fact ends`; negatives: the `steps.length === 0` return deleted (watched an empty
      batch journalled); the `factEnd === null` guard deleted (watched a typed date
      overwritten); the inverse built unreversed (watched undo order wrong on a leaf with a
      prior `in_progress`).

## 5. The table (D5)

- [x] 5.1 `WorkItemView` + fakes carry `status`, `factStart`, `factEnd`; `wbs-api.ts`
      `setStatus(id, status, on)` and the patch fields — test: `wbs-api.test.ts` › `sends the
reader's day as on`.
- [x] 5.2 Registry: `COLUMN_WIDTHS`, `hideableColumnIds`, `INITIAL_HIDDEN_COLUMNS`,
      `COLUMN_LABELS`, `COLUMN_HINTS`, `POPOVER_COLUMNS`, `createPlanColumns` — tests:
      `table-frame.test.ts` lists, `column-hints.test.ts`, `plan-layout.test.tsx` › offered order
      `… Deadline, Status, Fact start, Fact end …`.
- [x] 5.3 Cells: `status.tsx`, `fact-start.tsx`, `fact-end.tsx`, `use-plan-fields.ts` setters +
      two `useDateCellEditor`s, readings flags — tests: `plan-cells.test.tsx` › `the status
cell` (reads Unknown / In progress / Done, offers two, choosing Done sends setStatus with
      today), `the fact cells` (rest, edit, commit, clear).
- [x] 5.4 `data-row-done` + `styles.css` strike — test: `plan-table.test.tsx` › `a done row is
struck through`; negative: the attribute dropped from `PlanRow`, watched the rule not
      matching.

## 6. The chart (D6)

- [x] 6.1 `GanttRow` fields + `plan-chart-input.ts` offsets — test: `plan-chart-input` ›
      `a fact end rolls back to the workday before a weekend`, `an undated plan places no fact`.
- [x] 6.2 `layOutGantt` done bar — tests in `gantt-geometry.test.ts` › `a done leaf draws one
bar`, `the bar stops at the fact end where the estimate reaches past it`, `a plan that
drifted past the fact draws the fact's one day`, `a fact start moves the bar's start`,
      `absent a fact end the done bar spans the slices`, `the arrow leaves the done bar`, `a
person link finds the done bar by any of its slice ids`; negatives: the clip dropped
      (watched 15 where 12 is owed); the extra `barBySliceId` registrations dropped (watched a
      person link dropped).
- [x] 6.3 Panel paint + words — tests in `gantt-panel.test.tsx` › `a done bar is painted as done
and never as assumed`, `the done bar says when the work finished`; negative: `data-done`
      dropped, watched the query finding nothing.

## 7. Exports (D7)

- [x] 7.1 `plan-export.ts` three columns; `plan-mermaid.ts` `done` tag when it draws a Gantt;
      `projectMarkdown` checked — test: `plan-export.test.ts` › `carries status and both
facts`.

## 8. Browser gate and verification

- [ ] 8.1 `apps/fe-01/e2e/status.spec.ts`: show the three columns, choose Done, name struck,
      Fact end reads today, the row's bar stops inside today's axis cell and carries
      `data-done` — run on `E2E_PORT_SHIFT=1900`.
- [ ] 8.2 Gate: `bunx nx run-many -t test lint typecheck -p domain core contracts store-sqlite
store-memory be-01 mcp-01 fe-01`, `bunx nx format:check --all`, `openspec validate --all
--json`, whole browser gate; `verify.md` with the failure-proof table; PR; CI green.
