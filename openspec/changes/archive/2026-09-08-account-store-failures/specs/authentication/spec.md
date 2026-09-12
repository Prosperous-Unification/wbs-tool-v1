## ADDED Requirements

### Requirement: Account resolution failures remain server failures

Authentication SHALL distinguish invalid credentials from unexpected verification and account-store failures. Invalid credentials SHALL answer 401; unexpected failures SHALL reach the server error boundary.

#### Scenario: Password account lookup fails

- **GIVEN** a valid password-session token that authenticates against a healthy store
- **WHEN** its account lookup throws
- **THEN** the mounted auth route answers 500 rather than 401

#### Scenario: OIDC account resolution fails

- **GIVEN** verified OIDC claims that resolve against a healthy store
- **WHEN** identity resolution throws
- **THEN** the mounted auth route answers 500 without falling back to password authentication

#### Scenario: Invalid credentials versus unavailable verifier

- **WHEN** token signature or identity claims are invalid
- **THEN** authentication answers 401
- **WHEN** the verifier throws an unexpected dependency failure
- **THEN** authentication answers 500
