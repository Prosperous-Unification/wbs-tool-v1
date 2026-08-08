## 1. The contract, on its own

- [x] 1.1 `name-notes.ts`: `composeNameCell`, `splitNameCell`,
      `normalizeNewlines`.
      **Tests** (`name-notes.test.ts`, written first and watched failing on the
      missing module): compose with and without notes and the trailing-newline
      rule; split on the first newline only; `'name\n'` → no notes; a blank
      line that has something under it; the empty first line; delete-line-1;
      a deleted separator; a stored name that already holds a newline; the
      round trip; CRLF and a lone CR.

## 2. The cell that edits both fields

- [x] 2.1 `cell-input.tsx`: `commit` gains the baseline — the value this box was
      showing when the typing began, which is `shown` and is already what the
      "did anything change" question is asked of. The dead `expandedRows` path
      goes with the Notes cell that was its only caller.
- [x] 2.2 `wbs-table.tsx`: the Name cell renders `composeNameCell(name, notes)`
      and commits through `commitNameCell`, which splits both texts, compares
      **against the baseline**, and sends the changed subset in one `api.patch`.
      **Tests** (`wbs-table.test.tsx`, a new `a name and its notes in one box`
      block): the first line stored as the name and the rest as the notes; one
      request for both fields; only the field that changed; delete-line-1
      renames; an emptied first line commits no name; a refused patch changes
      neither field.
      **Negative tests, all through the real render path** — a peer's edit
      arrives as new props from a refetch while the focus is held, then blur:
      `keeps a peer’s note when the name is what was being typed` and
      `keeps a peer’s name when the notes are what was being typed`, both
      watched failing with the diff re-pointed at the current row props. The
      two `===` guards dropped one at a time, each watched against the
      changed-subset test; `normalizeNewlines` dropped from both sides, and the
      empty-patch return deleted, each watched against the stored-CRLF test.

## 3. The Notes column, deleted

- [x] 3.1 The column definition, the `POPOVER_COLUMNS` membership and the
      `COLUMN_WIDTHS` entry all go; `name` joins `POPOVER_COLUMNS` and the
      hover preview moves onto the Name cell.
      **Tests:** the markdown, the script-in-a-note and the no-notes cases
      re-aimed at the Name cell; a long note read from the preview while the
      box shows the first lines; the column-order test says there is no Notes
      header; the Tab walk and the grid's edges are one stop per row shorter.
      **Negative tests:** `'name'` removed from `POPOVER_COLUMNS`, watched
      failing the popover-clip test and the cell-chrome loop; the `notes` width
      put back in `COLUMN_WIDTHS`, watched failing the test that says the width
      table has never heard of that column.

## 4. Up and down belong to the text first

- [x] 4.1 `cell-navigation.ts`: `Caret.multiline`, and the gate that gives ↑ and
      ↓ to a multiline box until the caret reaches position 0 or the end of the
      value; `caretOf` answers `multiline` from the element type.
      **Tests** (`cell-navigation.test.ts`): leaves only from the extremes, in
      both directions; a selection keeps the key; left and right unchanged;
      single-line cells still move from any caret position.
      **Negative tests:** the gate deleted, watched failing the multiline
      arrow test; `multiline` hard-coded `true`, watched failing the one-line
      one; hard-coded `false`, watched failing the multiline one again.
- [x] 4.2 The Backspace veto reads both fields out of `input.value`, with the
      `row.notes` conjunct kept and given a case of its own.
      **Tests:** `anything the item holds vetoes the backspace removal`, with
      the note written under a blank first line so the veto cannot come from a
      name; and `a note that has not been deleted yet still vetoes the removal`
      — the box emptied, the deletion not yet sent.
      **Negative tests:** each conjunct dropped in turn, each watched failing
      its own test and only its own.

## 5. Prose, and what jsdom cannot see

- [x] 5.1 `keyboard-bindings.ts`: the arrows entry says what ↑ and ↓ do in the
      name; the Backspace entry says a note vetoes the removal; the `Where`
      note says the Name cell is where notes are written. `PROVEN_BY` names the
      two new arrow tests. `CONTEXT.md`: **Name cell**.
- [x] 5.2 `e2e/layout.spec.ts`: the preview test re-aimed at the Name cell, and
      a new one for the wrapped-name caret rule — a name of one logical line
      long enough to wrap, ↑ from the middle moving the caret rather than the
      focus. **Not run here: this machine has no browser.** Faults G and H are
      written in the spec's footer as instructions for the h2puni run.

## 6. Gate

- [x] 6.1 `format:check --all`, the run-many gate and `openspec validate --all`,
      with the fault table in `verify.md` and every fault in it watched.

## 7. Round 1 of the cross-review

- [x] 7.1 `cell-input.tsx`: `commit` answers `landed` / `refused` / `unsent`,
      and the cell holds a refused draft against every later refetch (rule 4)
      and refuses to send the same text twice against the same baseline
      (rule 5). `wbs-table.tsx`: `run` returns the verdict it already toasts;
      `commitNameCell`, `commitEstimate` and `commitCombinedEstimate` return it.
      **Tests** in `wbs-table.test.tsx`, three of them: the refused draft still
      on screen after a peer's refetch, through the same peer harness as the
      clobber pair; one request only, however often the cell is left while a
      PATCH the test holds open is still out; and the refused edit sent again
      when the cell is left a second time.
      **Negative tests:** the `refused.current` gate deleted from `sync`; the
      flag never set; the `sent.current` comparison deleted; the record
      cleared nowhere on a refusal — each watched failing its own test and only
      its own.
- [x] 7.2 `controller/undo.controller.test.ts`: a `{name, notes}` PATCH through
      the route, over real SQLite, is one `command_journal` row and one undo
      that restores both fields.
      **Negative tests:** the edit split into two requests (a fourth entry, and
      an undo one field short); `revertTo`'s notes line deleted (the name back,
      the note not).
- [x] 7.3 `name-notes.ts`: a semantic fault per function watched and recorded
      in a `Proof:` comment beside it — the invented trailing newline, the split
      at the last newline, the split that loses the notes' own newlines, and
      `normalizeNewlines` made the identity (watched on the production path as
      well, through the stored-CRLF test).
