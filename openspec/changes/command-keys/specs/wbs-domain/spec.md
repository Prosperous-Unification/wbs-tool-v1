## ADDED Requirements

### Requirement: Enter in a work item's name writes a line, not a work item

Enter pressed in the Name cell SHALL be left to the browser, so that it inserts
a newline into the text the cell holds. Since a work item's notes are written in
that cell under its name, this is what makes a note typeable at all.

It SHALL NOT create a work item. The gestures that create one are Ctrl+N (or
Alt+N) and, at the end of the plan, Cmd/Ctrl+Enter.

Enter inside an open picker list — dependencies, team, assignee, the `@`
mention picker — and on an open ⋯ menu keeps the meaning it already had: it
takes the entry, or activates the item.

#### Scenario: a note typed under a name

- **WHEN** a name is typed into the Name cell, Enter is pressed, and a note is
  typed under it
- **THEN** the cell holds both, separated by a newline, and no work item was
  created

#### Scenario: Enter takes a picker entry

- **WHEN** Enter is pressed with a picker's list open in that cell
- **THEN** the entry is taken, exactly as before

### Requirement: One chord family moves, creates and deletes from any cell

The table SHALL answer a family of chords from every editable cell — the Name
cell, the estimate boxes, the date cell, and the picker boxes whose list is
closed:

- **Ctrl+H, Ctrl+J, Ctrl+K, Ctrl+L** SHALL move the focus one cell left, down,
  up and right, following the same grid the arrow keys follow and skipping the
  same cells, but **without** the arrow keys' rule that the text has the key
  until the caret runs out. At the edge of the grid the chord SHALL move
  nothing and SHALL still be consumed, never reaching the browser.
- **Ctrl+N**, and **Alt+N** for the same action, SHALL create a work item below
  the current row at the same level and put the focus in its name.
- **Cmd+Enter or Ctrl+Enter** SHALL move the focus to the next visible row's
  name, or — on the last row — create a work item there and land in it.

Alt+N exists because Chrome reserves Ctrl+N everywhere except macOS, and it
SHALL be recognised by the physical key rather than by the character, because
macOS delivers no letter for it.

A chord held down by a modifier the table has not bound — Shift, or Alt on
anything but its own chord — SHALL NOT be treated as a command.

#### Scenario: moving out of a note in one press

- **WHEN** Ctrl+J is pressed with the caret in the middle of a note
- **THEN** the focus moves to the next row's name, where an arrow key would
  have moved the caret instead

#### Scenario: a new work item from the middle of the plan

- **WHEN** Ctrl+N is pressed in any cell of a row in the middle of the plan
- **THEN** a new work item appears directly below it, at the same level, with
  the focus in its name

#### Scenario: the chord at the edge is not the browser's

- **WHEN** Ctrl+H is pressed in the first cell of the table
- **THEN** the focus does not move and the browser is not given the keystroke

### Requirement: A chord that writes saves the cell first, and abandons on a refusal

Cmd/Ctrl+Enter and Ctrl+N SHALL commit what the cell holds — the same commit
leaving the cell runs — and SHALL wait for the answer before creating a work
item or moving the focus.

If that commit is refused, the chord SHALL do nothing further: the caret stays
in the cell, which holds the only copy of what was typed, and no work item is
created.

Repeated presses while a chord's requests are still out SHALL be one gesture:
two immediate presses on the last row create one work item, not two.

Where the cell has nothing new to send because the request carrying that text
is already out, the chord SHALL wait for **that** request and take its answer
as its own.

#### Scenario: a chord joins the save that is already out

- **WHEN** a cell is left, the save it started is still out, the cell is
  focused again without being typed in, and Cmd+Enter or Ctrl+N is pressed
- **THEN** nothing is created and the focus does not move until that save
  settles, and if it is refused nothing is created at all

#### Scenario: the name is saved before the row below exists

- **WHEN** a name is typed and Cmd+Enter is pressed on the last row
- **THEN** the name is saved first, and only then is the new work item created

#### Scenario: a refused save creates nothing

- **WHEN** the save a chord runs is refused
- **THEN** the caret stays where it was, the typed text stays on screen, and no
  work item is created

#### Scenario: two presses, one work item

- **WHEN** Cmd+Enter is pressed twice in immediate succession on the last row
- **THEN** exactly one work item is created

### Requirement: Deleting by keyboard takes two presses and says so first

Ctrl+D SHALL NOT delete anything on its own. The first press SHALL mark the row
on screen and say what a second press would do, naming the work item and saying
that its children move up.

A second press SHALL delete the work item — children promoted, the focus landing
where the actions menu's delete puts it — and SHALL say that it happened and
that undo puts it back. It SHALL do so only when all of these hold: it is the
same work item, the key was pressed rather than held, D has been released since
the first press, and it is within three seconds.

The mark SHALL be taken off by any other keystroke that is not the second
press — a modifier held or re-taken on the way to it is not "another
keystroke" — by the focus leaving the cell however it leaves, by the window or
the tab losing attention, by Escape, by the three seconds running out, and by a
refresh in which that work item has gone or is no longer under the number that
was named.

A work item whose number is frozen SHALL refuse to be marked, and SHALL say
that it must be unfrozen first.

#### Scenario: the first press only marks

- **WHEN** Ctrl+D is pressed once in a row
- **THEN** the row is marked, a message names the work item and what a second
  press does, and nothing is deleted

#### Scenario: the second press deletes

- **WHEN** Ctrl+D is pressed again in the same row, after the key was released
- **THEN** the work item is deleted with its children promoted, and a message
  says so and says undo restores it

#### Scenario: a held key never deletes

- **WHEN** Ctrl+D is held down so that it repeats
- **THEN** the row is marked once and nothing is deleted, however long it is
  held

#### Scenario: the mark follows the row it was made about

- **WHEN** the marked work item is renumbered or removed by somebody else
- **THEN** the mark is taken off, and a further Ctrl+D marks afresh rather than
  deleting

#### Scenario: a frozen work item refuses

- **WHEN** Ctrl+D is pressed in a row whose number is frozen
- **THEN** nothing is marked and a message says to unfreeze it first

### Requirement: An open list owns the keyboard

A cell SHALL ignore every command chord while a list is open in it — the
dependency list, a team or assignee picker, the `@` mention picker — and a row
SHALL ignore them while its ⋯ menu is open.

A chord the open list ignores SHALL be consumed there: it SHALL NOT be read as
the list's own unmodified key, SHALL NOT reach the browser, and SHALL leave the
list exactly as it found it.

Closing the list, which Escape does, SHALL give the chords back.

#### Scenario: a chord aimed at an open list does nothing

- **WHEN** Ctrl+N or Ctrl+D is pressed with a picker's list open
- **THEN** no work item is created, no row is marked, and the focus stays in
  the box

#### Scenario: a modified Enter is not the list's Enter

- **WHEN** Cmd/Ctrl+Enter is pressed with a team, assignee, dependency or `@`
  list open
- **THEN** no entry is taken, nothing is created, no dependency is added, the
  highlight does not move, and no work item is created

#### Scenario: a modified arrow is not the list's arrow

- **WHEN** Alt and an arrow are pressed with the folded cell's `@` list open
- **THEN** the row is neither moved among its siblings nor indented or
  outdented

#### Scenario: the same box answers once its list is closed

- **WHEN** the list is closed and Ctrl+N is pressed in the same box
- **THEN** a work item is created below the row
