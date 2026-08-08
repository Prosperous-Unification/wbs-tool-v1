# Design

Only two things here are non-trivial: who owns the DOM focus, and how a
component that has to be re-rendered per keystroke lives inside a `columns`
memo that must not be.

## The focus, and who is holding it

A menu button is one of the few controls in a browser that has no native
element, so every part of it is a decision. The ARIA menu button pattern is
followed rather than invented — button with `aria-haspopup="menu"` and
`aria-expanded`, `role="menu"` on the box, `role="menuitem"` on each item,
roving `tabIndex` — with two deliberate narrowings.

**The menu is not a focus trap.** Tab closes it and lets the browser move on.
A trap would need a backdrop, an `inert` sibling tree and a reason; this menu
holds two items and sits in a table that is walked with Tab. What Tab does
here, exactly: the item's handler closes the menu and puts the focus back on
the ⋯ button **without** `preventDefault`, so the browser's own Tab then moves
from the button to the next tab stop — the next row's ⋯ button. That ordering
is the one thing in this change jsdom cannot see (it performs no default
action for a synthetic key event), so the unit test asserts the half jsdom
does have — the menu closed, the button focused — and the browser spec asserts
where the focus actually ends up.

**DOM focus really moves.** `aria-activedescendant` is the other legal answer
and it is the wrong one here: the items are buttons, and a button that is
"active" without being focused takes no Enter of its own. Moving the focus
means every item is an ordinary button whose click and key handlers are the
same code path.

**The active item must exist.** The effect that focuses it throws when the
item it was told to focus is not there. That is not defensive noise: the ref
callbacks that collect the items are exactly the wiring that would break
silently, leaving `aria-expanded="true"` on a button that still has the focus
and a menu the keyboard cannot reach. It is thrown from an effect, never from
`render`, and `wbs-table.tsx` never renders the menu with an empty action
list.

**Where the focus lands after each action** is the caller's business, not the
menu's, with one exception. The menu always closes and returns the focus to
its own button — which is the whole answer for Unfreeze, and the starting
point for the other two: `duplicateRow` and `deleteRow` write `focusNext`
after be-01 has taken the change, and the existing focus machinery moves the
caret into the Name of the row that arrives. A refused request therefore
leaves the focus on the ⋯ button, which is where the person left it.

`deleteRow` is new only in that respect. The target is computed from the tree
**on screen before the request** — the next sibling in the row's own group,
else the row above it in the flattened tree, else nothing — and assigned only
once `api.remove` has resolved, the same rule `duplicateRow` states. For a
work item with children, deleting with `strategy: 'promote'` lifts those
children into its place, so the next sibling is below them rather than
immediately below the gap; that is the sibling group's own "what took its
place", and it is stated here because the other reading (first promoted child)
is defensible too and nobody should have to guess which was meant.

## Disabled, not removed

While `run()` has a request in flight the items carry `aria-disabled="true"`
and refuse activation, rather than disappearing or being `disabled`.

Native `disabled` was the first attempt and it is wrong for a menu: a disabled
button cannot hold the DOM focus, so a menu that goes busy while it is open
drops the focus on the floor, and one opened while busy has nothing to focus —
which is exactly the state the throw above would report as a bug in the
wiring. `aria-disabled` keeps every item focusable and reachable by the arrows
and makes activation a no-op, which is the ARIA pattern's own answer for this.

## Living inside the `columns` memo

`columns` in `wbs-table.tsx` depends on `roles` and `unfoldedRoles` and
nothing else, permanently: `flexRender` renders each `cell` as a component
type, so a rebuilt definition remounts every cell in the table and eats the
focus and any half-typed value. Which menu is open changes on a click and
would remount the table under the menu it just opened.

So `openMenuRowId` is state read through the `live` ref, exactly as
`depPicker` is — the state change re-renders the table, the cell functions run
again, and they read the current value out of a ref rather than out of a
closure the memo would have to be rebuilt to refresh. `busy` joins `live` for
the same reason.

One open menu at a time falls out of holding a single row id rather than a set,
and it is worth one line of why: two open menus are two sets of `menuitem`s
with the same accessible names, and "Duplicate" would then name as many
elements as there were open menus — to a screen reader and to a test alike.
That is the same argument that put the row number on the old buttons'
labels, which is why the items themselves can now be plainly named.

## What the width is

`actions` drops from 110 to 40. The button is one glyph; 40px is the cell it
needs with `CELL`'s padding included. The menu is 140px wide and opens from
the cell's right edge (`right: 0`), because `actions` is the last column and a
box hanging off its left edge would open over the table rather than off the
end of it.
