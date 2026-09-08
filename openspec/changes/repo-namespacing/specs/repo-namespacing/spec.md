## ADDED Requirements

### Requirement: Project discovery covers nested workspace projects

Workspace safety checks SHALL enumerate every application, library and tool project,
including nested projects, and SHALL fail on unreadable or malformed discovered state.

#### Scenario: A nested project would disappear from a shallow scan

- **WHEN** a project exists below another project or below a product/ring directory
- **THEN** totality, typecheck-target and input-coverage checks include its root and identity
- **AND** removing its required tag or breaking its target makes the production check fail

#### Scenario: Enumeration cannot read trusted project state

- **WHEN** a discovered project manifest or traversed directory is unreadable
- **THEN** discovery fails naming that path instead of omitting the project

### Requirement: Product layout and dependency direction agree

Every application/library SHALL have exactly one product tag matching its directory and
qualified Nx identity. Every project SHALL have exactly one scope, ring and runtime tag.
Library ring directories SHALL match ring tags; tools SHALL carry no product tag. A product
SHALL depend only on itself or shared-product libraries, including from test files.

#### Scenario: A directory claims a different ring

- **WHEN** a library under `libs/wbs/adapters` carries `ring:application`
- **THEN** the layout gate fails naming the conflicting root and tag

#### Scenario: A newly introduced product imports WBS

- **WHEN** a fixture project tagged `product:probe` imports `@wbs/core`
- **THEN** its actual Nx lint target refuses the import without a hand-added probe rule
- **AND** its same-product and `product:shared` controls pass

#### Scenario: Tags are absent duplicated or misplaced

- **WHEN** an app/library loses its product tag, any project has two ring tags, or a tool gains a product tag
- **THEN** the totality/layout gate names every violation

### Requirement: Namespace changes preserve consumer resolution

The namespace move SHALL retain all public alias keys and update every active path/target
consumer, including cache inputs, development setup/restart decisions and image builds.

#### Scenario: A moved configuration changes after a cached run

- **WHEN** a nested app project or Dockerfile changes after its guard has run successfully
- **THEN** Nx reruns the affected guard and the guard observes a deliberately invalid value

#### Scenario: Development reads the moved application layout

- **WHEN** setup, the development supervisor and source sync run against the moved checkout
- **THEN** setup uses the moved app environment files and the supervisor selects all four renamed projects
- **AND** moved migration/configuration changes still trigger the required restart or refusal

### Requirement: Deployment and migration identities survive the move

The move SHALL preserve applied SQL bytes and operational tier/image/container/DNS/state
identities while making all image, migration and CLI filesystem references resolve in the
new layout. The full gate and production dry-run SHALL evaluate the actual candidate.

#### Scenario: Migration commands run from the moved image workdir

- **WHEN** the backend image uses `/app/apps/wbs/be-01` as its working directory
- **THEN** the existing relative migration status, forward and rollback commands find the CLIs and drizzle folders
- **AND** missing down scripts and missing waiver scripts still fail their production checks

#### Scenario: A stale Dockerfile or migration path remains

- **WHEN** the candidate retains an old source path in Dagger or migration discovery
- **THEN** the real planning/build-input or migration-entrypoint check fails naming the missing path
- **AND** no zero-item migration scan or stale release manifest is accepted as success

#### Scenario: Previous release predates the directory rename

- **WHEN** deployment compares a new-layout HEAD with an old-layout deployed backend SHA
- **THEN** each revision's migration tree is resolved at that revision and the same ids remain equal
- **AND** a rename alone requires no migration acknowledgment while a newly added id still does
- **AND** absent or ambiguous migration roots fail instead of becoming an empty applied set
