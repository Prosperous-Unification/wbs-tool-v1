## Why

Removing a team currently revises only work items whose legacy singleton column names it. Removing a secondary team changes the plan while leaving its revision and audit stamp unchanged, so an undo can overlook the change. This implements refactoring plan §67 R2 before store extraction.

## What Changes

Every work item losing the removed team receives exactly one revision increment and the removal audit stamp in the removal transaction. The legacy column is cleared separately. Undo detects that revision change.

## Non-Goals

No store extraction, schema migration, route changes, or assignment query changes.

## Constraints

Preserve typed in-use/not-found refusals and existing cascade consent. Derive affected rows from work_item_team. Use the existing revision and audit conventions. The settled §67 intent authorizes implementation without another design interview.

## Capabilities

### New Capabilities

- `team-removal-revisions`: Revision and audit consistency when any team label is removed.

### Modified Capabilities

None.

## Domain Terms

None.

## Decisions Recorded

None.

## Impact

be-01 directory repository and undo regression coverage.
