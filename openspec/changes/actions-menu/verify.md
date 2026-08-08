# Verification

## The gate

Run on h1claw, 2026-08-08, on `change/keys-notes-and-fit`.

```
$ bunx nx format:check --all
(no files listed, exit 0)

$ bunx nx run-many -t test lint typecheck build --parallel=2
NX   Successfully ran targets test, lint, typecheck, build for 21 projects
      fe-01 (vitest)   23 files   507 pass  0 fail   (22 files / 485 before this change, +22)

$ bunx nx run-many -t test lint typecheck --projects=fe-01 --skip-nx-cache
NX   Successfully ran targets test, lint, typecheck for project fe-01
      Test Files  23 passed (23)
      Tests       507 passed (507)

$ bunx @fission-ai/openspec@1.3.0 validate --all --json
{"items": 36, "passed": 36, "failed": 0}
```

The 22 new tests: **12** in the new `actions-menu.test.tsx`, **9** in
`wbs-table.test.tsx` (the menu in the table, the delete's focus, the frozen
row), and **1** in `table-frame.test.ts` (the width). Four existing tests were
rewritten to go through the menu rather than the two buttons it replaced, and
two more had a stale sentence corrected; none was deleted.

**The two new tests in `apps/fe-01/e2e/layout.spec.ts` were not run at that
commit** — there is no browser on this machine. They ran on h2puni on
2026-08-08, during change 3, and the section below has been rewritten from
expectations into observations. Nothing in this document is a prediction any
more.

## The checks, and the faults that broke them

Every row below was watched failing with the fault in place and passing again
with it removed, one fault at a time, on h1claw on 2026-08-08.

### The menu itself (`actions-menu.test.tsx`, 12 tests)

