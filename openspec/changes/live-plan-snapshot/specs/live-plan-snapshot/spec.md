## ADDED Requirements

### Requirement: A working plan belongs to one admitted batch

A working plan SHALL be created from the stores supplied to one UnitOfWork callback after admission, and SHALL be discarded on every terminal path. It SHALL NOT serve another batch, ordinary route, undo/redo or post-commit announcement.

#### Scenario: a queued batch reads an intervening edit

- **WHEN** one batch completes, an ordinary write changes a row, and another batch starts
- **THEN** the second batch reads the intervening value and its undo restores that value

#### Scenario: a refused batch is followed by another batch

- **WHEN** an early command changes an estimate and a later command refuses
- **THEN** the database and the next batch both read the pre-batch estimate

### Requirement: Retained reads advance after each successful mutation

The working plan SHALL expose all successful writes before the mutating method returns, including same-command structural side effects. It SHALL preserve previously returned before-images and authoritative store revisions, labels, external refs and ordering.

#### Scenario: a first child inherits its parent's figures

- **WHEN** one batch estimates a leaf, creates its first child and edits that child's estimate
- **THEN** subsequent commands see the hand-down and undo restores the original parent and figures

#### Scenario: a removed dependency changes a survivor

- **WHEN** a batch deletes a branch with an external dependency
- **THEN** subsequent commands and undo preconditions use the surviving endpoint's updated revision

#### Scenario: a directory cascade precedes a work-item edit

- **WHEN** a batch deletes a team with cascade and then patches an affected row
- **THEN** the second command sees the removed labels/assignments and current revision

### Requirement: Plan-only batches bound full-project reads

For a project batch containing no global directory entry or membership mutation, the working plan SHALL read each retained full-project collection at most once. Setting or clearing a row's assignee is a project-scoped operation and SHALL retain this bound, even though its store method currently belongs to DirectoryStore. Targeted identity reads and write statements SHALL be counted separately, and correctness SHALL remain identical to execution over uncached admitted stores.

#### Scenario: two hundred estimates are set

- **WHEN** a batch sets estimates on 200 independently identified rows
- **THEN** each loaded retained collection performs at most one full-project read, the stored estimates all match, and one undo restores their distinct previous values

#### Scenario: an assignment precedes a patch within a plan-only batch

- **WHEN** a batch assigns an existing person and then patches the same row
- **THEN** the patch and journal see the assignment-induced stored revision, while each loaded retained collection still performs at most one full-project read
