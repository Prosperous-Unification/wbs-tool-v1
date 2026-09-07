## ADDED Requirements

### Requirement: Rendering budgets come from browser measurements

The change SHALL record actual Chromium baselines and concrete acceptance budgets before optimizing, covering100/500/1000 rows, two/eight steps and sparse/dense dependencies through the real backend.

#### Scenario: Reproducible scaling matrix

- **WHEN** the baseline runs with a fixed viewport and recorded environment
- **THEN** each fixture SHALL report cold-context and warm samples, input and filter paint opportunities, actual mounted cells and viewport geometry
- **AND** setup time and instrumented render counts SHALL remain distinct from uninstrumented timing.

### Requirement: Mounted cells follow the viewport

Mounted cells SHALL be bounded by visible rows and columns plus declared overscan and an explicit active-editor allowance, independently of total project size.

#### Scenario: Same viewport on larger projects

- **WHEN** project row count increases from100 to1000 with the same viewport and columns
- **THEN** mounted cells SHALL remain within the measured fixed-viewport budget
- **AND** restoring full mounting SHALL fail the browser assertion.

### Requirement: Editing and navigation retain logical identity

Keyboard traversal, selection, drag targets and accessible row indices SHALL operate on the full logical filtered/expanded row order. An active editor SHALL retain its node, draft and selection while its row leaves the normal mounted viewport.

#### Scenario: Keyboard crosses a mounted boundary

- **WHEN** navigation targets the next logical row beyond the viewport
- **THEN** that target SHALL mount and receive focus without changing the logical ordering or losing committed/refused state.

#### Scenario: Active editor scrolls away

- **WHEN** scrolling moves a half-typed editor outside the viewport
- **THEN** it SHALL remain pinned and return with the same node, text and selection
- **AND** commit/Escape SHALL preserve their existing behavior.

### Requirement: Find editing does not rerender unaffected cells

Urgent query editing SHALL be isolated from cell construction and filtering completion SHALL remain observable separately from input painting.

#### Scenario: Broad query preserves the same rows

- **WHEN** a real Find keystroke changes criteria without changing the logical rows
- **THEN** unrelated cells SHALL stay within the measured render-call budget
- **AND** restoring query ownership to the all-cells parent SHALL fail the production browser count.

### Requirement: Geometry and peer state remain correct

Variable row heights, logical striping, pinned columns, drag autoscroll, peer changes and Gantt row correspondence SHALL remain correct across viewport transitions. Gantt export SHALL include the complete logical chart.

#### Scenario: Peer changes a row dependency during another edit

- **WHEN** a peer changes a displayed committed value while an unrelated editor holds typed text
- **THEN** the changed value SHALL paint and the unrelated editor SHALL retain identity and selection
- **AND** omitting that row dependency SHALL fail the browser regression.

#### Scenario: Row height changes near a window edge

- **WHEN** a name wraps, notes expand, or a peer update changes row height
- **THEN** viewport placement and scroll anchoring SHALL follow measured height without clipping or incorrect row correspondence.
