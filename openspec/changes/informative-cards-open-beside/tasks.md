<!--
Ordered TDD slices. Only `- [ ]` checkboxes are tracked by the apply phase.
-->

## 1. The side is measured

- [x] 1.1 `sidewaysPlacement` answers a side and an alignment from the cell, the card's own box
      and the frame.
      Test: `hover-card.test.tsx` — right where the room is, left for a column near the edge,
      right on a tie, bottom for a row too low.
      Negatives: the side fixed at `right`, watched failing on `expected { side: 'right', align:
'top' } to deeply equal { side: 'left', align: 'top' }`; the alignment fixed at `top`, watched
      failing on `… to deeply equal { side: 'right', align: 'bottom' }`.
- [x] 1.2 `HoverCard` measures once per opening, in a layout effect, and draws right/top until
      it has. The frame is found by `[data-table-frame]`, as `roomForCard` finds it.

## 2. The informative cards take it

- [x] 2.1 Start, the reference cells and the folded step card pass `opensSideways`.
      Test: `e2e/card-lanes.spec.ts` — `an informative card stands beside its cell, not over its
column`, which asks {@link cardIsOnTopAt} at the middle of the next row's cell.
      Negative: `opensSideways` taken off all three; watched failing on `Start: the card stands
over 020's own cell · Expected: not "the card"`.
- [x] 2.2 The same case asserts the card is inside the frame.
      Negative: the side fixed at `left: '100%'`; watched failing on `Start: the card runs off
the right of the frame · Expected: <= 1385 · Received: 1637`.

## 3. Two tests whose subject the change moved

- [x] 3.1 `paints the card past the bottom of a 96px cell` asks its question **beside** the cell
      now, because that is where the folded card escapes its `<td>`'s clip. Through
      {@link cardIsOnTopAt} rather than a screenshot pair — hit testing respects a clip, so it
      tells a clipped card from a painted one.
      Negative: `opensAPopover`'s `-final` branch removed; watched failing on `the card is
clipped at its cell edge · Expected: "the card" · Received: "DIV"`.
- [x] 3.2 `paints over the pinned cell of the row below it` takes the **notes preview** as its
      subject. It is the one card left that hangs below its cell, and its column is pinned —
      which is the trap `POPOVER_ROW_LAYER` exists for. The scroll machinery that slid an
      unpinned column under the pinned block is gone with its subject.
      Negative: `raiseWhenOpen={false}`; watched failing on `the pinned cell below hides the
card · Expected: "the card" · Received: "TEXTAREA"`.

## 4. Gate

- [x] 3.1 `fe-01:test`, then the whole browser gate on the shifted ports, in shards.
