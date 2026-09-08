## Context

W3-10 concerns `apps/mcp-01/src/oauth.ts`, not be-01. be-01 already uses `InMemoryOidcTransactionStore`. MCP's map stores raw bindings and deletes before comparing upstream state. Since the historical refusal, TASK-276 changed the shared store to preserve live records on state mismatch; TASK-272 added plural browser cookies for be-01. Shared-store values still spread browserBinding, so digest-key adoption alone is not absence of that secret from retained values.

## Goals / Non-Goals

Adopt the shared store with three explicit behavior decisions: digested retained correlation, the existing timing-safe comparator, and mismatch preservation. Preserve MCP limits and downstream OAuth behavior. Do not adopt be-01's plural-cookie transport or split unrelated registry/token code.

## Decisions

Add `apps/mcp-01/src/pending-authorizations.ts` with `PendingAuthorizations`. It owns one actual `InMemoryOidcTransactionStore` and one bounded metadata map keyed by `digestOidcBinding(binding)`, a named helper exported by auth. The shared store owns state, nonce, verifier, expiry and single consumption. The metadata map owns only `{ clientId, codeChallenge, redirectUri, scope, state?, expiresAt }`, where state is the downstream client's state, not upstream proof. It stores neither the raw browser binding nor the upstream state.

```ts
type PendingOutcome =
  | { outcome: 'consumed'; nonce: string; verifier: string; authorization: AuthorizationContext }
  | { outcome: 'missing' | 'expired' | 'state_mismatch' };
interface AuthorizationContext {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scope: string;
  state?: string;
}
```

`save(binding, upstreamState, nonce, verifier, authorization)` is synchronous and returns `'saved' | 'capacity'`. It cleans expired entries, checks global and per-client bounds, saves the shared transaction and metadata without an await between them. Capacity refusal does not evict a live transaction. Preserve the current TTL and grant/session/client limits. A collision of generated binding with a live record throws rather than overwrites it; production randomness should make this impossible but injected deterministic sources can prove the guard.

`consume(binding, state)` first delegates to the shared store. On mismatch it preserves metadata and returns mismatch. On missing/expired it removes corresponding metadata and returns that outcome. On consumed it requires matching live metadata, deletes it, and returns context plus nonce/verifier. Missing metadata after successful shared consumption is malformed trusted state and throws. There is no successful fallback to empty redirect/client data.

`cleanupExpired` removes expired metadata and asks the shared store to reap transactions on the same injected clock. Capacity counts the metadata; the two stores are mutated only through this wrapper. The wrapper samples its clock once at the start of each synchronous operation and supplies that held instant through the concrete shared store's existing now option; both maps therefore use the same instant and deadline. No network request sits between correlation admission and metadata storage.

In auth, change the private stored record to omit browserBinding after computing its key; retain nonce, state, verifier and expiresAt. Public save/consume signatures stay unchanged. Export `digestOidcBinding` and use it in both stores; do not introduce a generic context-bearing auth store or a second shared state comparator.

In MCP callback, absent state or a mismatched state answers the existing 400 error without clearing a live binding cookie. A matched transaction is consumed before exchange; exchange failure cannot replay it. Missing/expired binding clears the cookie. Exchange receives the arriving matched state; it need not recover upstream state from metadata. A successful callback, grant-cap refusal or access denial after consumption clears the cookie as today.

## Proof Boundaries

A route-level wrong-state-then-honest-callback test is the behavioral proof. It must process Set-Cookie as a browser does: ignoring an erroneous clearing cookie would hide a lost login.

Raw retention is observable only through the in-process store boundary, not HTTP responses. In a test, run real authorize through InMemoryMcpOAuth and inspect its actual backing maps using a test-only type assertion; assert no retained key or value equals/contains the generated binding. This production-path assertion must fail when key hashing OR removal from values is undone.

Timing-safe comparison is a primitive-use claim, not a benchmark. Instrument node:crypto's timingSafeEqual in an isolated Bun test process, run an honest and wrong-state callback through the real wrapper/store, and assert the primitive was called with equal-length digest bytes. Fault the shared sameSecret implementation back to direct equality; the primitive-call assertion must fail while the ordinary callback behavior remains its control. Do not claim elapsed-time samples prove constant time.

## File Map and Migration Plan

`libs/auth/src/{oidc-store.ts,oidc-store.test.ts,index.ts}`; `apps/mcp-01/src/{pending-authorizations.ts,pending-authorizations.test.ts,oauth.ts,oauth.test.ts}`. First characterize all current capacity cases, then adopt shared transaction storage, then mismatch cookie behavior, then retained-secret/comparator proofs. Existing be-01 OIDC integration and binding tests run unchanged. No schema migration or external provider operation.

## Risks / Trade-offs

Two maps require synchronous ownership and expiry symmetry. The wrapper is the sole mutation boundary, with missing-metadata failure proof. Current single-cookie multi-tab limitations remain outside scope. Testing crypto instrumentation in an isolated process prevents mocking one security primitive across unrelated tests.

## Open Questions

None. Primitive instrumentation and negative outputs remain unverified until implementation; do not write Proof comments from anticipated messages.
