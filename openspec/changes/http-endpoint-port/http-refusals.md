# HTTP request/refusal inventory — merged checkpoint 362c29a8

Read-only production-source inventory, 2026-09-06. No tests, fault injection, source changes or fresh gate run by this agent. Sources are the merged controller/\*.routes.ts, their parsers, service outcomes, caller guard and app composition. Committed OpenAPI is not used as completeness evidence. This closes the currently emitted finite code families and identifies genuinely untyped wire outcomes; it does not claim an implemented closed union or tested reachability of every service-declared arm.

## Envelope and status rules

Current named refusal shape is `{ error: code, ...routeDetail }`. `RefusalDetail[code]` must be a union when the same code has different route contexts; endpoint-specific schemas must narrow that union. Never require global batch fields, and never accept arbitrary detail bags in the finished contract.

`controller/refusal-status.ts` maps `forbidden`403; `unknown_ref`400; `not_found` and other `unknown_*`404; cycle/frozen/rolled_up/ancestor/too_large/taken/in_use/optimizer_unavailable409; otherwise the caller's default. Defaults: command runtime400, step create/rename422, step delete404, project patch422, marker422, undo/redo409. Parser BadRequest always400, including `unknown_kind` and `unknown_strategy` (NOT404). Thus string-prefix mapping cannot replace per-shape literal pairs.

Shared policies: callerGuard signed-in failure401 unauthenticated; read-scope failure403 insufficient_scope (solution lookup and project export). app onRequest write-scope has the same401/403; OIDC-mode unsafe cookie origin403 invalid_origin. Internal secret failure401 unauthorized. Domain project ownership remains403 forbidden. Unexpected account lookup failures propagate (R3).

## Family inventory

| Operation family                                | Request body/query inputs                                                                                                                                | Existing modeled refusals and details beyond error                                                                                                                                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| POST smoke echo                                 | text:string                                                                                                                                              | 400 freeform ValidationError.message (not a closed code today)                                                                                                                                                                                     |
| POST/PATCH project step                         | name:string; id/stepId path                                                                                                                              | 422 invalid_body/name_required;404 not_found;403 forbidden;409 taken; no details                                                                                                                                                                   |
| DELETE step                                     | cascade query is true only for literal string true                                                                                                       | 404 not_found;403 forbidden;409 in_use + inUse:StepInUse                                                                                                                                                                                           |
| GET project work-items                          | id path                                                                                                                                                  | 404 not_found plus shared identity; success includes undo state                                                                                                                                                                                    |
| POST project commands                           | commands:PlanCommand[] up to200                                                                                                                          | parser400 families below; runner status mapping above; always runtime at:number/kind:PlanCommandKind plus code-specific fields                                                                                                                     |
| POST directory commands                         | same parser, directory kinds only                                                                                                                        | same; project_required400 for a plan kind; no project permission context supplied                                                                                                                                                                  |
| POST undo/redo                                  | id path; no parsed request body                                                                                                                          | 404 not_found/403 forbidden without detail;409 nothing_to_undo/stale_undo with detail:string                                                                                                                                                       | null; internal entryId never emitted                  |
| GET history                                     | optional workItemId/kind query strings                                                                                                                   | 404 not_found; kind unknown to history is empty results, not refusal                                                                                                                                                                               |
| GET solution lookup                             | slug path; read scope                                                                                                                                    | 404 not_found; shared401/403                                                                                                                                                                                                                       |
| POST project                                    | name:string                                                                                                                                              | 422 invalid_body; service create returns a project, not modeled UpdateOutcome                                                                                                                                                                      |
| GET project/list, POST opened                   | id where relevant                                                                                                                                        | GET by id/opened404 not_found; opened success204                                                                                                                                                                                                   |
| GET project export                              | format absent or json                                                                                                                                    | 400 unsupported_format;404 not_found; read-scope401/403                                                                                                                                                                                            |
| PATCH project                                   | name/restricted/estimateMethod/depReach/pertWeights/estimateRounding/startDate/solutionRef/optimizationEnabled/scheduleEngine/scheduleObjective optional | 422 invalid_body, service-declared bad_start_date/bad_pert_weights;404 not_found;403 forbidden;409 optimizer_unavailable; no details                                                                                                               |
| GET directory lists                             | six separate arrays: teams,people,tags,services,workItemTypes,externalSystems                                                                            | shared401; mutations belong to command routes                                                                                                                                                                                                      |
| GET/POST marker collection, PATCH/DELETE marker | id project; markerId path/create optional UUIDv4; create date/name/color?; patch exactly one name/color including null automatic                         | 422 malformed + field:body/markerId/date/name/color;422 contrast + field:color;404 not_found (collection: no field; addressed: field:markerId);409 taken (field:markerId only for an explicit supplied markerId);403 forbidden no field; DELETE204 |
| POST saved plan                                 | optional nonempty name; id project                                                                                                                       | 422 invalid_body;404 not_found;403 forbidden;503 snapshot_busy;409 quota + refusal:Quota                                                                                                                                                           |
| GET saved-plan list                             | id project; no consumed query filters                                                                                                                    | 404 not_found                                                                                                                                                                                                                                      |
| GET saved-plan compare                          | id project; left/right required nonempty strings; live means current, other strings saved IDs                                                            | 422 invalid_query (handler; current Elysia query schema emits framework report first);404 not_found optionally savedPlanId:string;422 corrupt with savedPlanId:string and refusal:Integrity                                                        |
| GET saved plan by id                            | id                                                                                                                                                       | 404 not_found;422 corrupt + refusal:Integrity                                                                                                                                                                                                      |
| PATCH/DELETE saved plan                         | PATCH required nonempty name                                                                                                                             | PATCH422 invalid_body; both403 forbidden/404 not_found/503 snapshot_busy                                                                                                                                                                           |
| Saved-plan wrapper on operations                | stored body version read                                                                                                                                 | 501 unsupported_body_version + savedPlanId:string, body:input                                                                                                                                                                                      | schedule, version:number, supported:readonly number[] |
| POST internal forward/resume                    | existing InternalForwardRequest/InternalResumeRequest schemas; x-internal-auth                                                                           | 401 unauthorized;400 freeform ValidationError.message; unrelated exceptions rethrow                                                                                                                                                                |

