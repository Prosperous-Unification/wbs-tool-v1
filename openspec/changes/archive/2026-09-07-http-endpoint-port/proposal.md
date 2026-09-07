## Why

The backend's framework-free route lists still expose unknown bodies and replies, while validation, documentation, frontend transport, and MCP schemas describe the same HTTP boundary independently. Drift reaches callers at runtime. This implements the already-approved ports plan's HTTP wave after TASK-262 and the §67 correctness slices.

## What Changes

Every endpoint has one shared, handler-free shape with literal operation identity, request policies, ArkType request/reply validators, and generated JSON Schema. Backend handlers bind to those shapes; Elysia enforces policies before parsing. Requests reject unknown fields throughout nested objects. Validation and modeled domain failures use one discriminated Refusal envelope with declared status/body pairs. The frontend validates successful and refusal replies while accepting additive response fields. OpenAPI and MCP tools derive from the same shapes.

## Non-Goals

No store/source extraction, unit-of-work changes, runtime-port extraction, namespace moves, browser-only mode, second HTTP adapter/kit, gateway WebSocket changes, or MCP authentication/server changes.

## Constraints

Authority: docs/2026-09-05-ports-and-adapters-plan.md D1–D29, §3.1 and §4; ADR 0014/0015; existing CONTEXT terms. Promoted after the frozen checkpoint gates; feature commits through b2bb095c and R1/R3/R5 are integrated on the refactoring branch. Disjoint ownership and fresh timing evidence preceded source changes. R1 must land before frontend client replacement; retain R1 refresh and R3/R5 authentication negatives. Controllers already use `*.routes.ts`. Preserve empty replies, redirects, ordered cookies, typed 405/429/503, and unexpected account-store failures. Complete D26’s status sketch with landed 501 unsupported_body_version semantics, distinct from 422 corruption and 503 contention (saved-plan.routes.ts and its controller tests). Record backend/frontend typecheck time before generics and after; apply the plan's principal-inference fallback if time doubles. No compatibility constraint protects old permissive request envelopes; additive response compatibility remains required.

## Capabilities

### New Capabilities

- `http-endpoint-port`: Shared endpoint shapes, typed handlers, ordered policies, document/tool generation, and validated clients.

### Modified Capabilities

No canonical specs exist (`openspec list --specs --json`: No specs found). Existing change artifacts remain the behavior references during migration.

## Domain Terms

Existing: Endpoint shape, Endpoint, Refusal, Request policy. No new terms.

## Decisions Recorded

Existing ADR 0014 and ADR 0015; no new ADR.

## Impact

be-01 HTTP/controller/composition/tests, contracts, fe-01 API clients/fakes/screens, mcp-01 schema derivation/tests, observability metrics adapter, build/document/dependency wiring.
