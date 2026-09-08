## Why

MCP OAuth still holds raw browser bindings in its own transaction map, compares upstream state directly, and deletes a live login before checking a callback's state. The shared auth store already implements digested keys, timing-safe comparison and mismatch preservation. Adoption must retain MCP-specific capacity and downstream authorization metadata.

## What Changes

MCP uses the shared transaction store for browser correlation and keeps typed downstream metadata behind a bounded MCP wrapper. Wrong-state callbacks preserve the honest login and its cookie; matched callbacks remain single-use. Existing client, grant and session capacity behavior remains.

## Non-Goals

No persistent OAuth storage, multi-tab cookie redesign, token format change, registration-policy redesign or broad OAuth class decomposition.

## Constraints

Keep five-minute TTL, global and per-client pending limits, no live eviction, expiry ordering and reservation during asynchronous signing. Digesting a map key does not establish absence of the binding from retained values; tests cover both. be-01 already uses this store and its mismatch behavior must remain.

## Capabilities

### New Capabilities

- `mcp-oidc-store`: shared browser transaction semantics with bounded MCP metadata.

## Domain Terms

None.

## Decisions Recorded

None; current shared-store semantics are authoritative.

## Impact

auth transaction store types and tests, mcp-01 OAuth composition and capacity/callback tests. No backend migration or external identity-provider change.
