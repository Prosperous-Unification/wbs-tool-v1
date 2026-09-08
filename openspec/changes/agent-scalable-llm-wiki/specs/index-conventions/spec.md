## ADDED Requirements

### Requirement: Indexes preserve authoritative knowledge placement

Indexes SHALL route from repository orientation to declared boundaries and raw authority,
with purpose, relative contents links, applicable relationships/invariants/checks and explicit
external-consumer knowledge limits. Symbols SHALL retain their knowledge in JSDoc; indexes
SHALL NOT create a second prose copy for every source file.

#### Scenario: A boundary is described as a grouped set

- **WHEN** test, fixture, vendor or archived content is covered by its nearest index
- **THEN** its exact selected membership remains checkable and visible in coverage
- **AND** an archived change retains its frozen proposal as entrypoint

### Requirement: Index membership and references are deterministic

Index lint SHALL compare declared membership in both directions, validate metadata and
relative path/case/anchor references, and resolve membership declarations to concrete
candidate paths using the versioned grammar before issuing a packet.

#### Scenario: A linked child is deleted or renamed with different case

- **WHEN** the candidate deletes an indexed child or changes its path case without updating the index
- **THEN** the production lint command fails naming that reference

#### Scenario: A declaration escapes its boundary

- **WHEN** metadata contains traversal, an unsupported wildcard or a symlink escape
- **THEN** validation refuses the declaration before ownership or coverage is inferred

### Requirement: Root consolidation preserves every existing warning

Root consolidation SHALL record a complete source-to-destination map for findings and R5
incidents, retain stable incident identities and observed proof details, preserve R1–R5,
keep AGENTS within 120 lines and LLM_README within 150, and link the destination catalogues.

#### Scenario: Consolidation drops an incident or exceeds a cap

- **WHEN** one mapped incident has no destination or AGENTS contains 121 lines
- **THEN** the full-tree lint command fails naming the missing destination or cap violation

### Requirement: Current factual claims reference their authority

Typed current port, route, table and target references SHALL select executable authority;
historical claims SHALL identify their historical revision. Unsupported prose relationships
SHALL remain declared or unresolved rather than being silently certified.

#### Scenario: A current target changes while its fact reference does not

- **WHEN** the selected executable target differs from the current fact reference
- **THEN** lint reports the authority-selector mismatch
- **AND** an explicitly historical reference continues to resolve against its pinned revision
