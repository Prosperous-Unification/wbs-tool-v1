## ADDED Requirements

### Requirement: Password login reserves bounded verification capacity

Password login SHALL synchronously reserve capacity before awaiting lookup or verification. An account and a client IP SHALL each admit fewer than six combined failed and pending attempts per existing failure window. The application SHALL impose a positive finite integer global concurrency cap, defaulting to eight, shared by all accounts. Exhausted capacity SHALL answer the existing 429 invalid_credentials refusal.

#### Scenario: Concurrent logins for one account or IP

- **WHEN** twenty password verifications are held pending for one account or IP
- **THEN** at most five are admitted and the rest answer 429 before any verification settles

#### Scenario: Distinct accounts share a cap

- **GIVEN** an application configured with a global cap of two
- **WHEN** two different accounts on different IPs are pending
- **THEN** a third login answers 429 without entering verification

#### Scenario: Invalid composition limit

- **WHEN** the configured cap is zero, negative, non-integral or non-finite
- **THEN** application composition throws

### Requirement: Login reservations end with their attempts

Every admitted login SHALL release capacity on success, invalid credentials, or unexpected failure. An unexpected verifier/store failure SHALL propagate to the server boundary. Failure-window expiry and a successful attempt SHALL NOT erase another pending reservation.

#### Scenario: Attempt settles

- **WHEN** an admitted attempt succeeds, refuses, or throws
- **THEN** another attempt can use its released slot while other attempts remain pending

#### Scenario: Window expires during pending work

- **WHEN** the failure window expires while five attempts remain pending
- **THEN** the same account or IP cannot admit a sixth attempt until capacity is released
