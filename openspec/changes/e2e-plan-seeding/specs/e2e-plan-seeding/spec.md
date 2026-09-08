## ADDED Requirements

### Requirement: API setup verifies real prerequisites

API fixtures SHALL use public authenticated endpoints and shared wire types, and SHALL validate final authored server state before the tested interaction or timing sample. Every command response SHALL retain its requested identity, index and ref.

#### Scenario: a successful response omits a created row identity

- **WHEN** the setup receives HTTP 200 without a requested row id
- **THEN** setup fails at the named command before any dependent command or measurement

#### Scenario: a command is dropped during setup

- **WHEN** an estimate command is skipped while other writes succeed
- **THEN** the final tree assertion fails on that exact row and step before the scenario begins

### Requirement: Interaction scenarios keep their defining gesture

Fixture conversion SHALL preserve UI gestures that the scenario exists to exercise. Only the explicit design allowlist SHALL adopt API prerequisites in this change.

#### Scenario: project creation arms a rename

- **WHEN** a case tests focus after creating a project
- **THEN** it creates through the UI and observes the rename arm rather than receiving an API-created project

### Requirement: Fixtures remain independent under measured concurrency

Projects and global directory names SHALL be disjoint across concurrent fixtures. Four workers SHALL become the default only after the design's full-suite correctness and speed acceptance rule passes.

#### Scenario: two fixtures create similarly named tags concurrently

- **WHEN** two workers seed their own recipe
- **THEN** their names and returned ids differ and neither fixture's final assertions depend on the other's directory entries

#### Scenario: four workers are slower or produce lock failures

- **WHEN** the prescribed comparison fails its speed or correctness rule
- **THEN** the default stays at one worker and the measurements explain that decision
