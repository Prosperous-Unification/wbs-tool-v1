## Why

Gateway ingress casts decoded JSON to a record before indexing it. Null and primitives can throw, resume points reach the backend without validation, and a malformed recognized control can fall through as a forwarded payload.

## What Changes

Validate client frames once against an ArkType inbound union before control dispatch. Accept ping, who, subscribe, unsubscribe, resume with a map of nonnegative safe-integer sequence points, and supported forward envelopes. Invalid JSON, primitives, arrays and malformed controls answer `invalid_payload`; the same connection remains usable.

## Non-goals

No presence fan-out change, backend transport deadlines, auth redesign or outbound-frame migration. Subscription authorization and existing unknown-subscription behavior stay where they are.

## Constraints

Approved refactoring plan §67 R4, independent of HTTP extraction. Preserve known client builders and forwarded message payloads. ArkType's string-index map accepts arrays and `number` accepts Infinity; the inbound resume declaration must close both gaps. Prove through the production controller and real loopback WebSockets, including ping after every refusal. Watch the unchecked-cast fault before writing Proof comments.
