<!--
INTENT. Hard cap: 400 words excluding these comments.

This is the recovered record for behavior that reached main through PR #175
without its own OpenSpec directory. It is archived directly because the
behavior is already shipped; TASK-364 closes the record hole rather than
proposing another implementation.
-->

## Why

Dany, 2026-08-13: _“every named team spends its own days.”_ A work item can be
labelled with several effective teams, and its scheduled block must consume its
whole width in every sized team's pool. The August `multi-team-engine` branch
implemented that contract, but PR #67 was closed and its OpenSpec directory
never reached the repository.

The behavior did reach `main` by another route: TASK-182 / PR #175 ported the
joint-capacity engine and its tests while delivering multi-team writes. TASK-364
recovers the missing specification against current source and archives it, so
the record no longer depends on a stale branch.

## What Shipped

- `Slice.poolIds` carries every sized effective team.
- The joint window search finds the first interval where every named pool has
  room, and reservation spends the block's whole width in every pool.
- Parallelism clamps to the narrowest named, sized team.
- A capacity-floored slice names the binding team and keeps the causal blocking
  set used by the schedule graph and UI explanation.

## Reconciliation of the August Proposal

The original proposal was correct about the required scheduling semantics but
four present-tense claims are now false:

1. **“Nothing observable moves” / production sets stay at most one.** PR #175
   also shipped bounded multi-team writes. `poolsFor` now accepts the complete
   effective team set, so current plans can exercise the multi-pool path.
2. **The engine lives under `apps/be-01/src/service`.** Refactoring commit
   `eeaac94d` moved the engine and its focused tests to `libs/domain/src`.
3. **fe-01 does not read `capacityTeamId`.** PR #175 and later refinements
   carried it into the shared response and Gantt capacity explanation.
4. **The August branch is the implementation source.** The authoritative
   landed route is PR #175 (`14b9ffa5`) plus later `main` refinements. PR #67's
   branch is historical evidence only and must not be merged.

The TASK-364 intake also said joint-capacity coverage was absent from `main`.
That was a path-search error: the coverage exists today at
`libs/domain/src/schedule-joint-capacity.test.ts` and its history traces through
PR #175 to the original August test commit `d8a09ce2`.

## Non-goals

No scheduling behavior, migration, route, payload, or UI change. No duplicate
test is added merely to replace one already present. This change restores the
specification and re-verifies the existing implementation and coverage.
