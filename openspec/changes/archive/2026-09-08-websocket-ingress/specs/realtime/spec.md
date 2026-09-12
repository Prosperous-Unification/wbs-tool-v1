## ADDED Requirements

### Requirement: Gateway validates client frames before dispatch

The gateway SHALL validate decoded client frames once before record indexing, callbacks or dispatch. Valid inbound frames SHALL be ping, who, subscribe/unsubscribe with string subscriptions, resume with a non-array map of nonnegative safe-integer sequence points, or a forward envelope with a string subscription and message. A forward envelope MAY omit type or use an unrecognized string type. A recognized control type SHALL satisfy that control's schema and SHALL NOT fall through to forwarding.

#### Scenario: Malformed decoded value

- **WHEN** invalid JSON, a binary frame, null, a number, a string or an array arrives
- **THEN** the gateway sends `error` with code `invalid_payload`
- **AND** it performs no subscription, resume or forwarding action

#### Scenario: Malformed resume point

- **WHEN** resume_points is absent, null, an array, or contains a non-number, negative, fractional, infinite or unsafe sequence
- **THEN** the gateway sends `invalid_payload` without contacting the backend

#### Scenario: Malformed control carrying a message

- **WHEN** a subscribe/unsubscribe/resume control has invalid required fields and also carries a forwardable message
- **THEN** it is refused rather than forwarded

### Requirement: Refused input does not disable a connection

A socket SHALL remain usable after refusing malformed input.

#### Scenario: Ping after refusal

- **GIVEN** a real authenticated WebSocket
- **WHEN** a malformed frame receives `invalid_payload` and the client then sends ping
- **THEN** that same socket receives pong and remains open

#### Scenario: Valid forwarding and resume

- **WHEN** supported forwarded messages or valid resume maps arrive
- **THEN** their contents reach the existing backend operations unchanged

#### Scenario: JSON whitespace and quoted commands

- **WHEN** valid controls, forwarded envelopes or resume frames have leading JSON whitespace (space, tab or newline)
- **THEN** the gateway decodes and accepts them unchanged
- **AND** a JSON string containing a serialized command is refused as `invalid_payload`, including when prefixed by that whitespace
- **AND** a subsequent ping succeeds on the same connection
