<!--
INTENT. Hard cap: 400 words excluding these comments.
-->

## Why

`WorkItemRepository.listByProject` answers in whatever order SQLite chose. That array is not
merely displayed: `slicesOf` walks it in order, and `deriveNumbers` sorts each sibling group
**stably** — so where two siblings share a `position`, the repository's order breaks the tie,
and the derived number is the third of `goesFirst`'s four tie-breaks. Two reads of an unchanged
project can hand Fast two different argument tuples and produce two different plans.

A tied position is legal and reachable, not hypothetical: `work_item_siblings`
(`schema.ts:562`) is a plain index with no uniqueness, and `placeAfter` appends at
`last + POSITION_STEP` from a group it read outside any lock (`place-sibling.ts:53`), so two
appends racing on one parent both compute the same number.

TASK-219 wrote `ORDER BY work_item.id` for this select and **took it back out on the PR 203
review**: imposing an order moves an existing project's dates on the deploy that ships it,
regardless of `optimization_enabled`. That is a real change over a real population and it does
not belong inside a solver-core PR unannounced. This is that change, said out loud.

## What Changes

- `listByProject` orders by `work_item.id`, and its **response order becomes a stated
  contract** — in the JSDoc and in the spec — so a later reader knows the order is load-bearing
  rather than incidental.
- A `(project_id, id)` index, so the ordered read is index-served rather than a sort of every
  row in the project. Additive, which is what blue/green needs.
- The three tests TASK-219 excised come back verbatim, driving the real repository. All three
  go red with the `ORDER BY` absent — 31 pass / 3 fail against a green 34 / 0, measured in
  TASK-219 run 13.
- The one-time date movement is **measured against the live population and announced** before
  the deploy, not discovered: pre/post fixtures over projects holding two siblings tied on
  `position`.

## Non-goals

- **No repair of tied positions and no uniqueness constraint.** ADR 0016 records why: a
  migration over live `position` values does not remove the race that produces the tie, and a
  unique index turns that race into a failed write on a legal user action.
- Not making `placeAfter` re-read under a lock. Different subject, different change.

## Constraints

- Additive migration only; blue and green share one SQLite file during a swap.
- The optimized cache key is unaffected — `canonical-schedule-input` groups slices by work item
  rather than hashing the array it was handed, so nothing in TASK-219 rests on this.
