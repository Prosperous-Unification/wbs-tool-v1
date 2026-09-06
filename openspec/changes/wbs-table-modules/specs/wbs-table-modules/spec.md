## ADDED Requirements

### Requirement: Columns preserve the live composition boundary

The table SHALL define mutable cell behavior through one exported live type, and its column definitions SHALL change identity only when steps, unfolded steps or hidden column ids change.

#### Scenario: A peer edits during a local name draft

- **WHEN** a peer refresh lands while a reader holds a half-typed name
- **THEN** the focused cell and its local typed value remain intact

### Requirement: Concept modules preserve table behavior

The table SHALL compose remembered layout, layout, column set, read, filter, toolbar, export actions, keyboard, structure, estimate drafts, reference sets, column families, cell props and chart input modules while preserving their existing behavior.

#### Scenario: Layout reset after a resize

- **WHEN** a reader resets a layout with remembered column widths and chart height
- **THEN** both return to their existing default rules

#### Scenario: Pointed row changes

- **WHEN** the pointed store changes its resolved row
- **THEN** PlanRow retains its existing subscription isolation and unrelated cell definitions remain mounted
