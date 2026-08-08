# The notes live under the name

## Why

Dany, 2026-08-08: notes become part of the Name field, after a newline. A work
item's note is a sentence about that work item, not a second document filed
beside it, and two boxes to Tab between made it feel like one.

And the table does not fit. `notes` is 260px of a table that has to lose about
500 to stop scrolling sideways on a 1280px screen — the largest single column
after Name. This is section 2 of `tmp/plan-keys-and-fit-2026-08-08.md`, it
frees those 260px, and it is what the key remap in section 4 needs: Enter can
only become a newline once there is something for a newline to mean.

## What Changes

**One box, two fields**

- The Name cell shows a work item's name, and its notes under it after one
  newline. The Notes column is gone — its width, its cell and its tab stop.
- `name` and `notes` stay two fields in be-01. Nothing about storage moves.
- The first line is the name; everything after it is the notes. So deleting
  line 1 renames the work item to what was its first note, and an empty first
  line commits a work item with no name. Both are what one merged field means,
  both are tested as the product's answer, and Cmd+Z is the way back.
- The rendered markdown, on hover, moves to the Name cell.

**A commit that cannot clobber a peer**

- Leaving the cell splits what was typed and compares each field against
  **what the box was showing when the typing began**, never against the row it
  renders from: a peer's note that arrived mid-word is held back on screen, and
  must not read as a note this user deleted.
- Only the changed fields are sent, in **one** request — so a name and a note
  written together are one refusal, one journal entry and one Cmd+Z.

**Up and down belong to the text first**

- In the Name cell ↑ leaves the row only with the caret at the very start and ↓
  only at the very end. Everywhere else the browser keeps the key, which is
  what walks a wrapped line. One-line cells are unchanged.

## Non-Goals

- **No newline key yet.** Enter is still "new work item"; the chord that makes
  it a newline is `command-keys`, section 4 of the same plan. Until then a note
  is written by pasting one or by editing one that exists.
- **No merge of the fields in be-01.** Two columns, two patch fields.
- **No guard against a destructive edit.** Deleting line 1 renames the row on
  purpose. A confirmation on one field pretending to be two is the failure this
  change is avoiding.
- **No rich-text editor, no second read mode.** Unchanged from `notes-and-wrap`.

## Constraints

- `columns` in `wbs-table.tsx` may depend on `roles` and `unfoldedRoles` and
  nothing else, or every cell remounts and the focus goes with it.
- The Name column is pinned. It now also holds a popover, so it must not clip.
- The width table stays the one source of truth: no `notes` entry left behind.

## Capabilities

### New Capabilities

- none

### Modified Capabilities

- `wbs-domain`: a work item's notes are written under its name in one cell,
  committed as a three-way diff against what that cell was showing, and the
  arrows leave that cell only from the ends of its text.

## Domain Terms

- Name cell

## Decisions Recorded

none

## Impact

fe-01 only: new `src/components/wbs/name-notes.ts` and its test; the `name`
column and the deleted `notes` column in `wbs-table.tsx`, plus `POPOVER_COLUMNS`
and a `commitNameCell`; `cell-input.tsx` (the baseline handed to `commit`, and
the dead `expandedRows` path the Notes cell was the only user of);
`cell-navigation.ts` (the caret gate); `table-frame.ts` (the width entry);
`keyboard-bindings.ts` prose; `notes-preview.tsx` JSDoc; `e2e/layout.spec.ts`;
`CONTEXT.md`. No be-01 change, no migration, no deploy change.
