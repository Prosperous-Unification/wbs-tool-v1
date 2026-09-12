<!-- INTENT. Hard cap: 400 words excluding these comments. -->

## Why

The table reads in position order and the Gantt panel in time order; on any plan with
dependencies or floors the row that starts first can sit at the bottom. Dany asked on 2026-09-10 for the table to be "nicely ordered for
examination of what's next" — a toolbar button that puts rows in the order their bars start.
Today that is a drag per row.

## What Changes

**Arrange by schedule.** One narrow toolbar control asks be-01 to rewrite every sibling
group's positions so siblings read in the order their projections start. Rows starting together
keep their order. Frozen rows move with the
rest and keep the label that left the tool.

**A frozen number is a name, not a place** (Dany, 2026-09-10). Readers order rows by tree
position; unfrozen siblings take natural labels skipping frozen ones; Fast breaks ties by
tree order; a frozen row can be dragged. Cost: numbers stop reading as order in a group with
a moved frozen row.

**It follows the selected engine** — Fast, or the displayed optimized variant when ready;
refused `schedule_not_ready` while it solves.

**One act to undo**: one journal entry, one `tree_replaced`.

## Non-Goals

No client-side sort, no sortable headers. No re-parenting. No implicit unfreeze, no change
to what a freeze writes. No automatic re-arrangement after edits. No chord, no setting.

## Constraints

Positions stay integers spaced by ten. `deriveNumbers` keeps "no two siblings share a
label"; the golden corpus proves byte identity. No migration. Positions are canonical schedule input, so a press
re-solves an optimized plan exactly as a drag does today. The toolbar width pins
(`layout.spec.ts` 1600px, `project-settings.spec.ts` 1265px) are re-measured, never
loosened silently.

## Capabilities

### Modified Capabilities

- `wbs-domain`: a project arranges its sibling groups by the selected engine's schedule as
  one undoable act; a frozen number is a name, not a place.

## Domain Terms

Arrange by schedule, Tree order (new); Work item number, Frozen number (rewritten) — D11.

## Decisions Recorded

ADR 0023 "A frozen number is a name, not a place" — D12, task 0.2.

## Impact

`libs/domain`, `libs/contracts`, `be-01`, `fe-01`, `mcp-01` (derived tool). No schema change.
