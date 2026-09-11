<!--
INTENT. Hard cap: 400 words excluding these comments.
-->

## Why

Dany, 2026-09-10, an hour after every cell card was made walkable: **"make sure that same
scheme works for all cells hover ons? even the informative ones? I still want to see what is up
and down from it for context; like, just push them to the side (left or right) ... depending on
where horizontally it is"**.

Yesterday's change asked whether the pointer can _reach_ the next row's trigger, and four
columns passed by being pointer-transparent: Start, Types, Tags and the folded step columns
open a card that hangs over the rows below, and the hit test goes straight through it. The
pointer reaches; the reader still cannot **see** what it is reaching for. A plan is read down a
column, and a card standing over the next three rows of that column takes the context with it.

The links and dependency cards already answer this by opening **beside** their cell. Doing the
same for the informative cards is one prop each — except for the side. Those two columns sit at
the left of the plan; Start is 4px from the frame's right edge, and a card that always opened
right ran 252px past it (measured in Chromium: the cell at x 1283–1381 in a frame ending at
1385, the card at 1377–1637).

## What Changes

- `HoverCard`'s `opensSideways` **measures** which side it opens on, and which of its edges it
  hangs from: `sidewaysPlacement` answers `right` where the room is there or the right is the
  roomier side, `left` otherwise; and `bottom` for a row too low in the frame to hold the card
  hanging from its top.
- Start, the four reference cells and the folded step card pass `opensSideways`.
- Nothing else changes. The notes preview keeps its 24px pull — a 640px document beside a cell
  covers half the plan, and its own lane is already clear — and the links and dependency cards
  are what this generalises.

## Non-goals

- No change to what any card says, how it opens, or when it closes.
- No portal. These stay absolutely positioned children of the cell's own wrapper, which is what
  keeps the cell's `mouseleave` the only thing that closes them.

## Constraints

- The side is a measurement, so it needs a browser to prove: `sidewaysPlacement` is pure and
  unit-tested, and that a real cell is measured by it is `e2e/card-lanes.spec.ts`.
- A transparent card cannot be asked "are you over this?" with a plain hit test — R5 #27, and
  the reason `cardIsOnTopAt` exists.
