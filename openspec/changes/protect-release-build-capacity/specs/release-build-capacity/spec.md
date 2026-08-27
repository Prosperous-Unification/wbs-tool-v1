## ADDED Requirements

### Requirement: Unsafe release builds are refused before Dagger starts

The release publisher SHALL acquire one non-blocking host-wide heavy-work lock
and SHALL verify host capacity before starting or connecting to a Dagger engine.
It MUST refuse when available memory is below 8 GiB, combined `/tmp` and
`/dev/shm` occupancy is above 25%, or one-minute load exceeds the online CPU
count. Missing or unreadable measurements MUST also refuse.

#### Scenario: Another heavy gate is active

- **WHEN** the host-wide heavy-work lock is already held
- **THEN** the release refuses immediately without starting Dagger

#### Scenario: One capacity limit is unsafe

- **WHEN** any one admission measurement crosses its limit
- **THEN** the release names the unsafe measurement and starts no engine

#### Scenario: Capacity is safe

- **WHEN** the lock is free and all measurements are within their limits
- **THEN** the release records the measurements and may start Dagger

### Requirement: Release engine resources and lifetime are bounded

The release publisher SHALL use a named Dagger v0.21.8 engine with explicit
memory, CPU, PID, loopback-port, and persistent-cache settings. It SHALL stop
that engine after every publish outcome. A mismatched existing engine or a
failed stop MUST fail the release.

#### Scenario: Publishing succeeds

- **WHEN** all selected images publish successfully
- **THEN** the release manifest is written and the engine is stopped

#### Scenario: Publishing fails

- **WHEN** Dagger or the registry reports an error
- **THEN** the original failure is reported and the engine is still stopped

#### Scenario: Existing engine limits drift

- **WHEN** the named engine does not match the required resource contract
- **THEN** the release refuses before connecting to it

### Requirement: Repository gates share release exclusion

The documented h2puni full-gate entrypoint SHALL acquire the exact lock used by
the publisher so a conforming full gate and release cannot overlap.

#### Scenario: A release owns the lock

- **WHEN** the h2puni gate entrypoint starts during that release
- **THEN** it refuses immediately without running Nx
