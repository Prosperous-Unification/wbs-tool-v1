## ADDED Requirements

### Requirement: A card a reader acts on is reachable by a pointer

Where a hover card carries something a reader is meant to click, the whole card SHALL take the
pointer — its own padding and the gaps between its lines included — and not only the lines
inside it.

Such a card SHALL open **beside** its cell, with its leading edge on the cell's own edge and
its top aligned with the cell's, so that a pointer crosses from the cell onto the card with
nothing between them and can then walk the list without leaving the card.

A card that carries nothing to click SHALL remain pointer-transparent, so that it cannot eat a
click aimed at the row it hangs over.

#### Scenario: the card stands beside its cell

- **GIVEN** a work item's links card open
- **WHEN** the card and the cell are measured
- **THEN** the card's left edge SHALL be at or after the cell's right edge
- **AND** the card's top SHALL be no lower than the cell's top

#### Scenario: the pointer crosses onto the card

- **GIVEN** a links card open beside its cell
- **WHEN** the pointer moves sideways out of the cell, in steps, to a point inside the card's
  outer padding
- **THEN** the card SHALL still be on screen
- **AND** the topmost element at that point SHALL be part of the card

#### Scenario: the pointer walks the list one item at a time

- **GIVEN** a links card open beside its cell, holding at least three links
- **WHEN** the pointer moves down onto each item in turn, in steps
- **THEN** the card SHALL still be on screen after each of them
- **AND** the link under the pointer SHALL be followable

#### Scenario: the pointer settles somewhere else

- **GIVEN** a links card open beside its cell
- **WHEN** the pointer leaves the cell and the card
- **THEN** the card SHALL close
