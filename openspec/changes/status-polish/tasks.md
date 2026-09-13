<!-- Ordered TDD slices. Only `- [ ]` checkboxes are tracked by the apply phase. -->

One branch, `change/status-polish`, stacked on `change/status-hint-words` (PR #429).

## 1. Chart

- [x] 1.1 `DONE_BAR_STROKE` in `gantt-geometry.ts`; the rect's `stroke`, `barClasses`' critical
      arm, the tick's stroke and the label's right padding in `gantt-panel.tsx` — test:
      `gantt-panel.test.tsx` › `is painted as done and never as assumed, and says so in its name`
      (stroke, class, tick, padding); negative: the `bar.done ? DONE_BAR_STROKE :` arm dropped,
      watched `expected '#475569' to be '#16a34a'`.

## 2. Table

- [x] 2.1 `--grid-done-tint` 7%; the status rule in the pinned right-edge set; `status` after
      `refs` in `hideableColumnIds` — tests: `table-frame.test.ts` › `hideableColumnIds` exact
      order; `plan-layout.test.tsx` Columns entries. The rule and the tint are CSS, judged on the
      rendered plan (verify.md).

## 3. Dependencies

- [x] 3.1 `status` on `PickableRow` and `DependsEntry`; `dependenciesOf` carries it;
      `statusStripStyle` on the card lines and the picker's `<li>` — tests: `depends-card.test.tsx`
      › `marks a finished predecessor with the status strip…`; `dep-picker.test.ts` › `carries each
row's status onto its entry…`; negative: `statusStripStyle` made transparent for every status,
      watched `expected '3px solid transparent' to be '3px solid var(--status-done)'`.

## 4. The status card

- [x] 4.1 `FACT_LEAD_ATTRIBUTE`, `FACT_TONE_ATTRIBUTE`, `factWords` in `hint.tsx`; the Status cell
      sets both — tests: `hint.test.tsx` › `bolds the lead where it occurs in the words, and colours
a done one`, `draws a lead that is not in the words as plain words…`; `plan-cells.test.tsx`
      lead and tone attributes; negative: `factWords` returning `words` outright, watched `expected
null not to be null`.
