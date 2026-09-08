## ADDED Requirements

### Requirement: Every command has one complete definition and binding

The system SHALL derive command kinds, structural wire types and command descriptions from one shared definition per kind, and SHALL require one typed semantic normalizer and one execution binding for each definition. Contracts SHALL remain independent of application services and storage.

#### Scenario: a definition has no executor

- **WHEN** a command definition is added without its application binding
- **THEN** the application typecheck fails at the binding record before the command can be published

#### Scenario: an existing kind is omitted from documentation

- **WHEN** the emitted command branches omit clearMeasure or describe another kind twice
- **THEN** the generated MCP consumer's independent per-kind assertion fails even when branch totals match

### Requirement: The registry preserves command behavior

The registry SHALL preserve structural and semantic validation order, semantic defaults, optional versus null values, refs, directory-only restrictions, cap precedence, refusal detail and ordered atomic execution.

#### Scenario: semantic failure precedes the cap

- **WHEN** a request has 201 structurally valid commands and its last command has an invalid semantic field
- **THEN** the existing semantic refusal and its index are returned before the command-cap refusal and no writes survive

#### Scenario: a create is used later in the same batch

- **WHEN** createWorkItem declares a ref and setEstimate targets that ref
- **THEN** execution uses the minted row id, retains ordered results and records one undoable batch

#### Scenario: normalization preserves the three priority states

- **WHEN** separate creates omit priority, supply null or supply a number
- **THEN** each has the same stored priority as before the registry change

### Requirement: MCP keeps the existing batch surface

MCP SHALL derive the existing project and directory batch tools from shared HTTP shapes, with inline structural alternatives and nonempty descriptions, and SHALL NOT add one tool per command.

#### Scenario: the tool vocabulary is unchanged

- **WHEN** the document and tools are generated from the registry
- **THEN** the existing batch operationIds remain and every independently enumerated command is described once
