# design — `work-item-status-and-facts`

## Context

be-01 has held per-step progress since `role-progress` (archived 2026-08-30):
`step_progress (work_item_id, step_id, state, stated_at)`, two stored states and "nothing
said" as the absence of a row, folded on read into a per-work-item reading
(`rollUpProgress`, `rollUpWorkItemStates` in `libs/core/src/service/roll-up.ts`; `agree`,
`stateOf` in `libs/domain/src/progress.ts`) that the response carries as `state` and that
nothing in fe-01 draws. Its design deferred one decision by name: which of a stored date
and a scheduled one a chart draws. ADR 0024 makes it; this file is the shape.

Dates on `work_item` are date-only `IsoDate` text (`start_no_earlier_than`, `deadline`),
edited through `patchWorkItem`, journalled as one `patch` step whose inverse `revertTo`
builds field by field, and validated at the route (`asOptionalDate`). The chart's bars are
per slice (`layOutGantt`), person and capacity links look bars up by slice id
(`barBySliceId`), dependency arrows read the reached **slice** (`reachedSpanOf`), and a
parent's bracket is be-01's projection verbatim.

## Decisions

Rationale for the shape lives in ADR 0024; this lists what is built.

### D1 — Status is the existing fold, renamed

`WorkItemState` → `WorkItemStatus`, `stateOf` → `statusOf`, `NOT_STARTED` → `UNKNOWN`,
`'not_started'` → `'unknown'`, the wire field `state` → `status`,
`rollUpWorkItemStates` → `rollUpWorkItemStatuses`. `StepState` and the per-step `progress`
map keep their names — a step's statement is **progress**; the row's reading is **status**.
No alias survives (R2). The archived `role-progress` artifacts keep the old words as
history.

### D2 — `setStatus` is a server-computed batch

`{ kind: 'setStatus', workItemId | workItemRef, status: 'unknown' | 'done', on?: IsoDate }`
in `plan-command-shapes.ts`, `PlanCommand`, `EVERY_KIND`, the route parser
(`parseStatus` → `invalid_status`, `asOptionalDate(raw['on'], 'on')` → `on_must_be_a_date`)
and `plan-commands.ts`. `WorkItemService.setStatus(id, actorId, status, on)` resolves the
leaves in scope (the row itself, or `leavesUnder` a parent), reads the project's steps and
the stored statements once, and builds the list of primitive steps that differ:

- `done`: `set_progress(done)` per (leaf, step) not already `done`; `patch({ factEnd: on })`
  per written-scope work item (leaves and the parent itself) whose `factEnd` is null. `on`
  defaults to `isoDayOf(stamp.at)` — the UTC calendar day of the act's own stamp, never a
  second `now()` (ADR 0012).
- `unknown`: `clear_progress` per stored statement on a leaf in scope. Facts untouched.

Zero steps → `{ ok: true }` with nothing written, journalled or announced (the
`arrangeBySchedule` no-op rule). One step → recorded as that step. Two or more → one
journal entry `{ do: 'batch', steps }` whose inverse is the steps' inverses reversed —
`set_progress(before)` / `clear_progress` per statement, `patch({ factEnd: null })` per fill —
kind `status`, label `mark "X" done` / `unmark "X"`. `touched` = the work items written.
Writes go through `this.opts.progress.set/remove` and the work-item store's patch inside
the unit of work the command batch already opens (ADR 0015). Refusals: `not_found`,
`forbidden` via `contextFor`; a parent is **not** `rolled_up` here — that is the point of
the fan-out.

### D3 — Facts are two ordinary patch fields

`work_item.fact_start TEXT`, `work_item.fact_end TEXT`, one additive migration
`20260912120000_add_work_item_facts` with `down.sql` dropping both. `WorkItem`,
`WorkItemPatch`, `WORK_ITEM_COLUMNS`, the sqlite patch's "names no field" guard, the memory
fixture's merge, `workItemRow()` defaults, `numberedWorkItem` + `workItemTree` shapes,
`workItemPatch` shape, `fieldsOf`, `revertTo`, the route's `asOptionalDate` per field, and
`duplicate`'s copy literal (`factStart: null, factEnd: null` beside `frozenNumber: null`).
`saved-plan-input.ts` records the omission with `externalRefs[].name`'s argument. Nothing in
`canonical-schedule-input.ts` changes and `SCHEDULER_CONTRACT_VERSION` stays.

