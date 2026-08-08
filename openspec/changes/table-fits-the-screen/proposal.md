# The table fits the screen

## Why

Dany, 2026-08-08: **"crucial elements must always be on screen"** — R6 of the
keys/notes/fit brief — and, in the amendments the same afternoon, "compact
every column as far as it will go" and "assignees must be visible _and_
editable in the folded role view".

The table did not fit. It declared a fixed total width and let the frame scroll
whatever did not fit, so on a 1280px laptop the dates, the slack and the row's
own actions were off the right-hand edge and only found by scrolling. Two of
the four changes in the plan have already given width back — the actions menu
70px, the Notes column 260 — and this is the one that spends it: every
remaining column is compacted to the figure it actually holds, and the Name
column stops being a number at all.

The arithmetic is the point, and it is why this is a change rather than a
tidy-up. With the v1.1 widths the fixed columns come to **752px**; Name's floor
is **200**; a folded role is **96** and an unfolded one **372**. So two roles
folded need 1144px and fit a 1280 laptop with room to spare, while one of them
unfolded needs 1420 and does not — which is what makes unfolding an accordion
rather than a set, and what keeps the pinned columns as the backstop under
everything narrower than the state's own minimum.

Making the assignee visible while folded is what unlocks the last of it: it is
what lets a role fold to one 96px column that still says who is doing the work,
instead of an estimate column that hides the person until 372px are spent.

## What Changes

**One flexible column, and an honest minimum**

- `table-frame.ts`: every fixed column compacted (drag 28→24, number 168→100
  with the indent step 16→12, depends 220→110, team 160→120, final-total 70→52,
  not-before 130→146 — more than it was asked to be, because an unconstrained
  `input[type=date]` asks this Chromium for 138px and the browser gate is what
  found that out — start 70→52, finish 70→52, float 90→56; a folded role
  110→96, a point box 76→52, an unfolded assignee 160→120).
- `name` leaves the width table for a `FLEXIBLE_COLUMNS` set: the `<colgroup>`
  emits no width for it and it absorbs whatever the others leave. `widthFor`
  keeps throwing `UnknownColumnError` for it, exactly as for a typo — a
  flexible column is not an unsized one, and the pinned arithmetic must not be
  handed a plausible number.
- `tableWidth` becomes `tableMinWidth`: the `<table>` is `width: 100%` with
  that as its `min-width`. Above it nothing scrolls sideways; below it the
  frame scrolls and the pinned columns hold the left edge.
- **Pinning stays.** `PINNED_COLUMNS`, `pinnedGeometry` and `pinnedCellStyle`
  keep working; the one change is that `pinnedCellStyle` no longer declares a
  `width` for Name, because the colgroup owns it.
- Headings shortened to fit: **Days**, **Start**, **End**, **Slack**. What the
  longer wording said moves into each heading's `title`, including whether the
  schedule columns are showing dates or day numbers.

**One role open at a time**

- Unfolding a role folds whichever was open. Not a preference: 1144px fits a
  laptop and 1420 does not.

**`@` assigns from the folded cell**

- A folded role's cell shows `4.8 · Kat` — the figure and who is doing it,
  truncated with the full name in the tooltip, the assumed name greyed and
  bracketed under the existing every-phase rule.
- Typing `@` in that cell opens the people picker, filtered by what follows it.
  Enter or a click assigns; nothing matching offers `Add "…"` through the same
  idempotent endpoint the unfolded picker uses; a bare `@` offers
  `Remove <name>` first. Escape closes and strips nothing.
- The estimate half and the mention half are held apart by a pure `split`, so a
  half-typed `@ka` can never read as a broken trio or commit on blur.
- `opensAPopover` extends to role `-final` columns, which is the narrowest clip
  in the table: a people list off a 96px cell.

## Non-Goals

- **No new fold state, and none shared.** Which role is open stays local to the
  reader and is not remembered across reloads, exactly as before.
- **No second control in the folded cell.** A `CreatablePicker` on a line of
  its own was rejected: two tab stops where Dany asked for one gesture, and a
  permanent height cost on every row.
- **No hiding of columns when a role opens.** Temporarily dropping Start/End/
  Slack to make one-unfolded fit 1280 is recorded in the plan and parked.
- **No responsive breakpoints and no column chooser.** One equation, one
  minimum, one backstop.

## Capabilities

### New Capabilities

- none

### Modified Capabilities

- `wbs-domain`: the table is laid out to the window rather than the window to
  the table; one role unfolds at a time; a folded role says who is doing the
  work and takes an `@` to change it.

## Domain Terms

- Flexible column
- Table minimum width
- Mention

## Impact

fe-01 only: `table-frame.ts` (+test), `wbs-table.tsx` (+test), new `mention.ts`
(+test), `creatable-picker.tsx` (its list extracted as `PickerList` so the
folded cell opens the same one), `cell-input.tsx` (an `onTyped` hook),
`keyboard-bindings.ts` and the cheat sheet's `PROVEN_BY`, `e2e/layout.spec.ts`,
`CONTEXT.md`. No be-01 change, no migration, no deploy change.
