## ADDED Requirements

### Requirement: A cell's card opens diagonally

A hover card opened from a plan cell SHALL stand past that cell horizontally and past its row
vertically, so that the column stays clear for the pointer and the row stays readable.

A card a reader is meant to point at SHALL survive the trip: leaving the cell SHALL hold the card
briefly rather than close it, and arriving anywhere in the cell's subtree — the card included —
SHALL cancel that hold.

#### Scenario: the card clears both the column and the row

- **GIVEN** a card open from a cell
- **THEN** the card's top SHALL be at or below its row's bottom edge
- **AND** the card SHALL be clear of its own column

#### Scenario: a hand reaching for the card keeps it

- **GIVEN** a notes preview open from its marker
- **WHEN** the pointer moves to the card in steps, leaving the cell on the way
- **THEN** the card SHALL still be open when the pointer arrives

#### Scenario: the pointer settling elsewhere still closes it

- **GIVEN** a card held by that reach
- **WHEN** the pointer settles somewhere that is neither the cell nor the card
- **THEN** the card SHALL close

### Requirement: Every column's pop-up opens diagonally, in the table's own type

A hint or fact card opened from a mark **inside the plan's scrolling frame** SHALL stand past
that mark's own cell horizontally and past that mark's own row vertically, on the roomier side
and the roomier edge, and SHALL be clamped inside that frame rather than inside the window. This
supersedes the beside-the-mark placement of `every-column-answers-aside`.

A card opened from a mark **outside** that frame — the toolbar's controls, a Gantt bar — SHALL
keep opening under its mark.

Every hover card SHALL be drawn in the type of the table it explains, whether it is rendered
inside its cell or portalled to the document.

#### Scenario: each named column clears its own column and its own row

- **GIVEN** a work item row, with the Deadline column shown
- **WHEN** the pointer rests on the mark in its Reorder, Prio, Not before, Deadline, People at
  once, End or Slack cell until the card opens
- **THEN** the card SHALL be clear of that cell's horizontal span
- **AND** the card SHALL be clear of that row's vertical span
- **AND** the whole card SHALL be inside the plan's scrolling frame

#### Scenario: a portalled card reads like the table

- **GIVEN** a cell's fact card, which is portalled to the document
- **THEN** its font family, size and line height SHALL be the cell's own

#### Scenario: a toolbar control's hint opens under it

- **GIVEN** a toolbar control that carries a hint
- **WHEN** it is hovered until its card opens
- **THEN** the card SHALL be under the control, overlapping it horizontally

### Requirement: The open Name editor shows its notes rendered beside it

While a work item's Name box has the keyboard, the notes written in it SHALL be rendered beside
the box, in the row's right half, by the same component the hover preview renders.

#### Scenario: the panel answers the keystroke

- **GIVEN** a work item whose notes carry markdown
- **WHEN** its Name box is clicked into
- **THEN** the rendered notes SHALL be on screen beside the box
- **AND** they SHALL be the rendering, not the source

#### Scenario: the panel belongs to the writing

- **GIVEN** that panel on screen
- **WHEN** the box is left
- **THEN** the panel SHALL go with it
