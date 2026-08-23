# Tasks

Ordered TDD slices. Public exposure and migration-fallback removal are held for
main-session review even when earlier slices merge to dev on green.

## 1. Shared authentication contract

- [x] 1.1 Add cached RS256/JWKS verification with issuer, audience, signature,
      and expiry enforcement — test: `libs/auth/src/token-verifier.test.ts`
      covers good, wrong audience, wrong issuer, and expired tokens.
- [x] 1.2 Add explicit auth/MCP mode readers and wire them into all three boot
      paths — test: `auth-mode.test.ts` plus be/gw/mcp config tests; negative:
      missing, unknown, and production-local modes observed failing.
- [x] 1.3 Declare development and production runtime signals and add `@wbs/auth`
      to devsync — test: `tools/dev/setup.test.ts` and remote-scripts Docker tests;
      negative: absent manifest entry observed failing the affected gate.

## 2. Browser OIDC transaction and session

- [x] 2.1 Implement single-use, browser-bound transaction records with TTL,
      PKCE verifier, state, and nonce — test: consume/replay/expiry unit cases.
- [x] 2.2 Implement rotating session records behind `TokenStore` — test:
      renewal, replay refusal, cleanup, and logout deletion.
- [ ] 2.3 Mount login/callback/logout/refresh in be-01 and assert the callback
      path — test: route integration and wrong-path boot failure.
- [ ] 2.4 Enforce hardened cookie attributes and Origin/CSRF on cookie writes —
      test: same-origin success and hostile/missing Origin failures.

## 3. Identity and authorization

- [ ] 3.1 Rebuild the SQLite account table with nullable password, normalized
      email, issuer, and subject — test: up/down on populated fixture preserves
      every legacy account and unique constraints.
- [ ] 3.2 Link issuer-subject first and verified email second in one transaction
      — test: replay, collision, unverified email, and non-email legacy cases.
- [ ] 3.3 Parse the configured groups claim into scopes — test: exact namespace,
      wrong environment, malformed claim, and empty groups.
- [ ] 3.4 Inventory every mutating route and apply write scope above the existing
      owner rule — test: read-only identity cannot mutate any inventoried route.

## 4. WebSocket and MCP trust

- [ ] 4.1 Authenticate WebSocket upgrades from the session cookie and enforce
      allowed Origin — test: expired cookie and cross-site upgrade failures.
- [ ] 4.2 Implement MCP standalone and trusted-gateway modes, caller propagation,
      and three health probes — test: both modes and false trusted-gateway boot.
- [ ] 4.3 Spike Claude connector registration and record the proven token,
      audience, issuer, and forwarding trace before fronting-AS code starts.
- [ ] 4.4 Add RFC 9728/8414 metadata — test: discovery from the MCP inspector.
- [ ] 4.5 Add exact-redirect DCR and PKCE with upstream Okta login — test:
      invalid redirect, verifier replay, and browser round trip.
- [ ] 4.6 Issue short-lived audience-bound MCP tokens, retain upstream tokens
      server-side, and enforce expiry/revocation — test: full trust trace.

## 5. Client and solution integration

- [ ] 5.1 Point fe-01 login at `/api/auth/login` and remove local token storage —
      test: browser flow under local mode without an IdP.
- [ ] 5.2 Add nullable `solutionRef` and solution-slug lookup — test: migration
      round trip, known slug, collision, unknown slug, and read scope.
- [ ] 5.3 Add JSON and Markdown project exports — test: both formats,
      unsupported format, unknown project, and missing read scope.

## 6. Acceptance and cutover

- [ ] 6.1 Document and run Keycloak-in-Docker over the HTTPS dev origin: browser
      login, cookie API, WS, standalone MCP, and fe-01 all succeed.
- [ ] 6.2 Wire the off-repo Okta env into dev, run real-Okta login, and remove
      `x-wbs-token` fallback — public-exposure review required before merge.
- [ ] 6.3 Add the Claude connector to dev with zero manual token steps and drive
      one tool call under Dany's identity; file deployment QA.
