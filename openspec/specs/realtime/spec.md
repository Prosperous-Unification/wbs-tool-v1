# Realtime

## Purpose

Define validated, recoverable WebSocket ingress and the connection behavior
that remains available after a client frame is refused.

## Requirements

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

### Requirement: Presence changes identify affected projects

Presence membership mutations SHALL identify the distinct projects whose membership changed. Delivery SHALL visit only current connections belonging to those projects. A move SHALL notify both the old and new projects. Unknown connections and unchanged membership SHALL produce no project notifications.

#### Scenario: Move between projects

- **GIVEN** a connection in project A, another observer remaining in A, and members in B and C
- **WHEN** the connection enters B
- **THEN** current members of A and B receive their respective updated rosters
- **AND** C receives no frame

#### Scenario: Repeated or stale membership instruction

- **WHEN** a connection subscribes to its current project or unsubscribes from a project it already left
- **THEN** it causes no presence delivery and retains its current roster

#### Scenario: Rejoin an existing connection id

- **GIVEN** an id in project A is joined again with a replacement username and socket
- **WHEN** the old membership is removed
- **THEN** remaining A members receive the updated roster
- **AND** the replacement socket receives its own empty initial roster
- **AND** the obsolete socket receives no frame

### Requirement: Initial and reset rosters are connection-specific

A newcomer SHALL receive an empty initial roster without notifying unrelated sockets. A connection that leaves its current project but remains connected SHALL receive an empty roster. A disconnected socket SHALL receive no further roster.

#### Scenario: Newcomer among many projects

- **GIVEN** 1,000 connections across 100 projects
- **WHEN** one additional connection joins without selecting a project
- **THEN** exactly one presence frame is sent to that newcomer
- **AND** all 1,000 existing connections receive zero frames at that transition

#### Scenario: Current-project unsubscribe

- **WHEN** a connection unsubscribes from its current project
- **THEN** remaining project members receive the updated roster
- **AND** the departing but connected socket receives an empty roster
- **AND** unrelated connections receive no frame

### Requirement: Scoped presence preserves connection identity and isolation

Presence SHALL retain separate connection identities for multiple tabs and deduplicate usernames in each project roster. Disconnect SHALL identify the affected project using the connection index. Scoped delivery SHALL preserve existing authentication verification ordering and project-content isolation.

#### Scenario: One of two tabs disconnects

- **GIVEN** two connections for one username in the same project
- **WHEN** one disconnects
- **THEN** the remaining connection still contributes that username exactly once
- **AND** only current members of that project receive the roster

#### Scenario: Verification races

- **WHEN** subscribe or close races an unresolved authentication verification
- **THEN** existing join ordering and controlled close behavior remain valid
- **AND** no unauthenticated connection enters or receives another project's roster
