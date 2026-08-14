## ADDED Requirements

### Requirement: A block spends slots in every team it is labelled with

A slice SHALL draw its slots from **every** team its work item is effectively
labelled with that this project has stated a capacity for, and from no other
pool. A team the project has stated no capacity for SHALL label the work and
constrain nothing.

The block SHALL start at the earliest instant at or after its plan floor where
**every** one of those pools has room for its whole width for its whole
duration, and SHALL hold its whole width in each of them for that whole
duration. It SHALL NOT split its width between them.

A slice labelled with no sized team SHALL reserve nothing and wait for nothing,
which is the state of every plan that names no team.

#### Scenario: two teams, and the later one decides

- **GIVEN** a work item labelled with two teams, each holding one person
- **AND** the first team is busy until day 5 and the second until day 2
- **WHEN** the plan is scheduled
- **THEN** the work SHALL start on day 5

#### Scenario: a pool is re-asked from where another pool pushed the block to

- **GIVEN** a work item labelled with two teams, each holding one person
- **AND** the first team is busy until day 3
- **AND** the second team is free until day 3 and busy from day 3 to day 6
- **WHEN** the plan is scheduled
- **THEN** the work SHALL start on day 6

#### Scenario: every named team spends its own days

- **GIVEN** a work item labelled with two teams, each holding one person
- **AND** it runs for three days from day 0
- **WHEN** other work labelled with either of those teams is scheduled
- **THEN** that work SHALL wait until day 3

#### Scenario: a set of one is the search it always was

- **GIVEN** a plan whose work items each name at most one team
- **WHEN** the plan is scheduled
- **THEN** every date, every float and every blocking set SHALL be what they
  were before a work item could name several

### Requirement: A block is no wider than the narrowest team it names

A work item's parallelism SHALL be clamped down to the **smallest** stated
capacity among the teams it is effectively labelled with. A team the project has
stated no capacity for SHALL contribute no clamp.

Where a block is nonetheless wider than one of its pools, the plan SHALL be
refused with an error naming **which** pool it could not fit.

#### Scenario: the narrowest team decides the width

- **GIVEN** a work item that may have three people at once
- **AND** it is labelled with a team of four and a team of one
- **WHEN** the plan is scheduled
- **THEN** the work SHALL run one person at a time

#### Scenario: a refusal names the pool it could not fit

- **GIVEN** a block wider than one of the pools it draws from
- **WHEN** the plan is scheduled
- **THEN** the refusal SHALL name that pool

### Requirement: A capacity-floored slice names the team that ran out

A slice whose start was decided by capacity SHALL name **one** team: the pool
whose own earliest fit is that start. Where more than one pool pins it, the team
named SHALL be the one whose blocking set holds the latest-finishing
reservation, ties broken on the team's own id.

A slice whose start was decided by anything else SHALL name no team.

The blocking set SHALL hold every reservation that had to end for the block to
fit, across all of its pools, and the slice the reader is pointed at SHALL be
one of them.

#### Scenario: the team named is the one with no room

- **GIVEN** a work item labelled with two teams, one of which has room
- **AND** the other holds the work back
- **WHEN** the plan is scheduled
- **THEN** the slice SHALL name the team that held it back

#### Scenario: nothing held the block up

- **GIVEN** a work item labelled with two teams, both of which have room
- **WHEN** the plan is scheduled
- **THEN** the slice SHALL name no team
- **AND** its blocking set SHALL be empty

#### Scenario: both pools pinned the start

- **GIVEN** a work item whose two teams both free a slot at the same instant
- **WHEN** the plan is scheduled
- **THEN** the team named SHALL be the one whose blocking set holds the
  latest-finishing reservation
