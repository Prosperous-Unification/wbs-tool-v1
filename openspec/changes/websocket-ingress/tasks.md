## 1. Inbound boundary

- [x] 1.1 Add controller regressions for primitives, malformed controls and resume maps; observe the unchecked-cast failure.
- [x] 1.2 Add real-socket malformed-frame/refusal/ping regression plus valid forwarded/resume controls; run with loopback permission.
- [x] 1.3 Define shared ArkType inbound schemas, validate before indexing and remove ingress casts/defaults.
- [x] 1.4 Inject boundary bypass, malformed-control forwarding and resume map/sequence weakening; record actual failures before Proof comments.
- [x] 1.5 Scoped gateway/contracts tests, typecheck, lint and formatting; record workspace/browser gates deferred to integration.

## 2. Review: complete wire decoding

- [x] 2.1 Observe real-socket failures for space/tab/newline-prefixed controls, forwarding and resume, preserving quoted-command refusal.
- [x] 2.2 Preserve raw frames ahead of Elysia's parser and decode JSON once in the route hook.
- [x] 2.3 Inject second decoding and missing wire envelope; record the actual failures and binary refusal coverage.
- [x] 2.4 Rerun scoped tests, source/spec typecheck, lint, formatting and strict artifact validation; hold for review.
