## Why

The plan's generation coordinator narrows socket refreshes, but local writes still reread tree, steps, six directory lists and markers. The correct scope belongs to each successful operation. A gesture can also create a directory entry and then fail to attach it, so a single success flag loses real changes.

## What Changes

Every plan mutation declares which resources a successful request changes. The existing coordinator refreshes the union of completed operations, including a successful prefix of a compound gesture that later refuses. Known tree-only edits stop requesting unchanged directory, step and marker resources.

## Non-Goals

No optimistic state, query cache, resource-generation rewrite, socket policy changes, new batch atomicity, or changes to directory-page mutation behavior.

## Constraints

Preserve refused drafts, focus, stale banners, not-found recovery, project/API ownership, undo/redo and mandatory trailing reads. Unknown recovery events keep full refresh. Completed subwrites are accounted for even when the overall gesture is refused.

## Capabilities

### New Capabilities

- `local-write-invalidation`: resource obligations derived from completed local operations.

## Domain Terms

None.

## Decisions Recorded

None.

## Impact

fe-01's use-plan-read, mutation hooks, toolbar, cell contracts and their existing production-page tests. Depends on merged plan-refresh; coordinate with measured-rendering on shared hook signatures. No backend change or migration.
