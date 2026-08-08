# The keys you plan with

## Why

Dany, 2026-08-08: "Enter loses new item. Cmd+Enter next row or create. A
new-item chord. hjkl motion chords. Ctrl+D twice deletes the row."

Enter has to stop making work items because `notes-live-in-the-name` gave the
Name cell a second line to write in, and a box whose Enter key makes a _row_
is a box nobody can write a note in. That is the forcing move; the rest is the
keyboard Dany asked for around it — one gesture family for structure, one for
motion, one for the item's own text.

This is section 4 of `tmp/plan-keys-and-fit-2026-08-08.md`, the last of four
changes, and it depends on section 2 having landed.

## What Changes

**Enter is a newline**

- The Name cell's Enter branch is deleted. Enter is the browser's own, which
  is what makes a typed note possible. Pickers keep their Enter.

**Five chords, from any cell**

- **Ctrl/⌘ + Enter** — saves this cell, waits for the answer, then moves to the
  next row's Name; on the last row it makes one and lands in it. A refused save
  leaves the caret where it is and creates nothing.
- **Ctrl + N**, and **Alt + N** for the same action — a new sibling below this
  row, from anywhere in the table, not only at the end.
- **Ctrl + H / J / K / L** — left, down, up, right between cells, with the
  arrows' "the text comes first" rule bypassed. Consumed at the grid's edge.
- **Ctrl + D twice** — deletes the row, children promoted. The first press
  tints the row and says what the second will do; the second has to be the same
  row, a real press rather than a key repeat, and after D has been let go.
  Frozen rows refuse. The toast says Cmd+Z puts it back.

**Where they apply, and where they do not**

- The chords are attached per cell class through one routing matrix, not to the
  window: `isTypingInto` and the undo/redo page guard are untouched.
- While any picker list is open — dependencies, team, assignee, the `@` mention
  picker, the ⋯ menu — every chord is inert in that cell. The open list owns
  the keyboard and Escape gives it back.

**A probe, not a proof**

- `tools/dev/chord-probe.html`: a static page that says, in a real browser,
  whether each chord arrives and whether `preventDefault` suppresses it.
  Nothing in this repository can answer that; this is the ten-minute check
  before merge.

## Non-Goals

- **No re-litigating the Ctrl family.** Cmd+N and Cmd+H never reach page JS
  (Chromium reserves File→New; macOS owns Hide). Ctrl+H/D/K/N shadow macOS's
  emacs-style text edits inside our cells — a named trade Dany took, with the
  guardrails that nothing destroys on one gesture and everything is undoable.
- **No global key listener.** Nothing new on `window` except the `keyup` that
  watches for D being let go and the disarm listeners.
- **No new destructive gesture.** Ctrl+D reuses the actions menu's delete path,
  strategy and focus rule exactly.
- **No confirmation dialog.** The arm/confirm _is_ the confirmation.

## Constraints

- `columns` in `wbs-table.tsx` may depend on `roles` and `unfoldedRoles` and
  nothing else; the armed row is read through the `live` ref like every other
  piece of state a cell needs.
- Every entry in `KEY_BINDINGS` names behaviour tests that exist, or the
  cheat-sheet cross-check fails.
- A chord this table advertises must never reach the browser, edge or no edge.

## Capabilities

### New Capabilities

- none

### Modified Capabilities

- `wbs-domain`: Enter in a work item's name writes a line rather than a work
  item; a family of Ctrl chords creates, moves between and deletes work items
  from any cell; a delete by keyboard takes two presses and says so first.

## Domain Terms

- command chord
- armed row

## Decisions Recorded

none — the Ctrl-family decision and its trade are Dany's, recorded in
`tmp/plan-keys-and-fit-2026-08-08.md` §0.

## Impact

fe-01 only: `keyboard-bindings.ts` (`commandChord`, `KeyPress.code`, five
registry entries), `cell-navigation.ts` (`commandMove`), `cell-input.tsx`
(`flushCell`, and `onLeave` answering what be-01 did), `wbs-table.tsx` (the
Enter branch deleted, `onCommandKey`, the armed row and its disarm rules, the
per-cell wiring), `creatable-picker.tsx` (`gridCell.onCommandKey`),
`actions-menu.tsx` (a modified Enter is not an activation), the tests, a new
`e2e/keyboard.spec.ts`, and `tools/dev/chord-probe.html`. No be-01 change, no
migration, no deploy change.
