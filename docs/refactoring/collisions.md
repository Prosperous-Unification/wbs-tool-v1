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
| gantt-calendar-markers | Fetched `4051512c` / #209; integration in progress           | Rehome marker state/read/write lifecycle into W4-4 modules; preserve incoming Gantt/API/tests and new timezone tier.                    |
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

## Feature integration, 2026-09-06

`git fetch origin main` advanced the remote from `f89ebf56` to `a91f831b`.
The three imported commits are calendar markers (`4051512c`), GET-only and
single-state OIDC callback (`39e53dda`), and typed OIDC callback errors
(`a91f831b`). Integration affects 99 feature files. Conflicts are the two auth
integration suites and `wbs-table.tsx`; each side's behavior is retained.
The original main checkout remains untouched.

The marker feature introduced another ADR 0014. Its decision is renumbered 0017
with marker references updated; architecture ADR 0014 and UoW ADR 0015 keep their
existing identities. The endpoint status sketch also needs landed 405 and 501
variants when HTTP Wave 1 begins. Those are completeness corrections preserving
feature behavior, not new refusal semantics.

R1 now includes calendar markers as an independent refresh resource, with its
own pending and installed generation. Marker reads on refused writes and
project departure join the held-response regression matrix. HTTP/store migration
inventories must include the new marker routes, service and store port.
