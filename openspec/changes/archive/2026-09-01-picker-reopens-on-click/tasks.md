<!--
Ordered TDD slices. Only `- [ ]` checkboxes are tracked by the apply phase.
-->

## 1. The gesture, reproduced in a browser first

- [x] 1.1 `e2e/reference-cells.spec.ts` `offers the rest of the directory when
the add field is clicked again` takes one tag through the cell as a reader
      does, asserts the box still holds the focus and the list is shut, and then
      clicks. Watched **failing on `main`'s component**, which is this change's
      whole negative: `clicking the focused add field offered nothing ·
Expected: 2 · Received: 0`.
- [x] 1.2 The same case covers the `+`, which is the other half of "the small
      add field". Negative: the `+`'s `click()` dropped and its `focus()` kept,
      watched failing on `the + offered nothing on a focused box · Expected: 2 ·
Received: 0`.

## 2. The rule, and the draft it must not touch

- [x] 2.1 `CreatablePicker`'s box opens its list on a click when the list is
      closed. Test: `creatable-picker.test.tsx` `opens the list again when the
closed box is clicked`; negative: the `onClick` deleted, watched failing
      on `Unable to find an accessible element with the role "option"`.
- [x] 2.2 Guarded on `typed === null`, so a click to place the caret in a
      half-typed search is inert. Test: `leaves a half-typed search alone when
the open box is clicked`; negative: the guard deleted, watched failing on
      `expected [ 'Platform', …(2) ] to deeply equal [ 'QA infra', 'Add “qa”',
…(1) ]` — the whole directory back and the search gone.
- [x] 2.3 Both `+` controls focus the box and then click it, so either state
      opens the list. One fix in the shared component and the shared strip, so
      Teams, Tags, Services and Types all get it.

## 3. Two checks that were measuring the wrong thing

- [x] 3.1 The browser case's option counter was `getByRole('option')` and it
      counted the **toolbar's** two native `<select>`s — seven `<option>`
      elements that are in the document at all times. Watched: `expect.poll ·
Expected: 0 · Received: 7` on a closed list with nothing wrong. Scoped to
      `[data-picker-list] [role="option"]`.
- [x] 3.2 And the wait before the gesture waited for nothing. `seed` puts
      `tags[0]` on row **010**, so the page-wide
      `page.locator('[data-reference-chip=…]')` matched 010's chip in the first
      frame and returned before 020's write had left the browser. Alone it
      passed; in the whole gate it failed at case **252 of 270** on `Expected: 2
· Received: 3` — the click landing on a row the server had not been told
      about, the list correctly offering all three tags, and `expect.poll`
      unable to recover because a list does not re-rank without a keystroke.
      Scoped to `cellOf(page, 'Tags for 020')`.
- [x] 3.3 And then the same case failed at 252 **again**, on the same numbers,
      with the fix working perfectly: the list was open and offering a **fourth**
      tag, `mobile e2e tag`, which `mobile.spec.ts` had left in the directory.
      The directory is **global** — every project draws from one list on purpose
      — so a literal count of what it offers is a test whose result depends on
      which other specs have run, and it passed alone because nothing had
      created that tag yet. The open-ness is `> 0` now (watched going to 0 with
      the fix removed) and the membership is asserted by name.

## 4. Gate

- [x] 4.1 fe-01's jsdom suite, the whole browser gate, lint, typecheck, format.
      Results in `verify.md`.
