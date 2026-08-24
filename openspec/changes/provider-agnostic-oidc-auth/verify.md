# Verification Report

**Change**: `provider-agnostic-oidc-auth`
**State**: merge candidate — implementation reviewed; public cutover unapplied

## 1. Structural Validation

- [x] `openspec validate --all --strict --json` — 73 changes valid, 0 invalid

## 2. Task Completion

Tasks 1.1–6.1 are complete. The reviewed merge applies 6.2's cutover; real Okta
and Claude connector acceptance remain post-deployment checks before archive.

## 3. Failure Proofs — shared contract slice

| Check                 | Fault observed                                        | Test that went red                      | Result            |
| --------------------- | ----------------------------------------------------- | --------------------------------------- | ----------------- |
| RS256 issuer          | token carried another issuer                          | `token-verifier.test.ts` wrong issuer   | refused           |
| RS256 audience        | token carried another audience                        | `token-verifier.test.ts` wrong audience | refused           |
| token expiry          | signed token was expired                              | `token-verifier.test.ts` expired token  | refused           |
| production local mode | production used `AUTH_MODE=local`                     | be-01 and gw-01 config tests            | boot refused      |
| MCP mode set          | unknown `MCP_AUTH_MODE`                               | mcp-01 config test                      | boot refused      |
| devsync coverage      | `libs/auth/project.json` absent from restart manifest | `tools/dev/setup.test.ts`               | affected gate red |
| transaction replay    | consumed browser transaction presented again          | `oidc-store.test.ts` one-use case       | refused           |
| browser binding       | another browser presented the valid state             | `oidc-store.test.ts` binding case       | refused           |
| transaction expiry    | callback arrived exactly at expiry                    | `oidc-store.test.ts` expiry case        | refused           |
| refresh replay        | rotated refresh token presented again                 | `oidc-store.test.ts` replay case        | session ended     |
| refresh mismatch      | unrelated token attempted rotation                    | `oidc-store.test.ts` unknown-token case | refused           |
| WebSocket Origin      | valid cookie arrived from a hostile Origin            | `ws-auth.integration.test.ts`           | upgrade refused   |
| WebSocket expiry      | verifier bypassed for an expired cookie               | `ws-auth.integration.test.ts`           | test failed red   |

The implementation run observed each row red before the production line was
accepted. Future safety checks append their own faults here; no reasoning-only
row counts as proof.

## 4. Gate Output — shared contract slice

At branch `9db0791` on h2puni, cache skipped:

- format: clean
- all 23 affected projects: test, lint, and typecheck green
- auth 10/0; fe-01 1714/0; be-01 1064/0; gw-01 46/0; mcp-01 65/0
- lint: one pre-existing fe-01 hook warning, zero errors

## 5. Gate Output — transaction-store slice

On h2puni with the Nx cache skipped: auth 19/0, lint clean, typecheck clean,
`nx format:check --all` clean, and strict OpenSpec validation 73/73.

## 6. Gate Output — WebSocket cookie slice

On h2puni with the Nx cache skipped:

- auth 23/0 and gw-01 51/0
- both projects lint and typecheck clean
- global format clean
- strict OpenSpec validation 73/73

## 7. Implementation Signal

- [x] Shared code committed and pushed on `change/okta-auth`
- [x] OpenSpec artifacts committed and pushed
- [ ] All tasks complete
- [x] Transaction and refresh-token stores implemented on `change/okta-auth-transaction`

## 8. MCP OAuth spike — 2026-08-24

## Verdict: VALIDATED

**Question:** Can Claude authenticate to mcp-01 with zero manual token steps
while be-01 keeps its single Okta issuer/audience verifier and no OBO/token
exchange is introduced?

**Registration evidence:** Anthropic's current official connector guidance
supports DCR and, when DCR is absent, a custom client ID/secret entered in the
UI with callback `https://claude.ai/api/mcp/auth_callback`. The custom-client
path is therefore technically available but not zero-manual. Okta's official
DCR API requires an administrative credential; exposing that path is rejected.

**Runnable trace:** throwaway spike run on h2puni from the task branch with
`/home/puni1/wbs-dark/.bun-1314/bin/bun ./.tmp-wbs-mcp-oauth-spike.ts`.
It generated independent RS256 signing keys and proved:

1. Claude's local token: issuer
   `https://dev.wbs.bulletpoints.club/mcp/oauth`, audience
   `https://dev.wbs.bulletpoints.club/mcp`.
2. mcp-01 verified it and resolved `local jti -> upstream token` only from
   server-side state; no browser token was forwarded.
3. be-01 accepted only the upstream token: issuer
   `https://example.okta.com/oauth2/default`, audience `api://wbs-dev`.
4. Subject `00u-dany` and scopes `wbs:read wbs:write` survived the trace.

**Stress evidence:** all three negative paths were observed rejected: local MCP
token at be-01, upstream Okta token at mcp-01, and a valid local token whose
server-side upstream mapping had been removed.

**Recommendation:** implement 4.4–4.6 as the fronting-AS path. Keep the custom
client-ID UI route only as a documented manual fallback, not acceptance.

