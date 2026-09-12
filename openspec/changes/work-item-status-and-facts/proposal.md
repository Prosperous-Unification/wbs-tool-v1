<!-- INTENT. Hard cap: 400 words excluding these comments. -->

## Why

A plan's timeline keeps moving while some of its work is finished, and nothing on screen says
which rows are done: the per-step progress be-01 has stored since 2026-08-18 has no face, and
a finished task whose estimate drifts is redrawn as still ahead. Dany,
2026-09-12: "marking as done tasks that were done while project timeline still evolves".

## What Changes

**Status has a face.** A `Status` column reads the work item's status — unknown, in progress,
done — the fold be-01 already derives from step progress. Done writes `done` on every step of
the project for that row, or for every leaf beneath a parent, as one undoable act; unknown
takes every statement away. `not_started` becomes `unknown`:
never stored, and Dany's word.

**Two facts beside the forecast.** `fact_start` and `fact_end`, nullable date-only columns on
`work_item`, edited in two new columns. Marking done fills an empty fact end with the day of
the act — the reader's day, or be-01's.

**The chart draws what happened.** A done work item draws one done bar from its fact start
(or its first slice's start) to its fact end, in place of its slices, marked as done; whatever
the estimate, it never reaches past the fact end. Arrows and person links leave the done bar;
the table strikes the row through.

## Non-Goals

The engine reads neither facts nor status: successors still wait on the forecast, Start and
End keep it, a parent's bracket stays be-01's projection. No row-level `in_progress` (a step's
statement), no `blocked` or `cancelled`, no time of day, no saved-plan or compare field, no
import. A duplicate copies no fact.

## Constraints

Additive migration with `down.sql`; the nine ledger tests move. One new command, `setStatus`;
the command-kind pins in contracts and mcp-01 move by one. All three columns hidden by default
(the 1280px folded budget, deadline's precedent). Fact dates are `IsoDate` on any work item,
never handed down — deadline's shape.

## Capabilities

### Modified Capabilities

- `wbs-domain`: a work item's status has a face and is set per row as one act; two fact
  dates; a done work item draws its fact span.

## Domain Terms

Progress, Status, Fact start, Fact end, Done bar — new, in `CONTEXT.md`.

## Decisions Recorded

ADR 0024 "A done work item draws its facts, not its slices".

## Impact

Every lib, `be-01` (migration), `fe-01`, `mcp-01` (derived tool).
