# MCP OIDC store verification

## Section 1 — current behavior and callback ordering

The baseline `apps/mcp-01/src/oauth.test.ts` contained **24 cases**, counted from the
current file rather than copied from the task text. Its registration restrictions,
dynamic-client expiry, anonymous/proven per-source limits, serial and concurrent promotion
reservation, global and per-client pending limits, grant capacity, and session capacity all
passed. The unmodified whole MCP target passed **114 tests in 10 files** with 454 assertions.

The first auth-target run inside the filesystem sandbox was not green: **91 passed / 2 failed**
because `Bun.serve` could not bind the token-verifier tests' ephemeral localhost sockets
(`EPERM`), and teardown consequently tried to stop an undefined server. The same owning target
was rerun with socket permission and passed **95 tests in 7 files** with 251 assertions. The
focused shared-store control passed **11 tests** with 29 assertions inside the sandbox.

Section 1 adds two OAuth cases and strengthens the existing matched-callback replay case. The
whole MCP target now passes **116 tests in 10 files** with 468 assertions. The focused OAuth
file passes **26 tests** with 110 assertions.

### Failure proofs

| Check                                                             | Injected fault                                                             | Observed failure                                                                                                                                    |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wrong state preserves the honest MCP login and browser cookie`   | Baseline delete-before-compare behavior                                    | Red first: after the forged response was applied to the cookie jar, the retained cookie was `undefined` instead of `__Host-wbs_mcp_oauth=random-2`. |
| same route-level test                                             | Move `transactions.delete(binding)` before the state comparison            | The later honest callback returned **400**, expected **302**; upstream exchange remained unavailable to the success assertion.                      |
| same route-level test                                             | Add `clearCookie()` to the wrong-state response while retaining the record | Applying that response removed the browser binding, and the later honest callback returned **400**, expected **302**.                               |
| `expires before mismatch and clears the dead browser transaction` | Compare state before checking expiry                                       | Exact retained transaction count was **1**, expected **0**.                                                                                         |
| `binds PKCE to a one-use upstream browser round trip`             | Omit matched-state deletion                                                | Exact upstream exchange count was **2**, expected **1**, after the second matching callback.                                                        |

Each mutation was restored before the green runs. The browser helper applies the handler's
single `Set-Cookie` field, including `Max-Age=0`, so the honest callback depends on the cookie
state a browser would actually carry rather than on a private-map-only assertion.

## Commands

| Command                                                                                                               | Result                                                    |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `bun test apps/mcp-01/src/oauth.test.ts --test-name-pattern 'wrong state\|expires before mismatch\|one-use upstream'` | 3 passed, 0 failed, 26 assertions                         |
| `bun test apps/mcp-01/src/oauth.test.ts`                                                                              | 26 passed, 0 failed, 110 assertions                       |
| `bun test --coverage --coverage-reporter=lcov` from `apps/mcp-01`                                                     | 116 passed, 0 failed, 468 assertions, 10 files            |
| `bun test libs/auth/src/oidc-store.test.ts`                                                                           | 11 passed, 0 failed, 29 assertions                        |
| `bun test --coverage --coverage-reporter=lcov` from `libs/auth`, with localhost socket permission                     | 95 passed, 0 failed, 251 assertions, 7 files              |
| `bunx eslint apps/mcp-01/src libs/auth/src`                                                                           | clean, exit 0                                             |
| `bunx tsc --build --force apps/mcp-01/tsconfig.json libs/auth/tsconfig.json`                                          | clean, exit 0                                             |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate mcp-oidc-store --strict --json`                        | valid, 1 passed, 0 failed                                 |
| `bunx prettier --check` over the four changed files                                                                   | clean, exit 0                                             |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx format:check --all --output-style=static`                           | clean, exit 0                                             |
| `git diff --check`                                                                                                    | clean, exit 0                                             |
| `bin/h2puni-gate.sh <section-1 SHA>`                                                                                  | unavailable, exit 70: `/home/puni1/.cache` does not exist |

The focused and whole MCP results above were rerun against the final test behavior. The auth
implementation is unchanged by Section 1; its focused and whole owning results are recorded from
this worktree.

The locked h2puni gate did not begin a checkout or any constituent check because this host lacks
the gate's required `/home/puni1/.cache` lock directory. No gate success is claimed.

## Section 2 — shared proof store and bounded MCP context

`PendingAuthorizations` now owns the concrete shared OIDC transaction store and a metadata map
keyed by the same exported `digestOidcBinding`. A save holds one clock reading while it cleans,
checks collision and capacity, and writes both records synchronously. A consume delegates proof
comparison and expiry to the shared store, preserves live mismatches, removes terminal metadata,
and throws if consumed proof has no live MCP context.

The MCP handler no longer has its raw `Transaction` map. Authorize saves bounded context through
the wrapper; callback consumes through it before provider exchange. The arriving matched upstream
state is sent to exchange, while the separately retained downstream state is returned to the MCP
client. Grant-cap refusal still occurs after proof consumption.

### Section 2 failure proofs

| Check                                                    | Injected fault                                                               | Observed failure                                                                                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| real authorize retains no raw browser binding            | Key the shared record by the raw binding                                     | Shared-map key was `random-2`, expected its SHA-256 digest.                                                                                                    |
| same production-path retention check                     | Spread `browserBinding` into the shared record value                         | Serialized retained values contained `"browserBinding":"random-2"`.                                                                                            |
| one clock instant across both saves                      | Give the shared store the source clock instead of the wrapper's held instant | Clock reads were **4**, expected **1**.                                                                                                                        |
| per-client pending capacity                              | Omit the per-client capacity arm                                             | A second request for the same client returned **302**, expected **429**.                                                                                       |
| no eviction at pending capacity                          | Evict the first proof/context and admit the overflow request                 | The first login's honest callback returned **400**, expected **302**.                                                                                          |
| expiry frees both capacities                             | Disable shared proof/context cleanup                                         | The next real authorization at the deadline returned **429**, expected **302**.                                                                                |
| duplicate generated binding                              | Remove the collision guard                                                   | The first login's honest callback returned **400**, expected **302**, after the second authorization overwrote its correlation.                                |
| consumed proof requires context                          | Return `missing` when context is absent after successful proof consumption   | Provider exchanges and grants remained zero, but the required trusted-state error was `undefined`.                                                             |
| exact requested scopes survive storage                   | Store only `wbs:read` in the authorization context                           | The grant lost `wbs:write`; exact `scope` and `scopes` assertions failed.                                                                                      |
| upstream and downstream states stay distinct             | Return the arriving upstream state to the connector                          | Redirect state was `random-3`, expected downstream `claude-state`.                                                                                             |
| exchange receives arriving matched state                 | Send retained downstream state to upstream exchange                          | Exchange check state was `claude-state`, expected arriving `random-3`.                                                                                         |
| forged state preserves shared proof                      | Delete the shared record on state mismatch                                   | The later honest callback returned **400**, expected **302**.                                                                                                  |
| forged state preserves browser cookie                    | Clear the mismatch response cookie                                           | The browser-applied cookie was absent and the later honest callback returned **400**, expected **302**.                                                        |
| expiry precedes mismatch after adoption                  | Compare state before shared-store expiry                                     | Exact retained context count was **1**, expected **0**.                                                                                                        |
| matched proof is single-use, including grant-cap refusal | Retain matched proof in the shared store                                     | Replay reached the wrapper's missing-context trusted-state error instead of returning the expected 400; both the normal success and grant-cap controls failed. |

The collision and missing-context route tests additionally assert the provider exchange and grant
counts. The collision test completes the original login with its original downstream state; the
missing-context test observes zero exchanges and zero grants before checking the thrown error.
Every fault above was restored before the green runs.

### Section 2 commands

| Command                                                                                                                  | Result                                         |
| ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `bun test apps/mcp-01/src/oauth.test.ts apps/mcp-01/src/pending-authorizations.test.ts libs/auth/src/oidc-store.test.ts` | 46 passed, 0 failed, 182 assertions            |
| `bun test --coverage --coverage-reporter=lcov` from `apps/mcp-01`                                                        | 124 passed, 0 failed, 509 assertions, 11 files |
| `bun test --coverage --coverage-reporter=lcov` from `libs/auth`, with localhost socket permission                        | 96 passed, 0 failed, 253 assertions, 7 files   |
| `bunx eslint apps/mcp-01/src libs/auth/src`                                                                              | clean, exit 0                                  |
| `bunx tsc --build --force apps/mcp-01/tsconfig.json libs/auth/tsconfig.json`                                             | clean, exit 0                                  |
| `bunx prettier --check` over Section 2 files                                                                             | clean, exit 0                                  |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx format:check --all --output-style=static`                              | clean, exit 0                                  |
| `git diff --check`                                                                                                       | clean, exit 0                                  |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate mcp-oidc-store --strict --json`                           | valid, 1 passed, 0 failed                      |

The first typecheck correctly rejected grouped failure-outcome unions because they did not narrow
to the consumed payload. Giving each outcome its own discriminated member fixed the type boundary;
the green result above is from the corrected contract.

## Section 3 — native comparison proof and local integration

Bun 1.4.2 supports the required instrumentation with an isolated test process and a preload-time
`mock.module('node:crypto', ...)`. The preload captures the real native `timingSafeEqual` before
installing a recording wrapper; the wrapper records each operand's byte length and then invokes
that captured native function. The child drives registration, authorization, a wrong-state
callback, and the later honest callback through `InMemoryMcpOAuth` and `PendingAuthorizations`.
It observes exactly two native calls, both with **64-byte / 64-byte** SHA-256 hex digest operands.
No elapsed-time samples are used.

### Section 3 failure proof

The initial test red had both callback behavior assertions green but received an empty primitive
call list instead of the two expected 64/64 calls. After installing the preload wrapper, replacing
the production `sameSecret` body with direct `left === right` reproduced the decisive mutation:
the child reported `real MCP wrong-state refusal preserves the honest callback` as passing, while
`real MCP callbacks compare equal-length state digests with timingSafeEqual` failed with received
`[]` versus the two expected calls. The child summary was **1 passed / 1 failed**. The mutation was
restored before all green runs. The adjacent Proof comment records this observed dependency.

### Section 3 commands

| Command                                                                                                                                                    | Result                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `bun test apps/mcp-01/src/oauth-timing-safe.test.ts`                                                                                                       | 1 passed, 0 failed, 2 outer assertions; isolated child passed both controls |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t test lint typecheck -p auth mcp-01 be-01 --parallel=2 --skip-nx-cache --output-style=static` | clean, exit 0; auth 96/0, MCP 125/0, be-01 1054/0 with 1 declared skip      |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate mcp-oidc-store --strict --json`                                                             | valid, 1 passed, 0 failed                                                   |
| `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json`                                                                               | valid, 82 passed, 0 failed                                                  |
| `bunx prettier --check` over the three proof files, `tasks.md`, and `verify.md`                                                                            | clean, exit 0                                                               |
| `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx format:check --all --output-style=static`                                                                | clean, exit 0                                                               |
| `git diff --check`                                                                                                                                         | clean, exit 0                                                               |
| `bin/h2puni-gate.sh <final Section 3 SHA>`                                                                                                                 | exit 70: `heavy lock: /home/puni1/.cache does not exist`; no gate started   |

Running the matrix without socket permission failed `auth:test` with its two localhost-bind cases
and `be-01:test` with 16 server-bind cases; the rerun with the required socket permission produced
the green result above. This is a host permission distinction, not a restored-code claim.

Task 3.2 remains open until the committed Section 3 SHA is available in the clean shared h2puni
checkout. On h2puni, `/home/puni1/.cache` must exist and be writable so the canonical
`/home/puni1/.cache/wbs-heavy-work.lock.d` can be acquired. From that checkout, run exactly
`bin/h2puni-gate.sh <final Section 3 SHA>` without checking out the SHA first; acceptance depends
on the script printing `h2puni gate: running on <final Section 3 SHA>` and exiting zero. This local
host lacks `/home/puni1/.cache`; the exact command exited **70** with `heavy lock:
/home/puni1/.cache does not exist` before checkout or any gate step.

### Final review repair: independent retained-key oracle

The final review replaced `digestOidcBinding` with identity and showed that both
retention tests still passed because they derived expected keys through that same
production helper. Both tests now compare their real retained map keys with fixed,
independently computed lowercase SHA-256 literals and separately assert that the
raw binding is absent from the key sets and serialized values.

With identity reintroduced, the MCP production-path test received `random-2`
instead of `a2d6d4faf36f2e1df73e7f326651ba0507442dc4b47698f700157c8460b4584d`;
the auth store test received `unguessable-browser-binding` instead of
`3bb40d614eda46d5ac33fae80c699a08385a0b4c35ab0d8651f8b33096115f8e`.
Both failed in one focused run (`0 passed / 2 failed`) and passed after restoration
(`2 passed / 0 failed / 9 assertions`). Task 3.2 remains unchecked until the
repaired immutable commit receives independent rereview and its required gate.

The full uncached owning matrix passed auth `96/0/254` and MCP `125/0/512`, with
both lint and typecheck targets clean. Changed-file Prettier, `git diff --check`,
and strict `mcp-oidc-store` OpenSpec validation also passed.

## Publication integration

The accepted implementation head
`ed1129b6ba00a73247c625cab59d48038b054817` was merged conflict-free with the
actual fetched `origin/main` tip
`9b13f98e62a7cd880977e348421e992e8c4951a3`. The resulting merge commit is
`bf27d1638bda23b053b5cdd4910d216287d570f0`. Current main changed solver,
work-item, backend composition and frontend behavior but did not overlap the MCP
OIDC implementation files; the focused and owning integration runs below prove
the accepted shared-store and callback behavior against those changes.

Fresh integration evidence:

- `bun test apps/mcp-01/src/oauth.test.ts apps/mcp-01/src/pending-authorizations.test.ts apps/mcp-01/src/oauth-timing-safe.test.ts libs/auth/src/oidc-store.test.ts apps/be-01/src/controller/oidc.integration.test.ts apps/be-01/src/controller/auth-oidc-endpoints.test.ts apps/be-01/src/http/elysia/auth-oidc.test.ts apps/be-01/src/app.routes.test.ts` — 119 passed, 0 failed, 1,153 assertions.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t test lint typecheck -p auth mcp-01 be-01 --parallel=2 --skip-nx-cache --output-style=static` — all nine targets passed: auth 96/0/254, MCP 125/0/512, and be-01 1,055/0/18,467 with one declared solver-supervisor skip.

