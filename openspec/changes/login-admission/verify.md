## Verification

Base: R3 commit `271500c4`, branch `refactor/planned-project`. No commits or deployment in this slice.

- Initial mounted auth tests: **15 pass / 10 fail**. Held-20 requests admitted all twenty; injected global-cap options were ignored; invalid limits did not throw; an unexpected verifier error became 401.
- Final scoped run: `bun test apps/be-01/src/controller/auth.integration.test.ts apps/be-01/src/controller/oidc.integration.test.ts apps/be-01/src/service/auth-service-null-password.test.ts apps/be-01/src/service/login-throttle.test.ts apps/be-01/src/app.routes.test.ts apps/be-01/src/http/binder.contract.test.ts` — **131 pass / 0 fail**, 308 assertions, 4.50s.
- `bunx tsc --build --force apps/be-01/tsconfig.json` — **exit 0**, no diagnostics.
- `bunx eslint` on `app.ts`, `controller/{auth.routes,auth.integration.test}.ts`, `service/{auth.service,login-throttle,login-throttle.test}.ts` — **exit 0**. An earlier pass caught the controller test importing the Elysia dialect directly; injected-clock lifetime tests now use the existing in-process binder over the production auth route. Admission, global cap and error-lifetime tests exercise `buildApp.handle`.
- Prettier check on all six changed TypeScript files and this change — **exit 0**.
- `bunx openspec validate login-admission --strict --json` — **exit 0, valid**, zero issues. The CLI subsequently printed an optional telemetry DNS failure for `edge.openspec.dev`; validation had completed successfully.
- Workspace, full backend and browser gates remain deferred to parent integration while other agents edit. The root TypeScript command above references and compiles both source and spec projects. No library files changed in R5.

The fixed full auth file has **31 passing tests**. Every injected fault below returned exit 1; the mutation runner restored each production file before the next mutation. All fixed-source suites passed after the injections. Logs: `/tmp/refactoring-r5-{red,windows,lifetime,restored,typecheck,mutation-summary}.log` and `/tmp/refactoring-r5-fault-*.log`.

## Failure-proof table

| Injected fault                                     | Production-path test                                                            | Observed failure                                                                                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Move reservation after awaiting `auth.login`       | `reserves at most five held attempts` for account, IP and both                  | Expected 5, received 20 while pending; 22 pass / 9 fail overall                                                                                                                                                      |
| Exclude pending attempts from account/IP admission | Same three held-20 cases                                                        | Expected 5, received 8 (the global ceiling); 25 pass / 6 fail                                                                                                                                                        |
| Remove global comparison                           | `applies the configured global cap to unrelated accounts`; default-cap case     | Expected 2, received 3; default expected 8, received 10; 29 pass / 2 fail                                                                                                                                            |
| Remove cap validation                              | All five `refuses invalid global cap` composition cases                         | Constructor did not throw; 26 pass / 5 fail                                                                                                                                                                          |
| Remove route's `finally` release                   | Release after success, refusal, verifier error; account lookup error            | Expected 3 admissions, received 2; lookup expected 1, received 0; 25 pass / 6 fail                                                                                                                                   |
| Keep per-key pending count after release           | Success-with-another-pending and failure-window cases                           | Expected 6 admissions, received 5; 29 pass / 2 fail                                                                                                                                                                  |
| Delete account window when another login succeeds  | `retains other pending reservations when one login succeeds`                    | Expected 6 admissions, received 7; 30 pass / 1 fail                                                                                                                                                                  |
| Delete expired windows while pending               | `retains pending reservations when the failure window expires`                  | Expected 5 admissions, received 6; 29 pass / 2 fail                                                                                                                                                                  |
| Let full-map eviction remove an active window      | `does not evict a pending account while pruning a full failure map`             | Expected 5 admissions, received 1; 30 pass / 1 fail. The orphaned window causes admission refusal at the bounded map, rather than the anticipated excess admission; this is the observed failure, not a guessed one. |
| Keep admission time as first-failure time          | `starts the failure window when verification refuses, not when it was admitted` | Expected 5 admissions at 62s, received 6; 30 pass / 1 fail                                                                                                                                                           |
| Restore verifier `.catch(() => false)`             | `releases capacity after error while another login remains held`                | Expected 500, received 401; 30 pass / 1 fail                                                                                                                                                                         |

Proof comments were written from these failures. No old wire assertion was changed; existing sequential five-failure and OIDC cookie/auth cases stay green.

Parent checkpoint: `bunx nx typecheck be-01 --skip-nx-cache` passed with R5/R6
held unchanged, covering both source and spec projects. Log:
`/private/tmp/wbs-refactoring-r5-r6-typecheck.log`. Independent task review
approved without blocking findings. Full workspace/browser gates remain pending.
