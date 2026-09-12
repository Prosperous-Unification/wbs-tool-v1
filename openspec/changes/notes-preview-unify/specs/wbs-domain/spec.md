## MODIFIED Requirements

### Requirement: The notes preview is one card, on hover and while editing

The rendered notes SHALL be shown by a single card: opened by the notes marker on hover, and shown
beside the Name box while it is being written in. The two SHALL be the same size and content —
placed and clamped by the same measurement — and SHALL never run off the edge of the screen. While
the box is being written in, the marker SHALL open no second card.

#### Scenario: editing and hover show the same card

- **GIVEN** a work item with notes
- **WHEN** its editing preview and its hover preview are each shown from the same saved text
- **THEN** the two SHALL be the same width and height
- **AND** neither SHALL extend past the right edge of the window

#### Scenario: the marker stays quiet while editing

- **GIVEN** the Name box being written in, with its editing preview shown
- **WHEN** the pointer enters the notes marker
- **THEN** no second card SHALL open
