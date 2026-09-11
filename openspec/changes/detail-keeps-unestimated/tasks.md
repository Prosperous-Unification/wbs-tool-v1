<!-- Ordered TDD slices. Only `- [ ]` checkboxes are tracked by the apply phase. -->

## 1. The switch's scope

- [x] 1.1 `drawnBars` stops filtering by `bar.estimated`; the hint text and
      `gantt-detail.ts`'s "three families" doc become two — test: `gantt-panel.test.tsx`
      `draws a slice nobody estimated, with the detail off and with it on`; negative: the
      filter put back, watched failing on the at-rest presence assertions.
- [x] 1.2 The seven cases that asserted the old rule inverted rather than deleted, each
      recording what it used to say — test: the whole `gantt-panel.test.tsx` file.

## 2. What the switch still hides

- [x] 2.1 The parent row keeps its caret gate: with the switch off a parent draws no bracket
      and therefore no caret — test: `draws no not-before caret on a parent row until the
detail is asked for`; negative: `drawnFlags` pinned to `placed.notBeforeFlags`.
- [x] 2.2 The canvas-width case keeps a real difference between the two states by gaining a
      parent — test: `declares the same canvas across the switch`; negative: the bracket
      precondition asserts the two states draw different sets.

## 3. In a browser

- [x] 3.1 `e2e/gantt.spec.ts`: with the detail off, an uncosted row draws a bar — the claim
      Dany made by eye, which jsdom cannot make about paint; negative: the filter restored.

## 4. Gate

- [ ] 4.1 `bunx nx run-many -t test lint typecheck -p fe-01`, then `bun run e2e` on shifted
      ports, then the workspace gate in CI.
- [x] 4.2 `verify.md` filled from the output.