Project bad_start_date/bad_pert_weights are service union arms, but current route parsing may reject their malformed inputs earlier as invalid_body. Do not claim both observed reachable without a targeted caller test. Marker list's broad CalendarMarkerRefusal return type admits taken/forbidden even though list implementation only returns not_found; shape should describe real handler branches precisely rather than mechanically exporting the broad service type.

## Runtime command union closure

`service/plan-commands.ts::Refused/BatchRefusal` currently loses type precision as reason:string and detail:Record<string,unknown>. Trace shows these finite sources:

- Runner itself: too_many_commands, project_required, unknown_ref, missing_id, duplicate_ref, name_required.
- WorkItemRefusal: not_found, forbidden, strategy_required, cycle, frozen, rolled_up, has_children, ancestor, too_large, unknown_step, unknown_metric, unknown_person, unknown_team, unknown_tag, unknown_service, unknown_type, unknown_system, not_before_reason_needs_a_date. Current WorkItemOutcome has no extra refusal fields.
- DirectoryRefusal: invalid_kind, name_required, not_found, nothing_to_change, unknown_service, unknown_team. DirectoryOutcome additionally taken with name:string. Removal additionally in_use with usage:DirectoryUsage. Bare taken also exists in a service return union; do not require name on every global taken variant (step and auth also have none).
- CapacityRefusal and PriorityBandRefusal: not_found, forbidden, no detail.

All runtime command failures carry at and kind. The runner's detailOf spreads all outcome fields except ok/reason into its bag; routes spread that bag before error/at/kind. Finite currently carried payloads are name and usage from directory operations. Keep runtime at/kind required in the batch schema; do not confuse parser failures before a recognized command with this arm.

## Parser-code closure (400)

`work-item.routes::refusalFor` catches BadRequest. With no index it emits error only. With index but no recognized kind it emits error+at. With recognized kind it emits error+at+kind. parseCommand wraps BadCapacity, BadLadder and estimate ValidationError with that command context. These are request-boundary branches, not service refusal statuses.

