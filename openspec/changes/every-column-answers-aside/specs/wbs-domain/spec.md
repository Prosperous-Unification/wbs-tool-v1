## ADDED Requirements

### Requirement: A cell's hint stands beside its mark

A hint or fact card opened from a mark inside the plan's scrolling frame SHALL stand beside that
mark rather than under it, so that the rows below the mark stay readable.

A card opened from a mark outside that frame — the toolbar's controls — SHALL keep opening under
its mark.

#### Scenario: a cell's fact opens beside its mark

- **GIVEN** a work item whose Finish cell carries a fact
- **WHEN** that mark is hovered
- **THEN** the card SHALL be clear of the mark's own horizontal span

#### Scenario: a toolbar control's hint opens under it

- **GIVEN** a toolbar control that carries a hint
- **WHEN** it is hovered until its card opens
- **THEN** the card SHALL be under the control, overlapping it horizontally

### Requirement: The notes preview leaves its own row and the lane clear

The Name cell's rendered-notes preview SHALL stand clear of the row it belongs to, and SHALL
start past its own cell so that the notes markers of the rows below it are not covered.

It SHALL be as wide as the room to the right of its cell allows, up to its own ceiling.

#### Scenario: the preview clears its row

- **GIVEN** a work item with notes, and a preview open from its marker
- **THEN** the preview's top SHALL be at or below its row's bottom edge
- **AND** the preview's left edge SHALL be at or past the next row's marker

#### Scenario: the preview takes the width it is given

- **GIVEN** a preview open on a plan wider than its own cell
- **THEN** the preview SHALL be wider than the cell it opens from
- **AND** the whole preview SHALL be inside the scrolling frame
