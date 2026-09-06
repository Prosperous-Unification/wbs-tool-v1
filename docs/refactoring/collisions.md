# Refactoring collision inventory

Inspected at base `f89ebf56`, 2026-09-06. Recheck before each migration wave and
again when importing feature commits. This is a code/history inventory, not a
live tracker status report; no tracker connector is available in this session.

| Work                   | Observed state                                               | Shared surface / treatment                                                                                                              |
| ---------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| TASK-262 / #211        | Framework-free Route arrays and two binders landed           | Evolve existing route/binder code into typed shapes. `http/body-doc.ts` replaced the old hand-parsed-body path.                         |
| TASK-219 / #203        | Dual scheduler landed at `2c839252`                          | Preserve durable event recording and post-commit publication in UoW work.                                                               |
| TASK-260 / #215        | Work-item read order contract landed at `ea516647`           | Preserve ordering throughout store changes.                                                                                             |
| TASK-261 / #210        | Generated scheduler corpus landed                            | Retain corpus in scheduler conformance and extraction gates.                                                                            |
| plan-json-import       | Approved artifacts; implementation not found at base         | Route/body, transaction, FE client/export and MCP overlaps. Feature remains separately owned; integrate its commits before final gates. |
| gantt-calendar-markers | Open artifacts; completion cannot be inferred from boxes     | Schema, endpoint and client overlap; refresh inventory before changing those surfaces.                                                  |
| retired-schema-cleanup | Compatibility work recorded; later destructive work separate | Preserve insertSubtree compatibility; do not execute unrelated destructive cleanup.                                                     |
| TASK-241 / TASK-220    | Deadline feature remains pending in recorded scheduler cases | Carry feature changes when landed; do not introduce the feature as extraction work.                                                     |

## Worker ownership

Frontend W4-4 owns table modules and its tests. R2/R6 owns directory repositories,
DirectoryStore declarations, directory fixtures and work-item service query
callers. R3/R5 owns auth service, login throttle, auth routes and tests. Shared
composition changes require an explicit handoff. Gateway and replay work receive
new owners after a worker finishes; no concurrent writers to those interfaces.

## Before measurement

Freeze tracked files for a broad gate. Reconcile main by commits and actual
content, not stale task counts. Run the final gate on the tree containing both
feature and refactor changes: a pre-merge pass proves neither their composition
nor the resolved conflicts.
