## Why

Concurrent password logins all pass the failure counter before any password verification settles. Twenty attempts for one account/IP can therefore start expensive verification despite the five-failure limit.

## What Changes

Reserve one account/IP attempt and one global verification slot synchronously before account lookup or password verification awaits. Pending attempts count toward the existing five-attempt limit. A composition-owned positive global cap bounds distinct-account work; the default is eight active logins. Release reservations on success, refusal and unexpected error. Keep settled-failure expiry and successful username reset behavior.

## Non-goals

No distributed throttle, request queue, new credential policy, registration admission redesign, or environment variable. The cap is a typed composition option.

## Constraints

Approved refactoring plan §67 R5, following R3 at `271500c4`, before auth endpoint migration. Preserve TASK-262 Route[] and current 429 response. Account/verifier infrastructure faults remain server failures. Tests observe held verifications, not settled responses, and inject missing admission/release checks before recording Proof comments.
