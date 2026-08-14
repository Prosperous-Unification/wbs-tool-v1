<!--
Ordered TDD slices. There is no separate plan.md in this schema — this file
absorbed it.

A slice is a coherent unit of behavior with a test that proves it, not a
two-minute keystroke. "Add a failing test for X, then make it pass" is ONE
slice.

Any slice that adds a safety check must also name the negative test proving the
check fails when the guarded thing is broken. See AGENTS.md, "Non-vacuous
checks". A check with no negative test is not done.

Only `- [ ]` checkboxes are tracked by the apply phase.
-->

## 1. The slice carries pools

- [x] 1.1 `Slice.poolId: string | null` → `poolIds: readonly string[]` in
      `apps/be-01/src/service/schedule.ts`. The shape changes rather than
      widening, so every reader is a compile error. Every fixture in
      `schedule*.test.ts`, `dependency.test.ts` and `work-item.service.test.ts`
      follows.
- [x] 1.2 `reserve` writes one reservation per pool, of the block's **whole**
      width. Negative: `reserve` narrowed to `poolIds.slice(0, 1)` — `takes a
slot from every pool it names, so both are busy behind it` fails with the
      block behind the second pool at day 0.

## 2. The joint window search

- [x] 2.1 `jointWindowFor(poolIds, width, duration, floor)` beside `windowFor`,
      which is untouched. Empty set short-circuits to the floor; a set of one
      delegates. Tests: `starts when the later pool frees a slot, not when the
earlier one does`, `names whichever team ran out, not the first of the
set`.
- [x] 2.2 The fixpoint re-asks every pool from the instant another pool pushed
      it to. Test: `re-asks every pool from the instant another pool pushed it
to` — the plan a single round gets wrong. Negative: the loop replaced by
      one pass over the pools from the floor, which the whole of `src/service`
      was green under until this test existed.
- [x] 2.3 The blocking set accumulates across rounds. Negative: taken from
      `binding`'s own sets instead — `edges every reservation either pool
stepped over` fails with an empty set.
- [x] 2.4 The `eventsVisited` bound re-stated for the fixpoint. Test: `visits a
bounded number of events, and the bound is the fixpoint's own`, beside
      the single-pool figure `schedule-capacity.test.ts` already pins at 2.

## 3. Which pool ran out

- [x] 3.1 `ScheduledSlice.capacityTeamId`, and `Placed` beneath it. Chosen as
      the binding pool whose blocking set holds the latest finisher, ties by
      pool id. Test: `breaks a tie between two pools on the blocker the reader
is looking at`. Negative: the tie taken on the id alone.
- [x] 3.2 The equivalence with `boundBy` written as an invariant rather than as
      a gate (design.md D5). Negatives, both watched: the single-pool arm's
      `start > floor` condition dropped (17 red in
      `schedule-capacity.test.ts`), and the fixpoint round's own `reached` set
      kept (5 red in `schedule-joint-capacity.test.ts`). Test: `names no team on
a slice no pool held up`.

## 4. The width clamps to the narrowest pool

- [x] 4.1 `poolFor` → `poolsFor` in `apps/be-01/src/service/work-item.service.ts`:
      every sized team is a pool, `slots` is the minimum of their sizes, an
      unsized team contributes neither. The `team-sets` arity refusal is
      deleted — it was the placeholder for this change. Tests: `spends in every
sized team the row names`, `takes the narrowest stated size, whichever
team states it`. Negative: `Math.max` for `Math.min`.
- [x] 4.2 `CapacityTooNarrowError` names which pool, asserted from the engine's
      side: `refuses a block wider than the narrowest of its pools, and says
which one`.

## 5. Identity — a set of one is what it was

- [x] 5.1 `capacity-migration-identity.test.ts` lifts `capacityTeamId` off every
      slice and asserts it: non-null exactly on capacity-floored slices, and
      equal to the row's own effective team. Negatives: the binding pool
      reported as `wrong-${poolId}`, and the single-pool arm made to answer the
      floor without consulting its pool.
- [x] 5.2 `priority-band-identity.test.ts`'s `lifted()` gains the same field, so
      the second reader of the same oracle is not a hole.
- [x] 5.3 `schedule-priority.test.ts`'s whole-field contention pin names
      `capacityTeamId: null` on all eight slices.
- [x] 5.4 `schedule-identity.test.ts`: `answers what one pool answered when a
second pool mirrors it exactly` — the fixpoint against the single search
      over the thousand-plan corpus, contended, compared as doubles rather than
      through `snappedSlack`.
