## Why

Gateway delivery, command forwarding and resume requests can wait indefinitely for response headers or bodies despite finite retry counts. That leaves callers pending and consumes transport resources without an application deadline. Refactoring plan §67 R9 requires bounded attempts and one overall budget before runtime extraction.

## What Changes

Each logical gateway request has injected attempt and overall budgets. Timeout and caller cancellation reach the active transport through response-body consumption and interrupt backoff. Modeled transient failures retry only within the remaining budget. Gateway callers retain their modeled unavailable responses. A committed edit remains successful when its gateway delivery expires, with its durable event available for replay and the write lock free during delivery.

## Non-Goals

No background delivery worker, fire-and-forget task per edit, retry of arbitrary non-idempotent commands, replay-buffer expansion, health-policy redesign, source extraction or broader HTTP migration.

## Constraints

Approved authority: docs/2026-09-02-refactoring-plan.md §67 R9 and ports plan §3.4. One owner coordinates runtime injection with Wave2. Start with backend-only ownership after the frozen gate releases; gateway lifecycle wiring waits for R7 handoff. Runtime capabilities stay outside domain/contracts. Preserve existing push status policy and retry-count semantics, journal/commit ordering, and post-lock publication. Unknown failures propagate rather than become transient defaults. Prove cancellation at both deterministic transport and real streaming-fetch boundaries; wrapper settlement alone is insufficient.

## Capabilities

### New Capabilities

- `gateway-request-deadlines`: Bounded logical gateway requests with transport cancellation and preserved commit semantics.

### Modified Capabilities

None.

## Domain Terms

None.

## Decisions Recorded

Existing ADR0014/0015 runtime and publication boundaries; no new ADR.

## Impact

Backend PushClient/composition/broadcaster tests; portable deadline/timer transport capability; gateway ForwardClient/resume transport and post-R7 connection cancellation wiring/tests.
