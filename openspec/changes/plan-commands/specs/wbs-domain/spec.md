## ADDED Requirements

### Requirement: A plan is written to as a command batch

The API SHALL accept `POST /api/projects/{id}/commands` — and, for directory
commands alone, `POST /api/directory/commands`, which has no project and
records no undo — carrying an ordered list of at most two hundred typed commands — every plan write (create, patch, move,
duplicate, delete, estimate, actual, progress, measure, assignee, dependency,
freeze, unfreeze, capacity, priority bands) and every directory write (team,
person, tag, service: create, patch, delete) — and SHALL apply them in order,
**all or none**. A command the API would refuse on its own route SHALL refuse the
batch with the same reason and status, naming the failing command's index and
kind, and SHALL leave no command applied, the ones before it included.

The response to an applied batch SHALL name, per command, the id of anything it
created — and, for a directory create or patch, the entry as its list route
shows it — and SHALL carry the undo state as the tree read does. A refused
directory command SHALL carry its route's own fields beside the code: `taken`
the surviving name, `in_use` the usage.

#### Scenario: a plan is drafted in one request

- **GIVEN** an empty project
- **WHEN** a batch creates three work items, estimates two of them and adds a
  dependency between them
- **THEN** all six commands are applied, the response carries the three new ids,
  and the tree read shows the plan as one request left it

#### Scenario: a refused third command leaves the first two unwritten

- **GIVEN** a batch whose third command estimates a role the project does not
  hold
- **WHEN** it is posted
- **THEN** the answer is 404 `{ error: 'unknown_role', at: 2, kind: 'setEstimate' }`
- **AND** the work items the first two commands created do not exist

#### Scenario: two hundred and one commands are refused before any is applied

- **WHEN** a batch of 201 commands is posted
- **THEN** it is refused with 400 and nothing is applied

### Requirement: A ref names what a batch creates, for the rest of that batch

The API SHALL accept an optional `ref` on a command that creates a work item, a
duplicate, a team, a person, a tag or a service, and SHALL let any later command
in the same batch name that ref wherever it would name an id, substituting the
created id. A ref
SHALL live only in the request that minted it. A ref that no earlier command
minted SHALL refuse the batch as `unknown_ref` at that index; a ref minted twice
SHALL refuse it as `duplicate_ref`. The response SHALL say which id each ref
became.

#### Scenario: a child under a parent created in the same batch

- **WHEN** a batch creates `{ ref: 'epic' }` and then creates a work item with
  `parentRef: 'epic'`
- **THEN** the second is a child of the first, and the response maps `epic` to
  the first's id

#### Scenario: a ref nobody minted

- **WHEN** a command names `parentRef: 'nope'` and no earlier command carries
  `ref: 'nope'`
- **THEN** the batch is refused with 400 `unknown_ref` at that index and nothing
  is applied

### Requirement: One batch is one undo

A batch that applied more than one reversible command SHALL be one command
journal entry whose compensating command reverses the steps in the opposite
order, and one plan event; undoing it SHALL put back everything the batch did,
all or none, and redoing it SHALL re-apply all of it. A batch of one reversible
command SHALL be recorded exactly as that command is on its own — the same kind,
label and plan event. A batch that changed nothing SHALL record nothing.

Directory commands in a batch SHALL be applied inside the batch's transaction and
SHALL NOT be recorded: the directory has no journal, and undoing the batch SHALL
leave the directory entries it made in place.

The batch's preconditions SHALL be the revisions of every entity any step wrote
to, as the batch left them; a later write to any one of them makes the undo
stale, as for any command.

#### Scenario: one Cmd+Z after a drafted plan

- **GIVEN** a batch that created three work items and two estimates
- **WHEN** the account undoes once
- **THEN** none of the three work items exists, the stack holds one redoable
  entry, and the plan history shows one event for the batch

#### Scenario: a batch of one is not a batch in the journal

- **WHEN** a batch holding one `patchWorkItem` renaming a row is applied
- **THEN** the journal entry and the plan event are those of a rename, exactly as
  the single command records them

