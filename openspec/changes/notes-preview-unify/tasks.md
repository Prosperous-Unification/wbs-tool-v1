<!--
Ordered TDD slices. Only `- [ ]` checkboxes are tracked by the apply phase.
-->

## 1. One card

- [x] 1.1 `WrittenNotesPanel` renders `HoverPreview` (the marker's own card) from the box's live
      text, with an optional Done affordance; its bespoke fixed-width panel is deleted.
      Test: `e2e/hover-cards.spec.ts` — `the editing preview is the same card as the hover preview,
and stays on screen` (width and height within 2px of the hover card, right edge inside the
      window).
      Negative: the bespoke `min(1000px, 55vw)` panel restored — `the two previews differ in width ·
Expected: <= 2 · Received: 510`, in Chromium.

## 2. The marker is quiet while editing

- [x] 2.1 The marker's `onMouseEnter` no-ops while this row's box is focused, off a ref the panel
      keeps from the box's `focus`/`blur`; focus also drops any open hover.
      Test: `plan-cells.test.tsx` — `while editing, hovering the notes marker opens no second
preview`; `e2e/hover-cards.spec.ts` — `while editing, the notes marker opens no second
preview`.
      Negatives: the guard removed — jsdom `expected [ …(2) ] to have a length of 1 but got 2`, and
      Chromium `two previews open while editing · Expected: 1 · Received: 2`.

## 3. Words

- [x] 3.1 `CONTEXT.md` — the Hover preview and Notes marker entries note the editing card is the
      same surface, and that the marker is quiet while editing.

## 4. Gate

- [x] 4.1 `fe-01:lint`, `fe-01:typecheck`, `fe-01:test:unit`, `fe-01:test`; `hover-cards.spec.ts`
      on a shifted port; CI's whole browser gate.
