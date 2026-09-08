## Why

The same 36 command kinds are described by an ArkType wire union, a backend command union, a semantic parser and a dispatcher. A new kind still needs coordinated edits despite the shared HTTP contract already supplying schemas and MCP tools. One definition per kind should make omissions fail where commands are bound.

## What Changes

Commands gain one shared structural definition and one exhaustive application binding. Validation, normalization, ordered execution, refusal precedence and the existing two batch MCP tools retain their behavior. The independent handwritten kind list and normalized command union disappear.

## Non-Goals

No new commands, individual MCP tools, transaction changes, HTTP framework change, or request/response redesign.

## Constraints

Preserve structural-versus-semantic validation order, null versus omitted fields, batch refs, the 200-command admission rule and directory-only refusals. Contracts cannot import services or storage. Reuse ArkType, SchemaShape, documentFromShapes and clientFromShapes already shipped by HTTP Wave 1; Elysia schema export is no longer a dependency.

## Capabilities

### New Capabilities

- `plan-command-registry`: complete command definitions and typed application bindings.

## Domain Terms

None.

## Decisions Recorded

Existing [ADR 0014](../../../docs/adr/0014-ports-live-in-a-framework-free-core-lib.md), D21/D25; no new ADR.

## Impact

contracts, core command parsing/execution after extraction, be-01 mounted command tests, fe-01 client type checks and mcp-01 generated-tool tests. No migration.
