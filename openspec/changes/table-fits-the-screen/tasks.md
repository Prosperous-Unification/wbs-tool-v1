## 1. The width table

- [x] 1.1 `table-frame.ts`: every fixed column compacted to the v1.1 figures,
      `INDENT_STEP` 16→12, the role widths 96/52/120.
      **Tests** (`table-frame.test.ts`): the literals, pinned as a table,
      because the equation below is only true while they are.
      **Negative test:** run against the pre-compaction widths.
- [x] 1.2 `FLEXIBLE_COLUMNS`, `FLEXIBLE_FLOOR` and `flexibleCellStyle`; `name`
      out of `COLUMN_WIDTHS` entirely, so `widthFor('name')` throws exactly as
      a typo does. No sentinel.
      **Tests:** `widthFor('name')` throws; the floor reaches the cell.
      **Negative test:** `name` put back in the width table and out of the
      flexible set.
- [x] 1.3 `tableMinWidth` replaces `tableWidth`, budgeting the floor for each
      flexible column.
      **Tests:** the three states — two folded 1144, three folded 1240, one
      unfolded 1420.
      **Negative test:** the flexible branch replaced by `widthFor`, and by
      `0`.
- [x] 1.4 `PINNED_COLUMNS` carries `width: undefined` for a flexible column and
      `pinnedCellStyle` stops declaring one; `PINNED_GEOMETRY` throws while
      loading if a flexible column is ever put in front of another pinned one.
      **Tests:** Name pinned at 124 with no width; only the last pinned column
      may be flexible.
      **Negative tests:** the `width` restored unconditionally; the pinned list
      reordered.

## 2. The table, laid out to the window

- [x] 2.1 `wbs-table.tsx`: `<table>` is `width: 100%` with
      `minWidth: tableMinWidth(leafColumnIds)`; the colgroup emits no width for
      a flexible column; `flexibleCellStyle` reaches both `<th>` and `<td>`.
      **Tests:** the colgroup's third `<col>` declares nothing; the table's
      minimum follows the fold.
- [x] 2.2 Headings shortened — Days, Start, End, Slack — with what they used to
      say moved into each one's `title`, including whether the schedule columns
      are dates or day numbers.
      **Tests:** the heading row; the `title` with and without a project start
      date.

## 3. One role at a time

- [x] 3.1 `toggleRole` replaces rather than adds; the fold button's copy no
      longer claims to hide the assignee and says the accordion out loud.
      **Tests:** unfolding QA folds Dev, and the declared minimum follows;
      folding the open one leaves none open; the button's `title`.
      **Negative test:** the writer put back to `[...current, roleId]`.

## 4. `@` in the folded cell

- [x] 4.1 `mention.ts` (+test): `splitMention`, cutting at the first `@`,
      trimming neither half.
- [x] 4.2 `creatable-picker.tsx`: the list extracted as `PickerList` with
      `pickableLabel`, so the folded cell opens the same one rather than a
      second copy of the rules that make a popover work here.
- [x] 4.3 `cell-input.tsx`: an `onTyped` hook, so a cell can react to text as
      it is typed without a second name for the change event.
- [x] 4.4 `wbs-table.tsx`: the folded cell shows `4.8 · Kat`; `@` opens the
      people picker; Enter takes the first entry; `Add "…"`; `Remove <name>`
      first on a bare `@`; Escape closes and strips nothing; the mention comes
      out on a pick and on the blur.
      **Tests:** the filter; the one gesture end to end; add; remove; the
      assumed name in grey; nothing shown where neither holds.
- [x] 4.5 `commitCombinedEstimate` splits, and refuses to send an estimate half
      that is empty or unchanged beside a mention.
      **Tests:** `@ka` over a selected figure leaves the estimate alone; a
      mention abandoned with Escape asks be-01 for nothing.
      **Negative test:** the split removed, so the parser sees the mention.
- [x] 4.6 `opensAPopover` extends to role `-final` columns.
      **Test:** the folded cell does not clip and `final-total` still does.
      **Negative test:** the suffix removed.
- [x] 4.7 `keyboard-bindings.ts`: the `@` binding under Pickers, with its
      `PROVEN_BY` tests.

## 5. What jsdom cannot see

- [x] 5.1 `e2e/layout.spec.ts`: the matrix — 1280×800 and 1512×982 × {two
      folded, each unfolded, three folded, deep numbering with a long name and
      six chips}; document and frame overflow; every leaf column's rect inside
      the frame; Name at or above its floor; the date input unclipped at 108;
      the depends listbox at 260; the actions menu and the folded `@` picker
      hit-test visible at the right edge and on the last row; the 900px
      backstop with Name pinned at 124 while the frame scrolls; one 125% zoom
      run with the roles folded.
      **Run on h2puni**, with the faults named in the spec's own footer.

## 6. Gate

- [x] 6.1 `format:check --all`, the run-many gate and `openspec validate --all`,
      with the fault table in `verify.md` and every fault in it watched.
