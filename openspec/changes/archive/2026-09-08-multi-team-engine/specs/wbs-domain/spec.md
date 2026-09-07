## ADDED Requirements

### Requirement: A block spends slots in every team it is labelled with

A slice SHALL draw its slots from every effective team for which the project
states a capacity, and from no other pool. An effective team with no stated
capacity SHALL label the work but SHALL NOT constrain it.

The block SHALL start at the earliest instant at or after its plan floor where
every pool has room for its whole width for its whole duration. It SHALL reserve
that whole width in every pool and SHALL NOT split its width between pools.

A slice with no sized effective team SHALL reserve nothing and wait for
nothing.

#### Scenario: the later team decides

- **GIVEN** a block labelled with two teams of capacity one
- **AND** one team is busy until day 5 and the other until day 2
- **WHEN** the plan is scheduled
- **THEN** the block SHALL start on day 5

#### Scenario: every named team spends its own days

- **GIVEN** a block labelled with two teams of capacity one
- **AND** the block runs for three days from day 0
- **WHEN** later work labelled with either team is scheduled
- **THEN** that work SHALL wait until day 3

#### Scenario: a pool is re-asked after another pool moves the candidate

- **GIVEN** one pool is busy from day 0 through day 3
- **AND** a second pool is free until day 3 and busy from day 3 through day 6
- **WHEN** a block requiring both pools is scheduled from day 0
- **THEN** the joint search SHALL re-ask both pools and start the block on day 6

#### Scenario: one pool preserves the prior search

- **GIVEN** every block in a plan names at most one sized team
- **WHEN** the plan is scheduled
- **THEN** its dates, float, and blocking sets SHALL match the single-pool
  scheduling contract

### Requirement: A block is no wider than the narrowest team it names

A block's parallelism SHALL be clamped to the smallest stated capacity among
its effective teams. A team with no stated capacity SHALL contribute neither a
pool nor a clamp.

If an internal caller nevertheless asks for a block wider than one of its
pools, the engine SHALL refuse the plan and name the pool that cannot fit it.

#### Scenario: the narrowest team decides width

- **GIVEN** a work item allows three people in parallel
- **AND** it is effectively labelled with teams of capacity four and one
- **WHEN** the plan is scheduled
- **THEN** the block SHALL run one person at a time

#### Scenario: a refusal names its pool

- **GIVEN** a block is wider than one pool it must reserve
- **WHEN** the engine is called without the adapter's clamp
- **THEN** the refusal SHALL name that pool

### Requirement: A capacity-floored slice names the team that ran out

A slice whose accepted start was decided by capacity SHALL name one binding
team. Among pools that pin the accepted start, the chosen team SHALL be the one
whose valid blocking set contains the latest-finishing reservation, with
remaining ties broken by team id.

A slice whose start was decided by another floor SHALL name no capacity team.
Its capacity predecessor set SHALL contain only reservations that finish by the
accepted start and SHALL include every such reservation that had to end for the
block to fit. The displayed predecessor SHALL come from the chosen team's valid
blocking set.

#### Scenario: the team without room is named

- **GIVEN** a block requires two teams and only one holds it back
- **WHEN** the plan is scheduled
- **THEN** the slice SHALL name the team that held it back

#### Scenario: nothing held the block up

- **GIVEN** every required pool has room at the plan floor
- **WHEN** the block is scheduled
- **THEN** the slice SHALL name no capacity team
- **AND** its capacity predecessor set SHALL be empty

#### Scenario: an overlapping reservation is not a predecessor

- **GIVEN** a pool has enough capacity for the block at the accepted start
- **AND** another reservation in that pool continues past the accepted start
- **WHEN** capacity predecessors are recorded
- **THEN** the continuing reservation SHALL NOT become a predecessor
- **AND** every published slice SHALL retain non-negative float
