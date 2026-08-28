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

### Requirement: The toolbar keeps to two rows at a laptop width

The plan toolbar SHALL lay out in at most two rows at 1280px with a plan of
unestimated rows on screen, so the frame under it keeps the height
`header-bar` measured for it. To hold that with a Columns control on the row,
the five export actions — Copy as Markdown, Copy as Mermaid, Download CSV,
Download as Markdown, Download what's on screen — SHALL sit behind one
**Export** control, opened and closed like Filters and Views, each keeping its
name, its title and what it does; Undo and Redo SHALL be drawn as glyphs whose
accessible names are still `Undo` and `Redo` and whose titles still name the
chord; and the Find box SHALL be narrower than it was. No control SHALL be
removed.

#### Scenario: the exports are one menu

- **WHEN** the toolbar is rendered
- **THEN** the five export actions are inside one Export control, in that
  order, and nowhere else on the toolbar

#### Scenario: Undo and Redo answer to their names

- **WHEN** the toolbar is rendered
- **THEN** a button named `Undo` and a button named `Redo` are offered, each a
  glyph, each titled with its keyboard chord

#### Scenario: two rows with unestimated rows on the plan

- **GIVEN** a 1280px window and a plan of twenty-three unestimated rows
- **WHEN** the toolbar is laid out
- **THEN** it takes two rows, and the frame under it is at least the height
  `header-bar` measured

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

### Requirement: A plan can be exported as a Mermaid gantt

A client SHALL be able to take the plan's chart as a Mermaid `gantt` block: one
task per placed slice, grouped by the outermost work item each slice hangs
under, carrying the work item's number and name, its phase, and whoever is named
on it.

Every task SHALL carry two absolute dates and SHALL ask the renderer to compute
nothing. The dates are be-01's own schedule read through the chart's calendar
scale, rounded outward to whole days — a start down and a finish up, so no bar
is drawn shorter than the work in it.

The block SHALL declare that its end dates are inclusive, because a task's end
is the last day the work is still on and a renderer reading it as the boundary
after that draws every bar a day short.

The block SHALL say, inside itself, what it cannot draw: dependency arrows,
capacity and hand-off waits, slack, priority, the three-point figures, how many
people a work item ran at, and one colour per assignee. It SHALL also say that
it holds every row of the plan, including rows the screen had collapsed or
searched away.

The export SHALL name no team. The exported table names it, and the diagram's
one grouping channel is spent on the plan's outline.

**A `Copy as Mermaid` action in the toolbar's Export menu SHALL put the diagram
on the clipboard**, beside the `Copy as Markdown` action, and SHALL model the
same clipboard outcomes that action already does — no clipboard on the page,
the write refused, or done — plus the refusal above where there is no diagram
to copy at all.

#### Scenario: a slice becomes a dated task

- **GIVEN** a plan on a calendar with a placed slice
- **WHEN** it is exported as a Mermaid gantt
- **THEN** the block SHALL hold a task naming the work item and the phase
- **AND** the task SHALL carry the day the slice starts and the last day it is
  still on

#### Scenario: a work item deeper than the top level keeps its outline

- **GIVEN** a slice on a work item three levels down
- **WHEN** it is exported
- **THEN** its section SHALL be the outermost work item above it
- **AND** its task SHALL carry its own number

#### Scenario: the diagram names no team

- **GIVEN** a plan whose work items state a team
- **WHEN** it is exported as a Mermaid gantt
- **THEN** no team name SHALL appear in the block

#### Scenario: the toolbar action copies the diagram

- **GIVEN** a plan on a calendar with a placed slice, and a page with a
  clipboard
- **WHEN** `Copy as Mermaid` is taken from the Export menu
- **THEN** the clipboard SHALL hold the Mermaid gantt block
- **AND** a toast SHALL say the copy happened

### Requirement: A plan not on a calendar is refused in words

A client asking for a Mermaid gantt of a plan with no start date SHALL be given a
sentence saying so and asking for a start date, and SHALL be given no diagram. A
Mermaid gantt has one axis and it is a calendar; an invented start would put
dates nobody agreed to into a document that outlives the screen.

The same SHALL hold for a plan whose dependencies run in a circle, and for a
plan nothing has been placed in: a sentence, and no diagram.

**The Export menu's `Copy as Mermaid` and `Download as Markdown` actions SHALL
show this sentence as a toast, and SHALL copy or download nothing, wherever
this requirement refuses.**

#### Scenario: a plan with no start date

- **GIVEN** a plan whose start date is not set
- **WHEN** a Mermaid gantt is asked for
- **THEN** the answer SHALL be a refusal naming the missing start date
- **AND** SHALL carry no diagram

#### Scenario: a plan whose dependencies run in a circle

- **GIVEN** a plan be-01 could not order
- **WHEN** a Mermaid gantt is asked for
- **THEN** the answer SHALL be a refusal and SHALL carry no diagram

#### Scenario: the toolbar shows the refusal as a toast

- **GIVEN** a plan whose start date is not set
- **WHEN** `Copy as Mermaid` or `Download as Markdown` is taken from the Export
  menu
- **THEN** a toast SHALL show the refusal sentence
- **AND** nothing SHALL be copied or downloaded

### Requirement: A plan can be exported as a bundled Mermaid document

A client SHALL be able to take a plan as one Markdown document holding a header
block, a Mermaid `gantt` fence of the plan's chart, and the same table
`planToMarkdown` writes, in that order. The document SHALL exist only where the
diagram exists: it SHALL be refused with the same sentence, and for the same
reason, wherever a Mermaid gantt of the plan is refused.

The header block SHALL state that the document holds the whole plan — every row
and slice, including any a collapsed branch or a running search had hidden on
screen — because the chart on screen may draw fewer.

The fence SHALL be long enough that no run of backticks anywhere in the
diagram's text, including inside a work item's name, can close it before the
diagram ends.

**A `Download as Markdown` action in the toolbar's Export menu SHALL save this
document as a `.md` file**, beside the `Download CSV` action, named the same
way `planFileName` already names the CSV, with the `.md` extension.

#### Scenario: a plan on a calendar becomes one document

- **GIVEN** a plan on a calendar with a placed slice
- **WHEN** it is exported as a bundled Mermaid document
- **THEN** the document SHALL hold, in order, a header block, a Mermaid gantt
  fence, and the exported table
- **AND** the header block SHALL state that the document holds the whole plan

#### Scenario: a plan with no start date is refused, and no document is given

- **GIVEN** a plan whose start date is not set
- **WHEN** a bundled Mermaid document is asked for
- **THEN** the answer SHALL be the same refusal a Mermaid gantt of that plan is
  given
- **AND** SHALL carry no document

#### Scenario: a task name carrying a run of backticks cannot close the fence early

- **GIVEN** a work item whose name holds three backticks
- **WHEN** the plan is exported as a bundled Mermaid document
- **THEN** the fence around the diagram SHALL use more backticks than the
  longest run inside it
- **AND** the table SHALL still follow the diagram inside that fence, not fall
  outside it as prose

#### Scenario: the toolbar action downloads the bundled document

- **GIVEN** a plan on a calendar with a placed slice
- **WHEN** `Download as Markdown` is taken from the Export menu
- **THEN** a `.md` file SHALL be saved holding the header block, the fence, and
  the table
