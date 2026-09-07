# Tasks

Ordered TDD slices. This public authentication change stops at prod-mode review.

## 1. Gateway boundary

- [x] 1.1 Add a production-path integration red proving a valid session JWT in
      `/ws?token=` is refused.
- [x] 1.2 Remove query-token authentication, require exact Origin plus the
      access cookie in OIDC mode, and fail closed when neither OIDC nor explicit
      local mode is configured. The dedicated upgrade test observes the exact
      401 body; deleting the fail-closed branch makes it red.
- [x] 1.3 Carry fixed local identity and verified token between Elysia hooks on
      private Symbols; prove `/ws?localIdentity=mallory` cannot override the
      cookie-verified user.
- [x] 1.4 Convert fan-out and presence-race fixtures to cookie plus exact Origin
      without weakening their connection-open ordering checks.

## 2. Client boundary

- [x] 2.1 Add a red proving the reconnecting client opens the configured URL
      without requiring or appending a JWT.
- [x] 2.2 Remove `ReconnectingWsOptions.jwt`, open `opts.url` verbatim on every
      attempt, and remove token inputs from both frontend socket surfaces and
      their fixtures.

## 3. Deployment boundary

- [x] 3.1 Add a complete-upgrade-request test proving smoke carries Origin and
      cookie headers while the request target remains exactly `/ws`.
- [x] 3.2 Make direct-Caddy and override smoke connections use the same
      credential-free request target and cookie/Origin contract.

## 4. Record and gates

- [x] 4.1 Replace query-token instructions in `docs/local-dev.md` and
      `docs/runbook-dev-deploy.md` with explicit local/OIDC procedures.
- [x] 4.2 Record proposal, design, capability delta, ordered tasks, gate counts,
      and watched-fault table.
- [x] 4.3 Run affected tests, lint, typecheck, build, global format, strict
      OpenSpec validation, exact-head CI, Gemini, and the required Anthropic peer
      review; hand the green branch to main-session prod review without merging.
