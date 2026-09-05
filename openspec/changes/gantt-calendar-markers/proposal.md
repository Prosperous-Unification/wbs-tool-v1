<!--
INTENT. Hard cap: 400 words excluding these comments.

This file is named proposal.md because the OpenSpec CLI hardcodes that filename
(item-discovery, archive, change commands). It holds the intent artifact.

If you cannot state the intent in 400 words, the change is too big. Split it.
Alternatives go in an ADR. Approach detail goes in design.md, if at all.
-->

## Why

A plan is read against dates the plan does not contain: a client demo, an
external deadline, a holiday. Today the only way to put one on the chart is a
zero-duration work item — which enters the dependency graph, the critical
path, capacity, and every one of Fast, PRI and Time. The reader gets a mark
and the schedule gets a lie.

A calendar marker is an **annotation on an absolute date**, not work: visible
on the Gantt, invisible to the engine.

## What Changes

**A day cell becomes clickable.** The axis already renders one `<span>` per
day carrying `data-axis-day` and `data-axis-date` (`gantt-panel.tsx:3871`). A
click on a dated cell opens a composer for a name and a colour; the same cell
reopens an existing marker to rename, recolour or delete.

**Markers are drawn in two layers.** A coloured chip in the axis band, plus one
1px rule per date in its first marker's colour down the chart body **behind**
the bars — so bars and their critical-path stroke keep full
contrast and nothing needs a z-order table.

**The undated plan refuses, out loud.** `workdayAxis` cells carry no
`data-axis-date` at all, so the click is refused with a reason naming the
missing project start date, never silently ignored.

**Persistence is a project-scoped child table** and one content-free
`calendar_markers_changed` broadcast, matching `broadcast.ts`'s four existing
`*_changed` members.

## Non-Goals

- No external-calendar sync, recurrence, ranges, or cross-project markers.
- **No engine change of any kind**: no scheduler input field, no new
  `work_item` row, nothing `libs/domain/src/schedule.ts` can read.
- No marker in dependency, capacity, critical-path or saved-plan capture.
- No new colour system beyond one fixed accessible palette.

## Constraints

- Blue/green shares one SQLite file: the migration is additive, FK cascading.
- Three zoom rungs — 28 / 12 / 4 px per day. A label cannot live in a day cell
  at two of the three.
- `AXIS_NUMBER_PX` is 14; below it only `heavy` cells print anything.

## Capabilities

### Modified Capabilities

- `wbs-domain`: the Gantt gains a date-annotation overlay.

## Domain Terms

**calendar marker** — proposed here, written to `CONTEXT.md` on approval.

## Decisions Recorded

`docs/adr/` entry for the undated-plan refusal — decided in `design.md` §1,
filed by tasks slice 1.

## Impact

be-01: `repository/schema.ts`, one migration, a controller, `broadcast.ts`.
fe-01: `gantt-panel.tsx` axis cell and overlay. Nothing under
`libs/domain/src/schedule.ts` — that is the point.
