## ADDED Requirements

### Requirement: Every lint mode checks the complete selected tree

Wiki lint SHALL run deterministic inventory, classification, schema, metadata, link,
selector and input-coverage checks over the full explicitly selected tree. The initial Nx
target SHALL have caching disabled and SHALL be wired into host gate, CI and whole-tree
pre-commit. An admission report SHALL bind its actual immutable candidate.

#### Scenario: A staged deletion leaves a reverse link outside staged paths

- **WHEN** a staged candidate deletes a target referenced by an unchanged index
- **THEN** staged full-tree lint fails on the broken reverse reference

#### Scenario: Working content differs from HEAD

- **WHEN** the user selects working mode with tracked edits and untracked additions
- **THEN** the report identifies the frozen tracked snapshot and separate untracked set
- **AND** it cannot be reused as a committed admission attestation

### Requirement: Rollout modes express actual review obligations

Observe SHALL report review debt without certification. Ratchet SHALL enforce adopted
boundaries, classify every new path and expose remaining debt. Enforce SHALL refuse unmet
obligations across the selected policy's coverage. Mode selection SHALL NOT lower a packet's
required level.

#### Scenario: Enforced work presents observe output

- **WHEN** a packet requiring enforce submits an observe report
- **THEN** admission refuses the report even when deterministic checks passed

### Requirement: Candidates cannot weaken their own verifier or policy

Host/CI admission SHALL load its policy, adopted coverage and validator identity from a
separately reviewed trusted binding. Candidate changes SHALL NOT activate weaker policy,
exemptions or replacement validator code for their own acceptance.

#### Scenario: Candidate removes an adopted boundary

- **WHEN** a candidate edits its policy to excuse an unmet adopted obligation
- **THEN** CI still evaluates the externally selected trusted policy and refuses the candidate

#### Scenario: Validator or policy activation changes check selection

- **WHEN** a separately reviewed activation changes required inputs or obligations
- **THEN** affected checks and reviews are reselected before later candidates can integrate

### Requirement: Host evidence proves the production check can fail

Tooling acceptance SHALL include observed fault failures through production entrypoints and
the actual full gate, with adjacent Proof comments written only after failure output exists.

#### Scenario: An enforced review becomes stale in the host candidate

- **WHEN** the candidate changes an enforced reviewed blob without new evidence
- **THEN** the host gate fails through tool-wiki lint on that candidate
- **AND** restoring the required evidence permits the same gate path to continue
