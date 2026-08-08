## 1. The menu, on its own

- [x] 1.1 `actions-menu.tsx`: `ActionsMenu`, a button and a hand-rolled
      `role="menu"` in the `creatable-picker` pattern — `aria-haspopup`,
      `aria-expanded`, roving `tabIndex`, ↑↓, Enter/Space, Escape, Tab,
      click-outside, `aria-disabled` while busy.
      **Tests** (`actions-menu.test.tsx`, written first and watched failing on
      the missing module): the closed button's ARIA; Enter, Space and ↓ each
      open it and land the focus on the first item; ↑↓ move the focus and the
      roving `tabIndex` follows; Enter and Space take the focused item; Escape
      closes and gives the focus back; Tab closes and leaves the focus on the
      button for the browser to move on from; a press outside closes it;
      a busy menu refuses activation and says so with `aria-disabled`.
      **Negative tests:** the roving `tabIndex` replaced by a fixed 0; the busy
      guard removed from the activation; the focus effect's `throw` replaced by
      a silent return, with the item refs unwired.

## 2. The menu in the table

- [x] 2.1 `wbs-table.tsx`: the `actions` cell renders one `ActionsMenu`;
      `openMenuRowId` state read through `live`, beside `depPicker`; `busy`
      joins `live`; `'actions'` joins `POPOVER_COLUMNS`. The `columns` memo
      keeps depending on `roles` and `unfoldedRoles` alone.
      **Tests** (`wbs-table.test.tsx`): Duplicate from the menu copies the
      branch; Delete on a parent sends `strategy: 'promote'`; a frozen row
      offers Unfreeze and not Delete; opening one row's menu closes another's.
      **Negative test:** `'actions'` removed from `POPOVER_COLUMNS` — the
      existing `does not clip the cells whose popovers open over the rows`,
      widened to the actions cell, must fail.
- [x] 2.2 `deleteRow`: the focus lands in the Name of the next sibling, else
      the row above, computed from the tree on screen and assigned only after
      be-01 has taken the request.
      **Tests:** the sibling case, the last-row case, and a refused delete that
      moves the focus nowhere.
      **Negative test:** the assignment moved in front of the `await`.
- [x] 2.3 The existing Duplicate and Unfreeze tests rewritten to go through the
      menu, and a helper that opens one row's menu and takes an item.

## 3. Width and prose

- [x] 3.1 `table-frame.ts`: `actions` 110 → 40, and `table-frame.test.ts` pins
      it — the first change of the four that has to leave the width table
      truthful about what the column now holds.
- [x] 3.2 `keyboard-bindings.ts`: the Tab entry says the menu rather than "that
      last row's Duplicate and Delete", and the same sentence is corrected in
      `onTabKey`'s JSDoc and in the comment on the edge-of-the-grid test.
      `PROVEN_BY` names tests, not copy, and the tests it names are unchanged —
      checked, not assumed.
- [x] 3.3 `CONTEXT.md`: **Actions menu**.

## 4. What jsdom cannot see

- [x] 4.1 `e2e/layout.spec.ts`: the open menu is hit-test visible below its own
      cell on the last row at the right edge of the table (the
      `POPOVER_COLUMNS` fault), and the keyboard path end to end — ↓ opens and
      focuses, ↑↓ move, Escape returns, Enter takes Duplicate, Tab out of an
      open menu leaves the table's grid rather than being trapped.
      **Not run here: this machine has no browser.** For h2puni, with the
      faults to inject named in the spec's own footer.

## 5. Gate

- [x] 5.1 `format:check --all`, the run-many gate and `openspec validate --all`,
      with the fault table in `verify.md` and every fault in it watched.
