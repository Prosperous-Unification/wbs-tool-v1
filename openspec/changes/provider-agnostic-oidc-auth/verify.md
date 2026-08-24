# Verification Report

**Change**: `provider-agnostic-oidc-auth`
**State**: partial — shared contract and transaction-store slices complete

## 1. Structural Validation

- [x] `openspec validate --all --strict --json` — 73 changes valid, 0 invalid

## 2. Task Completion

Tasks 1.1–2.2 are complete. OIDC routes, identity, MCP OAuth, solution integration,
acceptance, and the public cutover remain separate worker chunks.

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

- [ ] PASS — archive
- [x] IN PROGRESS — continue with OIDC login, callback, refresh, and logout routes.

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