#### Scenario: undo leaves the directory alone

- **GIVEN** a batch that created a tag and labelled a new work item with it
- **WHEN** the account undoes once
- **THEN** the work item is gone and the tag still exists in the directory

### Requirement: Writes wait behind an open batch

While a batch is being applied, every other write the API handles SHALL wait for
it to finish and SHALL then be applied on its own; no write SHALL be interleaved
into a batch's transaction. Reads SHALL NOT wait. The lock SHALL be held only
while the batch is applying, never across a network call.

#### Scenario: a single write during a refused batch survives

- **GIVEN** a batch that will be refused at its last command
- **WHEN** a single-command batch renaming an unrelated row arrives while the
  first is applying
- **THEN** the rename is applied after the first batch has rolled back, and the
  row carries the new name

### Requirement: The MCP server offers batches, not single writes

mcp-01 SHALL derive its tools from the OpenAPI document as it does, and the
document's write surface SHALL be the two `commands` routes — the project's and
the directory's — undo, redo and the project-level routes that are not plan
edits. No single-item plan or directory write SHALL be offered as a tool, and
the `commands` tools' input schema SHALL carry every command kind with its
description, so a model can compose a batch without another document.

#### Scenario: the tool set after this change

- **WHEN** the tools are derived from the committed document
- **THEN** `postApiProjectsByIdCommands` and `postApiDirectoryCommands` are
  among them, no tool matches `/api/work-items/*` or a single-item directory
  write, and the count is twenty

#### Scenario: every kind is described

- **WHEN** the `commands` tool's input schema is read
- **THEN** each command kind appears in the `commands` item schema with a
  description sentence

### Requirement: The browser writes through batches, above an unchanged API surface

fe-01's `ProjectApi` and `DirectoryApi` methods SHALL keep their names and
signatures, and each write SHALL post a batch of one command. A multi-field edit
that is one request today SHALL stay one command. The single-item write routes
SHALL be removed from be-01 and from the OpenAPI document once no caller in this
repository uses them.

#### Scenario: the table renames a row

- **WHEN** a reader renames a row in the table
- **THEN** one `commands` request carrying one `patchWorkItem` is made, and the
  journal records a rename

#### Scenario: the retired routes are gone

- **WHEN** `PATCH /api/work-items/{id}` is requested
- **THEN** the answer is 404 and the route is absent from the OpenAPI document

---

## MODIFIED Requirements

### Requirement: A reversible command is written down as it happens

Every mutation this API offers that can be reversed SHALL record a command
journal entry once it has been applied: what it did, the compensating command
that reverses it, the command a redo re-applies, and the revisions of every
entity it wrote to **as it left them**.

The reversible commands are: a work item's field patch, an estimate set or
cleared, an actual, progress or measure set or cleared, an assignment set or
cleared, a dependency added or removed, a move, a create, a delete, a freeze, an
unfreeze, a duplication — and a **command batch** of more than one of these,
which is recorded as one entry. Renaming a project, restricting it, changing its
estimate method, setting its start date, and every directory write SHALL NOT be
reversible.

A command that changed nothing SHALL NOT be recorded.

The entry SHALL be written on the mutation's success path, inside the batch's
transaction where there is one. A mutation that applies but cannot be recorded
SHALL report failure rather than reporting success for a command nothing can
reverse.

#### Scenario: a rename is written down

- **WHEN** a work item is renamed
- **THEN** the account's newest journal entry for that project describes the
  rename, and expects that work item at the revision the rename left it at

#### Scenario: clearing an estimate that was not there records nothing

- **WHEN** an estimate is cleared for a role that held none
- **THEN** no entry is added, because there is nothing to put back

#### Scenario: a project rename is not reversible

- **WHEN** a project is renamed
- **THEN** nothing is added to any account's stack for it

#### Scenario: a batch is one entry

- **WHEN** a batch of five reversible commands is applied
- **THEN** exactly one entry is added to the account's stack for that project
