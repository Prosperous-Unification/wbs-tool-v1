## ADDED Requirements

### Requirement: A work item's notes are written under its name, in one cell

A work item's name and its notes SHALL be shown and edited in one cell: the
name on the first line, the notes under it after a single newline. A work item
with no notes SHALL show its name and nothing else — no trailing blank line.
The two SHALL remain separate fields in storage; this is how they are composed
for reading and split on the way out.

Everything before the first newline is the name and everything after it is the
notes, with no edit refused and no ambiguity resolved by guessing. Deleting the
first line therefore SHALL rename the work item to what was its first note, and
a text whose first line is empty SHALL commit a work item with no name — both
being what one merged field means, and both undoable.

#### Scenario: a name and a note

- **WHEN** a work item with a name and notes is shown
- **THEN** its cell holds the name on the first line and the notes under it

#### Scenario: no notes

- **WHEN** a work item with no notes is shown
- **THEN** its cell holds its name alone, with no newline after it

#### Scenario: written as one text

- **WHEN** a name and two lines of notes are typed into the cell and it is left
- **THEN** the first line is stored as the name and the rest as the notes

#### Scenario: the first line is deleted

- **WHEN** the first line of the cell is deleted and the cell is left
- **THEN** the work item is renamed to what was its first line of notes, and
  the change can be undone

#### Scenario: the first line is emptied

- **WHEN** the first line is emptied, with notes still under it
- **THEN** the work item is stored with no name and its notes unchanged

### Requirement: Leaving the cell writes only what its owner changed

Leaving the Name cell SHALL compare the name and the notes it now holds against
**what that cell was showing when the typing began**, and SHALL send only the
fields that differ from it. It SHALL NOT compare them against the work item as
the table currently holds it: an edit by someone else that arrived while this
cell was being typed in is deliberately held back on screen, and comparing
against it would read that edit as one this person had just deleted.

The changed fields SHALL be sent in a single request, so that a name and a note
written together are one refusal, one entry on the undo stack and one undo.
When neither field differs, nothing SHALL be sent.

Text that be-01 refused SHALL stay in the cell until the person who typed it
resolves it: no later refetch — somebody else's edit arriving, this browser's
own next read, a reconnect — SHALL overwrite it, and leaving the cell again
SHALL send it again. While a request is still out, leaving the cell again
without having changed what it holds SHALL send nothing, so that one gesture
stays one request and one entry on the undo stack.

#### Scenario: their note, my name

- **GIVEN** a work item being renamed in this browser
- **WHEN** someone else's edit to its notes arrives mid-word and the cell is
  then left
- **THEN** only the name is sent, and their note is still there

#### Scenario: their name, my note

- **GIVEN** a work item whose notes are being typed in this browser
- **WHEN** someone else renames it mid-word and the cell is then left
- **THEN** only the notes are sent, and their name is still there

#### Scenario: both at once

- **WHEN** a name and its notes are both changed before the cell is left
- **THEN** one request carries both, and one undo puts both back

#### Scenario: a refusal

- **WHEN** the request is refused
- **THEN** neither field is changed and the refusal is on screen

#### Scenario: a refusal survives what arrives next

- **GIVEN** a name and a note whose edit be-01 refused
- **WHEN** someone else's edit to that work item arrives afterwards
- **THEN** the refused text is still in the cell, and leaving the cell again
  sends it again

#### Scenario: one gesture, one request

- **GIVEN** an edit whose request has not come back yet
- **WHEN** the cell is focused and left again with nothing typed in between
- **THEN** nothing further is sent

#### Scenario: nothing to say

- **WHEN** the cell is left holding what it was given, in a different form —
  a note stored with Windows line endings, shown with the browser's own
- **THEN** nothing is asked of be-01

### Requirement: The rendered notes are read from the Name cell

The Name cell SHALL NOT clip what opens over the rows below it, and hovering a
work item whose notes are not empty SHALL show those notes rendered as
markdown. A work item with no notes SHALL show no popover. Raw HTML in a note
SHALL be rendered as the text somebody typed, never as markup.

#### Scenario: reading a long note

- **WHEN** the Name cell of a work item with notes is hovered
- **THEN** the whole note is shown rendered, over the rows below

