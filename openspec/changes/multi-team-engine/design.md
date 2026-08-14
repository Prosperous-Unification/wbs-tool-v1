# Design — the joint window search

Written against `main@30e8c4c`. The authoritative design is
`notes/wbs-brief-2026-08-13-r2-team-service.md` §4 in the workspace; this file
holds the decisions the brief left open, the one place it contradicts itself,
and the arguments an implementation had to make on its own.

---

## D1 — `windowFor` is not rewritten. The joint search is a fixpoint over it.

`windowFor` (`schedule.ts:749`) is the tightest loop in the engine and carries
five watched proofs: the interior walk, the aggregation by timestamp, the two
`CapacityTooNarrowError` sites, and the termination argument. Every one of them
is a statement about **one** pool and stays true.

So `jointWindowFor` asks it once per pool per round:

```
candidate = floor
loop: starts = poolIds.map(p => windowFor(p, width, duration, candidate))
      best   = max(starts)
      if best === candidate: answer
      candidate = best
```

**Termination.** Reservations are immutable, so a pool's answer is a function of
the candidate alone. A round that does not finish moves the candidate *strictly*
forward onto an instant some pool's event list holds; the union of those lists
is finite; past the last of them every pool is empty, where `width <= size`
always fits — which is what the up-front width refusal guarantees. A round that
moves nothing is the answer by definition.

**Cost.** `O(rounds × pools × events)` against today's `O(events)`. The bound is
re-stated and re-watched in `schedule-joint-capacity.test.ts`'s last case, which
is what the brief asks for: `schedule-capacity.test.ts`'s `eventsVisited` claim
is a claim about the work a placement does, and it could not simply be deleted.

*Rejected:* a single joint scan over a merged event list of all the pools. It
would be one pass instead of several, but it is a rewrite of `windowFor` — a new
interior walk, a new aggregation, a new termination argument, and five proofs to
re-derive — inside the change that is already moving the arity. The fixpoint
reuses all five. If the rounds ever cost anything measurable, the merged scan is
the optimisation, and it lands against a test suite that already pins the
answers.

---

## D2 — a set of one takes an explicit short-circuit, and why that is not hiding the general path

