## ADDED Requirements

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