## Decision

- [x] PASS — merge candidate, gated by fresh CI and post-merge deployment acceptance
- [ ] ARCHIVE — only after real Okta and Claude connector acceptance

## 9. MCP OAuth discovery metadata — 2026-08-24

The watched red returned no `MCP_PUBLIC_URL`, accepted its absence, and could
not import either metadata handler. A second production-path red could not
import `mcpHttpResponse`; this pins the MCP-required `WWW-Authenticate`
challenge rather than only testing a detached metadata builder.

Fresh h2puni gate after implementation:

- mcp-01: 73 tests passed, 0 failed; lint and typecheck clean
- global format clean
- strict OpenSpec validation: 73 passed, 0 failed

MCP Inspector CLI connected to a temporary gateway-mode server at
`http://127.0.0.1:3339/mcp`. Without interactive auth it returned
`auth_required`; with auto-open enabled it followed the RFC 9728 challenge,
loaded RFC 8414 metadata, and reached the advertised DCR endpoint, where it
received the expected `404 Not found`. DCR belongs to task 4.5, so discovery
has reached the exact boundary of this slice.

## 10. MCP fronting tokens — 2026-08-24

The watched reds had no token or revocation endpoint and forwarded the presented
local token unchanged. The implementation now signs five-minute RS256 tokens
for the MCP audience, binds each `jti` to the upstream token server-side, and
keeps directly presented verified upstream tokens compatible. Authorization
codes are one-use; expired or revoked mappings invalidate an otherwise valid
local JWT. Fresh h2puni gate: mcp-01 80/0, lint, typecheck, global format, and
strict OpenSpec validation clean.

## 11. Browser cookie client — 2026-08-24

The watched reds found the username/password form, the token-bearing WebSocket
URL, and a missing-token 401 under local mode. fe-01 now starts the server-side
OIDC flow, resolves the httpOnly cookie through `/api/auth/me`, stores no session
credential in JavaScript, and opens `/ws` without a token query. Explicit local
mode supplies the fixed `local-dev` identity without a cookie or IdP.

Fresh h2puni gate: fe-01 1,714/0 and be-01 1,090/0; both lint and typecheck
clean; global format clean; strict OpenSpec validation 73/73.

## 12. Dev Okta cutover candidate — 2026-08-24

The dev source compose file now reads only the shared OIDC provider settings
from `/home/puni1/wbs-dev/oidc-dev.env` and starts every tier with
`AUTH_MODE=oidc`. The file exists off-repo at mode 600; no provider value is in
this change. Applying the compose change requires an explicit container
recreation, so the public origin remains on local mode until the required
public-exposure review passes.

The legacy `x-wbs-token` branch is removed. Its production-path negative was
watched red before implementation: the retired header authenticated and
returned 200 when the test required 401. It now returns 401; cookie and standard
Bearer inputs remain supported.

Fresh h2puni candidate gate:

- be-01: 1,101 tests passed, 0 failed; lint and typecheck clean
- mcp-01: 80 tests passed, 0 failed; the 51-tool drift guard records both new
  solution routes as plan surface
- tool-devsync affected targets green
- global format and plaintext-secret scan clean
- strict OpenSpec validation: 73 passed, 0 failed
- `docker compose config --quiet`: valid with the off-repo env present and with
  the CI-only missing-file case; OIDC boot remains the absence guard on dev

Real Okta browser acceptance is deliberately pending: changing the public auth
mode before main-session review would violate the exposure gate this task names.

## 13. Main-session exposure review — 2026-08-24

The review found one merge-blocking bypass: OIDC mode still mounted password
registration/login and authenticated legacy HS256 sessions before trying the
OIDC verifier. The watched red returned `200, 200` for the two password routes
and authenticated a valid legacy token with full scopes. Commit `fe0e5db`
makes password routes answer 404 under OIDC and makes the configured auth mode
exclusive; the focused gate is 17/17.

Fresh h2puni review evidence on the rebased head:

- OIDC identity plus solution migrations: 34/34 on real SQLite databases,
  including populated up/down, rollback refusal for passwordless identities,
  re-apply, full unwind, and solution-reference round trip.
- Watched mutations: legacy `x-wbs-token` restoration produced 1 intended red;
  hostile WebSocket Origin bypass produced 1; weakened MCP redirect membership
  produced 1; disabling the foreign-key rebuild marker produced 4.
- be-01: 1,104/1,104; fe-01: 1,715/1,715; both lints clean when run
  sequentially with Nx cache disabled. The first parallel run was discarded:
  another concurrent full gate drove load to 48 and killed both linters plus
  timed out four FE cases; the same targets passed after that run ended.
- format, typecheck, secret scan, Compose validation, migration lint, doc caps,
  and strict OpenSpec validation are clean. h2puni has no `shellcheck`, so the
  two shell build targets cannot execute there; fresh GitHub CI is the build
  and browser gate of record before merge.

The branch may merge only after rebased `gate` and `pixels` checks pass. The
merge then recreates dev under OIDC, followed by real Okta login/API/WS and one
zero-manual Claude MCP tool call before this change is archived.
