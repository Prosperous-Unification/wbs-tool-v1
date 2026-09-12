## Why

A tiny plan currently reads every assignment, person and team membership before filtering in memory. One assignment write also scans the assignment table. Refactoring plan §67 R6 requires project and work-item scope at the store boundary before extraction.

## What Changes

Tree reads obtain assignments and assigned names together within their project. Single-work-item assignment reads use its indexed key. Existing subset consumers retain their behavior through bounded indexed lookups.

## Non-Goals

No package extraction, schema migration, concurrency change, scheduler change, or narrowing of saved-plan directory capture.

## Constraints

Preserve wire replies, authorization, undo history and snapshots. Use existing migrated indexes. Prove scope with actual SQL result counts and query plans on the production tree/write path. The settled §67 plan supplies the approved intent.

## Capabilities

### New Capabilities

- `project-assignment-reads`: Project and single-row scope for assignment projections.

### Modified Capabilities

None.

## Domain Terms

None.

## Decisions Recorded

None.

## Impact

be-01 directory port/repository, work-item service and test fixtures.
