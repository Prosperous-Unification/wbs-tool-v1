## ADDED Requirements

### Requirement: A selector miss names the boundary, its selector and the relocation procedure

When a trusted boundary selects no candidate input, admission SHALL refuse naming that
boundary id, the selector kind and value that selected nothing, and the runbook section
that prepares a relocation activation from the candidate SHA. The refusal itself SHALL
stay unconditional — no boundary is exempted because its files appear to have moved.

#### Scenario: The trusted policy still selects a path the candidate moved

- **WHEN** production lint runs a candidate whose files live at the new path while the trusted policy's `selector` still names the old one
- **THEN** it exits 1 naming that boundary, its selector and `docs/runbook-tool-wiki-activation.md#relocation`
- **AND** it reports no trusted policy digest mismatch, because the trusted policy is intact

#### Scenario: The selector resolves against the candidate

- **WHEN** the trusted policy's selector selects at least one candidate input
- **THEN** admission proceeds to the mapping and authority checks and raises no selector refusal

### Requirement: An operator prepares a relocation activation from a candidate SHA

An operator SHALL prepare an activation from a candidate SHA and a base activation with one
command, which reads the candidate's policy and module mapping at that committed SHA. The
command SHALL refuse, naming what failed, an unknown or dirty SHA, a boundary whose selector
changed without a `sourceSelector`, a `predecessorModuleIds` chain that does not resolve, and
a selector that selects nothing in the candidate. On success it SHALL print the prepared
activation's version directory and digest.

#### Scenario: A candidate that renamed a boundary directory declares its move

- **WHEN** the candidate at that SHA carries `selector` at the new path, `sourceSelector` at the old, and a module mapping whose renamed modules name their predecessors
- **THEN** the command writes an activation root for that candidate and prints its version directory and digest
- **AND** running production admission for that candidate against the prepared activation raises no selector refusal

#### Scenario: A moved boundary omits its source selector

- **WHEN** the candidate's policy moves a boundary's selector but declares no `sourceSelector`
- **THEN** the command refuses naming that boundary and writes no activation

#### Scenario: The named revision is unknown or the tree is dirty

- **WHEN** the candidate SHA is not a commit in the repository, or the repository has uncommitted changes
- **THEN** the command refuses naming the revision or the dirty paths instead of reading a working tree

#### Scenario: A renamed module's predecessor does not resolve

- **WHEN** a module in the candidate mapping names a `predecessorModuleIds` entry absent from the base activation's mapping
- **THEN** the command refuses naming that module and its unresolved predecessor

#### Scenario: The candidate's own selector selects nothing

- **WHEN** the candidate's policy selector matches no path at the candidate SHA
- **THEN** the command refuses with the same selector-miss text admission raises

### Requirement: The runbook documents the two-step landing of a move

The activation runbook SHALL carry a `Relocation` section, reachable at the anchor the
selector-miss refusal names, stating the candidate's policy and mapping obligations, the
command that prepares the activation, publishing the archive and setting the activation
variables, rerunning the trusted check, and what happens after the merge. It SHALL state
that the single-valued activation variables serialize concurrent move candidates.

#### Scenario: An operator follows the refusal to the procedure

- **WHEN** an operator opens the runbook anchor named in the refusal
- **THEN** the section states the five ordered steps and the serialization limit
- **AND** a production test derives that anchor from the refusal text it observed and resolves it against the runbook's own headings, so renaming the heading makes the test red
