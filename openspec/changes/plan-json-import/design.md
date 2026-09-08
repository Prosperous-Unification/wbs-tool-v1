## Context

Approved on 2026-09-02; implementation remains unstarted. This 2026-09-08 handoff reconciles the artifacts with working HEAD `339708fa` and the planned core extraction. HTTP Wave 1 replaced TypeBox/Elysia-generated OpenAPI with ArkType SchemaShape, typed binders, documentFromShapes and generated clients. Wave 2 replaced TransactionRunner/OuterTransaction with UnitOfWork and explicit Scope. The JSON export's actual row key is workItems, not rows.

The live tree's estimates, actuals, progress and measures are roll-ups on parents. A blind SubtreeCopy of every exported row would store those derived aggregates as facts. The file remains the additive existing export; its import must identify leaves from the parent graph and discard parent aggregates.

## Goals / Non-Goals

Restore authored project inputs to a new project and preserve the current export's readable fields. No merge, replacement, undo, preview, raw audit restore, derived schedule restore or global directory overwrite. [ADR 0013](../../../docs/adr/0013-an-import-is-its-own-route-not-a-command-batch.md) remains authoritative.

## Decisions

### File and boundary

Create `libs/contracts/src/http/plan-document-shapes.ts`. `PlanDocument` is the existing JSON export plus:

- document: format wbs-plan, version 1, exportedAt as an ISO UTC string.
- settings: name, restricted, estimateMethod, depReach, pertWeights, estimateRounding, startDate, solutionRef, optimizationEnabled, scheduleEngine, scheduleObjective.
- capacity: ordered entries {teamId, size}; priorityBands retains its existing shape.
- calendarMarkers: authored date/name/color plus file-local id.
- directory: teams {id,name,serviceIds}, people {id,name,kind,teamIds}, tags/services/types/externalSystems {id,name}.

Export the transitive directory closure: explicit row labels/assignments/refs and capacity teams, then assigned people's team memberships and those teams' owned services. An unrelated entry remains excluded. Required missing references encountered by the exporter throw; they do not become unnamed defaults.

Keep project, workItems, steps, slices, seq and existing projection fields unchanged. settings is built from the same project value used in the existing response. Rows use the actual workItems key throughout diagnostics: workItems[12].dependsOn[0]. This corrects the old path examples, not the document structure.

The import request is a deliberately tolerant archival boundary, implemented with the existing `requestSchema(declaration, { undeclaredKeys: 'delete' })` projection, rather than weakening other requests. Writable settings and row fields are declared explicitly. Derived number, rolledUp, state, finalDays/finalTotal, schedule, dates, doesEveryStep, slices, optimization runtime output, seq and audit fields are projected away. Preserve frozenNumber as authored freeze state.

For the four step-value maps, the initial wire declaration accepts opaque values. After validating hierarchy, `prepareImport` validates those maps with the shared typed value shapes ONLY on leaves computed from parentId; parent maps are discarded without interpreting their contents. Explicit assignees remain assignments on every allowed row; doesEveryStep never creates assignments. Do not infer leafhood from rolledUp.

Version is structurally an integer so the endpoint can answer 400 unsupported_version before interpreting unsupported content. A format/version-first classifier in the binding recognizes the header on invalid versioned payloads; malformed headers answer invalid_body. Recognized version 1 then undergoes full writable projection. Request failure issues are converted through `classifyRequestFailure` to 400 invalid_body with the first stable document path, using the existing Standard Schema issues; do not introduce another HTTP parser or validator.

### Pure preparation

`libs/core/src/service/prepare-import.ts` returns a discriminated `ImportPreparation`: ready with `PreparedImport`, or refused with code/path/detail. It resolves all file-local ids before UnitOfWork.run: duplicate ids per entity kind, duplicate trimmed directory names within a kind, unknown parent/step/person/team/tag/service/type/system/dependency, self-parent, hierarchy cycles, duplicate sibling positions, illegal dependency cycles, invalid dates/priority/bands/capacity/step values and deadline before project start. Use existing domain parsers and planners. Dependencies are checked against the whole supplied hierarchy/edge set, not input order. Return the first fault in document field/array order.

PreparedImport contains typed authored rows, leaf values, explicit assignments, typed edges, settings, markers, and file-id indexes. File ids are refs, never database identifiers. Every nullable/omitted field follows its current writable domain contract. A malformed document opens no unit of work and mints no ids.

