<!-- Ordered TDD slices. Only `- [ ]` checkboxes are tracked by the apply phase. -->

One branch, `change/actions-set-status`; one PR, reviewed on :4200 before merge.

## 1. The row menu

- [x] 1.1 `createActionsColumn` and `cardRowActions` gain the status entry; `CardRowActionHandlers`
      gains `markDone` and `setUnknown`; the ⋯ cell is `text-align: center` — tests:
      `plan-structure.test.tsx` › `marks a row done from its ⋯ menu through the completion prompt,
and offers the way back`; `plan-cards.test.tsx` › `offers Set status to Done, which asks for the day
and then sends the mark` and the enumerations; negative: the entry dropped from the column,
      `Unable to find … "Set status to Done"`.

## 2. `factStart` on the command; unknown clears both facts

- [x] 2.1 `definitions.ts` (`'factStart?': 'string'`), `parseFactStart`, the binding, and
      `WorkItemService.setStatus(…, factStart?)`: fill where null on done; clear both facts of a
      row that read done on unknown — tests: core › `fills an empty fact start with the day given,
and keeps one somebody typed` (negative: fill dropped, `Expected: "2026-09-08" / Received:
null`), `unknown takes the statements away…` and `one undo of an unknown…` (negative: the start
      half of the clear dropped, both red); controller › `fills the fact start a mark names, and
refuses one that is not a date` (negative: `parseFactStart` pass-through, `Expected: 400 /
Received: 200`).

## 3. The prompt

- [x] 3.1 `defaultFactStart`, `defaultFactEnd`, `dayNote`; two fields with notes; `onConfirm(started,
finished)`; the table sends `factStart` and patches a changed held day — tests:
      `completion-prompt.test.tsx` (nine cases; negative: the forecast-end arm dropped, `expected
'2026-09-13' to be '2026-09-10'`); `plan-cells.test.tsx` › `offers the forecast start as the
fact start and sends it with the mark`; `wbs-api.test.ts` carries `factStart`.
