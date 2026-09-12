<!--
INTENT. Hard cap: 400 words excluding these comments.
-->

## Why

Dany, 2026-09-10, three asks in one message:

1. **"can you make it so that all on-hover pop-ups over cells - all display diagonally? like to
   make both the on-hover element available for vertical scroll of mouse & the whole row seen
   for context on all columns of the row"**
2. **"make it available to switch cursor and hover over the md preview if moving cursor fast"**
3. **"when you click on title cell and note field expands - the right half of the row is a md
   preview which is same as in the on-hover md preview"**

The cards stood beside their cell — the column was clear, the row was not — except the notes
preview, which had already been moved below its row. One rule for all of them is what (1) asks
for, and it is the rule the preview was given: past the cell **and** past the row.

Then, 2026-09-11: **"implement 'diagonal' pop-up for ALL columns including PRIO, not before,
deadline, end, slack; ALL of them, must have same look and feel"**. Those columns have no card
of their own — the **hint layer** is their pop-up, and it had been given the placement of the day
before: beside the mark, tops aligned. Column clear, row covered, one day later. And "same look
and feel" turned out to be two claims: the hint layer's card is **portalled**, so it was drawn
in the user agent's `Times / 16px` beside every in-cell card's `sans-serif / 13px`.

## What Changes

- **Every in-cell card is placed diagonally.** `opensSideways` and `leavesItsRowClear` are gone:
  a card with no anchor and no list is beside its cell and below its row, full stop. The side and
  the edge are measured (`sidewaysPlacement`), the row offset is measured, and `width:
max-content` against the measured room beside the cell is what lets a card be as wide as its
  words rather than its 260px minimum.
- **`roomForCard` is deleted with the placement it served.** Nothing opens under a cell any more.
- **A reach**: the two cards a reader puts the pointer _on_ — the preview, which scrolls, and the
  links card, whose lines are links — are held for 300ms after the pointer leaves their cell.
  Diagonal means every path from cell to card leaves the cell's subtree, and the `mouseleave`
  that closes the card fires before the hand lands. The dependency card's bridge takes the same
  hold.
- **The open Name editor renders its notes beside itself**, in the row's right half, through the
  same `RenderedNotes` the hover preview uses.
- **The hint layer's card is diagonal too**, which is every remaining column: `diagonalPlacement`
  replaces `asidePlacement` and is given the cross to clear — the mark's `<td>` horizontally, its
  `<tr>` vertically — plus the frame it is clamped inside. This supersedes
  `every-column-answers-aside`'s _"A cell's hint stands beside its mark"_, one day old.
- **One type for every card**, in `styles.css`: a portalled card is a child of `<body>`, outside
  the `font-sans` on `<main>` and outside `[data-grid]` both.

## Non-goals

- No change to what any card says, when it opens, or the toolbar's own hints.
- The panel beside the editor is not a card: no `role="tooltip"`, no pointer, no placement logic.

## Constraints

- The panel's text is the **panel's** state. Held in the cell it re-renders the uncontrolled box
  on every keystroke, which `plan-row-render-cost.test.tsx` and a keyboard test both catch.