#### Scenario: nothing to preview

- **WHEN** a named work item with no notes is hovered
- **THEN** no popover is shown

## MODIFIED Requirements

### Requirement: The name and notes cells wrap and grow

The Name cell SHALL wrap its text rather than scrolling it out of sight, and
SHALL be as tall as the name and notes it holds whether or not it has the
focus, up to a cap past which it scrolls and the hover preview is where the
rest is read. Enter SHALL remain the key that creates a work item. Tab,
Shift+Tab and Backspace SHALL behave as they do in a single-line cell, and the
arrow keys SHALL behave as the requirement below states.

There is no Notes cell: a work item's notes are written under its name. The
Notes column SHALL NOT be rendered, SHALL NOT be a tab stop, and SHALL NOT have
a declared width — asking for one SHALL be an error, like any column the table
does not show.

#### Scenario: a long name is readable

- **WHEN** a name longer than its cell is shown
- **THEN** it wraps within the cell rather than being cut

#### Scenario: the cell makes room for the note

- **WHEN** a note is written under a name
- **THEN** the cell grows to hold it, at rest as well as while it is focused,
  up to its cap

#### Scenario: one stop per row fewer

- **WHEN** Tab is pressed in the last field of a row
- **THEN** it moves to the first field of the next row, having passed no Notes
  cell on the way

### Requirement: Notes are markdown, rendered on hover

A work item's notes SHALL be held as markdown source, shown in the Name cell as
the lines under the name. Hovering that cell SHALL show them rendered. Raw HTML
in a note SHALL be rendered as text, never as markup. A work item with no notes
SHALL show no popover.

#### Scenario: markdown becomes markup in the popover

- **GIVEN** a note reading `## Risks` and a bulleted `*old*`
- **WHEN** the work item's Name cell is hovered
- **THEN** the popover holds a heading element and an emphasis element

#### Scenario: a note containing HTML

- **GIVEN** a note containing an `<img onerror=…>` and a `<script>`
- **WHEN** the Name cell is hovered
- **THEN** the popover contains neither element, and shows the text as typed

#### Scenario: nothing to preview

- **WHEN** a work item with no notes is hovered
- **THEN** no popover is shown

### Requirement: The arrow keys move between cells

The arrow keys SHALL move the focus between editable cells: up and down along a
column, left and right along a row once the caret has run out of text. A cell
that holds more than one line — the Name cell, which holds the notes under the
name — SHALL keep up and down for the text until the caret has run out of that
too: up SHALL leave the row only with the caret at the very start of the value
and down only at the very end, and anywhere else the browser SHALL keep the
key. Single-line cells SHALL move between rows from any caret position, so a
column of estimates can be filled downwards without looking.

The extremes are the ends of the value, never a count of lines: a name wraps,
so a rule about first and last lines would let go of the key while the caret
still had visual lines to climb.

#### Scenario: reading a note with the arrows

- **WHEN** up is pressed with the caret in the middle of a Name cell
- **THEN** the caret moves and the focus stays in that cell

#### Scenario: leaving from the top

- **WHEN** up is pressed with the caret at the very start of a Name cell
- **THEN** the focus moves to the name of the row above

#### Scenario: leaving from the bottom

- **WHEN** down is pressed with the caret at the very end of a Name cell
- **THEN** the focus moves to the name of the row below

#### Scenario: a wrapped name

- **GIVEN** a name long enough to wrap onto several visual lines
- **WHEN** up is pressed in the middle of it
- **THEN** the caret moves up a visual line and the focus does not leave

#### Scenario: filling a column of estimates

- **WHEN** down is pressed in a one-line box with the caret mid-number
- **THEN** the focus moves to the same box in the row below

### Requirement: Backspace removes a wholly empty row

At the very start of a name, Backspace SHALL outdent the row; on a top-level
row with nothing in it at all it SHALL remove the row and leave the focus on
the row above. Anything the work item holds SHALL veto the removal — a note
under the name included, which the cell's own value now says in one read.

#### Scenario: a row that holds only a note

- **GIVEN** a top-level work item with no name and a note under the blank first
  line
- **WHEN** Backspace is pressed at the very start of that cell
- **THEN** the row is not removed