| Check                                                          | Fault injected                                       | What the run reported                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exactly the focused item is a tab stop (roving `tabIndex`)     | `tabIndex={at === active ? 0 : -1}` → `tabIndex={0}` | **1 failed** — `moves the focus with the arrows, and the tab stop with it`, on `expected '0' to be '-1'`                                                                                                                                           |
| A busy menu takes nothing                                      | `if (busy) return;` deleted from `takeAction`        | **1 failed** — `shows its items as unavailable while a request is in flight, and refuses them`, on `Unable to find an accessible element with the role "menuitem"`: the first Enter took the action and closed the menu under the rest of the test |
| A menu that opened has something to focus (the effect's throw) | the `throw` replaced by a bare `return`              | **1 failed** — `refuses to open with nothing to focus`, on `expected [Function] to throw an error`                                                                                                                                                 |
| …and that check catches the wiring, not only an empty list     | the throw kept, the items' `ref` callbacks deleted   | **10 of the 12 failed** — every test that opens the menu, each on `The actions menu for 020 opened with no item 0 to focus.` The two that did not: the ARIA-only test, which never opens it, and the throw test itself                             |

All twelve were also watched failing before the component existed
(`Failed to resolve import "./actions-menu"`).

### The menu in the table (`wbs-table.test.tsx`)

| Check                                                      | Fault injected                                                                   | What the run reported                                                                                                                                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The actions cell does not clip its menu                    | `'actions'` dropped from `POPOVER_COLUMNS`                                       | **2 failed** — `does not clip the cells whose popovers open over the rows` and `gives every cell the chrome its declared width is measured with`, both on `expected 'hidden' to be 'visible'` |
| One menu open at a time                                    | the cell's `open` widened from `openMenuRowId === row.original.id` to `!== null` | **11 failed** — the named one, `opening one row’s menu closes the one already open`, on `Found multiple elements with the role "menuitem" and name "Duplicate"`                               |
| A parent's children are promoted, a leaf sends no strategy | `api.remove(row.id, { strategy: … })` → `api.remove(row.id)`                     | **2 failed** — `expected undefined to deeply equal { strategy: 'promote' }` and `expected undefined to deeply equal { strategy: undefined }`                                                  |
| The focus follows a delete                                 | the `focusNext` write removed from `deleteRow`                                   | **2 failed** — both delete-focus tests, on `expected <body>…</body> to be <textarea …>`: the deleted row takes its own ⋯ button with it, so nothing is left holding the focus                 |
| …and the row above is the fallback                         | `nextSibling ?? above` narrowed to `nextSibling`                                 | **1 failed** — `lands the caret in the row above when the last row is deleted`, on the same comparison                                                                                        |
| A refused delete moves the focus nowhere                   | the `focusNext` assignment moved in front of the `await`                         | **1 failed** — `says why a delete was refused, moves the focus nowhere and deletes nothing`, on `expected <textarea …> to be <button …>` — the caret in the name of a row nobody deleted      |

Nine of these tests were also watched failing before the cell was rewritten —
fourteen failures in that run, the other five being the existing Duplicate,
Unfreeze and popover tests rewritten to go through the menu.

### The width

| Check                      | Fault injected                                 | What the run reported                                                                                       |
| -------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `actions` is 40px, not 110 | the test run against the unchanged width table | `sizes the actions column for one ⋯ button rather than two labelled ones` failed on `expected 110 to be 40` |

### The browser spec — RUN, and both faults observed

**Run on h2puni on 2026-08-08**, inside the official Playwright image, against
the real three-tier stack — the branch at `5e0e6bc`, 22 tests, all passing
before and after each fault, one fault at a time. This section replaces the
expectations that stood here; codex's round-1 finding 4 asked for exactly that.

| Check                                       | Fault injected                                                      | What the run reported                                                                                                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The actions cell does not clip its menu (E) | `'actions'` dropped from `POPOVER_COLUMNS`                          | **2 failed** — `opens a row’s actions menu out past the bottom of its own cell` and `opens the last row’s actions menu at the right edge of a laptop`, on `4px below the actions cell is <div> in the no column, not the open menu` |
| DOM focus really moves into the menu (F)    | `item.focus()` dropped from the effect that follows the active item | **1 failed** — `drives the actions menu from the keyboard, and gives the focus back`, on `Expected: "Duplicate", Received: "⋯"` — the ⋯ button still holding the focus                                                              |

Two things the predictions got right and one they could not have: the overhang
assertions did **not** fail under E, exactly as fault D's note said they would
not; `drives the actions menu from the keyboard` passed throughout E, because
clipping is invisible to the focus; and the menu's own tests could not tell
either of those apart until a browser did.

### The Tab prediction, settled

This document named the assertion most likely to be wrong: Tab out of an open
menu was expected to land on the **next row's Name**, and would have landed on
the still-open menu item if React flushed the close _after_ the browser's
default action — a real focus trap, and a bug rather than a test to relax.

**It lands on `Name of 020`.** `expect(await label()).toBe('Name of 020')`
passed on the first browser run and on every run since, and so did the
click-beats-blur assertion after it (`Duplicate` taken by Enter, the copy's
Name focused with the copied text in it). The close and the focus return are
synchronous inside the handler, so the browser's Tab acts on the ⋯ button, and
the menu is already gone. Nothing was changed.

### What the browser also found

Two of this change's own tests **could not have passed**, and only a run could
say so. `keeps every control inside the cell it belongs to` asserted more than
twelve controls from a plan that has held exactly twelve since the Notes column
moved into the Name cell; and this change's own menu-escape test opened the
LAST row's menu and probed the FIRST row's cell — `no [role="menu"] is open in
tbody tr:first-child td[data-column="actions"]`, a throw it could only ever
have produced. Both are fixed in the commit that carries this run, and the
spec's footer records them.

## What is proven, and by what

**Proven by the repo gate, on this machine:** the menu's ARIA, its keyboard,
its click-outside, its busy state and its focus contract; the two-item
composition per row and the frozen row's Unfreeze; the promote strategy; where
the focus lands after a duplicate, after a delete, after a refused delete and
after an unfreeze; that the actions cell is exempt from the clip; and the
width. 507 fe-01 tests, the fault tables above.

**Checked rather than assumed:** the cheat sheet's `PROVEN_BY` map. The Tab
entry's prose changed ("that last row's Duplicate and Delete" → "that last
row's ⋯ menu"), and `PROVEN_BY` names behaviour tests rather than copy, so
nothing in it needed to move — `keyboard-cheat-sheet.test.tsx`, 21 passed, run
after the rewording.

**Verified in a browser on h2puni, 2026-08-08:** that the menu is really
unclipped in pixels, on the last row and at the right-hand edge of a 1280px
window; that DOM focus lands where the arrows say; where Tab out of the menu
goes; and that a click on an item beats the blur that closes it. All four were
this document's open items and all four now have a run behind them.

**Deliberately not covered:** a menu opened by a keyboard chord (there is
none — Tab past the last field of the last row is still how the ⋯ button is
reached), a submenu, and any action beyond the two that existed. The menu is
where more actions will go; this change adds none.

## One thing the unit tests cannot say

`closes on Tab and leaves the key to the browser` asserts two things — that no
handler called `preventDefault`, and that the menu closed with the focus back
on the button. It cannot assert the third, which is where the focus then goes,
because jsdom performs no default action for a synthetic key event. A menu that
closed and left the focus on the button but was somehow still in the tab order
would pass it. That gap is what the browser spec's Tab assertion is for, and
that assertion has now run: the focus lands on the next row's Name.
