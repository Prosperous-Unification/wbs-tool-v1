## ADDED Requirements

### Requirement: The notes editor closes on Escape and on Done, and both save

While a work item's Name box is being written in, Escape SHALL commit what is in the box through
the same path leaving it does, and SHALL collapse the box to its at-rest height. The rendered-notes
panel beside the box SHALL carry a Done button that does the same on a press. Neither SHALL
discard anything.

#### Scenario: Escape saves and closes

- **GIVEN** the Name box open with notes typed into it
- **WHEN** Escape is pressed
- **THEN** the notes SHALL be saved as typed
- **AND** the box SHALL be at its rested height and no longer focused
- **AND** the rendered-notes panel SHALL be gone

#### Scenario: Done saves and closes

- **GIVEN** the Name box open with notes typed into it
- **WHEN** the Done button in the rendered-notes panel is pressed
- **THEN** the notes SHALL be saved as typed
- **AND** the box SHALL be at its rested height and the panel gone

#### Scenario: Done is what the pointer lands on

- **GIVEN** the rendered-notes panel open
- **THEN** a hit test at the centre of the Done button SHALL answer the button, not the row behind
  the panel
