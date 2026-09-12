# scheduler-runtime-port

## Purpose

Defines the explicit scheduling capability, live failure contract, detached capture behavior, and stable adapter-owned schedule hash used by the portable core.

## Requirements

### Requirement: Explicit synchronous scheduling capability

Scheduler SHALL receive the complete canonical input and explicit selection, SHALL derive
capability from installed adapters, and SHALL NOT await a solve during a read.

#### Scenario: Missing selected engine

- **WHEN** an enabled optimized project is read in a composition without that adapter
- **THEN** it returns engine_unavailable before calling Fast, without fabricated dates

#### Scenario: Installed pending optimizer

- **WHEN** the installed optimizer has a pending or failed selected variant
- **THEN** the live tree retains its existing Fast baseline and explicit optimization state

#### Scenario: Complete input and invariant failure

- **WHEN** the adapter is called for a capacity-constrained plan with reach and deadlines
- **THEN** it receives all seven original scheduling inputs without arithmetic changes
- **AND** a ready variant without a schedule throws rather than substituting Fast

### Requirement: Availability reaches every live caller

Live read and export bindings SHALL map missing engine capability to typed 409 replies.
Publication after a committed write SHALL invalidate the unavailable plan without
misreporting the committed mutation as a failure.

#### Scenario: HTTP and generated consumers

- **WHEN** GET work items or either export format reads an unavailable optimized plan
- **THEN** the mounted route returns 409 with error engine_unavailable and engine optimized
- **AND** its schema, generated client and MCP-visible response describe that refusal

#### Scenario: Write notification after commitment

- **WHEN** an authorized mutation commits to a stored project whose engine is unavailable
- **THEN** it succeeds and publishes plan_unavailable through the durable broadcaster
- **AND** a peer refetches the tree, renders its typed failure, and receives no Fast replacement

### Requirement: Capture does not admit optimization

Saved-plan save and current SHALL schedule only detached captured input and SHALL preserve
the selected engine's result or a typed absence. Stored history SHALL never be recomputed.

#### Scenario: Ready optimized capture

- **WHEN** the exact captured key has a ready selected optimized variant
- **THEN** its schedule is stored with the optimized contract/objective/budget identity
- **AND** no generation, reservation, queue entry or solver process is created

#### Scenario: Unavailable or unfinished capture

- **WHEN** the selected optimized adapter is absent or its result is not ready
- **THEN** input capture remains saveable with the design's unavailable, pending or infeasible reason
- **AND** it does not save Fast under an optimized identity

#### Scenario: Historical schedule read

- **WHEN** stored history is read after the live engine, inputs or version changes
- **THEN** stored bytes and identity are returned unchanged with no scheduler invocation

### Requirement: Adapter-owned stable hash

Domain canonicalization SHALL be runtime-neutral. SQLite hashing SHALL preserve the exact
existing cache-key bytes and semantic version contract across extraction.

#### Scenario: Pre-extraction cached row

- **WHEN** the moved helper reads a row keyed from a literal pre-extraction fixture
- **THEN** it addresses the same row with the same hash, budget and contract version
- **AND** importing domain does not load Node crypto
