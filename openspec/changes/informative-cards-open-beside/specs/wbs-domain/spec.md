## ADDED Requirements

### Requirement: A cell's card stands beside it, not over its column

A hover card opened from a plan cell SHALL stand beside that cell rather than over the cells
above and below it in the same column, so that the rows around it stay readable while it is
open.

The side SHALL be measured: the card SHALL open on the side of its cell that has room for it
inside the scrolling frame, and SHALL hang from whichever of its own top or bottom edges keeps
it inside that frame.

#### Scenario: the card is not over the next row's cell

- **GIVEN** a card open from one row's cell in a column
- **WHEN** the cell below it in that column is asked what is painted on top of it
- **THEN** the answer SHALL NOT be the open card

#### Scenario: a column near the frame's edge opens the other way

- **GIVEN** a column standing within a card's width of the scrolling frame's right edge
- **WHEN** one of its cards opens
- **THEN** the card SHALL stand to the left of its cell
- **AND** the whole card SHALL be inside the frame

#### Scenario: the columns this holds for

- **GIVEN** a plan carrying notes, an estimate, a type, a tag, a dependency and a link on every
  row
- **THEN** the Start, Depends on, Types, Tags, folded step and Links columns SHALL all place
  their cards beside their cell