### One admitted import

`libs/core/src/service/import.service.ts` exposes `ImportService.import(document, actorId)`. After pure preparation, verify configured scheduler capability if the document requests enabled optimized scheduling; an unavailable selected engine returns the scheduler port's modeled refusal before writes. Disabled optimization can retain its recorded engine/objective without requiring a solver.

Inside UnitOfWork.run(scope), make one collector and compose services over that scope; never call public route graphs that reacquire the gate. Read existing directory names and solution-slug occupancy inside the admitted scope. Resolve/create services first, then teams, then people, with tags/types/externalSystems in their independent groups. Match trimmed names case-sensitively. Reuse existing entries unchanged; for newly created teams/people restore their service ownership/memberships/kind. File duplicates with conflicting definitions were already refused by preparation.

Existing entries' metadata is authoritative: import does not rewrite an existing person's kind/memberships or a team's ownership to match another deployment. This is the necessary bounded reading of approved name reuse. Round-trip equality is asserted against a compatible directory, and an existing-entry test separately proves no global overwrite.

Create project and its exact ordered steps through ProjectStore.create(project, steps, stamp), not ProjectService.create's Dev/QA defaults. Mint new ids for project, steps, rows, dependencies, external refs and markers. Build one SubtreeCopy with raw authored rows, leaf estimates/actuals/progress/measures, assignments and edges; its dependency inserts come after both endpoints. Preserve own label sets, not inherited effective labels. Apply labels/external refs through scoped stores after rows. Set bands, capacity and markers using the same stamp/actor where their contract accepts one. Revisions start as new rows, not imported values; recorded/stated timestamps are the import instant.

The solution ref is kept only when its slug is free under the same admission; otherwise write null and answer left-off. This is the approved visible degradation. Unexpected source errors roll back and rethrow; modeled source refusals return commit:false. No journal or plan-history row is created. Send collected directory/project/tree announcements after commit, after the gate is released; a refusal or throw sends none.

Answer 201 with {projectId, rows, created:{teams,people,tags,services,types,externalSystems}, solutionRef:'kept'|'left-off'|'none'}. Lists contain created names, including empty lists. Add endpoint shape `postApiProjectsImport` with cookie-origin plus write-scope policies, JSON media type, typed success/refusals and a real bound handler. Shape and mounted route bijection tests cover it. No hardcoded MCP tool-count target or committed openapi.json update.

### UI

Use the existing generated project client through ProjectApi's narrow facade. Plan toolbar summary becomes Export / Import; Download JSON fetches the complete server document and uses planFileName, ignoring collapsed/search state. Import JSON opens a hidden application/json file input. Cancellation is a no-op; read/JSON/HTTP failures produce one error toast and keep the current project. Success calls the same onOpenProject path used by the picker and produces one info toast from the complete typed summary. Reset the input after an attempt so selecting the same file again acts again. Disable repeat submission while that file is in flight.

## File Map and Migration Plan

After core extraction: `libs/core/src/{http/import.routes.ts,service/import.service.ts,service/prepare-import.ts,service/plan-document.ts,compose.ts}`; existing core `http/project.routes.ts`; contracts document/endpoint/refusal declarations; source kits and store methods only where needed by the existing ports; be-01 mount/bijection tests. Frontend `lib/wbs-api.ts`, `components/wbs/{plan-toolbar.tsx,wbs-table.tsx,plan-refusal.ts}` and project page's existing open callback; mcp generated-tool tests; `e2e/plan-import.spec.ts`.

Land after the core/scheduler-port contracts settle. This import does not need WorkingPlan: it constructs one complete import from PreparedImport and persists it once. No schema migration. Re-read the export response shape at implementation start to carry any additional authored fields introduced by the scheduler feature; never restore optimizer caches/jobs or change pending-solve behavior.

## Risks / Trade-offs

The export historically has no cross-request isolation guarantee; this packet preserves that contract, but directory refs must be resolvable. A separate snapshot-consistent export is outside this change. Import holds the write gate for large plans: measure preparation time and admitted time separately at 500 rows, with a queued ordinary write proving release after settlement. The HTTP server's existing body limit remains; no arbitrary 200-command limit applies.

## Open Questions

None. Current runtime-added authored fields, adapter capabilities, timings and all failure proofs remain implementation verification tasks.
