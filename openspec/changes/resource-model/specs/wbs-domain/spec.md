## ADDED Requirements

### Requirement: A work item's teams are a set, and the set is what a reader reads

The system SHALL hold the teams a work item is labelled with as a set of rows,
one per team, and every read of a work item's label SHALL come from that set
rather than from the single-valued column beside it.

A work item naming no team SHALL be **absent** from the set, never present with
an empty one: _unstated_ SHALL have exactly one spelling.

While this change is the deployed release, a write SHALL put at most one team in
a work item's set, and the single-valued column SHALL be written with it in the
same transaction, so that a release still reading the column reads the same fact.

A reader that can carry only one team SHALL refuse a set of two rather than
answer with one of them.

#### Scenario: a label written through the old field is read out of the set

- **GIVEN** a work item labelled with a team
- **WHEN** the plan is read
- **THEN** the work item's teams SHALL be that one team
- **AND** the answer SHALL come from the set, not from the column beside it

#### Scenario: clearing the label empties the set

- **GIVEN** a work item labelled with a team
- **WHEN** a client clears the label
- **THEN** the work item SHALL name no team
- **AND** the work item SHALL be absent from the plan's team sets rather than
  present with an empty one

#### Scenario: a duplicated branch is labelled like the branch it was copied from

- **GIVEN** a labelled work item
- **WHEN** it is duplicated
- **THEN** the copy SHALL name the same team
- **AND** the copy SHALL draw from the same pool as the row it was copied from

#### Scenario: a reader refuses a set of two rather than naming one of them

- **GIVEN** a work item whose set holds two teams
- **WHEN** a surface that can show only one team reads it
- **THEN** the read SHALL fail, naming the work item and both teams
- **AND** no plan, cell or document SHALL report either team as the answer

### Requirement: A service is a product area a work item wears, and it moves no date

The system SHALL hold a global, user-extensible list of services — product areas
such as Payments or Auth — and SHALL let a work item name a set of them.

A service SHALL have no size, no capacity, no members and no pool. No service id
SHALL reach the scheduler, and labelling any work item with any service SHALL
change no date, no float and no placed slice.

The list SHALL be global: a service SHALL NOT belong to a project, and the same
service SHALL mean the same thing in every plan.

A work item SHALL point at a service by id and SHALL NOT carry its name as text.

#### Scenario: labelling every row with services moves nothing

- **GIVEN** a plan whose dates a team's pool binds
- **WHEN** every work item in it is labelled with two services
- **THEN** every work item SHALL keep the schedule and the dates it had
- **AND** every placed slice SHALL be unchanged, the binding floors included

#### Scenario: the services a work item names are read back with it

- **GIVEN** a work item labelled with two services
- **WHEN** the plan is read
- **THEN** the work item SHALL name both services
- **AND** the order SHALL not change between two reads of an unchanged plan

### Requirement: Inheritance is override, per dimension, resolved independently

For each dimension separately, a work item's effective set SHALL be its own set
when that set is non-empty, otherwise the nearest ancestor's non-empty set for
**that** dimension, otherwise nothing.

An own set SHALL replace an inherited one whole and SHALL NOT be added to it.

A row whose ancestry states nothing for a dimension SHALL be absent from that
dimension's answer rather than present with an empty set.

A parent chain that runs in a circle SHALL be refused rather than answered with a
default.

#### Scenario: a row overrides one dimension and inherits the other

- **GIVEN** a parent naming a team and a service
- **AND** a child naming a different service and no team
- **WHEN** the plan is read
- **THEN** the child's effective services SHALL be its own
- **AND** the child's effective teams SHALL be its parent's

#### Scenario: an own set replaces the inherited one rather than joining it

- **GIVEN** a parent naming two teams
- **AND** a child naming one other team
- **WHEN** the plan is read
- **THEN** the child's effective teams SHALL be its own one team alone

#### Scenario: a parent chain that runs in a circle is refused

- **GIVEN** two work items each recorded as the other's parent
- **WHEN** the effective sets are resolved
- **THEN** the read SHALL fail, naming the row the walk started at

### Requirement: The migration seeds the team sets so that no plan moves

Applying this change SHALL write one team row for every work item that carries a
label, and none for a work item that carries none.

It SHALL leave the column it seeds from exactly as it found it, because a release
still serving reads that column.

It SHALL create no service and no service label: the list SHALL start empty.

It SHALL leave every per-project capacity row and every team membership
untouched, because a service has no size and is not a thing to be a member of.

Every plan SHALL schedule identically across the migration — every field of every
work item and every slice — asserted against an answer captured from the release
being replaced rather than one recomputed by the release replacing it.

#### Scenario: an existing plan's dates do not move

- **GIVEN** a plan whose work is labelled and whose teams are sized
- **WHEN** the migration is applied
- **THEN** every work item SHALL keep the schedule and dates it had
- **AND** every slice SHALL keep its binding floor and its blocking set

#### Scenario: an unlabelled work item is seeded nothing

- **GIVEN** a work item carrying no label
- **WHEN** the migration is applied
- **THEN** that work item SHALL name no team
- **AND** it SHALL be absent from the team sets rather than present with an empty one

#### Scenario: the outgoing release keeps working against the migrated schema

- **GIVEN** a database migrated by this change
- **WHEN** a release that knows nothing about the new tables deletes a team, or a
  work item
- **THEN** the delete SHALL succeed
- **AND** the rows naming that team, or that work item, SHALL go with it
