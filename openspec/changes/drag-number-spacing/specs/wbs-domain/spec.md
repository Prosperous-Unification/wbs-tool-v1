## ADDED Requirements

### Requirement: Compact drag-to-number spacing

The default plan table SHALL place work item numbers 8px closer to their drag handles than the previous layout, without changing number text, number indentation, the Number column's width or the reserved expander space. The drag glyph MUST remain visible and usable within its cell.

#### Scenario: Compact leading controls

- **GIVEN** a fresh table with default column widths and root rows
- **WHEN** the table is rendered
- **THEN** the blank horizontal gap between the drag glyph and each printed root number SHALL be 8px smaller than the previous layout
- **AND** each drag glyph SHALL remain inside its cell and remain draggable

#### Scenario: Parent and leaf alignment survives compaction

- **GIVEN** a parent and a childless sibling at the same depth
- **WHEN** the parent is collapsed and expanded
- **THEN** the sibling numbers SHALL remain aligned and stationary
- **AND** the expander SHALL remain usable

#### Scenario: Pinned controls stay adjacent

- **WHEN** the table is scrolled horizontally
- **THEN** its pinned columns SHALL remain adjacent using the compact drag-column width
- **AND** the existing Number column envelope and deep-number distinction SHALL remain intact
