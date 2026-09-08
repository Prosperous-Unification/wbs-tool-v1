## Why

WbsTable contains layout persistence, commands, keyboard behavior, filtering, chart projections and column renderers in one large function. W4-4's approved extraction gives each concept a file so later R1 and R10 work can change one boundary without loading or rewriting the entire table.

## What Changes

Move existing logic into the fourteen concept modules named by sweep C, including a column family directory and exported live contract. Preserve rendered behavior, request ordering, per-project state, PlanRow, pointed-row store and the columns memo's three dependencies.

Non-goals: changing refresh scope, introducing virtual rows, changing search behavior, or adding a PlanCard memo whose benefit has not been measured.

## Capabilities

### New Capabilities

- `wbs-table-modules`: explicit table composition and stable live column boundary.

### Modified Capabilities

None.

## Impact

Frontend source modules only. Existing table concept suites remain production-path behavioral oracles.
