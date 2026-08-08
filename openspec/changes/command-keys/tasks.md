## 1. The predicate, on its own

- [x] 1.1 `keyboard-bindings.ts`: `Command`, `commandChord(pressed)`, and an
      optional `code` on `KeyPress` — the only thing that can recognise Alt+N
      on macOS, where the letter never arrives.
      **Tests** (`keyboard-cheat-sheet.test.tsx`, written first and watched
      failing on the missing export — 7 red): the four directions; Ctrl+N and
      Ctrl+D; Alt+N through `code` with `key: 'Dead'`, and Alt+ArrowDown left
      alone so the row-move chords are not claimed; Alt with no `code` at all;
      Ctrl+Enter and Cmd+Enter, and bare Enter claimed by neither; every Cmd
      variant of the six letters rejected, alone and with Ctrl; Shift and Alt
      pollution rejected; the bare letters left alone.

## 2. The grid walk with the caret gate open

- [x] 2.1 `cell-navigation.ts`: `Direction` and `commandMove`, which is
      `nextCell` called with a caret that opens every gate — one named
      constant rather than four conditions removed, so the ragged-row skip and
      the refusal to wrap stay shared with the arrows.
      **Tests** (`cell-navigation.test.ts`): all four directions; a caret no
      arrow could leave, contrasted with the arrows refusing the same one;
      the ragged-row skip; the four edges; a cell the grid no longer holds.
      **Negative test:** the constant narrowed to a real mid-text caret,
      watched failing three of them.

## 3. The cell's own commit, reachable from a keystroke

- [x] 3.1 `cell-input.tsx`: `onLeave` answers the `CommitOutcome` it was
      already computing; every mounted cell registers a thunk for it in a
      `WeakMap` keyed by its node; `flushCell(node)` is what a chord calls.
      A node that is not a `CellInput` answers `unsent` — the date cell and the
      pickers hold no draft between keystrokes.
      Checked rather than added: the blur a focus move causes does **not** send
      the same edit twice, because rule 5 already covers it.

## 4. Enter, deleted

- [x] 4.1 `wbs-table.tsx`: the `preventDefault + addSibling` branch removed
      from the Name cell's `onKeyDown`.
      **Test:** `Enter in a name is a newline, and makes nothing` — the event
      not prevented, and no row created.
      **Negative test:** the branch put back, watched failing on
      `expected true to be false`.
- [x] 4.2 The grep-driven migration, its own task: `pressEnter` in
      `wbs-table.test.tsx` was the single scaffolding helper behind **15** call
      sites across 14 tests. Renamed `pressNewItem` and re-pointed at Ctrl+N;
      the one comment that named Enter as the gesture corrected. No test
      deleted, none rewritten to assert something else.

## 5. The chords, wired per cell class

- [x] 5.1 `onCommandKey` in `wbs-table.tsx`: the predicate, `preventDefault`
      for everything it claims, the motion branch, and the two writing chords
      behind an awaited `flushCell` and a `commandInFlight` ref.
- [x] 5.2 Wired into the Name cell, the folded estimate cell, the three trio
      boxes, the date cell, the depends box (closed only), and both
      `CreatablePicker`s through a new `gridCell.onCommandKey` the picker calls
      only while its own list is closed. `actions-menu.tsx`: a modified Enter
      is not an activation.
      **Tests**, one per routing-matrix row: Ctrl+N mid-table and from an
      estimate cell; Alt+N; Cmd+Enter to the next row and on the last row; the
      four directions and the consumed edge; the date cell; inert with the
      depends list open, with a team picker's list open, with the `@` list
      open, and with a ⋯ menu open — each paired with the same chord working
      once the list is closed.
      **Negative tests, all watched 2026-08-08:** the in-flight ref removed;
      the `await` dropped; the `refused` return removed; `preventDefault`
      removed; the depends `!open` condition forced true; the picker's `!open`
      guard dropped; the menu's modifier guard removed.

## 6. Ctrl+D, twice

- [x] 6.1 The armed row beside `depPicker` in component state, read through
      `live`; `dReleased` and the `keyup` listener; the disarm effect
      (`focusout`, window `blur`, `visibilitychange`, the three-second timer);
      the structural-refresh check on id **and** number; the tint on the cells
      and `data-armed` on the row; `MODIFIER_KEYS`; the frozen refusal; the
      delete through `deleteRow` and the three toasts.
      **Tests:** arm then confirm, with the focus landing where the menu's
      delete puts it; a held key; a repeat after the confirming press; two
      presses with no release; arm 020 then press on 030; a modifier tap
      between presses; any other key; Escape; the focus leaving; a peer
      renumbering the armed row; a frozen row.
      **Negative tests, all watched 2026-08-08:** the `repeat` conjunct, the
      `dReleased` conjunct, the same-row conjunct, the frozen refusal, the
      modifier exemption, the disarm listeners, and the id-and-number check —
      each removed one at a time, each watched failing on the test named beside
      it in the code.

## 7. The sheet, and the drift check

- [x] 7.1 `KEY_BINDINGS`: the old Enter entry replaced with the newline it now
      is, and four entries added — Ctrl/⌘+Enter, Ctrl+N / Alt+N, Ctrl+H/J/K/L,
      Ctrl+D twice — all in `Editing`, with the reason that grouping is right
      written into the `Where` JSDoc. `PROVEN_BY` names 20 behaviour tests
      across the five entries, every one of them in `wbs-table.test.tsx`.

## 8. What only a browser can say

- [x] 8.1 `e2e/keyboard.spec.ts`: Enter putting a real newline in and the box
      growing; Cmd+Enter's PATCH-before-POST on the real request log; Ctrl+D
      armed and confirmed through real `keyup`s; a genuinely held Ctrl+D
      arming once and deleting nothing.
- [x] 8.2 `tools/dev/chord-probe.html`: the §0 acceptance probe. Static, no
      framework, instructions at the top. It ships as a tool and is claimed to
      prove nothing on its own — the one question it answers is the one no test
      in this repository can.
