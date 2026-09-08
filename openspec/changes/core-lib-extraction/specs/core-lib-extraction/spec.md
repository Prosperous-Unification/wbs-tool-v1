## ADDED Requirements

### Requirement: Every project declares which ring it is in

Every project in the workspace SHALL carry exactly one `scope:` tag, exactly one `ring:` tag
and exactly one `runtime:` tag. A project carrying zero or two of any of them SHALL fail a
test, because a constraint the linter cannot find on a project is a constraint that never
fires for it.

`tools/*` projects SHALL be `ring:adapter`: they call adapters and nothing calls them.

#### Scenario: a project with no ring

- **WHEN** a project's `project.json` carries no `ring:` tag
- **THEN** the totality test fails naming that project

#### Scenario: a project with two rings

- **WHEN** a project's `project.json` carries both `ring:domain` and `ring:adapter`
- **THEN** the totality test fails naming that project

### Requirement: The dependency direction is enforced, not documented

`ring:domain` SHALL import only `ring:domain`. `ring:application` SHALL import
`ring:domain` or `ring:application`. `ring:adapter` MAY import any ring.

A `ring:application` or `ring:domain` **production** file SHALL NOT import `node:*`, `bun:*`,
`elysia`, `@elysiajs/*`, `drizzle-orm` or `jose`, and SHALL NOT reference the globals `Bun`,
`process`, `fetch`, `setTimeout`, `setInterval` or `Buffer`.

Recognized test files and fixtures (`**/testing/**`) SHALL be exempt from the ring
constraints and from the import ban, and SHALL remain subject to their test runtime constraints. That
exemption is what lets core's own tests compose core over the memory source and import
`bun:test`; it SHALL stop at the production file beside them.

#### Scenario: an adapter imported from the application ring

- **WHEN** a `libs/core` production file imports `@wbs/store-sqlite`
- **THEN** the ring constraint refuses it

#### Scenario: the same import from the test beside it

- **WHEN** `libs/core/src/compose.test.ts` imports `@wbs/store-memory`
- **THEN** it is allowed, because a test composes what it is testing

#### Scenario: a driver reached for from the application ring

- **WHEN** a `libs/core` production file imports `drizzle-orm`, or references `Bun`
- **THEN** the restricted-import or restricted-global rule refuses it

### Requirement: The core composes over any source and any runtime

`composeServices({ source, runtime, shared })` SHALL build one service graph from a source's
stores, a runtime's ports and the shared instances, and SHALL be the only place the graph is
assembled.

A composition over the in-memory source and the portable runtime adapters SHALL run a command
batch, a saved-plan save, a replay and a retention sweep **without HTTP, without SQLite and
without Bun** — which is the proof that the ports are ports rather than the SQLite adapter's
shape under another name.

#### Scenario: core over the memory source

- **WHEN** `composeServices` is given the in-memory source and `runtime-portable`'s adapters
- **THEN** a command batch applies, a saved plan is written and read back, a replay answers,
  and a retention sweep prunes — with nothing from `bun:sqlite` or `elysia` loaded

#### Scenario: execution without Bun

- **WHEN** the same pure composition probe executes in a fresh Chromium page with no backend
- **THEN** all four use cases return their asserted outcomes, no network request occurs,
  and a production reference to `Bun` makes that probe fail

### Requirement: Core ports contain no adapter transaction type

Core store ports SHALL expose source-independent operations and value types. SQLite-only
`recordEventIn`, `holdingOf` and `bodyOf` SHALL remain adapter methods. A saved-plan quota
callback SHALL run inside its independent write transaction; an optimizer outcome and its
durable event SHALL retain their existing single transaction.

#### Scenario: event insertion fails after the outcome write

- **WHEN** event insertion throws inside `storeOptimizedOutcomeAndRecord`
- **THEN** neither the outcome nor its event remains stored

#### Scenario: quota checked concurrently

- **WHEN** competing saves approach the quota limit through the independent history port
- **THEN** each successful write uses a holding measured in its own transaction and the
  stored count never exceeds the limit

### Requirement: A service graph belongs to the scope that admitted it

The command runner SHALL build services from the scope passed to that invocation of
`UnitOfWork.run`. Post-rollback repair SHALL use the surviving scope supplied to its callback;
postcommit operations SHALL use the public graph. Scoped stores, collectors and working
state SHALL NOT be reused across batches.

#### Scenario: refusing one staged batch and committing the next

- **WHEN** a memory-source batch mutates stores and refuses, followed by a successful batch
- **THEN** only the successful batch's writes are visible through public reads, and its
  events are published exactly once after settlement

#### Scenario: repair while another writer waits

- **WHEN** undo refuses and names a stale journal entry while another writer is queued
- **THEN** repair removes the entry from surviving state before the queued writer proceeds,
  without attempting another coordinator admission or writing to discarded staged state

### Requirement: History and account capability are explicit

A source SHALL keep independent saved-plan history outside transactional staged state.
An accountless composition SHALL expose no auth service. Missing account capability SHALL
NOT be represented by an auth service whose store throws when first used.

#### Scenario: independent history survives a batch

- **WHEN** a saved-plan write succeeds during a memory batch, and the batch commits or refuses
- **THEN** the saved plan can still be read after either outcome

#### Scenario: accountless composition is typed

- **WHEN** code reads `auth` from an accountless composition
- **THEN** the spec-project typecheck rejects the access

### Requirement: Use cases retain authorization without HTTP

Non-HTTP use cases SHALL retain the current actor scope, project access and internal-caller
requirements. Saved-plan success SHALL publish once after commit; refusal SHALL publish
nothing. Unexpected verifier/account errors SHALL propagate rather than become credential
refusals.

#### Scenario: a direct save is forbidden

- **WHEN** a read-only actor or an actor without write access invokes the save use case
- **THEN** it returns the corresponding refusal with no saved plan or announcement

#### Scenario: an account lookup fails after credential verification

- **WHEN** the account store throws after the verifier accepts a credential
- **THEN** the unexpected error propagates through the service and is not converted to 401

### Requirement: Project and test discovery remains complete after moves

Workspace checks SHALL discover nested projects and eligible fast-tier suites independently
of whether those projects already declare the checked target. Each new library's source and
spec types SHALL compile. Every production boundary check SHALL be proved at its effective
production lint target with a named fault.

#### Scenario: nested library has a missing target

- **WHEN** a nested eligible library lacks its required unit-test or typecheck target
- **THEN** the independent project inventory fails naming that library

#### Scenario: new library test fails

- **WHEN** a newly added eligible library contains a deliberately failing test
- **THEN** the root fast-tier command fails on that test's assertion

### Requirement: A move changes no behaviour

Each `git mv` commit SHALL leave the same tests passing as the commit before it. A test that
had to be rewritten to keep passing SHALL be named in the change's `verify.md` with what about
it changed.

#### Scenario: the suite after each move

- **WHEN** `bun run test:unit` is run after each independently reviewed move
- **THEN** it passes and every changed test count is accounted for by a named relocation,
  new behavioral test or explicitly reviewed retirement
