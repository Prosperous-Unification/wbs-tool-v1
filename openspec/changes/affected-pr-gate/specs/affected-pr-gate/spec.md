## ADDED Requirements

### Requirement: The gate scope is chosen from the event, never inferred

The CI gate SHALL select its scope from `github.event_name` alone. `pull_request` SHALL run
`nx affected` against the base SHA carried in the event payload; `push`, `merge_group` and
`workflow_dispatch` SHALL run the full `nx run-many`. An event with no mapping SHALL fail the
job naming that event, and the mapped set SHALL equal the events this workflow subscribes to.

#### Scenario: A pull request gates only what it can reach

- **WHEN** the workflow runs on `pull_request`
- **THEN** the Nx gate runs `nx affected -t test lint typecheck build` with `--base` set to the
  payload base SHA and `--head=HEAD`
- **AND** the targets it reports are a subset of the targets a full run reports for the same tree

#### Scenario: The merge queue and main keep the full gate

- **WHEN** the workflow runs on `merge_group`, `push` or `workflow_dispatch`
- **THEN** the Nx gate runs `nx run-many` over every project, unchanged from before this change
- **AND** no base SHA is read, because none of those events needs a comparison boundary

#### Scenario: The workflow is subscribed to an event with no gate rule

- **WHEN** the gate-mode step runs for an event outside the mapped set
- **THEN** the step exits non-zero naming the event, and no Nx target runs
- **AND** removing that refusal arm from the workflow makes the pin suite fail

#### Scenario: A pull-request payload carries no base SHA

- **WHEN** the event is `pull_request` and the payload base SHA is empty
- **THEN** the step fails naming the missing value instead of widening or narrowing the scope

### Requirement: Tool Wiki stays in the pull-request gate when it is affected

The gate SHALL keep running Tool Wiki's own targets and `wiki-cli:lint:source`, which the
workspace `run-many` excludes, whenever Tool Wiki is affected by the pull request. Membership
SHALL be read from `nx show projects --affected --json` through a JSON reader, because the
command emits JSON on a non-TTY runner whatever separator is requested.

#### Scenario: A pull request changes Tool Wiki

- **WHEN** `nx show projects --affected` for the pull request's base includes `wiki-cli`
- **THEN** the gate runs `wiki-cli`'s test, typecheck and build targets and
  `wiki-cli:lint:source`, exactly as a full run does

#### Scenario: A pull request cannot reach Tool Wiki

- **WHEN** that project list does not include `wiki-cli`
- **THEN** those targets do not run, and the full gate on `merge_group` and `push` still runs them

#### Scenario: The affected project list cannot be computed

- **WHEN** `nx show projects --affected` fails or its output is unreadable
- **THEN** the gate-mode step fails, rather than recording Tool Wiki as unaffected

### Requirement: The browser gate follows the same switch without going vacuous

The four `pixels` shards SHALL run whenever the gate mode is full, or whenever the pull request
affects any project the browser stack boots. The stable `pixels` check SHALL stay required and
SHALL distinguish a deliberate skip from a failed, cancelled or never-decided shard.

#### Scenario: A pull request reaches the browser stack

- **WHEN** the affected project list includes `wbs-fe-01`, `wbs-be-01` or `wbs-gw-01`
- **THEN** all four shards run and `pixels` requires every one of them to succeed

#### Scenario: A pull request reaches none of the three

- **WHEN** the affected project list contains none of those projects
- **THEN** the shards are skipped and `pixels` reports success without booting chromium

#### Scenario: The job that decides the browser scope fails

- **WHEN** the scope job fails, is cancelled, or reports no verdict
- **THEN** `pixels` fails, so skipped shards are never read as a pass
