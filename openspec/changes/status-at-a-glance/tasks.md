<!-- Ordered TDD slices. Only `- [ ]` checkboxes are tracked by the apply phase. -->

Every negative below is watched failing **before** the production line is believed, and its
observed output goes into the adjacent `Proof:` comment and into `verify.md`'s table. One
branch, `change/status-at-a-glance`, stacked on `change/work-item-status-and-facts` (PR #423)
until that merges; one PR.

## 1. Words and the core (D1)

- [x] 1.1 `CONTEXT.md`: **Status strip**, **Completion prompt** after **Fact end** — test: none.
- [x] 1.2 `WorkItemService.setStatus`'s `unknown` arm folds the before-status of every in-scope
      work item with `rollUpWorkItemStatuses` and pushes `patch({ factEnd: null })` for each
      that read `done` and holds one, inverse restoring the day; JSDoc names ADR 0024 and the
      rule — tests in `libs/core/src/service/progress.test.ts`: rewrite `unknown takes every
statement away and leaves the facts where they are` as `unknown takes the statements
away, and the fact end of a done row with them` (fact start `2026-09-08` stands, fact end
      `null`); add `a parent's unknown clears only the leaves that were done` and `unknown on a
row that was not done leaves its typed fact end`; extend `one undo puts every statement
back…` with the cleared day coming back from one entry — negative: the "read `done`" guard
      removed, watched clearing the typed `2026-09-09` of the never-done leaf.

## 2. The row's face (D2)

- [x] 2.1 `PlanRow` takes `status`, writes `data-row-status` beside `data-row-done`; tokens
      `--status-done`, `--status-in-progress`, `--grid-done-tint` in `:root` and `.dark`; the
      strip rules on the drag cell — test: `plan-table.test.tsx` › `every row says its status,
and a done row still says done`; `wbs-table.tsx` JSDoc on the prop.
- [x] 2.2 `--row-tint` two-layer paint: `[data-grid] td` in `styles.css` and `ROW_BACKGROUND` in
      `table-frame.ts`, `HEADER_BACKGROUND` unchanged — test: `table-frame.test.ts` › `paints a
pinned body cell with the tint layer over the row colour, and a heading without`;
      negative: the gradient layer dropped from `ROW_BACKGROUND`, watched in 5.1's browser proof
      as a pinned cell of a done row with `background-image: none` while its unpinned neighbour
      carries the layer.

## 3. The glyph column (D3, D4)

- [x] 3.1 `STATUS_COLUMN_WIDTH = 28`, `createStatusColumn` after `createNumberColumn`,
      `PINNED_COLUMN_IDS` with `status` third; `hideableColumnIds` and `INITIAL_HIDDEN_COLUMNS`
      unchanged — tests: `table-frame.test.ts` › `holds every pinned column at the sum of the
widths the same call declared` gains a Status-shown case (refs and name 28 further right);
      `refuses a column pinned behind a flexible one` still red on the injected order;
      `plan-layout.test.tsx` offered-list order unchanged; `plan-keyboard.test.tsx` walk with
      Status shown lands on it after `#`.
- [x] 3.2 `STATUS_GLYPH`, glyph value, the word as `title`, colour per status, `role="img"`
      heading; `STATUS_HINT`, the fact-end hint and `STATUS_WORDS.done` reworded — test:
      `plan-cells.test.tsx` › `the status cell shows a glyph and says the word`, `the heading is
the glyph named Status`; `column-hints.test.ts` words.

## 4. The completion prompt (D5)

- [x] 4.1 `completion-prompt.tsx` — tests in `completion-prompt.test.tsx`: `offers today when the
row holds no fact end`, `offers the held fact end`, `holds Mark done back while the day is
not a date`, `Cancel and Escape confirm nothing`, `confirms the day in the field once`;
      negative: the `disabled` guard removed, watched confirming `''`.
- [x] 4.2 Wiring: `completionFor` state and the surface in `WbsTable` off the live row,
      `live.openCompletionPrompt`, `createStatusColumn`'s `choose` routing `done` to the prompt
      and `unknown` straight through, `onConfirm` running `setStatus` then the `patch` only when
      a held day changed — tests: `plan-cells.test.tsx` › `choosing Done opens the prompt and
sends nothing`, `confirming sends setStatus with the day`, `a changed held day follows as a
patch, second`, `Unknown sends at once with no prompt`, `a parent's prompt sends one
setStatus`; the deleted-row state is the `refsEditing` pattern (`?? null`) and is not
      separately tested — assumption, stated; negative: `choose('done')` restored to a direct
      `setStatus`, watched by `choosing Done … sends nothing`.

## 5. Browser proofs

- [x] 5.1 `e2e/status.spec.ts`: the Done pick now confirms the prompt; computed `box-shadow` on
      the done row's drag cell names the strip and the row above's does not; computed
      `background-image` of a pinned and an unpinned cell of the done row both carry the layer;
      the existing fact-end and bar pins hold — test: the spec, run on a shifted port.
- [x] 5.2 `e2e/layout.spec.ts` › `puts the pinned columns where they are declared with Status
shown`: five measured lefts equal five declared — test: the spec.

## 6. Close

- [x] 6.1 `verify.md` with the command table and the failure-proof table; `LLM_README.md`
      untouched (no orientation changed) — test: `openspec validate status-at-a-glance --json`.
