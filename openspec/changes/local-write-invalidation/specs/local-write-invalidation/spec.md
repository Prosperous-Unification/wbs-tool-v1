## ADDED Requirements

### Requirement: Completed local operations name their refresh resources

A plan gesture SHALL invalidate exactly the union declared by its completed requests through the existing generation coordinator. Tree-only mutations SHALL NOT fetch steps, directory or markers. Narrowing SHALL NOT depend on a socket echo.

#### Scenario: an estimate lands without a subscription

- **WHEN** an estimate request completes successfully on a page without a socket subscription
- **THEN** the changed server total appears after one covering tree refresh and no step, directory or marker refresh is issued

#### Scenario: a directory entry is minted while assigning

- **WHEN** a new person is created and assigned
- **THEN** the refreshed directory names that person and the refreshed tree names the assignment, without a marker or step read

### Requirement: A successful prefix is refreshed after a later refusal

A compound gesture SHALL retain refresh obligations from each completed request even when a later request refuses. It SHALL preserve the refusal toast and draft and SHALL NOT report the whole gesture as landed.

#### Scenario: creating a tag succeeds and attaching it refuses

- **WHEN** the create returns a new tag but the following patch returns a modeled conflict
- **THEN** the tag appears in the directory after the covering refresh, the row remains unattached, and the gesture reports refused

### Requirement: Existing lifecycle and recovery semantics survive narrowing

The plan SHALL preserve trailing reads, owner isolation, stale banners, not-found recovery, marker-refusal refresh and undo/redo recovery. An ambiguous write outcome SHALL trigger a full recovery read.

#### Scenario: an old read is held across a write

- **WHEN** a tree read starts before a successful rename and its old answer arrives afterward
- **THEN** that answer cannot discharge the rename's obligation and a later tree answer installs the renamed row

#### Scenario: a previous owner's write settles late

- **WHEN** the API or project owner changes while a write is pending
- **THEN** its completion does not change the replacement owner's screen, busy state or refresh obligations
