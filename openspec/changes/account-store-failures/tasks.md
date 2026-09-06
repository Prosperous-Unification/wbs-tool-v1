## 1. Failure boundary

- [x] 1.1 Add mounted-route regressions for password lookup and OIDC resolution, with healthy and invalid-token controls; observe failures before implementation.
- [x] 1.2 Limit catches to modeled credential failures and resolve accounts outside catches; test malformed claims and unexpected verifier failures.
- [x] 1.3 Restore the broad catches and observe the route regressions fail; record output before Proof comments.
- [x] 1.4 Run scoped auth tests, formatting and lint; record workspace verification deferred to integration.
