# Team removal revisions

## Purpose

Keep work-item revisions and undo staleness consistent when any attached team is
removed.

## Requirements

### Requirement: Removing a team revises every affected work item

A successful team removal SHALL increment the revision of every work item holding that team exactly once and stamp its update time while preserving its original author in the same transaction. Unaffected rows SHALL remain unchanged.

#### Scenario: Secondary team removal

- **WHEN** a work item holds two teams and the removed team is not its legacy singleton
- **THEN** its remaining team is preserved and its revision and audit stamp change exactly once

#### Scenario: First team removal

- **WHEN** the removed team also occupies the legacy singleton
- **THEN** the singleton is cleared and the revision changes exactly once

#### Scenario: Refused or repeated removal

- **WHEN** removal is refused as in-use or the team is already absent
- **THEN** no work-item revision or audit stamp changes

### Requirement: Undo observes removal of any team

Undo SHALL refuse as stale when a later team removal changed a work item touched by the journal entry.

#### Scenario: Undo after secondary team removal

- **WHEN** a rename is journalled on a work item and a secondary team is subsequently removed
- **THEN** undo refuses as stale and preserves the current name and surviving team