Literal codes: expected_object, number_is_derived, externalRefs_must_be_a_list, too_many_externalRefs, externalRefs_entry_needs_a_systemId, externalRefs_entry_needs_a_url, invalid_actual, invalid_measure, invalid_progress, cannot_send_both_teamIds_and_serviceTeamId, unknown_kind, unknown_strategy, commands_must_be_a_list, invalid_estimate.

Finite interpolated codes, expanded from helper callers (not arbitrary field names):

| Suffix                           | Exact field values                                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| \_must_be_id_or_null             | parentId, afterId, personId, serviceTeamId                                                                                                                                    |
| \_must_be_text                   | name, notes, kind, startNoEarlierThanReason, stepId, metric                                                                                                                   |
| \_must_be_an_id                  | workItemId, workItemRef, ref, parentRef, afterRef, personRef, predecessorId, predecessorRef, teamId, teamRef, personId, tagId, tagRef, typeId, typeRef, serviceId, serviceRef |
| \_must_be_a_list_of_ids          | teamIds, teamRefs, tagIds, tagRefs, serviceIds, serviceRefs, typeIds, typeRefs                                                                                                |
| \_must_be_at_most_10             | teamIds, teamRefs, serviceIds, serviceRefs, typeIds, typeRefs                                                                                                                 |
| \_must_be_at_most_50             | tagIds, tagRefs                                                                                                                                                               |
| \_must_be_a_date                 | startNoEarlierThan                                                                                                                                                            |
| \_must_be_a_whole_number_from_1  | priority, maxParallel                                                                                                                                                         |
| \_must_be_at_most_1000           | maxParallel                                                                                                                                                                   |
| \_must_be_true_or_false          | cascade                                                                                                                                                                       |
| \_must_be_at_most_200_characters | startNoEarlierThanReason                                                                                                                                                      |

Capacity parser: expected_object, size_required, size_must_be_a_whole_number_from_1, size_must_be_at_most_1000.

Priority parser/domain ladder: expected_object, bands_required, bands_must_be_an_array, bands_must_number_5, bands_must_be_objects, band_start_must_be_a_whole_number_from_1, band_default_must_be_a_whole_number_from_1, band_label_must_be_1_to_40_characters, band_labels_must_differ, first_band_must_start_at_1, bands_must_start_in_increasing_order, band_default_must_be_inside_its_own_band.

A replacement strict validator must preserve specific semantic codes (especially number_is_derived) or explicitly record approved envelope changes. The interpolated English-ish parser codes are existing wire literals, not permission to widen RefusalCode to string/template<string>. The current helper field parameters and capacity/ladder reason types should become finite or be translated once at the boundary.

## Detail schemas

- StepInUse: estimates/actuals/progress/measures:number; assumedAssignees:AssumedAssigneeFlip[]. Import-free wire declaration must retain every field of that existing type (source snapshot below).
- DirectoryUsage: projects:Array<{id:string,name:string,workItems:Array<{id:string,number:string,name:string,effects:DirectoryEffect[]}>}>; members:Array<{id:string,name:string}>. Both arrays always present.
- DirectoryEffect discriminated by kind: assignment_dropped with step:{id,name}; label_nulled; label_removed; capacity_released with size:number/fromId:string; assumed_assignee_changed with assumedNow:string|null/assumedAfter:string|null.
- Quota: {limit:body_bytes|plan_count|project_bytes,asked:number,allowed:number}. Wire key is allowed, not prose's limit ambiguity.
- Integrity shared savedPlanId:string, body:input|schedule; reason body_missing adds nothing; body_hash_mismatch adds stored/recomputed:string; schedule_input_mismatch restricts body:schedule and adds scheduleInputSha256/inputSha256:string; input_version_unreadable restricts body:input and adds storedVersion/readerVersion:number, versionReason:from-the-future|no-upgrade-path|not-a-version.
- unsupported_body_version is separate from Integrity: body/version/supported are top-level with error/savedPlanId. Preserve501 rather than collapsing it into corrupt422.
- Global not_found detail is a route union: empty; {savedPlanId:string}; {field:markerId}; runtime batch {at,kind}. Global in_use: {inUse:StepInUse} versus {usage:DirectoryUsage,at,kind}. Global taken: empty (step/register), {field:markerId}, or batch {name:string,at,kind}. Do not loosen these to optional-everything records: endpoint shape schemas must select the applicable variant.

