## ADDED Requirements

### Requirement: Subscription selection performs bounded work

Each record operation SHALL select at most one other subscription for expiry using a bounded number of iterator advances independent of the total subscription count. Selection SHALL NOT materialize or scan the complete key set.

#### Scenario: Large subscription populations

- **GIVEN** 100, 1,000 or 10,000 buffered subscriptions
- **WHEN** the production record path performs a sweep
- **THEN** selecting the next subscription uses at most three iterator advances

### Requirement: Rotation preserves expiry and replay semantics

The sweep SHALL continue across wrap, deletion and new subscriptions while preserving the configured age/count limits and replay coverage decisions.

#### Scenario: Deleted subscriptions during a lap

- **WHEN** a sweep expires and removes subscriptions while another subscription keeps receiving records
- **THEN** every abandoned subscription is eventually removed and current records remain replayable

#### Scenario: Expired replay range

- **WHEN** the buffer no longer covers a requested sequence after expiry
- **THEN** replay falls back to the durable event log as before
