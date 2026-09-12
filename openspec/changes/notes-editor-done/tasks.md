<!--
Ordered TDD slices. Only `- [ ]` checkboxes are tracked by the apply phase.
-->

## 1. Escape

- [x] 1.1 The Name cell's `onKeyDown` answers Escape by blurring the box, before the chords and
      the arrows. Test: `plan-cells.test.tsx` — `Escape saves what was typed and closes the notes
editor`; `e2e/hover-cards.spec.ts` — `Escape saves the note and closes the editor`, which
      reads the save back through the hover preview.
      Negative: the Escape branch removed — jsdom on `expected '## Risks' to be '## Risks\n\nand a mitigation'`, Chromium on `Escape left the notes panel up`.

## 2. Done

- [x] 2.1 `WrittenNotesPanel` renders a Done button in its top-right corner, `pointer-events:
auto` on a panel that has none, `tabIndex={-1}`, answering `mousedown` by blurring the box.
      Test: `plan-cells.test.tsx` — `the Done button beside the notes saves and closes the editor
too`; `e2e/hover-cards.spec.ts` — `Done is the thing under the pointer, and closes the editor`.
      Negatives: the button's `pointer-events` left to the panel's — Chromium on `Done is not what
the pointer lands on · Expected: "Done writing notes for 010" · Received: "TD"`; its press
      handler's `blur()` removed — jsdom on `expected '## Risks' to be '## Risks\n\n- one more'`.

## 3. Words

- [x] 3.1 `CONTEXT.md` — **Edit exit** gains the Name box's Escape; `keyboard-bindings.ts` lists
      Escape under Editing.

## 4. Gate

- [x] 4.1 `fe-01:lint`, `fe-01:typecheck`, `fe-01:test:unit`, `fe-01:test`; `hover-cards.spec.ts`
      on a shifted port; CI's whole browser gate.
