## ADDED Requirements

### Requirement: Plan assignment projections are scoped to the project

A tree read SHALL read only assignments belonging to its requested project and only assigned person id/name fields. Unrelated assignments, people and memberships SHALL NOT be scanned or materialized for that projection.

#### Scenario: Tiny project among unrelated projects

- **GIVEN** one assigned work item in the requested project and many assigned work items and people in unrelated projects
- **WHEN** the production tree read runs
- **THEN** its assignment/name projection returns only the requested assignment and name using indexed searches without global assignment or person scans

### Requirement: A single work-item assignment read is bounded

An assignment write SHALL read its prior assignment through the work item's indexed assignment key. Reads SHALL NOT require an arbitrary large IN list.

#### Scenario: Assignment write among unrelated projects

- **WHEN** an assignment is changed on a work item while unrelated projects hold many assignments
- **THEN** reading its prior assignment visits only assignments on that work item and undo preserves the prior assignee

### Requirement: Store projections preserve existing consumers

Subset reads and test stores SHALL preserve assignment contents and project isolation.

#### Scenario: Different projects in the memory fixture

- **WHEN** two projects hold assignments to different people
- **THEN** each tree contains only its own assignments and assigned names
