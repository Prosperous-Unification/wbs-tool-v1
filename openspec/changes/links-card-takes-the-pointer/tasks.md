<!--
Ordered TDD slices. Only `- [ ]` checkboxes are tracked by the apply phase.
-->

## 1. The card takes the pointer

- [x] 1.1 `HoverCard` gains `takesPointer`, and `ExternalRefsCard` passes it and drops its
      per-line `pointer-events: auto`.
      Test: `e2e/external-refs.spec.ts` — `the pointer walks onto the card and follows a link`
      asserts that `elementFromPoint` inside the card's own padding is part of the card.
      Negative: `takesPointer` removed; watched failing on `the card does not take the pointer
in its own padding`.

## 2. Beside the cell, not under it

- [x] 2.1 `HoverCard` gains `opensSideways` — `left: 100%` with the tops aligned, still an
      absolute child of the cell's wrapper — and the links card passes it. Dany, 2026-09-09:
      _"move the on-hover hint to the right of the cell - so that i can move my cursor down to
      look at each item one by one uninterrupted"_.
      Test: the same case measures the card against the cell, then walks sideways onto it and
      down every item in turn, asserting after **each** one.
      Negative: `opensSideways` removed; watched failing on `the card does not open beside the
cell`.
- [x] 2.2 A 200ms grace period on closing was written for the reach across the Name column and
      **deleted**. Its negative was real while the card opened _under_ the cell (`the card
closed on a diagonal reach for a link` with the timer at 0); beside the cell there is no
      gap, and the walk passes with the timer and its re-arm entirely removed. Measured before
      deleting, not assumed.

## 3. Gate

- [x] 3.1 `fe-01:test`, then the whole browser gate on the shifted ports.
- [x] 3.2 R5 #23 recorded in `AGENTS.md`, tally 22 → 23, including the deleted guard.
