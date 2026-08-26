# Verification Report — `websocket-url-credentials`

**Change:** `websocket-url-credentials`  
**Mode:** prod mode — public authentication path  
**State:** merge candidate pending fresh exact-head gates and peer reviews

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

## Exact-head gates owed

- [ ] h2puni affected tests, lint, typecheck, build, global format, and strict
      OpenSpec validation
- [ ] GitHub `gate` and `pixels` on the exact rebased head
- [ ] verified sealed Gemini artifact on the complete diff
- [ ] verified sealed Anthropic peer artifact on the complete diff
- [ ] main-session prod review; lane A does not merge this branch

## Decision

- [ ] PASS — return to main-session review when every exact-head item above is
      recorded green
- [ ] MERGE — main-session decision only after prod review
