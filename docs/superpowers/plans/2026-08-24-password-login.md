# Password Login Beside SSO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let existing WBS password accounts sign in beside Auth0 while both paths use the hardened browser cookie and resolve to the same WBS identity/scopes.

**Architecture:** Keep the existing local credential store and HS256 session issuer. In OIDC mode, explicitly enable that issuer with `AUTH_PASSWORD_LOGIN`, put its token in `__Host-wbs_access`, and teach be-01 and gw-01 to accept the local verifier as a controlled fallback after OIDC verification. Keep registration independently disabled unless `AUTH_PASSWORD_REGISTER=true`; throttle failed password attempts before exposing the route publicly.

**Tech Stack:** Bun, TypeScript, Elysia, jose, React, Playwright.

## Global Constraints

- `AUTH_PASSWORD_LOGIN` defaults to `true`; production may set it to `false`.
- `AUTH_PASSWORD_REGISTER` defaults to `false`; registration stays 404 when disabled.
- Password and SSO sessions use `__Host-wbs_access` with `HttpOnly; Secure; SameSite=Lax; Path=/`.
- Password identities receive the local-mode scopes `read`, `write`, and `editor`; the schema has no per-user role/scope column.
- Five failed attempts per normalized username or client IP lock that key for 60 seconds; unknown-user and wrong-password responses stay identical.
- Builds and tests run only on h2puni.

---

### Task 1: be-01 password session in OIDC mode

**Files:**

- Modify: `apps/be-01/src/controller/auth.controller.ts`
- Modify: `apps/be-01/src/service/auth.service.ts`
- Modify: `apps/be-01/src/boot.ts`
- Modify: `apps/be-01/src/services.ts`
- Test: `apps/be-01/src/controller/oidc.integration.test.ts`
- Test: `apps/be-01/src/service/auth-service-null-password.test.ts`

**Interfaces:**

- Consumes: existing `AuthService.login(username, password)` and `JWT_SIGNING_KEY_CURRENT`.
- Produces: `OidcRouteOptions.passwordLoginEnabled`, `OidcRouteOptions.passwordRegisterEnabled`, and an OIDC-mode POST login response carrying `__Host-wbs_access`.

- [ ] Write an OIDC integration test that creates a password user, POSTs valid credentials, asserts the hardened cookie, then calls `/api/auth/me` with that cookie and expects `read/write/editor` scopes.
- [ ] Push the test-only commit and run `bun test apps/be-01/src/controller/oidc.integration.test.ts` on h2puni; record the expected 404 watched RED.
- [ ] Parse the two flags in `oidcRouteOptionsFromEnv`, defaulting login on and registration off.
- [ ] Allow POST login when enabled, set the access cookie on success, and keep the same invalid-credentials body for unknown and wrong passwords.
- [ ] Permit HS256 session verification after OIDC verification fails only when password login is enabled; keep OIDC-only users unloggable by password.
- [ ] Run the targeted be-01 tests, lint, and typecheck on h2puni and commit.

### Task 2: Failure throttle

**Files:**

- Create: `apps/be-01/src/service/login-throttle.ts`
- Test: `apps/be-01/src/service/login-throttle.test.ts`
- Modify: `apps/be-01/src/controller/auth.controller.ts`
- Test: `apps/be-01/src/controller/oidc.integration.test.ts`

**Interfaces:**

- Consumes: normalized username, client IP, `Date.now`, and the existing login outcome.
- Produces: a bounded in-memory throttle with `canAttempt`, `recordFailure`, and `recordSuccess` operations.

- [ ] Write watched-red tests proving the sixth failure inside 60 seconds is refused independently by username and IP.
- [ ] Implement fixed-window counters with expired-entry cleanup and clear the username entry after success.
- [ ] Wire the throttle before password verification while preserving the identical 401 body.
- [ ] Run affected be-01 tests, lint, and typecheck on h2puni and commit.

### Task 3: gw-01 password WebSocket sessions

**Files:**

- Modify: `apps/gw-01/src/config.ts`
- Modify: `apps/gw-01/src/app.ts`
- Test: `apps/gw-01/src/ws-auth.integration.test.ts`
- Test: `apps/gw-01/src/config.test.ts`

**Interfaces:**

- Consumes: the OIDC verifier, `JWT_SIGNING_KEY_CURRENT`, optional previous key, and `AUTH_PASSWORD_LOGIN`.
- Produces: a verifier that tries OIDC first and the existing `JwtVerifier` second only when password login is enabled.

- [ ] Write a watched-red real WebSocket test whose access cookie is a be-01-style HS256 token while OIDC mode is active.
- [ ] Compose the OIDC and local verifiers without weakening origin or cookie checks.
- [ ] Prove an invalid token and a foreign origin still fail, then run gw-01 tests, lint, and typecheck on h2puni and commit.

### Task 4: Login card and browser contracts

**Files:**

- Modify: `apps/fe-01/src/components/auth/auth-form.tsx`
- Modify: the existing auth API client used by the form
- Test: the colocated auth-form unit test
- Test: the existing Playwright auth spec

**Interfaces:**

- Consumes: POST `/api/auth/login`, GET `/api/auth/login`, and inline API errors.
- Produces: username/password controls beside a `Continue with SSO` link; all interactive targets are at least 44px.

- [ ] Write watched-red component tests for both paths, stable inline error space, and 44px controls.
- [ ] Implement the form, reload/navigate after the cookie response, and keep SSO as a normal browser navigation.
- [ ] Add Playwright coverage for password login and preserve the SSO redirect assertion.
- [ ] Run fe-01 unit, Chromium, lint, typecheck, and format gates on h2puni and commit.

### Task 5: Documentation, deployment, and QA handoff

**Files:**

- Modify: `docs/auth-integration.md`
- Create off-repo: `/home/puni1/wbs-dev/qa-accounts.env` with mode `600`

**Interfaces:**

- Consumes: the verified flags, throttle, scope rule, and QA account location.
- Produces: operator runbook, PR, and queued credentialed Browser Use Cloud QA.

- [ ] Document both flags, the full local scope rule, the throttle, and the off-repo QA account path without recording credentials.
- [ ] Run the full affected gate on h2puni, open the PR, wait for green CI, and route the public-login diff to main-session review.
- [ ] After merge/deploy, verify password `/api/auth/me` and WebSocket behavior plus SSO in Browser Use Cloud.
- [ ] Requeue TASK-107 and TASK-108 with log lines naming only the QA account file path.
