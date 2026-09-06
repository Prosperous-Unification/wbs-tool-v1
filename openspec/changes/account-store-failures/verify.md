## Verification

Base: `f89ebf56`, working branch `refactor/planned-project`. Scoped verification only; the workspace gate, full be-01 suite, browser gate are deferred to parent integration while other agents edit. No deployment performed.

- Before implementation: `bun test apps/be-01/src/controller/auth.integration.test.ts apps/be-01/src/controller/oidc.integration.test.ts` — **37 pass / 3 fail**, each new failure expected 500 and received 401.
- After implementation and after restoring the injected fault: `bun test apps/be-01/src/controller/auth.integration.test.ts apps/be-01/src/controller/oidc.integration.test.ts apps/be-01/src/service/auth-service-null-password.test.ts libs/auth/src/oidc-identity.test.ts` — **48 pass / 0 fail**.
- `bun test libs/auth/src` with loopback permission for the local JWKS server — **23 pass / 0 fail**.
- ESLint on the six changed TypeScript files — **exit 0** after import sorting. Prettier applied to those files and this change.
- No existing wire assertion rewritten. Two injected OIDC invalid-token fixtures now throw the modeled JOSE algorithm error rather than a generic infrastructure error.

## Failure-proof table

| Fault                                                                                | Production-path test                                                                | Observed failure           |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | -------------------------- |
| Restore pre-change AuthService credential catches, including password account lookup | `keeps password account lookup faults as server failures` through `buildApp.handle` | Expected 500, received 401 |
| Restore pre-change AuthService credential catches, including OIDC account resolution | `keeps OIDC account resolution faults as server failures` through `buildApp.handle` | Expected 500, received 401 |
| Restore pre-change catch accepting unexpected verifier failures                      | `keeps unexpected verifier failures as server failures` through `buildApp.handle`   | Expected 500, received 401 |

Mutation rerun: **37 pass / 3 fail**; restored run: **48 pass / 0 fail**. Logs in `/tmp/refactoring-r3-{red,green,mutation,restored,auth-library}.log`. Proof comments written from the observed 500/401 failures.

Parent verification: `bunx nx typecheck be-01 --skip-nx-cache` passed on the frozen backend sources containing R2 and R3. `openspec validate account-store-failures --strict` passed. Independent task review approved with no code findings.

## First full-workspace checkpoint and merge follow-up

The frozen `ae1fc858` full workspace run found **1,621 backend tests passing and 2 failing** in `boot.db.test.ts`: password sessions with the kill switch off/on received 500 instead of the existing 401/200 expectations. The larger gate was stopped after these failures (exit 130); it is not a passing gate.

The boot fixture still used plain `Error("not an OIDC token")`, violating the verifier's modeled credential-error contract. R3 had migrated the equivalent unit fixture but omitted the boot file from scoped verification. Boot wiring forwarded the fake unchanged; the intended R3 unexpected-error rethrow explains both 500 responses. Installed JOSE 5.10 emits `JOSEAlgNotAllowed` for an HS256 token against the RS256 allowlist, before key retrieval. The fixture now uses that precise error. Neither kill-switch expectations nor production authentication behavior were weakened.

After integrating `origin/main` a91f831b, conflicts preserve both R3/R5 authentication tests and incoming calendar-marker fixture/OIDC callback tests. `buildApp` still passes routed OIDC logger options and composes the bounded shared login throttle; the login handler still reserves before awaiting and releases in finally. No behavior edits to those auto-merged production files were needed.

- `bun test ./apps/be-01/src/boot.db.test.ts` before correction: **7 pass / 2 fail**, expected 401/200, received 500 (`/private/tmp/refactoring-boot-red.log`).
- Focused boot/auth/OIDC/null-password suite after correction and new outage cases: **83 pass / 0 fail**, 272 assertions, four files, 4.89s (`/private/tmp/refactoring-boot-auth-green.log`).
- Deliberately remove the unexpected-error rethrow from the OIDC catch and run `boot.db.test.ts -t 'boot verifier outages'`: **0 pass / 2 fail**, expected 500, received **401 with password login false** and **200 with true** (`/private/tmp/refactoring-boot-fault.log`). Restored immediately afterward. Adjacent Proof comment names these observed outputs.

Full workspace/browser verification remains parent-owned.

Restored focused run: **83 pass / 0 fail**, 272 assertions, four files, 5.77s (`/private/tmp/refactoring-boot-auth-restored.log`). `bunx tsc --build --force apps/be-01/tsconfig.json` compiled source and spec projects with **exit 0**, no diagnostics. Four-file ESLint and formatting passed. Strict OpenSpec validation passed with zero issues.
