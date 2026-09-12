# design — `status-at-a-glance`

## Context

`work-item-status-and-facts` (PR #423, this branch's base) holds status as a folded reading
(`statusOf`, `rollUpWorkItemStatuses`), sets it through `WorkItemService.setStatus`, and
shows it in a word in a hidden 88px column. The row says `data-row-done` and `styles.css`
strikes the name. The table's paint is a `--cell-bg` join: every `tr` state — band, hover,
dependency light, drop — re-points one custom property, and the pinned cells follow it
through an inline `background: var(--cell-bg, …)` (`ROW_BACKGROUND` in `table-frame.ts`).
The pinned block is contiguous from the left edge by construction (`PINNED_COLUMN_IDS`,
`frameLayout` throws otherwise). One modal opens from a cell today, `ExternalRefsModal`,
held as `refsEditing` state in `WbsTable` and rendered from the live row.

## Goals / Non-Goals

Goals: the strip, the tint, the glyph column in the pinned block, the completion prompt,
the fact-end clear on `unknown`. Non-goals: a time of day (ADR 0024), a default-visible
Status column, any change to per-step statements or to the engine.

## Decisions

### D1 — `unknown` clears the fact end of what read done

In `setStatus`'s `unknown` arm, after the `clear_progress` steps: fold the before-status of
every work item in scope — the leaves and the row itself — from the statements read at the
top of the act, with the same `rollUpWorkItemStatuses` the read uses, so the arm and the
column can never disagree about what "was done". For each in-scope work item whose fold read
`done` and whose `factEnd` is not null, push `patch({ factEnd: null })` with inverse
`patch({ factEnd: before })`. Same batch entry, same `touched`, same label. Fact start is
never touched; an in-progress or unknown row's typed fact end stands.

### D2 — The row states its status, and paints two things off it

`PlanRow` takes `status: WorkItemStatus` in place of `done: boolean` and writes both
`data-row-status` and the existing `data-row-done` (the strike rule and `status.spec.ts` pin
it). Three tokens in `styles.css`, light and dark: `--status-done`, `--status-in-progress`,
and `--grid-done-tint` (the done colour at low alpha over `transparent`).

**Strip.** `tr[data-row-status='done'] td[data-column='drag']` and the in-progress twin take
`box-shadow: inset 3px 0 0 var(--status-…), inset 0 -1px 0 var(--border)` — the strip and
the row separator every body cell already draws, in one declaration, because a second
`box-shadow` rule replaces the first rather than adding to it. `box-shadow` is the table's
separator medium and moves nothing. On a drop-target row the drop rule's shadow wins for as long as the drag
lasts; accepted.

**Tint.** A second custom property, `--row-tint`, `transparent` on `[data-grid]` and
`var(--grid-done-tint)` on `tr[data-row-status='done']`. Every cell paints two layers:
`background: linear-gradient(var(--row-tint), var(--row-tint)), var(--cell-bg)` in
`styles.css`, and `ROW_BACKGROUND` becomes the same pair with its fallbacks, so the pinned
cells stay opaque and follow. `--cell-bg` and its `:not()` chain are untouched; the tint sits
over whichever colour they chose. `HEADER_BACKGROUND` stays single-layer.

### D3 — Status is the third pin

`STATUS_COLUMN_WIDTH = 28`; `createStatusColumn` moves to after `createNumberColumn` in
`createPlanColumns`; `PINNED_COLUMN_IDS` = `drag, number, status, refs, name`. The
`hideableColumnIds` order and the Columns control entry stay where they are (after
`Deadline`, beside the two facts). `INITIAL_HIDDEN_COLUMNS` keeps `status`. The keyboard
grid walks table order, so Tab from `#` lands on Status when it is shown; `plan-keyboard`'s
walk follows.

### D4 — The cell is a glyph with the word in its name

`STATUS_GLYPH: Record<WorkItemStatus, string>` = `○ ◐ ✓`; the `<input>` combobox stays (the
grid walks inputs), its `value` is the glyph, its `aria-label` stays `Status of ${number}` —
the handle every walk, proof and hint finds it by — and the word is its `title` (a combobox
takes no `aria-description`, per `jsx-a11y`); its colour is `var(--status-…)` for the two
coloured statuses and `--muted-foreground` for unknown. The heading is `<span role="img" aria-label="Status">○</span>`.
`STATUS_HINT`, the fact-end hint and `STATUS_WORDS.done` say "asks for the day" instead of
"fills with today".

### D5 — The completion prompt is the write

`completion-prompt.tsx`: `Modal` + `ModalContent side="centre" closeButton={false}`,
`ModalTitle` "Mark {number} done", `ModalDescription` (every step will say done; the day is
the fact end), one `DateField` autofocused, `ModalFooter` with `ModalClose` Cancel and a
`Mark done` button disabled while the field is not an `IsoDate`. A plain controlled
`<input type="date">`, not `DateField`: nothing lands from a server here, and Enter has to
submit the form. Props: `number`, `heldFactEnd: IsoDate | null`, `today: IsoDate`,
`onConfirm(day)`, `onOpenChange`, `onClosed` — Radix's `onCloseAutoFocus` is taken over,
because the element it would return focus to is the picker's `Done` line, unmounted by then
(watched: focus fell to `<body>`); the table focuses the Status cell itself.

Wiring follows `refsEditing`: `WbsTable` holds `completionFor: string | null`, renders the
prompt from the live row (a deleted row means no surface), exposes
`live.openCompletionPrompt(rowId)`. `createStatusColumn`'s `choose`: `done` on a row not
already done → open the prompt; `unknown` → `setStatus` at once. `onConfirm(day)` runs
`setStatus(id, 'done', day)` and then, only when `heldFactEnd !== null && heldFactEnd !== day`,
`setFactEnd(id, day)` — two entries, stated in the JSDoc — and skipped after a refusal.
`onClosed` focuses the Status cell of the row that asked.

## Risks / Trade-offs

- A drop target hides the strip for the length of a drag. Accepted over a pseudo-element,
  whose containing block inside a sticky table cell is browser-dependent.
- Two undo steps when a held fact end is changed in the prompt. Accepted: a fill-and-overwrite
  variant of `setStatus` is a contract change for one uncommon path.
- Status shown puts a 28px column into the pinned prefix sums; `frameLayout` already derives
  them from one resolution, and `layout.spec.ts` measures them, so a drift is loud.

## Test strategy

Core: `progress.test.ts` — the existing `unknown … leaves the facts where they are` case is
rewritten to the fact-start-stays / done-fact-end-cleared reading; parent clears only done
leaves; unknown on an in-progress row leaves facts; undo restores the cleared day. Negative:
the "read done" guard removed, watched clearing the typed day of a leaf that was never done.
fe-01: `plan-table.test.tsx` row attributes; `table-frame.test.ts` pins with Status shown and
`ROW_BACKGROUND` naming both layers; `plan-cells.test.tsx` glyph, name, prompt open sends
nothing, confirm sends `on`, held-and-changed sends the patch second, parent; `completion-
prompt.test.tsx` prefill, disabled, Cancel/Escape. Negatives: `choose('done')` restored to a
direct `setStatus`, watched by "cancel sends nothing"; the `disabled` guard removed, watched
sending `on: ''`; the inline tint layer removed, watched in the browser as pinned cells
without the tint. e2e: `status.spec.ts` gains the prompt, the strip and the tint by computed
style; `layout.spec.ts` measures five pins with Status shown.
