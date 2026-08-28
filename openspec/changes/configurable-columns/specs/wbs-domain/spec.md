## ADDED Requirements

### Requirement: The default column set is the same on every deployment

The table SHALL show one **default column set** before a reader has hidden or
shown anything: the drag handle, Number, Name, Depends on, Prio, Tags, each
role's columns as the Phases dialog folds them, In parallel, Days, Float, Not
bef., Start, End and the row's ⋯ menu. Teams and Services SHALL be hidden by
default. Whether the directory holds a tag, a service or a team SHALL NOT
change which columns are on screen.

The default set's folded two-phase width MUST NOT exceed the width the 1280px
budget was measured at before this change — Teams off pays for Tags on, to the
pixel.

#### Scenario: an empty directory still shows the Tags column

- **GIVEN** a deployment whose directory holds no tag, no service and no team
- **WHEN** a plan is opened
- **THEN** the Tags column is on screen and the Teams and Services columns are
  not

#### Scenario: a full directory changes nothing

- **GIVEN** a deployment whose directory holds tags, services and teams
- **WHEN** a plan is opened with nothing hidden or shown by the reader
- **THEN** the columns on screen are exactly the default column set

#### Scenario: the folded budget is untouched

- **WHEN** a plan with two folded phases is shown at 1280px with the default
  column set
- **THEN** the table's minimum width is the figure the budget test held before
  this change, and nothing scrolls sideways

### Requirement: A reader hides and shows columns from the toolbar

The toolbar SHALL offer a **Columns** control listing every column a reader may
hide — Depends on, Prio, Teams, Tags, Services, In parallel, Days, Float, Not
bef., Start, End — and every role by name, each with a checked state that says
whether it is on screen. Unchecking SHALL take the column off the table;
checking SHALL put it back. A role SHALL be hidden and shown whole: none of its
folded or unfolded columns is on screen while it is hidden, and its estimates
SHALL still reach Days, Start and End.

The drag handle, Number, Name and the ⋯ menu SHALL NOT be offered: they are the
row's controls, not the plan's data.

A hidden column SHALL be absent from the table model, so keyboard movement
between cells, hover cards and drag-and-drop SHALL behave as if the column had
never been declared.

#### Scenario: hiding a column

- **GIVEN** the default column set on screen
- **WHEN** the reader unchecks Depends on
- **THEN** no Depends-on header or cell is rendered, and Right from the Name
  cell lands on the Prio cell

#### Scenario: hiding a role whole

- **GIVEN** a plan with roles Dev and QA, Dev unfolded
- **WHEN** the reader unchecks Dev
- **THEN** none of Dev's columns is rendered, QA's are, and every row's Days and
  dates are the figures they were with Dev on screen

#### Scenario: what cannot be hidden is not offered

- **WHEN** the Columns control is open
- **THEN** it offers no entry for the drag handle, Number, Name or the ⋯ menu

### Requirement: Hidden columns are remembered per project, per browser, and read as a claim

A reader's hidden columns SHALL be stored per project and per browser, beside
the column widths, and SHALL NOT be sent to or read from any server. Storage
SHALL hold the **hidden** ids, not the shown ones, so a column this table
learns to draw later is on screen by default.

The stored value is a claim: a value that is not a list of strings SHALL be
discarded whole and the key removed; an id the table does not declare — a
column that no longer exists, a role this project does not hold, a hand-typed
name — SHALL be dropped on its own and the rest applied.

#### Scenario: hidden columns survive a reload

- **GIVEN** Prio hidden by the reader
- **WHEN** the page is reloaded
- **THEN** Prio is still off the table and the Columns control shows it
  unchecked

#### Scenario: the store is not a list

- **GIVEN** a hand-edited value under the hidden-columns key that is not a list
  of strings
- **WHEN** the project is opened
- **THEN** the default column set is shown and the key is cleared

#### Scenario: one unknown id among known ones

- **GIVEN** a stored list naming Prio, a role id this project does not hold,
  and `banana`
- **WHEN** the project is opened
- **THEN** Prio is hidden and nothing else is

---

## MODIFIED Requirements

### Requirement: Resetting forgets the widths rather than freezing them

