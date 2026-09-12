## 1. Failure boundary

- [x] 1.1 Add mounted-route regressions for password lookup and OIDC resolution, with healthy and invalid-token controls; observe failures before implementation.
- [x] 1.2 Limit catches to modeled credential failures and resolve accounts outside catches; test malformed claims and unexpected verifier failures.
- [x] 1.3 Restore the broad catches and observe the route regressions fail; record output before Proof comments.
- [x] 1.4 Run scoped auth tests, formatting and lint; record workspace verification deferred to integration.

## 2. Full-checkpoint boot fixture correction

- [x] 2.1 Reproduce the two boot kill-switch failures found by the full workspace gate.
- [x] 2.2 Make the boot verifier fake use its modeled JOSE credential error; preserve both kill-switch assertions and add boot outage cases for both values.
- [x] 2.3 Observe the outage cases fail with the broad OIDC catch restored; restore the production catch.
- [x] 2.4 Verify merged boot/auth/OIDC coverage and scoped static checks; defer full workspace gates to parent.
