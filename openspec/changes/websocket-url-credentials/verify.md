# Verification Report — `websocket-url-credentials`

**Change:** `websocket-url-credentials`  
**Mode:** prod mode — public authentication path  
**State:** merge candidate pending final exact-head CI and main-session decision

## Baseline implementation evidence

At original implementation head `2a01dd48` on h2puni with Bun 1.3.14:

- gw-01: **56 passed, 0 failed**
- `@wbs/realtime`: **8 passed, 0 failed**
- tool-smoke: **9 passed, 0 failed**
- fe-01: **1,754 passed, 0 failed**
- affected lint, typecheck, and build: clean
- `nx format:check --all`: clean
- GitHub `gate` and `pixels`: passed at the exact head

Main-session review independently reran the focused auth/realtime/smoke boundary
at **19/19** and the unchanged migration forward/rollback suite at **80/80**.
The branch has since been rebased onto `origin/main@b25aeb0` and gained only the
record and runbook fixes below, so fresh exact-head evidence is required before
the prod-review handoff.

## Failure-proof table

| Safety property                  | Injected or observed fault                                                                     | Test that went red                                | Result                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------- |
| URL token refused                | Restored valid-JWT query authentication                                                        | production upgrade test, **1/4 failed**           | killed                              |
| Reconnect URL verbatim           | Appended `?token=mutation` in the shared client                                                | focused realtime suite, **1/6 failed**            | killed                              |
| URL local identity untrusted     | Used ordinary query keys for trusted hook state; `/ws?localIdentity=mallory` joined as Mallory | OIDC cookie integration case                      | killed before Symbol carrier landed |
| Client API has no JWT dependency | Removed the old JWT callback before the call sites changed                                     | reconnect test threw `opts.jwt is not a function` | observed TDD red                    |
| Smoke target is credential-free  | Built the old `GET /ws?token=...` request                                                      | `caddyUpgradeRequest` request-line assertion      | killed                              |
| Missing auth fails closed        | Deleted the explicit unconfigured-auth branch                                                  | dedicated upgrade test, **4 passed / 1 failed**   | killed                              |

## Review history

Gemini round one at the original branch blocked one Critical, three Important,
and one Minor finding. The private Symbol carrier, production-path URL-token
case, connection-open recheck, cookie/Origin smoke, and stale client API removal
closed them at `2a01dd48`; Gemini round two then passed with no new findings.
Those verdicts are stale after the rebase and documentation/artifact commit.

Gemini round three reviewed the complete rebased diff at `7e10fc13` and passed
with 0 Critical / 0 Important / 2 Minor findings. Both are closed in the next
commit: unused frontend socket token inputs are gone, and the unconfigured
gateway branch has a dedicated upgrade test whose deletion was watched red at
4 passed / 1 failed. The restored h2puni focused gate is gw-01 **57/0** and
fe-01 **1,754/0**, with both lint and typecheck targets green.

## Post-merge QA — TASK-175, 2026-08-29

Both PRs merged on 2026-08-27 (#163 as `9ecd06a2`, #166 as `25151d93`) with the
Anthropic peer seat unavailable; Dany allowed the builder to merge and the
structural peer review stayed owed. Lane q settled it on 2026-08-29:

- `anthropic/claude-opus-5` (the required peer of `openai/gpt-5.6-sol`):
  APPROVE-WITH-FINDINGS, 0 Critical / 2 Important / 2 Minor / 1 Nit.
- `gemini/antigravity-cli` on the same complete diff, pinned to a detached
  `25151d93` worktree: APPROVE, 0 findings.

Both verdicts are sealed artifacts in the ops repo
(`queue/reviews/task175-ws-auth-{opus,gemini}.txt`).

The two Important findings are fixed on `fix/task175-ws-identity-fail-closed`:

| Finding                               | Fault                                                                                                                                                                                        | Watched red                                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity-less socket served as `anon` | An upgrade that passed `beforeHandle` but failed the `open` recheck stayed open; `message` fell back to `clientId = 'anon'` and would subscribe to any project                               | Reverting the `app.ts` close, `ws-auth.integration.test.ts` fails at 2,011 ms on "socket stayed open without an identity" — 5 passed / 1 failed |
| Runbook misstated registration        | `docs/runbook-dev-deploy.md` said OIDC mode "does not mount" `/api/auth/register`; it is mounted unconditionally and gated by `AUTH_PASSWORD_REGISTER` (default false), not by the auth mode | n/a — documentation                                                                                                                             |

Live check performed against dev at 16:58Z on 2026-08-29:
`GET https://dev.wbs.bulletpoints.club/api/auth/me` answered HTTP 401 with body
exactly `{"error":"invalid_token"}`, so PR #166's repaired probe matches the real
be-01 and the pre-#166 `missing_token` expectation really was a false failure.

The remaining browser criteria were discharged in Browser Use Cloud session
`47920860-2216-4943-b2f9-eaaf71caa169`. Instrumentation installed before the
application at both the page constructor and CDP network layers observed 14
socket constructions, every URL exactly `wss://dev.wbs.bulletpoints.club/ws`,
11 successful 101 handshakes, 15 sent / 46 received frames, and zero query
strings or credentials. A forced close produced a replacement socket 0.5 s
later on the same clean URL and that socket exchanged frames. At 396 seconds
after the session's last close, the Caddy file log held exactly the matching
11 `/ws` records, all 101 with URI `/ws` and no credentials. Project switching,
phone-width rendering, and sign-out also passed; sign-out returned auth/me 401
and opened no further socket. All five TASK-175 acceptance criteria are closed.

## Exact-head gates — PR #181

- [x] h2puni watched red: reverting the fail-closed guard fails at 2,009 ms,
      5 passed / 1 failed. Deleting only the independent in-flight-message
      guard fails the new frame-race case on one forbidden backend forward,
      58 passed / 1 failed; restored exact head passes gw-01 59/59 plus lint,
      typecheck, build, and global format on Bun 1.3.14
- [ ] GitHub `gate` and `pixels` on the final exact head
- [x] verified sealed Gemini artifact on the complete shipped #163/#166 diff
- [x] verified sealed Anthropic peer artifact on the complete shipped #163/#166 diff
- [ ] main-session prod review and merge of PR #181

No migration path changed in PR #181, so forward and rollback migration
rehearsals are not applicable.

## Decision

- [ ] PASS — final exact-head CI is green and main-session review finds no blocker
- [ ] MERGE — main-session decision after the prod review
