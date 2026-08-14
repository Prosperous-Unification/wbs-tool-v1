<!--
INTENT. Hard cap: 400 words excluding these comments.

This file is named proposal.md because the OpenSpec CLI hardcodes that filename
(item-discovery, archive, change commands). It holds the intent artifact.

If you cannot state the intent in 400 words, the change is too big. Split it.
Alternatives go in an ADR. Approach detail goes in design.md, if at all.
-->

## Why

Dany, 2026-08-13: _"I want to separate team vs service in each of the work item;
can be several teams and several services per work item"_ — and, of the several
teams, _"every named team spends its own days"_.

R2-1 (`team-sets`) made the store hold a set and `effectiveTeamsOf` answer one.
It stopped there on purpose: the engine takes **one** pool per slice, so the
adapter throws on a second team rather than narrowing to the first. R2-2 is the
change that gives the engine the arity — the joint window search — and it is the
only change in the six that touches `schedule.ts`.

Nothing observable moves. The write path still writes at most one team, so
production sets stay ≤ 1 and a set of one is today's search verbatim. What
lands is the machinery a set of two needs, ahead of the release that can write
one — C1's own sequencing rule: the reader learns the shape before the writer
produces it.

## What Changes

**A slice carries pools, not a pool.** `Slice.poolId: string | null` becomes
`poolIds: readonly string[]`, so every reader of the old field is a compile
error rather than a silent first-member read.

**A joint window search.** `jointWindowFor(poolIds, width, duration, floor)` is
a fixpoint over the existing `windowFor`, which is untouched: ask every pool for
its window at the candidate, move the candidate to the latest answer, stop when
a round moves nothing. The block starts where **all** of its pools have room and
takes a slot from **each**.

**The width clamps to the narrowest pool.** A work item naming a team of 4 and a
team of 1 runs at width 1 — today's clamp under a set, and the bound that keeps
`CapacityTooNarrowError` an invariant rather than ordinary data.

**The payload names which pool ran out.** `ScheduledSlice.capacityTeamId`, set
exactly when `boundBy === 'capacity'`. The chart cannot read it off the row's
labels: with several teams the binding one need not be the first of them.

## Non-goals

fe-01 reading any of it — the wire type, the floor words, the bar colour, the
cells (R2-3, R2-4). The `service` label dimension (R2-5). Dropping
`work_item.service_team_id` (R2-6). Filtering (R10). No migration, no route, no
wire field fe-01 must learn to send.
