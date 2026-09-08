## ADDED Requirements

### Requirement: Inventory accounts for exact candidate entries

The ledger SHALL inventory complete path/mode/blob tuples at an immutable candidate and
partition every entry into content or a reserved evidence schema. Working checks SHALL
report untracked content separately; admission SHALL include additions and deletions.

#### Scenario: Equal counts conceal a replaced path

- **WHEN** an inventory substitutes a different path while retaining the total count
- **THEN** the production validator fails on the complete tuple mismatch

#### Scenario: Executable content is hidden under evidence

- **WHEN** a reserved evidence path contains source, executable mode or an unknown schema
- **THEN** classification fails before evidence is accepted

### Requirement: Evidence validation terminates without self-attestation

Content manifests SHALL exclude evidence bytes; evidence artifacts SHALL be validated by
schema, provenance and referential integrity. Attestations SHALL name their reviewed source
base; final candidate/commit binding SHALL be external to the containing commit.

#### Scenario: Only an evidence record changes

- **WHEN** valid evidence bytes change without changing their content or relationship inputs
- **THEN** artifact validation terminates and runs again
- **AND** the unchanged content review does not become stale solely from that edit

#### Scenario: A source blob changes after review

- **WHEN** a reviewed content tuple no longer matches the candidate
- **THEN** the applicable content judgment is stale and enforced coverage fails

### Requirement: Currency follows the scope of each judgment

Currency SHALL separately track content, public declarations including re-exports, semantic
selectors and topology/reverse edges. Implementation changes SHALL select applicable behavior
checks and impact review even when types remain stable. Unsupported impact SHALL expand
required review.

#### Scenario: A barrel stays unchanged while a re-exported type changes

- **WHEN** a resolved public declaration changes behind an unchanged barrel
- **THEN** dependent structural evidence becomes stale

#### Scenario: A descendant changes internally without changing navigation

- **WHEN** only the descendant's implementation bytes change
- **THEN** its content review becomes stale while the unchanged ancestor navigation judgment remains current
- **AND** applicable behavioral checks still run

#### Scenario: A new importer or indexed child appears

- **WHEN** a candidate adds a reverse import edge or index membership edge
- **THEN** the relevant provider relationship or navigation judgment becomes stale

### Requirement: Review evidence preserves protocol and invocation provenance

Attestations SHALL retain actual model/configuration, protocol identity, invocation journal
binding, context/read sets, raw response references, checks, findings and unresolved
relationships. Cold and informed judgments SHALL remain separate. Missing telemetry or
unknown provenance SHALL remain unverified and SHALL NOT satisfy enforced review coverage.

#### Scenario: A writer invents a review invocation

- **WHEN** a submitted attestation names an invocation absent from the trusted journal
- **THEN** the production validator rejects its provenance even if all blob hashes match

#### Scenario: Informed review resolves initial uncertainty

- **WHEN** expanded reads produce an informed yes after a cold partial or no
- **THEN** both judgments and their separate read costs remain in the record

### Requirement: Exhaustive review obligations remain distinct

The exhaustive policy SHALL require every content path and file/directory/project/docs
obligation, fresh post-correction reviews, explicit unresolved/unreviewed sets and reproducible
audit selection. Disagreement SHALL require source-based adjudication and fresh shard review.

#### Scenario: A sampled review is submitted for exhaustive coverage

- **WHEN** only the sampled subset has review evidence
- **THEN** enforce reports the exact remaining obligations and refuses exhaustive certification

#### Scenario: A reviewed correction changes source

- **WHEN** a writer fixes a finding after its recorded review
- **THEN** the finding remains unresolved until current source/check evidence and a fresh post-correction review support closure
