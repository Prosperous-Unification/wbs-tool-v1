## MODIFIED Requirements

### Requirement: The notes editor closes on Escape and on Done, and both save

While a work item's Name box is being written in, Escape SHALL commit what is in the box through
the same path leaving it does, and SHALL collapse the box to its at-rest height. A Done button SHALL
stand in the cell's top-right, beside the notes marker, and SHALL do the same on a press. Neither
SHALL discard anything.

#### Scenario: Escape saves and closes

- **GIVEN** the Name box open with notes typed into it
- **WHEN** Escape is pressed
- **THEN** the notes SHALL be saved as typed
- **AND** the box SHALL be at its rested height and no longer focused

#### Scenario: Done stands by the notes marker and saves

- **GIVEN** the Name box open with notes typed into it
- **THEN** the Done button SHALL be beside the notes marker in the cell's top-right
- **AND** a hit test at its centre SHALL answer the button
- **WHEN** it is pressed
- **THEN** the notes SHALL be saved as typed and the editor closed
