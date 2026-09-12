<!--
Ordered TDD slices. Only `- [ ]` checkboxes are tracked by the apply phase.
-->

## 1. The hint layer

- [x] 1.1 `asidePlacement` places an anchored card beside its mark: right, flipped left with no
      room there, clamped inside the viewport where neither side fits, and lifted for a mark too
      low to hold it.
      Test: `hover-card.test.tsx` — four cases.
      Negative: the side fixed at right; watched failing on `expected { left: 740, top: 200 } to
deeply equal { left: 654, top: 200 }`.
- [x] 1.2 `HoverCard` takes `opensAside`, and `HintLayer` passes it for marks inside
      `[data-table-frame]` — {@link OpenHint.aside}.
      Test: `e2e/hints.spec.ts` — `a cell’s fact stands beside its mark, not over the rows
below`, and the toolbar case that already asserts the opposite for a control.
      Negative: `aside` fixed to `false`; watched failing on `the card is not beside its mark ·
Expected: >= 0 · Received: -18.078125`.

## 2. The notes preview

- [x] 2.1 `leavesItsRowClear` puts the preview below its row (above it where the frame is short)
      and past its own cell, `width: max-content` against the measured room to the right.
      `clearsMarkerLane` and `MARKER_LANE_PX` go with it: starting past the cell leaves the lane
      clear by construction.
      Test: `e2e/hover-cards.spec.ts` — `leaves its own row and the marker lane clear`, which
      also walks the markers of three rows.
      Negative: `leavesItsRowClear` taken off; watched failing on `the preview covers its own
row · Expected: >= 174.1875`.
- [x] 2.2 `hover-card.test.tsx` reads the declarations jsdom can: `left: 100%`, `width:
max-content`, and the measured ceiling.
      Negative: the same prop dropped; watched failing on `expected '0px' to be '100%'`.

## 3. Gate

- [x] 3.1 jsdom in three shards, then the whole browser gate in four.
