## Context

The approved W4-4 row and sweep C define this mechanical extraction. Existing tests are already separated by concept and the live literal is already written once.

## Goals / Non-Goals

Each extracted hook owns one table concern and returns the same values used by composition. Cells continue reading mutable values through a typed live ref. No new behavior or request optimization belongs in this change.

## Decisions

- Preserve hook body logic and memo dependencies while moving it.
- Keep PlanRow and the pointed store unchanged.
- Expose the live contract once and pass it to column factories; the columns memo remains keyed by steps, unfoldedSteps, hiddenColumnIds.
- Keep the existing component suites on WbsTable's production path to verify extracted logic through the real composition.

## Risks / Trade-offs

Moving closed-over state can change callback identity or hook order. Keep stable setters and refs stable, retain explicit dependencies, and run focus-preservation and chart-memo tests before broader verification. Browser geometry is verified only by the coordinated browser gate.