`jointWindowFor` returns `windowFor`'s answer directly when `poolIds.length ===
1`. It is provably the same answer: a second round would ask the pool for its
window at its own answer, where the block fits for the whole duration by
construction, and get that instant back with an empty blocking set.

It is there for a measured reason rather than for tidiness. `eventsVisited` is
on `Schedule` because the alternative was a wall-clock assertion, and
`schedule-capacity.test.ts` pins one plan's figure at exactly `2`. Running a
confirmation round for every pooled slice on the deployment would double that
number to re-derive an answer already in hand.

**What stops it hiding a bug in the loop:** the loop is exercised over the
thousand-plan corpus by `answers what one pool answered when a second pool
mirrors it exactly` (`schedule-identity.test.ts`). Two pools of the same size,
spent by the same blocks, are one pool wearing two names, so the fixpoint's
answer must be the single search's — every date, every blocking set, every
float. That test drives the loop, not the short-circuit, on 1,000 plans, and its
`contended` counter refuses a green run in which no pool ever said no.

---

## D3 — the blocking set accumulates across rounds. The brief says both things.

Brief §4 says the answer carries the "union of every scan's blocking set"; brief
§4's *Float edges* paragraph says it is "the union of the blocking sets over the
binding pools' final scans". Those are different sets, and the second one is
**empty**.

At the fixpoint every pool answers the candidate *because it fits there*, so
every scan of the final round records nothing at all. What each earlier round
records is why the block could not start where it was asked to — which is
exactly "every reservation that had to end for this block to fit", the sentence
`ScheduledSlice.capacityPredecessorIds` is written to.

**Decision: accumulate across every round and every pool.** Watched: reading
`binding`'s own sets instead gives `[]` where two holds were owed, and the slice
then claims a capacity wait while edging nothing — every blocker reads as free
to slip, which is the exact class of fault D8 exists to prevent.

D8's one-sidedness survives a union unchanged. The set is a superset of the
causes of a disjunctive constraint, so the graph stays at least as tight as
reality and no row is ever reported movable when it is not. The fixture in
`schedule-joint-capacity.test.ts` is deliberately the loose case — a hold that
could in truth slip and is reported tighter — and says so.

---

## D4 — `binding` is the round that moved, not every pool that ever pushed

A pool that pushed the candidate early and had room at the answer is no longer
the reason for the answer. So `binding` is overwritten each round and holds the
pools whose own earliest fit is the **final** start.

Consequence, stated because it is the one a reviewer will ask about: with pools
A and B where B pushes the block from 0 to 5 and A then pushes it from 5 to 7,
the slice names **A** alone. B had room at 7. The sentence is about the date the
reader is looking at, not about the history of the search.

*Rejected:* carrying every pool that ever pushed. It reads as "waiting for A and
B" on a plan where B is free, which is the same wrong-name fault the whole field
exists to prevent, one step out.

---

## D5 — `capacityTeamId` is read off the search and then checked against `boundBy`

The obvious shape is `boundBy === 'capacity' ? tightestOf(binding) : null`. It
is a gate that **cannot fail**: a pool binds exactly where it pushed the block
off the plan floor, and a floor strictly past the plan's own is what `capacity`
means, so the two conditions are one fact. This repo has shipped a check that
could not fire six times, and once this month (#60's ladder guard).

So the field is computed from the search unconditionally, and the equivalence is
written as the invariant instead:

```ts
if ((boundBy === 'capacity') !== (capacityTeamId !== null)) throw …
```

Both arms are watched — one by dropping the single-pool arm's `start > floor`
condition (17 tests red), one by keeping the fixpoint round's own `reached` set
(5 red). A gate would have swallowed both silently.

The same argument runs one level down: the loop that picks the tightest pool
names a binding pool **whether or not its blocking set is empty**. An empty set
is unreachable — a pool that pushed the candidate had a reservation in the way,
or the width refusal fired first — but if the loop skipped it, `binding`'s own
condition would stop being load-bearing and the two injections above would go
green. Measured, not reasoned: the first version of this loop skipped it, and
both injections passed 25/25 and 8/8.

---

## D6 — the tie between two equally tight pools

Named the pool whose blocking set holds the latest-finishing reservation, ties
by pool id. That is `resourcePredecessorId`'s own rule (`schedule.ts:1104`), one
level up, and picking it means the team the sentence names and the slice the
arrow points at are answers to the same question.

*Rejected:* the pool id alone. Deterministic, but it names a team whose blocker
the chart does not draw, on a plan where the other team's blocker is the one the
reader is looking at.

Ties past that fall to the id because the pass needs a total order and the id is
the only one that does not depend on set order or placement order.

`boundBy` gains no seventh member and the whole set of binding pools is not
carried: the chart's "and N other teams" is R2-3's, and what the reader is owed
here is the blocking *slices*, which `capacityPredecessorIds` already holds.

---

## D7 — the width clamps to the minimum, and an unsized team clamps nothing

`poolsFor` (`work-item.service.ts`) answers `{poolIds, slots}` where `slots` is
the **minimum** stated capacity over the row's effective team set. It is a
correctness bound rather than a policy: a block wider than the narrowest of its
pools can never be placed there, and without the min `CapacityTooNarrowError` —
an invariant about the caller's clamp and these sizes coming apart — becomes
reachable from ordinary data.

An unsized team is absent from `teamSizes`, so it is absent from `poolIds` and
contributes no clamp. Unstated is not a capacity of zero; reading it as one
would move dates nobody typed, which is `capacity-per-project` D1's no-fallback
rule under a set.

---

## D8 — fe-01 is not touched, and `wbs-api.ts` is left for R2-3

`capacityTeamId` reaches the payload because `work-item.service.ts` spreads the
whole `ScheduledSlice`. fe-01's `ScheduleSliceView` does not declare it, and
does not have to: an extra field on the wire is not a breaking read, and the
existing drift test only catches FE-side drift.

Declaring it here would mean every fe-01 fixture that constructs a slice view
gains a field — several dozen of them, in `apps/fe-01/src/components/wbs/`,
which three other agents own tonight. R2-3 declares the field in the same change
that reads it, which is also where the words that use it are written.

**The consequence, stated rather than left to be found:** until R2-3 ships, the
chart still names the row's own team in the floor sentence. On production data
that is right — every set is of one — and it stops being right the moment a
release can write two, which is R2-4. The order in the brief's split already
says R2-3 must not merge after R2-4.

---

## D9 — what this change does *not* do to the engine

`goesFirst` and the whole priority order (capacity-engine D7 — capacity never
reorders). The aggregation-by-timestamp profile (D9). The anchor arithmetic, the
tiling rule, `held`, `offsets[]`, the prefix sum (D1). `lateTimes` and
`hasResourceEdges` (D11) — more edges, same rule, read from the edges actually
emitted, and the corpus differential is what says so.

`PoolSizes` keeps its shape: `Map<teamId, size>`, no project component, no
separator to typo (capacity-per-project D3's surviving half).

---

## Open question for Dany

**A named person on multi-team work spends a slot in every one of those pools.**
capacity-engine D2 dismissed "which of kat's teams does her hour come out of" as
aimed at the wrong key, *because the item names exactly one*. After this change
an item may name three, and one named human then spends three slots while being
one person. That is decision 3 applied literally, and it is what this change
implements; the brief flags it (§7) as an argument that needs rewriting rather
than citing. Nothing in production can reach it yet — the write path writes at
most one team — so it is recorded here rather than guessed at.
