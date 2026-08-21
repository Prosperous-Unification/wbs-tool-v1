## ADDED Requirements

### Requirement: A plan records what a role's work on a work item cost, in units other than days

The plan SHALL hold, for each work item, role and **metric**, one number and the
moment it was typed. The metrics SHALL be a closed set: `token_estimate` — the
tokens a role's work on a work item is expected to take; `token_actual` — the
tokens it took; `hours_actual` — the hours it took.

Each figure SHALL be one number rather than a three-point range: only a days
estimate is folded into a scheduled duration, and nothing folds these.

Figures SHALL be held **per role**, at the same grain as the estimate and the
recorded days, and a work item's own figure for a metric SHALL be the sum of its
descendants' when it has children — computed on read and never stored.

A figure SHALL be recordable only against a work item with no children. A work
item with children SHALL be refused with `rolled_up`, a role the project does not
hold SHALL be refused with `unknown_role`, and a metric outside the closed set
SHALL be refused with `unknown_metric`.

A correction SHALL carry the moment the correction was typed rather than the
moment the figure it replaced was.

#### Scenario: tokens estimated and then recorded against a leaf

- **GIVEN** a leaf work item with a days estimate of 1/2/3 for a role
- **WHEN** 400000 is recorded as that role's `token_estimate` on that work item
- **AND** 512345 is recorded as its `token_actual`
- **THEN** the plan SHALL report both figures for that role
- **AND** the days estimate SHALL still be 1/2/3

#### Scenario: a parent reports the tokens recorded below it

- **GIVEN** a work item with two children, one holding a `token_actual` of 200000
  for a role and the other 300000
- **WHEN** the plan is read
- **THEN** the parent SHALL report a `token_actual` of 500000 for that role

#### Scenario: hours are recorded beside tokens without either implying the other

- **GIVEN** a leaf work item with a role
- **WHEN** 6 is recorded as that role's `hours_actual`
- **THEN** the plan SHALL report 6 hours for that role
- **AND** that role's `token_actual` SHALL be absent

#### Scenario: a figure cannot be recorded on a work item with children

- **GIVEN** a work item that has children
- **WHEN** a `token_actual` is recorded against it
- **THEN** the write SHALL be refused as `rolled_up`
- **AND** nothing SHALL be stored

#### Scenario: a metric the plan does not hold is refused

- **GIVEN** a leaf work item with a role
- **WHEN** a figure is recorded against a metric named `story_points`
- **THEN** the write SHALL be refused as `unknown_metric`
- **AND** nothing SHALL be stored

### Requirement: Nobody having recorded a figure is its absence, never a zero

A role nobody has recorded a metric for SHALL be **absent** from what the plan
reports for that metric, rather than reported as zero. Absence SHALL be per
metric: a role holding one figure SHALL be absent from every other.

Clearing a figure SHALL take it away rather than store zero. A recorded zero
SHALL be kept and reported, because "this cost nothing" is a statement somebody
made.

#### Scenario: a role nobody costed is absent rather than zero

- **GIVEN** a leaf work item with two roles, one holding a `token_actual`
- **WHEN** the plan is read
- **THEN** the other role SHALL be absent from the reported `token_actual`
  figures rather than reported as 0

#### Scenario: clearing takes the figure away rather than zeroing it

- **GIVEN** a role with a recorded `hours_actual` of 6
- **WHEN** the figure is cleared
- **THEN** that role SHALL be absent from the reported `hours_actual` figures

#### Scenario: a recorded zero is kept

- **GIVEN** a leaf work item with a role
- **WHEN** 0 is recorded as that role's `token_actual`
- **THEN** the plan SHALL report a `token_actual` of 0 for that role

### Requirement: Recorded costs do not change the plan's dates

No figure held under this requirement SHALL be read by the scheduler or by any
rule it depends on. A plan's dates SHALL be identical before and after any of
these figures is recorded, corrected or cleared.

#### Scenario: recording tokens far over the estimate moves nothing

- **GIVEN** a scheduled plan whose dates have been read
- **WHEN** a `token_actual` ten times the `token_estimate` is recorded against
  one of its leaves
- **THEN** every work item's scheduled start and finish SHALL be unchanged

#### Scenario: recording hours moves nothing

- **GIVEN** a scheduled plan whose dates have been read
- **WHEN** an `hours_actual` is recorded against one of its leaves
- **THEN** every work item's scheduled start and finish SHALL be unchanged

### Requirement: Recording a figure is a journalled command

Recording, correcting and clearing SHALL each go through the plan's journal, so
each is undoable and each appears in the plan's history.

The inverse of a **first** recording SHALL be a clear, never a recording of zero
— undoing a figure that did not exist SHALL leave an absence.

#### Scenario: an undo of the first recording leaves an absence

- **GIVEN** a role with no `token_actual`
- **WHEN** 512345 is recorded and the command is undone
- **THEN** that role SHALL be absent from the reported `token_actual` figures
  rather than reported as 0

#### Scenario: the plan's history holds the recording

- **GIVEN** a role with a recorded `token_actual`
- **WHEN** the plan's history is read
- **THEN** it SHALL hold an entry naming the work item, the role and the metric

### Requirement: Recorded costs follow the work they were recorded against

A figure SHALL move with the work item it describes: down to a new first child,
up to a parent losing its last child, and back with a restored branch.

A duplicate SHALL carry the estimate and **not** the recorded figures — a copy is
work that has not been done yet, so nothing has cost anything.

#### Scenario: the record survives a branch being deleted and restored

- **GIVEN** a subtree whose leaf holds a `token_actual` and an `hours_actual`
- **WHEN** the subtree is deleted and the deletion undone
- **THEN** both figures SHALL be reported against that leaf again

#### Scenario: a duplicate carries the estimate and not the record

- **GIVEN** a leaf with a days estimate and a `token_actual`
- **WHEN** it is duplicated
- **THEN** the copy SHALL hold the estimate
- **AND** the copy SHALL be absent from the reported `token_actual` figures

### Requirement: Removing a role counts the figures recorded against it

A role holding only recorded figures and no estimate SHALL still count as in use:
an unconfirmed removal SHALL be refused, and a confirmed one SHALL take the
figures with the role.

#### Scenario: a role holding only recorded figures is still in use

- **GIVEN** a role with no estimates and one recorded `hours_actual`
- **WHEN** its removal is requested without confirmation
- **THEN** the removal SHALL be refused
- **AND** the refusal SHALL report the work the role holds

### Requirement: The directory says whether an assignee is a person or an agent

Every person in the directory SHALL carry a kind, one of `person` or `agent`, and
it SHALL be editable. A person the directory already held SHALL read as `person`.

The kind SHALL make no difference to assignment, capacity or scheduling: an agent
SHALL be assignable, schedulable and counted exactly as a person is.

#### Scenario: an existing person reads as a person

- **GIVEN** a directory holding people recorded before kinds existed
- **WHEN** the directory is read
- **THEN** every one of them SHALL report a kind of `person`

#### Scenario: an assignee can be marked as an agent

- **GIVEN** a person in the directory
- **WHEN** their kind is set to `agent`
- **THEN** the directory SHALL report them as an agent

#### Scenario: marking an assignee as an agent moves no dates

- **GIVEN** a scheduled plan with work assigned to a person
- **WHEN** that person's kind is set to `agent`
- **THEN** every work item's scheduled start and finish SHALL be unchanged

#### Scenario: a kind outside the set is refused

- **GIVEN** a person in the directory
- **WHEN** their kind is set to `robot`
- **THEN** the write SHALL be refused
- **AND** their stored kind SHALL be unchanged
