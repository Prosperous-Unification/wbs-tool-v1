## ADDED Requirements

### Requirement: Every invalidation reaches a covering outcome

The plan refresh owner SHALL retain an invalidation until every requested resource reaches a covering installed generation, a covering failure, or owner disposal. A read started before an invalidation SHALL NOT satisfy that invalidation merely because its URL matches.

#### Scenario: A newer tree change arrives during an old tree read

- **GIVEN** a real tree GET started for sequence A is held
- **WHEN** change B is committed/notified and the held A response is released
- **THEN** a trailing GET SHALL install B without a third event
- **AND** the caller awaiting B SHALL NOT report installed from A.

#### Scenario: Repeated invalidations coalesce without disappearing

- **WHEN** several tree invalidations arrive during one running read
- **THEN** pending obligations MAY share one later covering read
- **AND** every waiting caller SHALL receive an outcome for its own resource obligation.

### Requirement: Resources retain independent installation authority

The coordinator SHALL independently track tree, steps, grouped directory and calendar markers. Invalidating one resource SHALL NOT revoke installation authority for another resource's still-current read.

#### Scenario: A renamed step finishes after a newer tree read

- **GIVEN** a steps response containing the renamed step is held
- **WHEN** a newer tree-only invalidation completes and the steps response is released
- **THEN** the renamed step SHALL install
- **AND** the same behavior SHALL hold for grouped-directory and initial full-load overlap.

#### Scenario: Marker reads do not replace schedule state

- **WHEN** a marker mutation succeeds or is refused
- **THEN** its marker list SHALL be invalidated and read back
- **AND** an unrelated tree/steps read SHALL retain its own installation authority
- **AND** marker-only invalidation SHALL NOT request schedule/tree work.

### Requirement: Failures remain visible until their resources recover

A failed resource read SHALL retain its previously installed value and unresolved stale state. Successful, failed or superseded work for a different resource SHALL NOT clear that state.

#### Scenario: Tree recovery cannot conceal failed markers

- **GIVEN** a marker reread failed and the prior list remains drawn
- **WHEN** a later tree read succeeds
- **THEN** stale status SHALL remain until a covering marker read succeeds.

#### Scenario: A committed edit has a failed refresh

- **WHEN** a mutation commits and its covering read fails
- **THEN** the mutation SHALL remain landed and the read failure SHALL be visible
- **AND** it SHALL NOT be reported as a refused mutation or trigger unbounded retries.

### Requirement: Stream acknowledgment reflects installed coverage

A sequence SHALL be acknowledged only after the required installed generations cover all preceding contiguous subscription invalidation obligations. A larger tree response sequence SHALL NOT bypass unresolved marker, steps or directory obligations.

#### Scenario: An earlier resource failure blocks later acknowledgment

- **GIVEN** sequenced marker invalidation B is unresolved
- **WHEN** a later tree invalidation C installs successfully
- **THEN** the resume watermark SHALL NOT advance past B
- **AND** it MAY advance through C after B's required marker state installs.

#### Scenario: Full resync does not acknowledge a partial load

- **WHEN** a full resync installs tree but its directory or marker group fails
- **THEN** the stream SHALL NOT claim the full resync was installed.

#### Scenario: A newer tree response precedes an unseen marker event

- **GIVEN** marker event B has committed but has not reached the stream
- **WHEN** a tree response carrying sequence B installs and the socket disconnects
- **THEN** reconnect SHALL resume from the last covered anchor/event obligation rather than B
- **AND** replay SHALL cause marker B to install without a later event.

#### Scenario: Baseline closes the initial subscription registration gap

- **GIVEN** the first tree read establishes anchor A
- **WHEN** unsequenced resources read after A install and changes occurred before socket registration
- **THEN** the stream SHALL request replay from A on the subscribed socket
- **AND** the baseline SHALL NOT rely on unsequenced reads started before A or request the entire history from -1.

#### Scenario: A later live event overtakes an earlier event

- **GIVEN** durable event B has not arrived and later event C arrives first
- **WHEN** C's known resource read installs
- **THEN** acknowledgment SHALL NOT advance across unseen B
- **AND** bounded replay or anchored full resync SHALL recover the unknown gap without requiring another event or disconnect.

### Requirement: Read ownership ends with its project and API lifetime

Disposal SHALL settle outstanding callers as disposed and prevent subsequent installation, stale changes, notifications, toasts and acknowledgments. A new project or API identity SHALL use a distinct owner, including when the project ID is unchanged.

#### Scenario: Old requests settle after departure

- **WHEN** a departed owner's held read resolves or rejects
- **THEN** the active project SHALL receive no state, stale, toast or acknowledgment effect from it.

#### Scenario: StrictMode remount establishes a live owner

- **WHEN** React performs setup, cleanup and setup again
- **THEN** the second setup SHALL obtain a live owner and complete its initial load
- **AND** the disposed first owner SHALL remain unable to publish.

### Requirement: Editing and assembled chart state are preserved

The adapter SHALL preserve stable columns and sameSteps identities on unrelated reads, current draft/refusal settlement and coherent ChartRead publication.

#### Scenario: A peer update arrives during a local draft

- **GIVEN** a focused cell contains a half-typed value
- **WHEN** an unrelated peer tree or marker update installs
- **THEN** the editor node, focus and typed value SHALL survive
- **AND** the peer's changed reading SHALL appear in the relevant non-draft output.

### Requirement: Empty-history baselines can replay the first event

A covered empty-history baseline SHALL use cursor -1 with explicit replay intent. The gateway SHALL accept safe integer cursor -1 and SHALL reject cursors below -1. Generic never-read -1 callers without explicit baseline intent SHALL retain their no-history replay behavior.

#### Scenario: The first event occurs before baseline subscription registers

- **GIVEN** an anchored baseline has empty history at -1
- **WHEN** event0 commits before the subscription registers
- **THEN** explicit baseline replay SHALL request events after -1 and install event0's resource state without waiting for event1.

#### Scenario: A cursor lies below the modeled sentinel

- **WHEN** the client resumes from -2
- **THEN** ingress SHALL refuse invalid_payload and the connection SHALL remain usable.

### Requirement: Replay recovery retains one registered stream

A replay refusal or acknowledgment without the subscription replay count SHALL start anchored recovery on the existing registered stream. Completing that recovery SHALL advance its installed cursor without opening another socket solely to request replay again.

#### Scenario: Every replay attempt is refused

- **WHEN** the current socket refuses replay or returns an empty acknowledgment map
- **THEN** one covering recovery SHALL complete without another immediate socket/resume attempt
- **AND** a later actual disconnect SHALL reconnect from the recovered anchor and may request another covering recovery.

#### Scenario: Reconnect occurs during held recovery

- **WHEN** another registration gap requires recovery while a resource read is held
- **THEN** the later covering obligation SHALL remain pending until its resource state installs.

### Requirement: Physical socket callbacks expire with their socket

Open, message and close callbacks SHALL act only for their current physical socket and live subscription.

#### Scenario: Old callbacks arrive after replacement synchronization

- **GIVEN** a replacement socket has synchronized
- **WHEN** the old socket reports close, open, replay refusal or presence
- **THEN** the replacement SHALL remain connected with no extra frames, recovery request, presence publication or reconnect timer.