No new behavior or failure proof was added during this conflict-free publication
integration. Task 3.2 remains unchecked pending the required host gate.

## Task 3.2 closeout against current main

The change worktree fast-forwarded from `87056705840dfdbfe07a96972be50d01e1694696`
to the current fetched `origin/main` tip
`8779208a38b5312cae949d9706c650a392f33415`. `git merge-base --is-ancestor`
returned zero before `git merge --ff-only origin/main`; no rebase or overwrite was
used.

Fresh pre-gate evidence at that tip:

- `bun test apps/mcp-01/src/oauth.test.ts apps/mcp-01/src/pending-authorizations.test.ts apps/mcp-01/src/oauth-timing-safe.test.ts libs/auth/src/oidc-store.test.ts apps/be-01/src/controller/oidc.integration.test.ts apps/be-01/src/controller/auth-oidc-endpoints.test.ts apps/be-01/src/http/elysia/auth-oidc.test.ts apps/be-01/src/app.routes.test.ts` — **119 passed, 0 failed, 1,153 assertions across 8 files**, exit 0. The unchanged be-01 integration cases `lets the first tab finish a login a second tab started after it`, `holds three concurrent logins per browser and drops the oldest`, and `refuses a stateless callback without discarding the logins in flight` passed in this run.
- `NX_DAEMON=false NX_ISOLATE_PLUGINS=false bunx nx run-many -t test lint typecheck -p auth mcp-01 be-01 --parallel=2 --skip-nx-cache --output-style=static` — all **9** targets passed uncached, exit 0: auth **96 passed / 0 failed / 254 assertions**; MCP **125 passed / 0 failed / 512 assertions**; be-01 **1,055 passed / 0 failed / 18,467 assertions**, with the one declared solver-supervisor test skipped. All three lint and all three typecheck targets were clean. The auth target's unchanged `oidc-binding.test.ts` plural-binding suite passed all **11** cases, including independent cookie names, reading every binding cookie, three-live-login admission, consuming the state-proven binding while keeping the other, and mismatch preservation.
- `OPENSPEC_TELEMETRY=0 bunx @fission-ai/openspec@1.3.0 validate --all --json` — **83 passed, 0 failed** (**72 changes and 11 specs**), exit 0.

No production safety check changed during this closeout, so it adds no new fault
injection or `Proof:` comment. The applicable R5 watched failures are the observed
mutations already recorded in Sections 1–3 and the independent-retained-key review;
their restored controls are included in the fresh focused and uncached owning runs
above.
