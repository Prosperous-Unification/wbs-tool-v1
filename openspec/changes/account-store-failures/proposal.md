## Why

A valid password or OIDC bearer token becomes `401 invalid_token` when account resolution throws. The authentication boundary currently catches storage faults with credential failures, hiding an unavailable account store.

## What Changes

Keep modeled token and claim refusals as 401; propagate unexpected verification, discovery and account-store failures to the server error boundary. Resolve verified identities outside credential catches.

## Non-goals

No account schema, token format, password policy or OIDC protocol changes. Login admission is a separate slice.

## Constraints

Implements approved refactoring plan §67 R3 before the HTTP endpoint migration. Collision window: main f89ebf56, after TASK-262; retain its Route[] composition. Exercise mounted password and OIDC routes, healthy tokens and modeled invalid tokens, and observe the regression with account resolution inside the old catch.
