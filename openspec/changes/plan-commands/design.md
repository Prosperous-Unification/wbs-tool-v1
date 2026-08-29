## Context

be-01 writes are ~25 single routes over `WorkItemService` (`work-item.service.ts`)
and `DirectoryService`. Every service method reads context, guards, awaits one or
more store calls (each store call is its own SQLite transaction), announces to
the gateway, then `record`s **one** journal entry (`payload {label, forward}`,
`inverse`, preconditions) and one `plan_event`. `CompensatingCommand` is a flat
union of 16 single kinds; `apply` handles exactly one. mcp-01 derives one tool
per route from `openapi.json` (mcp-server D4/D5) and forwards the caller's
token. fe-01 talks to the routes through `wbs-api.ts`'s `ProjectApi` /
`DirectoryApi` (33 write call sites behind ~52 methods).

Measured 2026-08-29 (`bun:sqlite` 1.3.14 + drizzle): a store's `db.transaction`
opened while a manual `BEGIN IMMEDIATE` is held becomes a savepoint; an inner
throw rolls back only that savepoint; the outer `ROLLBACK` discards every step.
[ADR 0007](../../../docs/adr/0007-a-command-batch-is-an-outer-transaction-over-the-stores-own.md)
records the choice this made possible.

## Goals / Non-Goals

**Goals:** one write shape for API, MCP and browser; all-or-none; one undo per
batch; refs across steps; ~12 MCP tools; fe-01 unchanged above `wbs-api.ts`;
single-item routes gone.

**Non-Goals:** directory undo; partial application; streaming; schema changes;
more than one database connection.

## Decisions

### D1 — the batch is a list of typed commands, not a list of HTTP calls

`{ commands: Command[] }`, ≤ 200. Each command is `{ kind, ...fields }` where
the fields are exactly today's route body plus the ids the route carried in its
path, and any id field also accepts `<ref>`. `createWorkItem`, `duplicateWorkItem`
and the four directory creates take an optional `ref`. Kinds, one per retired
route: `createWorkItem patchWorkItem moveWorkItem duplicateWorkItem
deleteWorkItem setEstimate clearEstimate setActual clearActual setProgress
clearProgress setMeasure clearMeasure setAssignee addDependency removeDependency
freezeProject unfreezeProject unfreezeWorkItem setCapacity setPriorityBands
createTeam patchTeam deleteTeam createPerson patchPerson deletePerson createTag
patchTag deleteTag createService patchService deleteService`. Undo/redo, project
create/patch/opened and roles stay their own routes: they are not plan edits.

The OpenAPI body is a `oneOf` over the kinds with `description`s — that is the
whole of what mcp-01 shows the model (D5 pass-through). No hand-written schema.

The directory has no project, and the directory page writes without one, so a
second route `POST /api/directory/commands` takes directory kinds alone: same
runner, lock and transaction, nothing journalled, `project_required` for a plan
kind. Two write tools, not one; the browser's `DirectoryApi` uses the second.

### D2 — atomicity by outer transaction, serialised by a write lock

`runBatch` takes the process-wide write lock (an async mutex every be-01 write
handler also takes — `withWriteLock` in `services.ts`), runs `BEGIN IMMEDIATE`
on the connection, then calls the **existing** service methods in order with a
`BatchCollector` installed on the service. Refusal at step _i_ → `ROLLBACK`,
`{ error, at: i, kind }`, status from `statusFor`. Success → compose the journal
entry, `COMMIT`, then broadcast once. The lock is what makes the outer
transaction safe on one shared connection (ADR 0007); it is held for the batch
only, never across a network call.

### D3 — one journal entry, one undo, via a composite compensating command

`CompensatingCommand` gains `{ do: 'batch', steps: CompensatingCommand[] }`.
Forward = the steps' forwards in order; inverse = the steps' inverses **reversed**;
`touched` = union; `before` = the first recording's rows; `apply` runs the steps
in order under the same outer-transaction discipline (so an undo is atomic too);
`touchedBy`/`subjectOf` extended (subject = the first step's). While the collector
is installed, `record` pushes recordings and `announce*` marks the tree dirty
instead of publishing; a batch whose collector holds **one** recording records
that recording itself, so a single command's undo label and history row are what
they are today. A batch that changed nothing records nothing.

Directory commands run inside the transaction (atomic) but produce no recording:
the directory has no journal. The spec states that undoing a batch leaves the
directory entries it made.

### D4 — refs are resolved by the batch runner, not by the services

`refs: Map<string, string>` in the runner; a create's outcome id is stored under
its `ref`; any id-shaped field whose value is a ref name is replaced before the
service call. Unknown ref → refusal `unknown_ref` at that index (400). A ref
reused → `duplicate_ref` (400). Refs are request-local; the response carries
`results: [{ index, ref?, id? }]`.

### D5 — mcp-01 hides the retired routes even before they are gone

`EXCLUDED_PATHS` grows the single-item write routes in phase 1, so the tool set
is right the moment `commands` exists; phase 3 deletes the routes and the
exclusions become no-ops that the document test proves are no longer matching
anything (the exclusion list is asserted against the document: an entry that
excludes nothing fails). `openapi-tools.ts` needs no change: the body is an
object with one `commands` property whose schema is passed through.

### D6 — fe-01 moves under its own API surface

`wbs-api.ts` gets `commands(projectId, list)`; each write method becomes a
one-command batch. The fake API in tests grows the same method and routes each
kind to its existing handler, so every table/card/dialog test runs unchanged.
`phase 3` deletes the single routes, regenerates `openapi.json`, and the
document freshness test plus mcp-01's derivation tests pin the result.

## Risks / Trade-offs

- The write lock serialises all writes: fine for one host and one writer at a
  time; a long batch (200 creates) blocks other writers for its duration. Cap
  at 200 and the lock is held for well under a second on the dev box.
- Broadcast-before-journal (the existing ordering contract) becomes
  journal-inside-transaction, broadcast-after-commit for batches. Clients
  refetch on any message, so the order they observe is unchanged.
- Undo of a big batch touches many rows: `staleness()` checks every touched
  revision, so one edited row since makes the whole batch a `stale_undo`. That
  is the journal contract, stated for batches in the spec.
- Deleting routes is a breaking API change for anything outside this repo. The
  MCP server on dev is the only known consumer and moves in the same deploy.
