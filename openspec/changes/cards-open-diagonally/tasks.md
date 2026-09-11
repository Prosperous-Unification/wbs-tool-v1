<!--
Ordered TDD slices. Only `- [ ]` checkboxes are tracked by the apply phase.
-->

## 1. One placement for every in-cell card

- [x] 1.1 The in-cell branch of `HoverCard` is unconditional: past the cell (`sidewaysPlacement`
      picks the side), past the row (measured, because `100%` is the cell's wrapper and a wrapper
      is a line box inside a row), `width: max-content` against the measured room beside.
      `opensSideways`, `leavesItsRowClear`, `roomForCard` and `CardRoom` are deleted with the
      placements they served.
      Test: `e2e/card-lanes.spec.ts` — every lane asserts the card clears its own row, on top of
      the column claims it already made.
      Negative: the row offset replaced by `top: 0`; watched failing on `Start: the card covers
its own row · Expected: >= 174.1875 · Received: 150`.

## 2. The reach

- [x] 2.1 The **store** holds a cell's card for {@link REACH_FOR_THE_CARD_MS} after the pointer
      leaves (`holdHovered`), and every write cancels it — so a cell that opens its own card
      kills the previous cell's hold without knowing it exists. `cancelHold` is the one arrival
      that is not a write: the pointer landing on the card itself, which must not re-open a card
      the marker alone may open.
      The first cut put the timer in the cells and the dependency card died to a hold started
      before the pointer came back: `the tint moves the same way on both surfaces` waited 120s
      for `locator('[role="tooltip"]')`.
      Negative for the cancel: `cancelHold` made a no-op; watched failing on `the card closed
while walking to item 2`.
      Test: `e2e/hover-cards.spec.ts` — `is still there after a flick of the hand towards it`,
      **in steps**: a single `mouse.move` lands on the card, which is a DOM child of the cell, so
      no `mouseleave` fires at all and the teleport passes over the fault (R5 #23, third time).
      Negative: the reach set to 0; watched failing on `the preview did not survive the reach ·
Expected: 1 · Received: 0`, and on `e2e/external-refs.spec.ts`'s `the card closed on the way over
to it`.
- [x] 2.2 Three jsdom cases that read the frame the pointer left on now wait for the hold:
      `keeps the preview open while the pointer crosses the cell to reach it`, `lifts the hovered
row above the pinned cells the preview opens over`, `lifts the links cell over the pinned layer
while its card is open`, and the dependency bridge's `keeps the card mounted across passive
padding`. The lights still go at once; only the card waits.

## 3. The written notes, beside the box

- [x] 3.1 `RenderedNotes` is lifted out of `HoverPreview` so the panel and the card are one
      rendering rather than two that drift.
- [x] 3.2 `WrittenNotesPanel` listens to the Name box's own `focus`, `input` and `blur` and holds
      the text **itself**. Held one level up it re-renders the cell — and the uncontrolled box —
      on every keystroke: `plan-row-render-cost.test.tsx` went red on `expected 1 to be +0`, and
      `a chord waits for the blur's patch that is still out` on a re-render inside the blur
      putting the old text back in the box.
      Test: `e2e/hover-cards.spec.ts` — `the open editor shows the same rendering beside it`.
      Negative: the panel's `focus`/`input` listeners dropped; watched failing on `waiting for
getByLabel('Notes for 010, rendered while writing')`.

## 4. Every other column, which is the hint layer

- [x] 4.1 `diagonalPlacement` replaces `asidePlacement`: past the cross of a cell's column and a
      row's band, the roomier side and edge, clamped into the **frame** rather than the window,
      and no gap on either axis — an in-cell card touches the cross it clears, so a hint card 6px
      off it would be a second look for one pop-up.
      Test: `hover-card.test.tsx` — five cases.
      Negatives, all watched 2026-09-11: the side fixed right (`expected { left: 740, top: 226 }
to deeply equal { left: 600, top: 226 }`); `underneath` fixed true (`{ left: 240, top: 740 }` for
      `{ left: 240, top: 710 }`); both clamps taken back to the window (`{ left: 160, top: 90 }`
      for `{ left: 300, top: 100 }`); a refusal in front of the clamp (`expected null to deeply
equal { left: +0, top: 40 }`).
- [x] 4.2 `HintLayer` measures the cross itself — the mark's `<td>` and `<tr>`, not the mark,
      because a fact's mark is often a word inside a much wider cell — and hands it over as
      `OpenHint.placement`, a union of one key that **is** the card's prop.
      Test: `e2e/hints.spec.ts` — `every column's pop-up stands diagonally`, sweeping Reorder,
      Prio, Not before, Deadline, People at once, End and Slack, both axes and the frame per
      column.
      Negatives: the aside placement back (`Reorder: the card covers its own row · Expected: >=
-0.5 · Received: -26.1875`) and `{ anchor }` for an in-frame mark (`Reorder: the card stands over
its own column · Expected: >= -0.5 · Received: -12`). Both in Chromium, 2026-09-11.
- [x] 4.3 One type for every card, `[role='tooltip']` in `styles.css`: `@apply font-sans` and the
      grid's 13px over 1.4, because a portalled card is a child of `<body>`.
      Test: `e2e/hints.spec.ts` — `a card reads in the table's own type, wherever it is drawn`,
      which asserts the portalled card **and** the in-cell one against the cell's own computed
      type, and asserts each card's parent first so the claim is about the card it names.
      Negative: the block deleted; watched on `the portalled card's type · Expected: "sans-serif /
13px / 18.2px" · Received: "Times / 16px / normal"`.

## 5. Gate

- [x] 5.1 jsdom in three shards, then the whole browser gate in four.
