## ADDED Requirements

### Requirement: One authority acquires all claims atomically

Work-packet ownership SHALL use one canonical common-Git authority, acquire every requested
path/conflict-group claim atomically and reject ancestor/child overlap, traversal, symlink
escape, malformed state and ambiguous declarations. Claims SHALL bind session, worktree,
base, mapping/policy and generation.

#### Scenario: Two processes acquire overlapping claims

- **WHEN** independent processes concurrently request conflicting path sets
- **THEN** at most one acquires its complete set and the refused request acquires none
- **AND** unrelated claims remain unchanged

### Requirement: Submission freezes publication and fences stale generations

Submission SHALL store an immutable patch/candidate identity and fence further publication
for that generation. Claims SHALL persist through submitted state until integration or
explicit terminal rejection/abandonment. Release SHALL be idempotent only for the exact
session/generation. Heartbeat expiry SHALL NOT assert that a writer stopped.

#### Scenario: A stale writer resumes after reacquisition

- **WHEN** an old generation submits, integrates or releases after a successor acquired the claims
- **THEN** the authority refuses the stale operation and preserves the successor's claims

#### Scenario: A submitted writer changes its patch

- **WHEN** the writer attempts another publication under its submitted generation
- **THEN** the authority refuses instead of replacing the frozen submission

### Requirement: Admission checks both write and read boundaries

Admission SHALL compare actual additions/deletions and both rename sides with the packet's
resolved ownership, and revalidate read dependencies/interfaces on the actual candidate.
Read expansion SHALL NOT grant write authority.

#### Scenario: A rename crosses out of the packet

- **WHEN** a submission renames an owned path to an unowned destination or introduces an unowned new path
- **THEN** admission refuses before publication

#### Scenario: A dependency changed after scoped checks

- **WHEN** a declared read dependency differs on the combined candidate
- **THEN** admission requires the affected checks/review again or refuses integration

### Requirement: Integration validates the exact combined candidate

Only the candidate containing the exact immutable submissions SHALL satisfy integration.
Changed contracts, policy, gates or relationships SHALL reselect affected checks. Final
integration SHALL revalidate generations and base with an atomic ref update. Failure/recovery
SHALL preserve other sessions' submissions, bound retries and expose queue/rework state.

#### Scenario: Incompatible contract-only intermediate state

- **WHEN** a submission changes a shared contract without its required consumer changes
- **THEN** combined acceptance fails and the unusable intermediate state does not integrate

#### Scenario: Base advances while the candidate is checked

- **WHEN** the target branch changes before the atomic integration update
- **THEN** the update refuses and the coordinator recomposes/revalidates against the new base

### Requirement: Ownership guarantees report their actual scope

Reports SHALL distinguish admission detection/refusal from prevention of editing-time
filesystem writes. Single-host file claims SHALL NOT claim multi-host coordination or
reservation of runtime ports, databases and heavy-work lanes.

#### Scenario: A worker writes outside its packet before admission

- **WHEN** the editing environment permits that write and admission later rejects its diff
- **THEN** the report states that publication was refused and does not claim the write was prevented
