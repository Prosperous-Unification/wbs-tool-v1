<!--
INTENT. Hard cap: 400 words excluding these comments.

This file is named proposal.md because the OpenSpec CLI hardcodes that filename
(item-discovery, archive, change commands). It holds the intent artifact.

If you cannot state the intent in 400 words, the change is too big. Split it.
Alternatives go in an ADR. Approach detail goes in design.md, if at all.
-->

## Why

One entity does two jobs. `service_team` is the pool the scheduler spends slots
in **and** the label a work item wears, and a work item carries at most one of
them — one nullable column, no join table.

Dany, 2026-08-13: _"I want to separate team vs service in each of the work item;
can be several teams and several services per work item"_, and at 23:41 what a
service is: _"A label."_ A product area — Payments, Auth — with no size, no pool
and no effect on any date. Capacity stays teams-only, and the two live in two
tables (Q1, 23:39). The list of services is global and user-extensible (Q7,
23:59).

R2-1 is the first of six changes and deliberately the dullest: **the schema and
the read model, with nothing observable moving.**

## What Changes

**A work item's teams become a set.** `work_item_team`, seeded one row per work
item that carried a label, and every read path — the scheduler's adapter, the
directory's removal, the table, the cards, the chart, the export, the Teams
dialog — switched to it.

**One inheritance rule, per dimension.** `effectiveTeamOf` is deleted;
`effectiveSetOf(rows, membersOf)` replaces it. Override, not union; blank is
unstated; each dimension resolves alone. The rename is the point — a function
still answering `.teamId` would leave every reader compiling and silently
dropping teams.

**The service tables arrive empty.** `service` and `work_item_service`, global,
no `project_id`. The read model carries `serviceIds` on every row; nothing
creates one until R2-5.

**Writes stay capped at one member.** The column is still written, mirrored into
the join inside the same transaction, and `soleMemberOf` refuses a plural set
rather than spending its first member. So no date can move, and the committed
capacity oracle proves it field by field.

## Non-goals

The multi-pool engine (R2-2). Any UI that draws a set, or the `Teams`/`Services`
export columns (R2-3). Writing more than one member (R2-4). The service
directory, its routes and its picker (R2-5). Dropping the column or renaming
`service_team` (R2-6).