### D4 — The FE sends the reader's day

`api.setStatus(id, status, on)` always passes `on = todayIso` (the same local-day string
`useToday` keys on). Tested with `vi.setSystemTime` on a zone ahead of UTC.

### D5 — Three columns, hidden by default

Ids `status`, `fact-start`, `fact-end` (no `-final`/`-assignee` suffix collision; `status`
hides nothing by prefix because no column is `status-*`). Registered in `COLUMN_WIDTHS`
(`STATUS_COLUMN_WIDTH`, `DATE_COLUMN_WIDTH` ×2), `hideableColumnIds` after `deadline`,
`INITIAL_HIDDEN_COLUMNS`, `COLUMN_LABELS`, `COLUMN_HINTS`, `POPOVER_COLUMNS` (all three
open a list or a date editor), `createPlanColumns`. Cells: `plan-columns/status.tsx` (a
`CellInput` combobox over a two-line `PickerList`, `priority-cell.tsx`'s shape without the
band machinery), `fact-start.tsx` / `fact-end.tsx` (the `deadline.tsx` pattern with their own
`useDateCellEditor` and `readings.editingFactStart/End`). Live values: `setStatus`,
`setFactStart`, `setFactEnd`. Rows: `data-row-done` on the `<tr>`; `styles.css` strikes the
name cell's text and mutes it, joining no `--cell-bg` rule.

### D6 — The done bar is built in `layOutGantt`

`GanttRow` gains `status: WorkItemStatus`, `factStartOffset: number | null`,
`factEndStop: number | null` — workday units computed in `plan-chart-input.ts`:
`factStartOffset` via `workdaysBetween` (a start rolls forward), `factEndStop` via
`deadlineOffsetOf` + 1 (an end rolls backward; `before-project-start` → 0), both `null` on
an undated plan. For a done leaf, `layOutGantt` replaces the per-slice loop with one
`GanttBar`: `start = factStartOffset ?? min(slice starts)`, `finish = factEndStop ?? max(slice
finishes)`, `start >= finish` → `start = finish - 1`, `drawnSpan = finish - start`,
`done: true`, `estimated: true`, `sliceId` = the first slice in step order, `stepName: null`,
`personColor: DONE_BAR_COLOR`, `floorWords` = the fact sentence; registered in
`barBySliceId` under **every** slice id of the leaf. `reachedSpanOf` reads
`barBySliceId.get(reached.slice.id)` and falls back to the slice only when the reached leaf is
not a shown row. Horizon unchanged. `placeGantt` unchanged. The panel paints `data-done`,
`DONE_BAR_CLASSES` (solid stroke, full opacity, its own fill), a `<path data-done-mark>` tick
with `pointerEvents="none"` inside the SVG so the standalone export keeps it, and `barFacts`
puts "Done · 8 Sep → 12 Sep" first. `aria-label` ends `· done`.

### D7 — Exports

JSON export follows the shared shape. `plan-export.ts` gains `Status`, `Fact start`, `Fact
end` columns. `plan-mermaid.ts` tags a done row `done` and ends it at the fact end when it
draws a Gantt section. `projectMarkdown` gains nothing unless it lists dates (checked in 7.1).

## Test strategy

Domain: `progress.test.ts` (rename), `gantt-geometry.test.ts` (done bar cases, arrow anchor,
link lookup). Core: `work-item.service.test.ts` / `progress.test.ts` (fan-out, no-op, undo,
default `on`, typed fact end survives), `roll-up.test.ts`. Contracts: shape arms count 38.
Store-sqlite: fact columns write/read, delete-undo restores them, nine ledgers. Controller:
`invalid_status`, `on_must_be_a_date`, `fact_*_must_be_a_date`. fe-01: `plan-cells.test.tsx`
(three cells), `plan-layout.test.tsx` offered list, `table-frame.test.ts` lists, `column-hints`,
`gantt-panel.test.tsx` paint + words, `wbs-api.test.ts` sends `on`. e2e: `status.spec.ts` —
choose Done, name struck, fact end today, bar stops in today's axis cell, arrow leaves it.

Every safety check below carries a negative watched red with the check removed, recorded in
`verify.md` (R5).
