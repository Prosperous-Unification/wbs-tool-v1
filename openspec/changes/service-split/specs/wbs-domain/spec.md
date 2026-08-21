## ADDED Requirements

### Requirement: A work item carries one service, and a service decides nothing

A work item SHALL carry at most one **service** — the product area the work
belongs to — alongside its set of teams and its set of tags. The dimensions
answer different questions: a team says **who does the work** and the scheduler
spends its capacity, a tag says **what kind of thing this is**, a service says
**what product area this delivers**. An item answers all three at once, and each
answer SHALL be independent of the others.

A service SHALL be a row in a global directory: a name, unique across the
deployment, with **no project**, no pool, no size, no capacity row and no
membership. The scheduler SHALL NOT read a service: adding, changing or removing
one SHALL move no start, no finish and no floor anywhere in the plan. That
absence SHALL be asserted rather than assumed, and the assertion SHALL carry a
control proving the plan's dates answer to a label at all.

A service SHALL NOT colour a bar.

#### Scenario: a service moves no date

- **GIVEN** a plan whose dates are decided by a sized team
- **WHEN** every work item is given a service, and the services are then cleared
- **THEN** every start, finish and floor in the plan is what it was

#### Scenario: the vocabulary is global

- **WHEN** a service is created
- **THEN** it is available to every project in the deployment, and it belongs to
  none of them

#### Scenario: two names cannot collide

- **GIVEN** a service named `Payments`
- **WHEN** a second service is created with that name
- **THEN** it is refused as taken, naming the service that survives

#### Scenario: a work item states one service, not several

- **WHEN** a work item is given a service while it already carries one
- **THEN** it carries the new one and only the new one

### Requirement: Services are inherited by override, per dimension, independently

A work item stating no service SHALL read as its nearest ancestor's service, and
a work item stating a service SHALL read as exactly that one — override, never
union. Blank SHALL mean inherit; there SHALL be no third "deliberately none"
state, exactly as there is none for teams and none for tags.

The three dimensions SHALL inherit **independently**: a row stating a service
and no teams SHALL inherit its ancestor's teams and override its ancestor's
service, and the mirror cases SHALL hold. Inheritance SHALL be a reading
computed over the tree, never a write: nothing SHALL be stored denormalised, and
every surface that shows a service SHALL show the **effective** reading rather
than the row's own stored column. A parent chain that runs in a circle SHALL be
refused with an error rather than walked.

#### Scenario: an ancestor's service is inherited

- **GIVEN** a parent whose service is `Payments`, and a child stating none
- **THEN** the child reads as `Payments`, named from the parent

#### Scenario: the dimensions inherit independently

- **GIVEN** a parent labelled team `Platform`, tag `regulatory` and service
  `Payments`
- **WHEN** a child states service `Auth` and nothing else
- **THEN** the child reads as service `Auth`, team `Platform` and tag
  `regulatory`

#### Scenario: a circular parent chain is refused

- **GIVEN** a parent chain that runs in a circle
- **WHEN** the effective services are read
- **THEN** the read is refused with an error naming where the walk started

### Requirement: A team owns services, and the map is directory data

The directory SHALL record which services a team is responsible for: a team
SHALL own any number of services, and a service SHALL be owned by any number of
teams. The map SHALL be edited in the directory on the team's own row.

The map SHALL be data about teams and services only. It SHALL NOT label a work
item, SHALL NOT be inherited down the tree, and SHALL NOT be read by the
scheduler. Editing it SHALL move no date in any plan.

Stating a team's services SHALL replace that team's whole set; omitting them
SHALL leave the set alone. An unknown service SHALL be refused rather than
created.

#### Scenario: one team owns several services

- **WHEN** a team is given the services `Payments` and `Auth`
- **THEN** the team owns both, and each service reads as owned by that team

#### Scenario: editing the map moves no date

- **GIVEN** a plan whose dates are decided by a sized team
- **WHEN** that team's owned services are changed
- **THEN** every start, finish and floor in the plan is what it was

#### Scenario: the map is not a work item label

- **GIVEN** a team that owns `Payments`, and a work item labelled with that team
  and stating no service
- **THEN** the work item's effective service is not `Payments` — it is whatever
  its ancestors state, or none

### Requirement: A plan flags work built by a non-owner and work assigned outside the team

A work item SHALL read as **built by a non-owner** when its effective service is
stated, its effective team set is non-empty, and none of those teams owns that
service.

A work item SHALL read as **assigned outside the team** when its effective team
set is non-empty and it names an assignee belonging to none of those teams.
Membership SHALL be the directory's existing person-to-team membership.

