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

Test files (`**/*.test.ts`) and fixtures (`**/testing/**`) SHALL be exempt from the ring
constraints and from the import ban, and SHALL remain subject to the runtime constraints. That
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

### Requirement: A move changes no behaviour

Each `git mv` commit SHALL leave the same tests passing as the commit before it. A test that
had to be rewritten to keep passing SHALL be named in the change's `verify.md` with what about
it changed.

#### Scenario: the suite after each move

- **WHEN** `bun run test:unit` is run after each of the three move commits
- **THEN** it passes, with the same count as before the move
