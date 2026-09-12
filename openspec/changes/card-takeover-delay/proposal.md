<!--
INTENT. Hard cap: 400 words excluding these comments.
-->

## Why

Dany, 2026-09-11, an hour after the reach's departure fix (PR #409): _"i need a delay for when
cursor moves into another cell and disappearing of the callback, like 50ms i think is fine ...
when i move diagonally to hover over the notes preview icon - i see popup diagonally - i want to
move cursor over to the pop-up - it can move over the dependency cell (which triggers it's own
pop-up) or over the neighbouring notes preview icon (which triggers another notes pop-up); i need
for cursor in flight while the notes pop-up is open - to have a small delay ... same for links,
deps"_.

Every in-cell card opens diagonally: past its cell and past its row. The notes card's corner is
the Depends cell's left edge one row down, so the hand's path from the `≡` to the card crosses the
same row's Depends cell or the next row's `≡` — both live triggers — and `arriveOn` replaced the
card the moment the pointer entered either. The reach (180ms) protects the trip from the _close_;
nothing protected it from a _takeover_.

## What Changes

- **A takeover waits.** While a card is open, a different trigger takes its place only after the
  pointer has rested on it for `TAKEOVER_MS` — 50ms, Dany's figure after watching 100 in Chrome on
  2026-09-12 (_"maybe reduce it to 50ms?"_). Arriving on the open card drops the pending takeover;
  so does leaving the trigger. With no card open, a trigger opens its card at once.
- **One rule for every card kind** — Dany: _"same for links, deps"_ — because one rule is the
  simple rule he asked for, and 50ms is well under what reads as lag when running down a column.
- **The store names its writes**: `arriveOn(cell)` for the pointer's arrival, `arriveOnCard()`
  (was `cancelHold`) for the pointer landing on the open card, `leave(cell)` for the same-cell
  clear the three leave handlers wrote functionally, and `updateHovered` for the refresh remap
  alone.
- **The Start cell's keyboard focus moves to the keyboard channel** (`updateFocused`), where the
  folded estimate's already is, so a focus never waits behind a pointer rule.

## Non-goals

- No geometric "is the hand aiming at the card" rule, and no invisible bridge over the path: the
  first is heavy and its proofs are this repo's hardest kind, the second would swallow the hovers a
  reader runs down a column for.
- The reach (180ms), and where any card opens, are unchanged.

## Constraints

- A card from a rested page still opens instantly: `e2e/hover-cards.spec.ts` reads the DOM once
  after a hover with nothing open.
- Running down a column of triggers shows each card `TAKEOVER_MS` after landing; that figure must
  stay under what a reader sees as lag. It is one constant, judged in Chrome.
