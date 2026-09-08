## ADDED Requirements

### Requirement: The plan document carries what a restore needs

The JSON export SHALL preserve its existing project, workItems, steps and projection fields and add the versioned wbs-plan header, writable settings, capacity, calendar markers and the transitive referenced directory. Settings SHALL include current optimization settings and rows SHALL retain deadlines. Directory closure SHALL include capacity-only teams, assigned people's memberships and team-owned services, while excluding unrelated entries.

#### Scenario: the document names what its ids mean

- **WHEN** a row is assigned to agent Kat who belongs to team Billing, and an otherwise unused team has project capacity
- **THEN** directory.people includes Kat with kind and teamIds, directory.teams includes Billing and the capacity team, and no unrelated tag is included

#### Scenario: nothing MCP reads has moved

- **WHEN** an unchanged project is exported
- **THEN** its existing project, workItems, steps, slices, scheduleError, seq, assignedPeople, waitingForPerson and waitingForCapacity retain their existing values and shapes

#### Scenario: the export is the import's input

- **WHEN** a document is imported into a deployment with compatible directory entries and exported again
- **THEN** authored settings, row fields, leaf step values, explicit assignments, dependency endpoints, bands, capacity and markers agree after remapping ids and excluding stamps and the optional solution-ref collision outcome

### Requirement: A plan document imports as a new project whole or not at all

POST /api/projects/import SHALL create a new caller-owned project with fresh ids and all declared authored settings, ordered steps, rows, labels, deadlines, constraints, values, assignments, dependencies and markers. It SHALL ignore derived projection fields, including parent roll-ups. FrozenNumber SHALL be preserved as authored freeze state. An import SHALL use one admitted unit of work, SHALL produce no undo/history entry and SHALL leave no project, row or directory creation behind on refusal or failure.

#### Scenario: a restored plan is the plan

- **WHEN** a plan with three steps, bands, capacity, a frozen row, deadline, not-before flag, dependency, actual, measure and marker is imported
- **THEN** a read of the new project answers those authored values under newly minted ids and the original project is unchanged

#### Scenario: parent aggregate maps do not become facts

- **WHEN** a parent carries arbitrary exported aggregate maps and its child carries valid own estimates
- **THEN** only the child's own step values are stored, regardless of the exported rolledUp flag, and the parent's values are recomputed

#### Scenario: a failure occurs after a directory creation

- **WHEN** a valid document creates an absent team and a later scoped store operation deliberately refuses or throws
- **THEN** that team, the new project and its rows are absent after the request settles, and no collected announcement is sent

### Requirement: Malformed documents refuse by their actual paths before admission

The import SHALL validate version, writable values, unique ids/names, hierarchy, step/directory references and dependency validity before entering its unit of work. Refusals SHALL carry paths in the actual document vocabulary, including workItems. Unsupported versions SHALL answer 400 unsupported_version; malformed values SHALL answer 400 invalid_body; missing file-local references SHALL answer 400 unknown_ref.

#### Scenario: a dangling dependency refuses before any creation

- **WHEN** workItems[12].dependsOn[0] names no declared row
- **THEN** the response is 400 unknown_ref at that path and the unit of work is not entered

#### Scenario: a malformed row names its field

- **WHEN** workItems[3].priority is high as text
- **THEN** the response is 400 invalid_body with path workItems[3].priority and nothing is written

#### Scenario: the format is known but the version is not

- **WHEN** document.format is wbs-plan and document.version is 2
- **THEN** the response is 400 unsupported_version naming document.version before interpreting version-specific fields

#### Scenario: a hierarchy cycle is wholly declared

- **WHEN** two declared rows parent each other
- **THEN** the import returns a typed malformed-document refusal naming the offending parentId and enters no unit of work

### Requirement: Directory names are reused without global overwrite

The import SHALL match trimmed names case-sensitively. It SHALL create absent entries inside the same unit of work and report their names by kind. Newly created people and teams SHALL retain declared kind, memberships and ownership; existing entries SHALL remain unchanged.

#### Scenario: an existing tag is reused

- **WHEN** the target directory already holds urgent
- **THEN** the imported row uses that tag id and created.tags is empty

#### Scenario: an existing person's metadata differs

- **WHEN** a matching person's existing kind or memberships differ from the file
- **THEN** the imported assignment reuses the existing person and no existing kind or membership is overwritten

#### Scenario: a missing agent is created

- **WHEN** the document assigns an absent agent Kat
- **THEN** Kat is created as an agent with the document's remapped memberships and created.people contains Kat

### Requirement: Optional solution reference loss is explicit

The import SHALL keep a free solution slug and SHALL omit a taken slug while returning solutionRef left-off. It SHALL NOT silently disable a requested enabled optimized engine that the target cannot provide.

#### Scenario: the slug is taken

- **WHEN** a project already holds acme-q4
- **THEN** the new project has no solution ref, the holder is unchanged and the success summary reports left-off

#### Scenario: the selected optimizer is unavailable

- **WHEN** settings request enabled optimized scheduling but the target has no applicable scheduler adapter
- **THEN** import returns the scheduler port's typed refusal and creates nothing

### Requirement: The toolbar offers export and import together

The menu SHALL be named Export / Import. Download JSON SHALL fetch the whole server document and save the plan's JSON filename. Import JSON SHALL read one file, open the newly imported project on success and show one summary toast; refusal SHALL keep the current project and show the reason/path. Cancellation SHALL do nothing.

#### Scenario: the whole project is downloaded

- **WHEN** a branch is collapsed and search narrows the table to one row, then Download JSON is pressed
- **THEN** the file contains every work item, not just the displayed rows

#### Scenario: import lands

- **WHEN** a valid 40-row file creates one absent tag
- **THEN** the picker opens the new project and one toast reports 40 work items and one created tag

#### Scenario: import is refused

- **WHEN** the selected file carries a dangling dependency
- **THEN** the error toast names workItems[12].dependsOn[0] and unknown_ref, the project count is unchanged, and the current project remains selected
