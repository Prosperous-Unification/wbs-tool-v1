## Why

A plan lives in one deployment's SQLite file. The JSON export cannot be imported and names directory entries only by ids. Dany asked on 2026-09-02 for Export / Import and JSON carrying every project parameter, so the same file can preserve and restore authored work.

## What Changes

The JSON export grows additively into a versioned plan document with settings, step order, bands, capacity, calendar markers and referenced directory entries. Existing fields remain readable by MCP. Current deadlines and optimization preferences are included.

Import JSON creates a new caller-owned project with fresh ids in one admitted unit of work. Directory names match case-sensitively after trimming; absent entries are created. A taken solution slug is omitted and reported. Success opens the project and shows one summary toast; refusal shows its document path and keeps the current project.

## Non-Goals

No replacement, merge, undo, preview, CSV/Markdown import, picker import, existing-directory overwrite, audit restoration or derived-field restoration.

## Constraints

Preserve the JSON export's existing fields. The 200-command batch and undo journal are not the import mechanism. Use UnitOfWork's supplied stores, ArkType shared HTTP shapes and generated clients. File ids are local references. Parent roll-ups and optimizer runtime output are ignored. Every modeled refusal or source failure leaves no partial import.

## Capabilities

### New Capabilities

- `plan-import`: a plan document creates a new project, whole or not at all.

### Modified Capabilities

- `wbs-domain`: JSON joins the toolbar exports as the restorable plan document.

## Domain Terms

Plan document, Import, Plan export.

## Decisions Recorded

[ADR 0013](../../../docs/adr/0013-an-import-is-its-own-route-not-a-command-batch.md) and [ADR 0015](../../../docs/adr/0015-a-command-batch-is-a-unit-of-work-the-source-implements.md).

## Impact

contracts, core, be-01, fe-01 and generated mcp-01 tools. No migration. The 2026-09-08 readiness update replaces stale TypeBox/transaction/OpenAPI instructions; implementation remains unstarted.
