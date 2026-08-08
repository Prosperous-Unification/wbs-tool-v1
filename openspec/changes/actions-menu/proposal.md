# One ⋯ per row instead of two buttons

## Why

Dany, 2026-08-08: Delete and Duplicate belong under a per-row ⋯ menu, and more
row actions are coming. Two reasons, and the second is the one with a number on
it.

The pair does not scale. Every action added to a row is another button on every
row, another 70px of table, and another tab stop between the last field of one
row and the first field of the next.

And the table does not fit. `actions` is 110px of a table that has to lose
about 500px to stop scrolling sideways on a 1280px screen — this is the first
of four changes that make it fit, and it frees 70 of them. The plan is
`tmp/plan-keys-and-fit-2026-08-08.md`; this change is section 1 of it and
carries its own width budget, truthfully, in its own commit.

## What Changes

**One button, one menu**

- Each row's actions cell holds a single ⋯ button — `aria-label`
  `Actions for 020`, `aria-haspopup="menu"`, `aria-expanded` — that opens a
  hand-rolled menu in the `creatable-picker` pattern: an absolutely positioned
  box in a `position: relative` wrapper inside the `<td>`, with `actions` added
  to `POPOVER_COLUMNS` so the cell does not clip it.
- The items are what the buttons were: **Duplicate**, and **Delete** — or
  **Unfreeze** on a row whose number is frozen. Same handlers, same
  `strategy: 'promote'` for a work item with children.
- One menu open at a time, held as a row id beside the dependency picker's own
  state and read through `live`.

**The menu owns the focus while it is open**

- Enter, Space or ↓ on the button opens it and moves DOM focus to the first
  item; roving `tabIndex` (0 on the active item, -1 on the rest); ↑↓ move;
  Enter or Space activate; Escape closes and gives the focus back to the ⋯
  button; Tab closes and moves on, because a menu is not a focus trap.
- After **Duplicate** the caret lands in the copy's Name and after **Delete**
  in the Name of the row that took its place — the next sibling, else the row
  above. After **Unfreeze** it goes back to the ⋯ button.
- While a mutation is in flight the items are shown disabled rather than
  removed, so the menu does not change shape under the hand using it.

**Width**

- `actions` 110 → 40 in the width table.

## Non-Goals

- **No new actions.** The menu is the place more of them will go; this change
  moves the two that exist and adds none.
- **No submenu, no separators, no icons.** Two items.
- **No focus trap and no `inert` backdrop.** Tab out is a supported way to
  leave, which is what the ARIA menu button pattern asks for.
- **No change to what Delete does.** Same request, same promote strategy; only
  where the focus lands afterwards is new, and it is new because there was
  nothing there before.
- **No keyboard chord to open it.** The ⋯ button is reached the way it always
  was, by Tab past the last field of the last row. Chords are change 4.

## Capabilities

### New Capabilities

- none

### Modified Capabilities

- `wbs-domain`: a row's actions live in one menu, which owns the keyboard while
  it is open and says where the focus goes when it closes.

## Domain Terms

- Actions menu

## Impact

fe-01 only: new `src/components/wbs/actions-menu.tsx` and its test, the
`actions` column in `wbs-table.tsx` (plus `POPOVER_COLUMNS`, a `deleteRow` that
names where the focus lands, and `openMenuRowId`), `table-frame.ts`'s width for
`actions`, `keyboard-bindings.ts`'s Tab prose, `e2e/layout.spec.ts`, and
`CONTEXT.md`. No be-01 change, no migration, no deploy change.
