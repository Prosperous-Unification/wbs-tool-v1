## ADDED Requirements

### Requirement: Accepted outcomes are fixed before task partitioning

Experiments SHALL pin a corpus of outcome ids and acceptance criteria before partitioning.
Each outcome SHALL count once after integration and acceptance, regardless of subtasks,
retries or commits. Different corpora/configurations SHALL remain explicitly incomparable.

#### Scenario: One outcome is split into several worker tasks

- **WHEN** all subtasks integrate and the original outcome's acceptance passes
- **THEN** the completed-outcome count increases by one

### Requirement: Cost and elapsed accounting include the whole workflow

Trial reports SHALL include discovery, review, upkeep, waiting, integration, gates, failed
and censored attempts, raw usage categories, actual model/provider/price identity, human
time and infrastructure allocation. Missing required telemetry SHALL be unverified, not zero.

#### Scenario: Failed attempts are omitted from a submitted report

- **WHEN** invocation/session records contain failed work absent from the accounting report
- **THEN** report validation refuses the incomplete total

#### Scenario: Usage receipt is unavailable

- **WHEN** an invocation lacks a required token or price identity receipt
- **THEN** its report remains unverified and cannot complete cost acceptance

### Requirement: Trials preserve controlled conditions and true concurrency

Trials SHALL pin models, policies, prompts/tools, resources, seeds, retries/time windows,
prices and cache conditions, use repeated randomized cohorts and retain negative results.
The required eight-session cohort SHALL contain eight simultaneously active sessions.

#### Scenario: Two four-session groups substitute for eight sessions

- **WHEN** the execution log contains no interval with eight active sessions
- **THEN** the eight-session trial is invalid or pending and cannot support its scaling hypothesis

#### Scenario: Conditions change after a result is observed

- **WHEN** a threshold, corpus, resource envelope or model configuration changes
- **THEN** the report identifies a new condition instead of presenting it as the original comparison

### Requirement: Review policy adoption follows explicit evidence

Reports SHALL distinguish tooling acceptance, selected-policy coverage, completed
experiments and supported scaling claims. The exhaustive sweep and all required cohorts
SHALL be accounted for. Scaling claims SHALL name the tested corpus and satisfy the pinned
hypotheses; negative results SHALL remain complete experiments without positive claims.

#### Scenario: Tooling works but the eight-session trial is unavailable

- **WHEN** deterministic tooling checks pass but capacity cannot run the required cohort
- **THEN** tooling acceptance is reported separately and experiment reporting remains pending

#### Scenario: A completed trial falls below the efficiency target

- **WHEN** measured throughput misses a pinned hypothesis
- **THEN** the report retains the result and limiting factors without lowering verification or excluding failures

### Requirement: Measurement evidence remains portable

The runner SHALL export documented raw JSONL and tabular trial/outcome evidence sufficient
for independent recomputation without the wiki command implementation.

#### Scenario: The wiki tooling is unavailable to a report reader

- **WHEN** the reader consumes only the exported schema and observations
- **THEN** the reader can recompute accepted outcomes, full elapsed time and verified cost totals
