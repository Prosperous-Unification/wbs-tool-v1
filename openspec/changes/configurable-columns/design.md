## Context

`table-frame.ts` owns every width: `COLUMN_WIDTHS`, `PLAN_WIDTHS`, the role
suffix widths, `FIXED_COLUMNS` ("on screen in every state") and
`CONDITIONAL_COLUMNS = ['tag', 'service']`, which `wbs-table.tsx`'s `columns`
memo honours with two `.filter`s keyed on `tagsExist` / `servicesExist`.
`foldedTableMinWidth` sums `FIXED_COLUMNS` + Name + one folded column per role
and is quoted by the Phases dialog and pinned by `e2e/layout.spec.ts` (`holds
the folded budget at 1280`: 1219px against 1248). Per-project-per-browser
memory already exists for widths (`wbs.columnWidths.<projectId>`) and saved
views (`wbs.views.<projectId>`), each read as a claim at the boundary.

## Goals / Non-Goals

**Goals:** one deterministic default column set; a reader-owned hidden list;
reset and saved views carry it; the budget gate unchanged.

**Non-Goals:** cards, exports, Gantt, hover cards, column order, server state,
merging Phases into the picker.

## Decisions

### D1 — a hide-list, not a show-list

Storage and state hold `hiddenColumnIds: readonly string[]`. A column added in
a later release is therefore visible by default without touching stored data,
and the default set is expressed once: `DEFAULT_HIDDEN_COLUMNS = ['team',
'service']` in `table-frame.ts`. `CONDITIONAL_COLUMNS` is deleted;
`FIXED_COLUMNS` becomes "every declared column" and `DEFAULT_COLUMN_SET` is that
list less the default-hidden ones. `foldedTableMinWidth(roleIds, state, hidden =
DEFAULT_HIDDEN_COLUMNS)` subtracts the hidden ids — a bare role id hides that
role's folded column — and throws on an id it does not know, so the Phases
dialog quotes the table actually on screen and a typo cannot hide nothing.

### D2 — a role is one entry

The picker lists roles, not `<roleId>-final` / `-optimistic` / `-assignee`.
Hiding a role stores its bare id; the `columns` memo drops every column whose id
starts with `${roleId}-` while the role stays in `roles` (so estimates still
roll up — be-01 computes the plan, the table only draws it). Folding stays in
`unfoldedRoles`.

### D3 — one remount per toggle

`hiddenColumnIds` joins `[roles, unfoldedRoles]` as a `columns` dep. The memo
rebuilds the column definitions, every cell remounts — the same cost a fold
pays, on the click that asked for it. The `.filter(each => each.id !== 'tag' ||
tagsExist)` pair is replaced by one `.filter(each => !isHidden(each.id))`.
Landmine from `LLM_README.md`: `roles` is still the only reference that must
stay stable; the hidden list is a primitive-array state, replaced only on a
toggle.

### D4 — saved views carry an optional `hiddenColumnIds`

`SavedView` gains `hiddenColumnIds?: readonly string[]`. `isSavedView` accepts
absent or string[] (the `isAbsentOrStringArray` posture the facets already
use). Save captures the current list; apply sets it and writes storage; absent
leaves columns alone. Save stays refused with no filter in force — the spec's
existing rule — so a columns-only view is not a thing; the picker's own memory
is the columns-only case.

### D5 — the Columns control reuses the Filters popover pattern

Same `Button` + popover as `FilterFacets`, a checkbox per hideable column in
table order, then a checkbox per role. `Reset layout` gains the hidden list in
`resetLayout` and in its "offered only while something is in force" predicate.

### D6 — the toolbar pays for its thirteenth control

Measured at 1280 with a plan of unestimated rows (`e2e/header.spec.ts`'s own
fixture): the bar is 1248px, row one held 1174px, and the Columns control
(78px) kept `N unestimated` (101px) off it, which pushed `Plan with` onto a
third row — the frame lost 36px. Five rare export actions took 683px of the
toolbar. They sit behind one `Export` `<details>` now, Undo/Redo are the glyphs
the ⌨ beside them already proved (aria-label and title keep the words), and the
Find box is `w-32`. Two rows again with ~500px to spare; every action keeps its
name, title and handler, so the export specs change only in where the action
sits. Dany's call, 2026-08-28: "not all buttons need to be this big".

## Risks / Trade-offs

- Every existing test that reads a Teams or Services cell now needs those
  columns shown first. Mitigation: a test helper that seeds
  `wbs.hiddenColumns.<projectId>` to `[]`, applied where the test is about
  those cells; the default-set tests assert the opposite.
- Hiding Teams hides the only place a row's own team is edited on desktop; the
  cards still edit it. Accepted: one click in the picker.
- The e2e budget test must pass **unchanged**. A re-pinned figure would be the
  vacuous-check shape R5 forbids; the proof is that it does not move.
