# Design — the landed joint-capacity engine

This is a retrospective description of the implementation on
`main@0cb148afe85fb307effb7e4bae90968d65177b6b`. The original August design was
written against `apps/be-01/src/service/schedule.ts`; refactoring commit
`eeaac94d` moved the engine to `libs/domain/src/schedule.ts` without moving its
domain contract.

## D1 — preserve the single-pool search and compose it

The one-pool `windowFor` search remains the primitive. `jointWindowFor` runs a
fixpoint over it:

1. begin at the supplied floor;
2. ask every pool for its first fitting window at that candidate;
3. advance to the latest answer;
4. re-ask every pool until no answer advances the candidate.

This is required because a pool that is free at the original floor can be busy
at an instant another pool chooses. A single pass answers that plan too early.
The candidate advances only to reservation boundaries from finite ledgers, so
the search terminates. Empty and singleton pool sets keep direct paths: no pool
returns the floor, and one pool returns `windowFor`'s answer directly.

## D2 — reserve the full block in every pool

`Slice.poolIds` is a set-shaped input. Once a window is accepted, reservation
writes the block's whole width and duration into every id in that set. Width is
not divided among pools: a three-day block labelled Alpha and Beta spends three
days of one slot in Alpha and three days of one slot in Beta.

Pool order is not scheduling policy. Current canonical schedule input sorts and
deduplicates it for hashing, and the window answer is a maximum over all pool
answers.

## D3 — clamp at the adapter boundary

`apps/be-01/src/service/work-item.service.ts` resolves effective team labels
before calling the engine. `poolsFor(teamIds, teamSizes)` keeps only teams for
which the project states a capacity and returns:

- every such id as `poolIds`; and
- the minimum stated size as the maximum usable width.

An unsized team remains a label but creates neither a pool nor a clamp. This
keeps missing pool sizes an internal caller fault instead of treating unknown
capacity as zero. `CapacityTooNarrowError` remains the engine-side assertion and
names the pool that cannot fit the supplied width.

## D4 — blockers accumulate, then causality narrows them

The fixpoint accumulates the reservations encountered across pools and rounds.
At annotation time, only reservations finishing by the accepted start become
capacity predecessors. A reservation that continues alongside a block because
the pool has more than one slot is not a predecessor; adding it to the backward
graph can make public float negative.

The binding team is selected from pools that pin the accepted start. The pool
whose valid blockers contain the latest finisher wins, then pool id breaks a
remaining tie. The displayed referent is selected from that chosen pool's valid
blockers, latest finish first and placement order for equal finishes. Thus the
team named in the capacity sentence and the arrow it draws are one causal
explanation.

If capacity did not move the slice off its plan floor, `capacityTeamId` is null
and capacity predecessors are empty. The engine asserts the equivalence between
`boundBy === 'capacity'` and a non-null binding team rather than manufacturing a
fallback explanation.

## D5 — identity and failure proofs

The single-pool path preserves the earlier engine contract. The focused suite
also covers multi-pool cases that distinguish the correct implementation from
plausible wrong ones:

- choosing the earlier pool answer instead of the later one;
- reserving only the first pool;
- taking blockers from only the final, empty fixpoint round;
- failing to re-ask a pool after the candidate moves;
- choosing the first team rather than the actual binding team; and
- treating an overlapping reservation as a causal predecessor.

The current file records the injected fault and watched failure beside each
claim. TASK-364 does not duplicate those tests; it proves their landed path and
runs a current remote control.

## D6 — what changed after the August proposal

The August branch deliberately stopped before multi-team writes and UI
readership. That boundary did not survive the route that actually landed:
TASK-182 / PR #175 shipped complete team-set writes, the engine port, response
typing, and the Gantt binding-team explanation together. Later refactors moved
the engine into `libs/domain` and strengthened schedule annotation and corpus
contracts.

Therefore PR #67 is neither a patch source nor a releasable intermediate. Its
value is historical: it holds the original decisions and watched evidence that
this archive reconciles with the implementation reachable on current `main`.
