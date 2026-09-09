<!--
INTENT. Hard cap: 400 words excluding these comments.
-->

## Why

Dany, 2026-09-09, an hour after `link-names-and-card` merged: **"i cannot hover over the
dropdown - it disappears when i move cursor down to it"**.

Two faults, and each is blind to the other's proof.

The card was `pointer-events: none` with `padding: 6px 10px`, and only its **lines** took the
pointer. So the 6px band around them hit-tested the row _beneath_ the card: a cursor moving
down fired the cell's `mouseleave` and the card unmounted before the cursor reached a line.
Measured in the running app — the card at `[88, 242, 370, 56]`, and `elementFromPoint` 1px and
4px inside its top edge both answering the next row's name `<textarea>`.

And the cell is 40px while its card is up to 400px, so a hand reaching for a link on the right
leaves the cell **sideways into the Name column** before descending onto the card. There is no
instant at which the pointer is over either. Probed at 15 steps: `card.count() === 0` before
arrival.

**The oracle was `locator.hover()`, which teleports.** It puts the pointer on an element's
centre, so the previous change's two assertions about reaching and clicking a card link passed
over both defects. R5 #23.

## What Changes

- `HoverCard` gains **`takesPointer`**: the whole card is hit-testable, padding and inter-line
  gaps included. Off by default — transparency is load-bearing for a card that only exists to
  be read, because one that takes the mouse eats a click aimed at the row it hangs over.
- The links card passes it, and drops its per-line `pointer-events: auto`. Two answers to
  "what takes the pointer" is how this happened.
- The card opens **beside** its cell rather than under it — `opensSideways`, still an absolute
  child of the cell's wrapper, tops aligned. Dany asked for it (_"so that i can move my cursor
  down to look at each item one by one uninterrupted"_), and it also removes the gap outright:
  the card's left edge is the cell's right edge.
- A 200ms grace period on closing was written for the reach across the Name column, watched
  failing, and then **deleted**: with the card beside the cell the walk passes with the whole
  timer gone. A guard whose removal cannot be seen is not kept here.

## Non-goals

- No hover-intent on the way **in**. A card still opens the moment the pointer arrives.
- No pointer bridge of `DependsCard`'s kind. That models a corridor between an owner and rows
  it lights; here the cell and the card touch and the path between them crosses a third cell,
  so there is no corridor to describe.

## Constraints

- Every proof walks the pointer in steps. A test that teleports cannot see either fault.
