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