## Authentication mode and callback inventory

Password POST register/login and GET me are always registered. OIDC option adds GET login, GET okta/callback, POST refresh, POST logout; disabled password registration/login still has registered routes returning404 after credentials parsing. Request security checks remain ordered per actual composition.

- Register: credentials shape failure422 invalid_body; disabled mode404 not_found; OIDC origin403 invalid_origin; trusted proxy metadata400 invalid_client; IP throttle429 rate_limited; service taken409 or invalid400. Detail empty.
- Login: shape422 invalid_body; disabled404 not_found; OIDC origin403 invalid_origin; proxy400 invalid_client; reservation exhaustion429 invalid_credentials; wrong credentials401 invalid_credentials. Same error code at two statuses deliberately. R5 reservations are released in finally and retain global/per-account/IP admission.
- Me:401 invalid_token if no resolved identity. Account-store failures stay unexpected, not this arm (R3).
- OIDC GET login:302 Location, binding cookie; no modeled error body currently.
- Callback HEAD:405 method_not_allowed + Allow:GET; no consume/exchange or cookie clear. Registered GET and arrived HEAD must stay distinct.
- Callback any duplicate query key:400 duplicate_parameter before consume and no cookie clear. Raw URL cardinality required; query record already collapsed repeats.
- Incoming d08a6ad6 callback contract (reviewed before integration): missing state/binding or missing/expired consume outcome gives empty400 and clears binding. Live state_mismatch gives the same empty400 without Set-Cookie and leaves the transaction available for the honest callback. Only consumed returns nonce/verifier and spends the record; replay is missing. The planned envelope rewrite must keep the same public refusal body across these outcomes, without exposing state_mismatch as a wire code.
- Valid consumed provider error: nonempty allowlisted error gives302 Location /?auth_error=<reason>, clear binding, no exchange; unknown maps provider_error. Allowed access_denied/account_selection_required/consent_required/interaction_required/login_required/temporarily_unavailable. Redirect is a control reply, not JSON Refusal. Blank error gives empty400 + clear binding.
- Exchange throws: empty401 + clear binding, structured error log. No verified ID-token claims or modeled claim parsing failure: same empty401. Account resolution returning null: empty409 + clear binding. Thrown account resolution remains outside all these catches.
- Refresh: missing correlation/token record or failed atomic rotation gives empty401 + clears session; successful204 resets access cookie. Provider refresh throws currently propagate; do not silently classify them by copying callback's exchange catch.
- Logout: successful204 clears session; modeled missing optional record does not refuse; provider revoke/storage exceptions propagate.

## Health and still-untyped outcomes to map explicitly

Health200 {status:ok,commit:string|null}; health503 {status:migrating|database_unreachable|schema_missing,commit:string|null}. These are status-discriminated health objects, not the planned Refusal envelope. Metrics is text. Smoke/internal400 freeform validator messages and Elysia malformed JSON/query reports likewise have no finite error code today. OIDC empty400/401/409 have no discriminant at all.

Wave1 must choose explicit codes/details for these boundary translations and name changed assertions. Existing source alone cannot supply a nonexistent code; suggested mapping is not landed behavior and must be recorded as such in the implementation artifacts. Preserve status, cookie clearing, transaction timing, health commit metadata and log behavior. Generic invalid_body cannot erase marker field detail or number_is_derived. Unsupported response-schema conversion must fail, not turn semantic predicates into unconstrained documents.

## Limits and verification handoff

Static closure above follows actual runner helpers and service unions, not every runtime branch execution. Some declared service arms are unreachable after route parsing; verify those through the intended handler seam before pruning or publishing them. No new safety check or Proof is claimed. Two guessed source paths were absent during exploration (command-refs.ts and priority-ladder.service.ts); actual reference logic is inline plan-commands.ts and actual service is priority-band.service.ts, both read. No default implementation was substituted.

