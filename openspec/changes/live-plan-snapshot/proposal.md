## Why

Each command in one admitted batch rereads whole project collections to validate its write and capture undo state. The transaction already owns the writes, but the services repeatedly rebuild the same context. Reusing that context must retain every intervening mutation, including same-command hand-down and directory cascades.

## What Changes

An admitted project batch gets a working plan that serves detached collection reads and refreshes affected identities after successful writes. Ordinary routes, later batches and post-commit announcements keep their own reads. Full-project scans become bounded for plan-only batches; actual statement counts are measured separately.

## Non-Goals

No global cache, persisted snapshot, saved-plan changes, schedule interface changes, Promise.all rewrite, delayed writes, or isolation promise beyond the unit of work.

## Constraints

Create the working plan only inside UnitOfWork.run from its supplied stores. Never reuse SavedPlanCapture's separate connection. Preserve revisions, labels, order, rollback, undo before-images and event publication. Directory mutations conservatively reload the retained project collections. No SQL schema migration.

## Capabilities

### New Capabilities

- `live-plan-snapshot`: batch-owned plan collections with immediate read-after-write visibility.

## Domain Terms

Working plan.

## Decisions Recorded

[ADR 0019](../../../docs/adr/0019-a-working-plan-belongs-to-one-admitted-batch.md).

## Impact

Core store contracts and command composition after extraction; be-01 indexed readers and conformance kits. Depends on core extraction and command-registry binding completion.