Both signals SHALL be computed from the **effective**, inherited team set,
never from the row's own stored labels.

Both signals SHALL flag only when the facts they compare are stated: a work item
missing a service, missing a team, or missing an assignee SHALL flag nothing.
Absence SHALL NOT be a mismatch.

Neither signal SHALL block, refuse or alter any write, and neither SHALL move
any date. A plan SHALL be able to record that a non-owner built something.

Each signal SHALL be offered as one filter facet and shown as a marker on the
cell the signal is about, and the marker SHALL be able to say which team, and
which service or person, produced it.

#### Scenario: a non-owner is flagged

- **GIVEN** a team `Platform` owning only `Auth`, and a work item labelled
  `Platform` with service `Payments`
- **THEN** the work item reads as built by a non-owner

#### Scenario: an owner is not flagged

- **GIVEN** a team `Platform` owning `Payments`, and a work item labelled
  `Platform` with service `Payments`
- **THEN** the work item reads as built by its owner, and carries no marker

#### Scenario: an inherited team is the team the signal reads

- **GIVEN** a parent labelled team `Platform`, and a child stating no team and
  service `Payments` that `Platform` does not own
- **THEN** the child reads as built by a non-owner

#### Scenario: an unlabelled row flags nothing

- **GIVEN** a work item with a service and no effective team
- **THEN** it reads as neither built by a non-owner nor assigned outside the team

#### Scenario: an assignee outside the team is flagged

- **GIVEN** a work item labelled team `Platform` and assigned to somebody who
  belongs to no team, or only to other teams
- **THEN** the work item reads as assigned outside the team

#### Scenario: a mismatch is recorded, not refused

- **WHEN** a work item is given a service its team does not own
- **THEN** the write succeeds and the work item reads back with the mismatch

### Requirement: A service can be created, renamed and removed, and removal is loud

Services SHALL be created, renamed and removed through the directory. A rename
colliding with an existing name SHALL be refused as taken, naming the service
that survives.

Removing a service that work items still name SHALL be refused with a usage
report naming every work item that would lose the label, and SHALL succeed only
when the caller repeats the request with an explicit confirmation. The usage
report SHALL state that each item's service is cleared, SHALL NOT report any
capacity as released, and SHALL NOT report the ownership rows the removal also
takes — an ownership claim about a service that no longer exists is not an
effect on any plan.

Removing a service SHALL clear it from every work item that names it and SHALL
move no date. Each touched project SHALL be told its directory changed, and
SHALL NOT be told its capacity changed.

#### Scenario: removing a used service is refused first

- **GIVEN** a service named by three work items
- **WHEN** it is removed
- **THEN** the removal is refused, naming the three work items and what each
  would lose

#### Scenario: a confirmed removal clears the label and nothing else

- **GIVEN** the refusal above
- **WHEN** the caller confirms
- **THEN** the service is gone, those three work items carry no service, every
  date in the plan is what it was, and no capacity is reported as released

#### Scenario: removing a service does not remove work items

- **GIVEN** a work item naming a service
- **WHEN** the service is removed with confirmation
- **THEN** the work item still exists

### Requirement: A work item's service is patched, journalled and undoable

A work item's service SHALL be set and cleared through the same patch path as
its other labels. An unknown service SHALL be refused rather than created.

The change SHALL be journalled with the item's **prior** service, so undo
restores it and redo re-applies it.

#### Scenario: undo restores the previous service

- **GIVEN** a work item whose service is `Auth`
- **WHEN** it is changed to `Payments` and then undone
- **THEN** its service is `Auth`

#### Scenario: an unknown service is refused

- **WHEN** a work item is patched with a service id that no service carries
- **THEN** the patch is refused as an unknown service, and the work item is
  unchanged

### Requirement: A plan can be narrowed by service and by either mismatch

The filter SHALL offer a service facet and a facet for each mismatch signal,
beside the facets already offered. Every one of them SHALL read the
**effective** value, so a row inheriting a service is found by that service's
facet.

A mismatch facet SHALL NOT be offered as an empty working filter while no team
owns any service; it SHALL say why it is unavailable.

The export SHALL carry one `Service` column beside the team and tag columns.

#### Scenario: an inherited service is found by its facet

- **GIVEN** a parent whose service is `Payments`, and a child stating none
- **WHEN** the plan is narrowed to `Payments`
- **THEN** the child is among the rows found

#### Scenario: the mismatch facet finds only stated mismatches

- **WHEN** the plan is narrowed to work built by a non-owner
- **THEN** every row found states both a service and a team, and none of the
  rows missing either is among them
