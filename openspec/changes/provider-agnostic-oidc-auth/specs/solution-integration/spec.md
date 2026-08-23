## ADDED Requirements

### Requirement: A project can reference and resolve a solution

A project SHALL permit one nullable solution reference containing a slug and URL.
An authenticated reader with read scope SHALL be able to resolve the project by
that slug; an unknown slug MUST be refused as not found.

#### Scenario: a known solution is resolved

- **GIVEN** a project references a solution slug
- **WHEN** a read-scoped caller requests `/plans/by-solution/:slug`
- **THEN** the referenced project SHALL be returned

#### Scenario: the solution slug is unknown

- **GIVEN** no project references the requested solution slug
- **WHEN** a read-scoped caller requests it
- **THEN** the route SHALL answer not found

### Requirement: A plan has read-scoped machine and document exports

A read-scoped caller SHALL be able to export one project as JSON or Markdown.
The export SHALL be read-only and SHALL refuse unsupported formats.

#### Scenario: a reader exports JSON

- **GIVEN** an authenticated caller with read scope
- **WHEN** it requests `/api/projects/:id/export?format=json`
- **THEN** the response SHALL contain the project's WBS and Gantt data as JSON

#### Scenario: a caller without read scope requests an export

- **GIVEN** an authenticated identity without read scope
- **WHEN** it requests either export format
- **THEN** the export SHALL be refused
