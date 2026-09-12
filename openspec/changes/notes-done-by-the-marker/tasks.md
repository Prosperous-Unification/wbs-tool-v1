<!--
Ordered TDD slices. Only `- [ ]` checkboxes are tracked by the apply phase.
-->

## 1. Done by the marker

- [x] 1.1 `WrittenNotesPanel` renders Done in the cell's top-right (just left of the `≡`) rather
      than inside the card; `HoverPreview` loses its Done affordance, so the editing and hover cards
      are identical.
      Test: `e2e/hover-cards.spec.ts` — `Done stands by the notes marker, and closes the editor when
pressed` (beside the marker, the pointer's target there, saves and closes);
      `plan-cells.test.tsx` — `the Done button beside the notes saves and closes the editor too`.
      Negatives: `right: 24` moved to `right: 400` — `Done is not beside the notes marker · Expected:
<= 12 · Received: 384.40625` (Chromium); the button's `blur()` removed — `expected '## Risks'
to be '## Risks\n\n- one more'` (jsdom).

## 2. Words

- [x] 2.1 `CONTEXT.md` — Edit exit: Done is in the cell's top-right by the notes marker.

## 3. Gate

- [x] 3.1 `fe-01:lint`, `fe-01:typecheck`, `fe-01:test:unit`, `fe-01:test`; `hover-cards.spec.ts`
      on a shifted port; CI's whole browser gate.