The table SHALL offer a reset that removes the stored keys for the project and
drops every override in force: every column width override, the panel height
override, and every hidden column. Each column SHALL then be laid out at the
width the frame layout resolves for it **now**, and the columns on screen SHALL
be the default column set — the reset MUST NOT write a snapshot of any width or
of any column set, including the defaults as they stood when it was pressed.

The reset SHALL be offered only while at least one override is in force or the
column set differs from the default — a column hidden, or a default-hidden one
shown: a control that provably does nothing reads as a broken one.

#### Scenario: reset returns a column to today's default, not yesterday's

- **GIVEN** not-before overridden while no row in the project sets a date, and
  a row has since been given one — so its resolved default has changed
- **WHEN** the widths are reset
- **THEN** not-before is laid out at the default that holds now, and the
  stored key is gone

#### Scenario: reset is absent with nothing to reset

- **GIVEN** a project no column has been dragged in and no column hidden in
- **WHEN** the table is rendered
- **THEN** no reset control is offered

#### Scenario: reset forgets the hidden columns

- **GIVEN** Depends on hidden and no column dragged
- **WHEN** the layout is reset
- **THEN** Depends on is on screen, the hidden-columns key is gone, and the
  reset control is no longer offered

### Requirement: A reader can name a filter and pick it again later, per browser

A client SHALL let a reader save the filter currently in force — the typed
name plus every ticked facet — under a name of their choosing, together with
the **column set** on screen at that moment, and pick a saved one back up in
one gesture that restores all of it together.

Saving SHALL be offered only while the filter is asking something of the plan;
a save while nothing is typed or ticked SHALL be refused, since a view of the
whole plan has nothing to be picked back to.

A saved view SHALL be stored per browser and per project, and SHALL NOT be
sent to, or read from, any server: it is one reader's own named answer to
"what am I looking at", not a fact about the project.

A saved view SHALL be deletable, and deleting one SHALL remove it from
storage as well as from what is offered.

A view saved before column sets existed carries none, and applying it SHALL
leave the columns on screen as they are.

#### Scenario: nothing to name

- **GIVEN** an untouched Find box and no facet ticked
- **THEN** the control to save a view under a name is refused

#### Scenario: a view remembers both halves

- **GIVEN** a typed name and a ticked facet, saved together as one view
- **WHEN** the filter is cleared and the saved view is picked
- **THEN** the Find box and the facet are both restored, exactly as saved

#### Scenario: a view remembers its columns

- **GIVEN** Depends on hidden, a facet ticked, and the view saved
- **WHEN** Depends on is shown again and the saved view is picked
- **THEN** Depends on is hidden again, and the hidden-columns store says so

#### Scenario: an older view leaves the columns alone

- **GIVEN** a stored view with criteria and no column set
- **AND** Prio hidden by the reader
- **WHEN** the view is picked
- **THEN** its filter is applied and Prio stays hidden

#### Scenario: a saved view is deleted

- **GIVEN** a saved view
- **WHEN** it is deleted
- **THEN** it is offered nowhere and nothing is left of it in storage

### Requirement: A malformed saved view is dropped without losing the rest

A client SHALL discard the whole saved-views key, rather than guess at its
shape, where the stored value under it is not a list at all.
Where the stored value is a list but one entry is not a usable saved view —
missing a name, an empty name, criteria missing a field a filter requires, or
a column set present but not a list of strings — that entry alone SHALL be
dropped and the other saved views SHALL still be offered. An absent column set
is usable and means the view says nothing about columns.

#### Scenario: the whole store is not a list

- **GIVEN** a hand-edited value under the saved-views key that is not a list
- **WHEN** the project is opened
- **THEN** no saved view is offered and the key is cleared

#### Scenario: one bad entry among good ones

- **GIVEN** a stored list holding one entry with no name and two entries that
  are complete and valid
- **WHEN** the project is opened
- **THEN** the two valid views are offered and the bad one is not

#### Scenario: a view whose column set is not a list

- **GIVEN** a stored view whose `hiddenColumnIds` is the number 3, beside a
  valid one
- **WHEN** the project is opened
- **THEN** the valid view is offered and the malformed one is not