Next implementation evidence: generate declaration union from the finite families; exact per-endpoint status/detail schemas; compile-negative mismatched pairs; direct handler refusal cases and production app.handle schema failures; preserve R3/R5 and OIDC transaction/cookie negatives. Current OpenAPI does not establish this inventory's completeness.

### Exact AssumedAssigneeFlip source snapshot

```ts
export interface AssumedAssigneeFlip {
  workItemId: string;

  assumedNow: string | null;

  assumedAfter: string | null;
}
```

## Command request arms (merged parseKind)

All arms carry kind; fields below are the fields the current parser reads, before the runner resolves references. `target` means optional workItemId/workItemRef, with missing target refused later as missing_id. `ref` is an optional minted-result name. Step-bearing arms require stepId:string. The current parser eagerly validates target/ref fields even on kinds that discard them; strict per-arm schemas intentionally refuse undeclared fields instead, so exact error precedence needs named wire tests.

| Kinds                                                                  | Fields                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| createWorkItem                                                         | ref?, parentId?:string                                                    | null, parentRef?:string, afterId?:string | null, afterRef?:string, name?:string, notes?:string, priority?:number | null                       |
| patchWorkItem                                                          | target, patch:{name?,notes?,startNoEarlierThan?:date                      | null,startNoEarlierThanReason?:string    | null,priority?:number                                                 | null,serviceTeamId?:string | null,teamIds?,serviceIds?,tagIds?,typeIds?,maxParallel?:number | null,externalRefs?:{systemId:string,url:string}[],serviceRefs?,tagRefs?,typeRefs?,teamRefs?}; each IDs/Refs list string[] |
| moveWorkItem                                                           | target, parentId/parentRef/afterId/afterRef as create                     |
| duplicateWorkItem                                                      | target, ref?                                                              |
| deleteWorkItem                                                         | target, strategy?:cascade                                                 | promote                                  |
| setEstimate                                                            | target, stepId, days:ThreePointEstimate                                   |
| clearEstimate, clearActual, clearProgress                              | target, stepId                                                            |
| setActual                                                              | target, stepId, days:number                                               |
| setProgress                                                            | target, stepId, state:StepState                                           |
| setMeasure                                                             | target, stepId, metric:string, value:number                               |
| clearMeasure                                                           | target, stepId, metric:string                                             |
| setAssignee                                                            | target, stepId, personId?:string                                          | null, personRef?:string                  |
| addDependency, removeDependency                                        | target, predecessorId?:string, predecessorRef?:string                     |
| freezeProject, unfreezeProject                                         | no per-arm fields                                                         |
| unfreezeWorkItem                                                       | target                                                                    |
| setCapacity                                                            | teamId?:string, teamRef?:string, size:number                              | null                                     |
| setPriorityBands                                                       | bands:five {startsAt:number,defaultValue:number,label:string} entries     |
| createTeam, createTag, createService, createWorkItemType               | ref?, name:string                                                         |
| createPerson                                                           | ref?, name:string, teamIds?:string[], teamRefs?:string[]                  |
| patchTeam                                                              | teamId?/teamRef?, patch:{name?:string,serviceIds?:string[]}               |
| patchPerson                                                            | personId?/personRef?, patch:{name?:string,teamIds?:string[],kind?:string} |
| patchTag                                                               | tagId?/tagRef?, name:string                                               |
| patchWorkItemType                                                      | typeId?/typeRef?, name:string                                             |
| patchService                                                           | serviceId?/serviceRef?, name:string                                       |
| deleteTeam, deletePerson, deleteTag, deleteWorkItemType, deleteService | corresponding ID/ref pair, cascade?:boolean                               |

Only directory create/patch/delete kinds are admitted to /api/directory/commands. Body array validation and max200 admission are separate; parser can decorate a failure at an index before runner admission. Preserve optional, explicit null and empty-list distinctions; notably not-before reason normalization and pair validation are semantic behavior, not JSON-schema conversion transforms to introduce silently.
