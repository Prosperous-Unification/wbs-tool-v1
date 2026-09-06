## ADDED Requirements

### Requirement: The work-item read answers in a stated order

`WorkItemRepository.listByProject` SHALL answer its rows in ascending `work_item.id` order.
The order SHALL be part of the method's contract, stated in its JSDoc, and not an incidental
property of the query plan.

Two reads of a project no write has touched SHALL answer the **same array in the same order**.

The order SHALL be imposed by the query rather than by the caller, because the caller cannot
restore it: `slicesOf` walks these rows in order and emits its `slices` argument in that order,
so an unordered read reaches Fast as a different argument tuple, not as a display detail.

A sibling group whose members hold **distinct** `position` values SHALL be scheduled
identically whatever order the rows were written in — `deriveNumbers` takes the labels off
`position` alone, so the read order is not observable there.

A sibling group holding **tied** `position` values SHALL be resolved by ascending
`work_item.id`. A tie SHALL NOT be an error: `work_item_siblings` is a plain index and
`placeAfter` appends without a lock, so two appends racing on one parent legally produce one
number twice (ADR 0016).

The ordered read SHALL be served by an index on `(project_id, id)` rather than by sorting every
row in the project.

#### Scenario: two reads of an unchanged project

- **WHEN** a project's work items are read twice with no write in between
- **THEN** both reads answer the same ids in the same order, and that order is ascending
  `work_item.id` — not the order the rows were written in

#### Scenario: siblings tied on position

- **WHEN** two siblings of one parent share a `position`, share a one-slot team pool, and the
  project is scheduled
- **THEN** the sibling with the lower `work_item.id` takes the slot first and the other waits,
  whichever order the two rows were inserted in

#### Scenario: siblings with distinct positions

- **WHEN** two siblings hold distinct `position` values
- **THEN** the schedule is byte-identical whichever order the rows were written in, because the
  derived numbers come off `position` and never reach the tie-break

#### Scenario: the ordered read is index-served

- **WHEN** `EXPLAIN QUERY PLAN` is taken over the ordered select on a migrated database
- **THEN** it reports a `SEARCH` using the `(project_id, id)` index, not a `SCAN` followed by a
  `USE TEMP B-TREE FOR ORDER BY`
