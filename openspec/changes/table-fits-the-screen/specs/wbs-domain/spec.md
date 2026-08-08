## ADDED Requirements

### Requirement: The table is laid out to the window, not the window to the table

The work breakdown table SHALL take the width of the frame it sits in. Every
column except the name SHALL be laid out at a declared width; the name column
SHALL have none and SHALL absorb whatever the others leave, down to a floor
below which it does not shrink. The table SHALL declare a minimum width equal
to its declared columns plus that floor, computed from the columns it is
currently showing. Above that minimum there SHALL be no horizontal scrolling;
below it the frame SHALL scroll and the handle, number and name SHALL stay held
at the left edge, where they have always been.

An id the width table does not declare SHALL remain an error rather than a
plausible default, and a flexible column SHALL be told apart by membership
rather than by a sentinel width.

#### Scenario: a laptop-width window with the roles folded

- **WHEN** a plan with two roles, both folded, is shown in a 1280px window
- **THEN** every column is on screen and nothing scrolls sideways

#### Scenario: the name takes what is left

- **WHEN** the window is wider than the table's minimum
- **THEN** the name column is wider than its floor by exactly what the other
  columns did not take

#### Scenario: a window narrower than the table can be

- **WHEN** the window is narrower than the table's minimum for what it is
  showing
- **THEN** the frame scrolls sideways and the handle, number and name stay at
  its left edge

#### Scenario: a column nobody sized

- **WHEN** a column id that is neither declared nor flexible is laid out
- **THEN** the table refuses it rather than giving it a width

### Requirement: One role's estimates are unfolded at a time

Unfolding a role's three estimate points SHALL fold whichever role was
unfolded. Folding the open one SHALL leave none open. Which role is open SHALL
remain local to the reader.

#### Scenario: opening a second role

- **GIVEN** Dev's three points are on screen
- **WHEN** QA is unfolded
- **THEN** QA's three points are on screen and Dev's are not

#### Scenario: closing the open one

- **WHEN** the unfolded role is folded
- **THEN** no role's three points are on screen, and the one folded earlier is
  not put back

### Requirement: A folded role says who is doing the work, and takes an @ to change it

A folded role's cell SHALL show its final figure together with the person
assigned to that role on that work item, truncated to the column with the whole
name available on hover. Where nobody is assigned and exactly one person is
assigned to another role of the same work item, that person's name SHALL be
shown as an assumption — visibly distinct from an assignment. Where neither
holds, the cell SHALL show the figure alone.

Typing `@` in that cell SHALL open a list of people filtered by what follows
it. Taking an entry SHALL assign that person and remove the `@` and what
follows it from the cell, leaving what was typed in front of it as the
estimate. A search matching nobody SHALL offer to add a contributor by that
name; a bare `@` SHALL offer to take the assigned person off, and SHALL offer
it first so that no search-and-take can unassign anybody. Escape SHALL close
the list and change nothing.

What is typed after the `@` SHALL never be read as part of the estimate: a
half-typed mention SHALL NOT be reported as a malformed estimate, and leaving
the cell with one still in it SHALL NOT save, clear or alter the estimate.

#### Scenario: the figure and the person

- **WHEN** a work item with a Dev estimate and a Dev assignee is shown with the
  Dev role folded
- **THEN** its Dev cell shows the final figure and that person's name

#### Scenario: the assumed person

- **GIVEN** one person assigned to Dev and nobody to QA
- **WHEN** the QA role is folded
- **THEN** the QA cell shows that person's name marked as an assumption rather
  than as an assignment

#### Scenario: one gesture

- **WHEN** `2/3/8@ka` is typed into a folded Dev cell and Enter is pressed on
  the offered person
- **THEN** that person is assigned, the cell is left holding `2/3/8`, and
  leaving it saves that trio

#### Scenario: a contributor nobody had

- **WHEN** `@` and a name matching nobody is typed and taken
- **THEN** a contributor of that name is added and assigned, by the same rule
  the unfolded picker adds one

#### Scenario: taking somebody off

- **GIVEN** somebody is assigned to the folded role
- **WHEN** `@` is typed with nothing after it
- **THEN** the first entry offered is to remove them

#### Scenario: a mention abandoned

- **GIVEN** a folded cell showing a figure this tool computed
- **WHEN** `@` and a partial name are typed and the cell is left without taking
  anything
- **THEN** nothing is asked of the server, the estimate is unchanged, and the
  cell shows the figure again

#### Scenario: a half-typed mention is not a malformed estimate

- **WHEN** `@ka` is typed into a folded cell
- **THEN** the cell reports no problem with what it holds

### Requirement: A folded role's cell does not clip the list it opens

The cell a folded role's `@` picker opens in SHALL NOT clip it: the list SHALL
be readable over the rows below rather than cut to a cell one line high.

#### Scenario: the picker on a narrow column

- **WHEN** `@` is typed in a folded role's cell
- **THEN** the list of people is readable over whatever is below that row

## MODIFIED Requirements

### Requirement: A role's columns fold behind its final figure

Each role SHALL show, by default, a single column holding its final planning
figure per row **and the person doing that role's work**, headed by a control
that unfolds the role's three estimate points and its assignee box beside it.
Folding SHALL be per role and local to the viewer, and at most one role SHALL
be unfolded at a time. A typed but unsent estimate SHALL survive folding and
unfolding. A trio that cannot be saved SHALL remain visible while folded, as a
marked final figure carrying the reason.

#### Scenario: the table at rest

- **WHEN** a project with Dev and QA roles is shown
- **THEN** each role contributes one column, holding the final figure and
  whoever is doing it, and no estimate inputs or assignee boxes are shown

#### Scenario: unfolding one role

- **WHEN** the Dev control is activated
- **THEN** Dev's three estimate boxes and its assignee box appear beside its
  figure, and QA stays folded

#### Scenario: a draft survives the fold

- **GIVEN** `5` typed into Dev optimistic and nothing sent
- **WHEN** Dev is folded and unfolded again
- **THEN** the box still reads `5` and nothing has been sent

#### Scenario: a complaint outlives the fold

- **GIVEN** a half-filled trio
- **WHEN** the role is folded
- **THEN** the row's final figure is marked, carrying the reason
