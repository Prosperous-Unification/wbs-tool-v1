<!-- INTENT. Hard cap: 400 words excluding these comments. -->

## Why

The table reads in position order and the Gantt panel in time order, and on any plan with
dependencies, capacity or not-before floors the two disagree: the row that starts first can
sit at the bottom. Dany asked on 2026-09-10 for the table to be "nicely ordered for
examination of what's next" — a toolbar button that puts rows in the order their bars start.
Today that is a drag per row.

## What Changes

**Arrange by schedule.** One toolbar control asks be-01 to rewrite every sibling group's
positions so siblings read in the order their projections start — every group, every depth,
the whole plan. Rows starting together keep their order. A
frozen row keeps its place among its siblings and the others are arranged around it.

- From: the chart is the only place the sequence can be read.
- To: the table reads top to bottom as the chart reads left to right.
- Impact: non-breaking. One new plan command; the MCP tool derives it.

**One act to undo.** One journal entry whose inverse is the exact prior positions, one
`tree_replaced`, one plan-wide event. Undo is refused in the existing shape when a moved row
has changed, been deleted or been frozen since.

**It follows the drawn schedule** — Fast, or the ready optimized variant the project
displays — computed inside the write lock.

## Non-Goals

No client-side sort, no sortable headers. No re-parenting. No moving frozen rows, no implicit
unfreeze. No automatic re-arrangement after edits. No chord, no setting.

## Constraints

Positions stay integers spaced by ten; `deriveNumbers` is unchanged. The 200-command cap is
not the mechanism — the command is one. No migration. Positions are canonical schedule input,
so an arrangement re-solves an optimized plan exactly as a drag does today. The toolbar width
pins (`layout.spec.ts` 1600px, `project-settings.spec.ts` 1265px) are re-measured, never
loosened silently.

## Capabilities

### Modified Capabilities

- `wbs-domain`: a project arranges its sibling groups by the drawn schedule as one undoable
  act, frozen rows keeping their place.

## Domain Terms

Arrange by schedule — proposed in `design.md` D11, written to `CONTEXT.md` in task 0.1.

## Decisions Recorded

ADR 0023 — drafted in `design.md` D12, written in task 0.2.

## Impact

`libs/domain`, `libs/contracts` (command shape, wire fixture, OpenAPI), `be-01` (service,
repository, journal step), `fe-01` (toolbar control, toast, e2e), `mcp-01` (derived tool).
No schema change.
