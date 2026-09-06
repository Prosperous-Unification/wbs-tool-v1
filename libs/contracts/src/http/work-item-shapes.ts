import { type Type, type } from 'arktype';

import { defineEndpointShape } from './endpoint-shape';
import { planCommandsBody } from './plan-command-shapes';
import type { ParserRefusalCode, PlanCommandKind } from './refusal';
import { requestSchema, responseSchema } from './schema-shape';
import { workItemTree } from './work-item-response';

const commandKinds = {
  createWorkItem: true,
  patchWorkItem: true,
  moveWorkItem: true,
  duplicateWorkItem: true,
  deleteWorkItem: true,
  setEstimate: true,
  clearEstimate: true,
  setActual: true,
  clearActual: true,
  setProgress: true,
  clearProgress: true,
  setMeasure: true,
  clearMeasure: true,
  setAssignee: true,
  addDependency: true,
  removeDependency: true,
  freezeProject: true,
  unfreezeProject: true,
  unfreezeWorkItem: true,
  setCapacity: true,
  setPriorityBands: true,
  createTeam: true,
  patchTeam: true,
  deleteTeam: true,
  createPerson: true,
  patchPerson: true,
  deletePerson: true,
  createTag: true,
  patchTag: true,
  deleteTag: true,
  createWorkItemType: true,
  patchWorkItemType: true,
  deleteWorkItemType: true,
  createService: true,
  patchService: true,
  deleteService: true,
} satisfies Record<PlanCommandKind, true>;
// Object.keys is bounded by this owned exhaustive literal vocabulary.
const commandKindsType = type.enumerated(
  ...(Object.keys(commandKinds) as (keyof typeof commandKinds)[]),
);
const parserArms = {
  expected_object: type({ error: "'expected_object'", at: 'number', kind: commandKindsType }),
  number_is_derived: type({ error: "'number_is_derived'", at: 'number', kind: commandKindsType }),
  externalRefs_must_be_a_list: type({
    error: "'externalRefs_must_be_a_list'",
    at: 'number',
    kind: commandKindsType,
  }),
  too_many_externalRefs: type({
    error: "'too_many_externalRefs'",
    at: 'number',
    kind: commandKindsType,
  }),
  externalRefs_entry_needs_a_systemId: type({
    error: "'externalRefs_entry_needs_a_systemId'",
    at: 'number',
    kind: commandKindsType,
  }),
  externalRefs_entry_needs_a_url: type({
    error: "'externalRefs_entry_needs_a_url'",
    at: 'number',
    kind: commandKindsType,
  }),
  invalid_actual: type({ error: "'invalid_actual'", at: 'number', kind: commandKindsType }),
  invalid_measure: type({ error: "'invalid_measure'", at: 'number', kind: commandKindsType }),
  invalid_progress: type({ error: "'invalid_progress'", at: 'number', kind: commandKindsType }),
  invalid_estimate: type({ error: "'invalid_estimate'", at: 'number', kind: commandKindsType }),
  cannot_send_both_teamIds_and_serviceTeamId: type({
    error: "'cannot_send_both_teamIds_and_serviceTeamId'",
    at: 'number',
    kind: commandKindsType,
  }),
  unknown_kind: type({ error: "'unknown_kind'", at: 'number', kind: commandKindsType }),
  unknown_strategy: type({ error: "'unknown_strategy'", at: 'number', kind: commandKindsType }),
  commands_must_be_a_list: type({
    error: "'commands_must_be_a_list'",
    at: 'number',
    kind: commandKindsType,
  }),
  size_required: type({ error: "'size_required'", at: 'number', kind: commandKindsType }),
  bands_required: type({ error: "'bands_required'", at: 'number', kind: commandKindsType }),
  bands_must_be_an_array: type({
    error: "'bands_must_be_an_array'",
    at: 'number',
    kind: commandKindsType,
  }),
  bands_must_number_5: type({
    error: "'bands_must_number_5'",
    at: 'number',
    kind: commandKindsType,
  }),
  bands_must_be_objects: type({
    error: "'bands_must_be_objects'",
    at: 'number',
    kind: commandKindsType,
  }),
  band_start_must_be_a_whole_number_from_1: type({
    error: "'band_start_must_be_a_whole_number_from_1'",
    at: 'number',
    kind: commandKindsType,
  }),
  band_default_must_be_a_whole_number_from_1: type({
    error: "'band_default_must_be_a_whole_number_from_1'",
    at: 'number',
    kind: commandKindsType,
  }),
  band_label_must_be_1_to_40_characters: type({
    error: "'band_label_must_be_1_to_40_characters'",
    at: 'number',
    kind: commandKindsType,
  }),
  band_labels_must_differ: type({
    error: "'band_labels_must_differ'",
    at: 'number',
    kind: commandKindsType,
  }),
  first_band_must_start_at_1: type({
    error: "'first_band_must_start_at_1'",
    at: 'number',
    kind: commandKindsType,
  }),
  bands_must_start_in_increasing_order: type({
    error: "'bands_must_start_in_increasing_order'",
    at: 'number',
    kind: commandKindsType,
  }),
  band_default_must_be_inside_its_own_band: type({
    error: "'band_default_must_be_inside_its_own_band'",
    at: 'number',
    kind: commandKindsType,
  }),
  parentId_must_be_id_or_null: type({
    error: "'parentId_must_be_id_or_null'",
    at: 'number',
    kind: commandKindsType,
  }),
  afterId_must_be_id_or_null: type({
    error: "'afterId_must_be_id_or_null'",
    at: 'number',
    kind: commandKindsType,
  }),
  personId_must_be_id_or_null: type({
    error: "'personId_must_be_id_or_null'",
    at: 'number',
    kind: commandKindsType,
  }),
  serviceTeamId_must_be_id_or_null: type({
    error: "'serviceTeamId_must_be_id_or_null'",
    at: 'number',
    kind: commandKindsType,
  }),
  name_must_be_text: type({ error: "'name_must_be_text'", at: 'number', kind: commandKindsType }),
  notes_must_be_text: type({ error: "'notes_must_be_text'", at: 'number', kind: commandKindsType }),
  kind_must_be_text: type({ error: "'kind_must_be_text'", at: 'number', kind: commandKindsType }),
  startNoEarlierThanReason_must_be_text: type({
    error: "'startNoEarlierThanReason_must_be_text'",
    at: 'number',
    kind: commandKindsType,
  }),
  stepId_must_be_text: type({
    error: "'stepId_must_be_text'",
    at: 'number',
    kind: commandKindsType,
  }),
  metric_must_be_text: type({
    error: "'metric_must_be_text'",
    at: 'number',
    kind: commandKindsType,
  }),
  personId_must_be_an_id: type({
    error: "'personId_must_be_an_id'",
    at: 'number',
    kind: commandKindsType,
  }),
  workItemId_must_be_an_id: type({
    error: "'workItemId_must_be_an_id'",
    at: 'number',
    kind: commandKindsType,
  }),
  workItemRef_must_be_an_id: type({
    error: "'workItemRef_must_be_an_id'",
    at: 'number',
    kind: commandKindsType,
  }),
  ref_must_be_an_id: type({ error: "'ref_must_be_an_id'", at: 'number', kind: commandKindsType }),
  parentRef_must_be_an_id: type({
    error: "'parentRef_must_be_an_id'",
    at: 'number',
    kind: commandKindsType,
  }),
  afterRef_must_be_an_id: type({
    error: "'afterRef_must_be_an_id'",
    at: 'number',
    kind: commandKindsType,
  }),
  personRef_must_be_an_id: type({
    error: "'personRef_must_be_an_id'",
    at: 'number',
    kind: commandKindsType,
  }),
  predecessorId_must_be_an_id: type({
    error: "'predecessorId_must_be_an_id'",
    at: 'number',
    kind: commandKindsType,
  }),
  predecessorRef_must_be_an_id: type({
    error: "'predecessorRef_must_be_an_id'",
    at: 'number',
    kind: commandKindsType,
  }),
  teamId_must_be_an_id: type({
    error: "'teamId_must_be_an_id'",
    at: 'number',
    kind: commandKindsType,
  }),
  teamRef_must_be_an_id: type({
    error: "'teamRef_must_be_an_id'",
    at: 'number',
    kind: commandKindsType,
  }),
  tagId_must_be_an_id: type({
    error: "'tagId_must_be_an_id'",
    at: 'number',
    kind: commandKindsType,
  }),
  tagRef_must_be_an_id: type({
    error: "'tagRef_must_be_an_id'",
    at: 'number',
    kind: commandKindsType,
  }),
  typeId_must_be_an_id: type({
    error: "'typeId_must_be_an_id'",
    at: 'number',
    kind: commandKindsType,
  }),
  typeRef_must_be_an_id: type({
    error: "'typeRef_must_be_an_id'",
    at: 'number',
    kind: commandKindsType,
  }),
  serviceId_must_be_an_id: type({
    error: "'serviceId_must_be_an_id'",
    at: 'number',
    kind: commandKindsType,
  }),
  serviceRef_must_be_an_id: type({
    error: "'serviceRef_must_be_an_id'",
    at: 'number',
    kind: commandKindsType,
  }),
  teamIds_must_be_a_list_of_ids: type({
    error: "'teamIds_must_be_a_list_of_ids'",
    at: 'number',
    kind: commandKindsType,
  }),
  teamRefs_must_be_a_list_of_ids: type({
    error: "'teamRefs_must_be_a_list_of_ids'",
    at: 'number',
    kind: commandKindsType,
  }),
  tagIds_must_be_a_list_of_ids: type({
    error: "'tagIds_must_be_a_list_of_ids'",
    at: 'number',
    kind: commandKindsType,
  }),
  tagRefs_must_be_a_list_of_ids: type({
    error: "'tagRefs_must_be_a_list_of_ids'",
    at: 'number',
    kind: commandKindsType,
  }),
  serviceIds_must_be_a_list_of_ids: type({
    error: "'serviceIds_must_be_a_list_of_ids'",
    at: 'number',
    kind: commandKindsType,
  }),
  serviceRefs_must_be_a_list_of_ids: type({
    error: "'serviceRefs_must_be_a_list_of_ids'",
    at: 'number',
    kind: commandKindsType,
  }),
  typeIds_must_be_a_list_of_ids: type({
    error: "'typeIds_must_be_a_list_of_ids'",
    at: 'number',
    kind: commandKindsType,
  }),
  typeRefs_must_be_a_list_of_ids: type({
    error: "'typeRefs_must_be_a_list_of_ids'",
    at: 'number',
    kind: commandKindsType,
  }),
  teamIds_must_be_at_most_10: type({
    error: "'teamIds_must_be_at_most_10'",
    at: 'number',
    kind: commandKindsType,
  }),
  teamRefs_must_be_at_most_10: type({
    error: "'teamRefs_must_be_at_most_10'",
    at: 'number',
    kind: commandKindsType,
  }),
  serviceIds_must_be_at_most_10: type({
    error: "'serviceIds_must_be_at_most_10'",
    at: 'number',
    kind: commandKindsType,
  }),
  serviceRefs_must_be_at_most_10: type({
    error: "'serviceRefs_must_be_at_most_10'",
    at: 'number',
    kind: commandKindsType,
  }),
  typeIds_must_be_at_most_10: type({
    error: "'typeIds_must_be_at_most_10'",
    at: 'number',
    kind: commandKindsType,
  }),
  typeRefs_must_be_at_most_10: type({
    error: "'typeRefs_must_be_at_most_10'",
    at: 'number',
    kind: commandKindsType,
  }),
  tagIds_must_be_at_most_50: type({
    error: "'tagIds_must_be_at_most_50'",
    at: 'number',
    kind: commandKindsType,
  }),
  tagRefs_must_be_at_most_50: type({
    error: "'tagRefs_must_be_at_most_50'",
    at: 'number',
    kind: commandKindsType,
  }),
  startNoEarlierThan_must_be_a_date: type({
    error: "'startNoEarlierThan_must_be_a_date'",
    at: 'number',
    kind: commandKindsType,
  }),
  deadline_must_be_a_date: type({
    error: "'deadline_must_be_a_date'",
    at: 'number',
    kind: commandKindsType,
  }),
  priority_must_be_a_whole_number_from_1: type({
    error: "'priority_must_be_a_whole_number_from_1'",
    at: 'number',
    kind: commandKindsType,
  }),
  maxParallel_must_be_a_whole_number_from_1: type({
    error: "'maxParallel_must_be_a_whole_number_from_1'",
    at: 'number',
    kind: commandKindsType,
  }),
  size_must_be_a_whole_number_from_1: type({
    error: "'size_must_be_a_whole_number_from_1'",
    at: 'number',
    kind: commandKindsType,
  }),
  maxParallel_must_be_at_most_1000: type({
    error: "'maxParallel_must_be_at_most_1000'",
    at: 'number',
    kind: commandKindsType,
  }),
  size_must_be_at_most_1000: type({
    error: "'size_must_be_at_most_1000'",
    at: 'number',
    kind: commandKindsType,
  }),
  cascade_must_be_true_or_false: type({
    error: "'cascade_must_be_true_or_false'",
    at: 'number',
    kind: commandKindsType,
  }),
  startNoEarlierThanReason_must_be_at_most_200_characters: type({
    error: "'startNoEarlierThanReason_must_be_at_most_200_characters'",
    at: 'number',
    kind: commandKindsType,
  }),
} satisfies Record<ParserRefusalCode, Type>;
/** Validates the finite legacy parser vocabulary before any string becomes a wire refusal. */
// Proof: removing forbidden context fields admitted at:text,400 instead of500 in the mounted parser-refusal case.
export const commandParserRefusal = responseSchema(
  type.or(
    ...Object.values(parserArms),
    type({ error: "'expected_object'", 'at?': 'never', 'kind?': 'never' }),
    type({ error: "'commands_must_be_a_list'", 'at?': 'never', 'kind?': 'never' }),
    type({ error: "'invalid_estimate'", 'at?': 'never', 'kind?': 'never' }),
    type({ error: "'expected_object'", at: 'number', 'kind?': 'never' }),
    type({ error: "'unknown_kind'", at: 'number', 'kind?': 'never' }),
  ),
);
const context = { at: 'number', kind: commandKindsType } as const;
const named = type({ id: 'string', name: 'string' });
const effect = type({ kind: "'assignment_dropped'", step: named })
  .or({ kind: "'label_nulled'" })
  .or({ kind: "'label_removed'" })
  .or({ kind: "'capacity_released'", size: 'number', fromId: 'string' })
  .or({
    kind: "'assumed_assignee_changed'",
    assumedNow: 'string | null',
    assumedAfter: 'string | null',
  });
const usage = type({
  projects: type({
    id: 'string',
    name: 'string',
    workItems: type({
      id: 'string',
      number: 'string',
      name: 'string',
      effects: effect.array(),
    }).array(),
  }).array(),
  members: named.array(),
});
/**
 * The wire omits the producer kind. Known fields are reserved across variants;
 * unknown additive fields remain readable. The binding checks producer-specific
 * required fields before erasing its internal kind. An untagged client cannot
 * infer that a missing membership belongs to a patch response.
 */
const appliedResults = type({
  results: type({
    index: 'number',
    'id?': 'string',
    'ref?': 'string',
    // Proof: widening known kind/serviceIds admitted malformed fields on createTeam,200 instead of500 in the mounted results case.
    'entity?': {
      id: 'string',
      name: 'string',
      'kind?': "'person' | 'agent'",
      'serviceIds?': 'string[]',
      'teamIds?': 'string[]',
    },
  }).array(),
});
export const commandResults = responseSchema(appliedResults);
const readPolicies = [{ kind: 'identity', require: 'signed-in' }] as const;
// Proof: removing origin or weakening write scope reached malformed JSON,400 instead of403 in the mounted policy cases.
const writePolicies = [
  { kind: 'origin', when: 'always-unsafe-with-session-cookie' },
  { kind: 'identity', require: 'write-scope' },
] as const;
const params = requestSchema(type({ id: 'string' }));
const genericRefusals = [
  {
    status: 400,
    schema: responseSchema(
      type({ error: "'invalid_params' | 'invalid_query' | 'invalid_body' | 'invalid_json'" }),
    ),
  },
  { status: 401, schema: responseSchema(type({ error: "'unauthenticated'" })) },
] as const;
const writeRefusals = [
  ...genericRefusals,
  {
    status: 403,
    schema: responseSchema(type({ error: "'invalid_origin' | 'insufficient_scope'" })),
  },
] as const;
const batchRefusals = [
  ...writeRefusals,
  { status: 400, schema: commandParserRefusal },
  {
    status: 400,
    schema: responseSchema(
      type.or(
        type({ ...context, error: "'too_many_commands'" }),
        type({ ...context, error: "'project_required'" }),
        type({ ...context, error: "'unknown_ref'" }),
        type({ ...context, error: "'missing_id'" }),
        type({ ...context, error: "'duplicate_ref'" }),
        type({ ...context, error: "'name_required'" }),
        type({ ...context, error: "'strategy_required'" }),
        type({ ...context, error: "'has_children'" }),
        type({ ...context, error: "'not_before_reason_needs_a_date'" }),
        type({ ...context, error: "'invalid_kind'" }),
        type({ ...context, error: "'nothing_to_change'" }),
      ),
    ),
  },
  { status: 403, schema: responseSchema(type({ ...context, error: "'forbidden'" })) },
  {
    status: 404,
    schema: responseSchema(
      type.or(
        type({ ...context, error: "'not_found'" }),
        type({ ...context, error: "'unknown_step'" }),
        type({ ...context, error: "'unknown_metric'" }),
        type({ ...context, error: "'unknown_person'" }),
        type({ ...context, error: "'unknown_team'" }),
        type({ ...context, error: "'unknown_tag'" }),
        type({ ...context, error: "'unknown_service'" }),
        type({ ...context, error: "'unknown_type'" }),
        type({ ...context, error: "'unknown_system'" }),
      ),
    ),
  },
  {
    status: 409,
    schema: responseSchema(
      type.or(
        type({ ...context, error: "'cycle'" }),
        type({ ...context, error: "'frozen'" }),
        type({ ...context, error: "'rolled_up'" }),
        type({ ...context, error: "'ancestor'" }),
        type({ ...context, error: "'too_large'" }),
      ),
    ),
  },
  { status: 409, schema: responseSchema(type({ ...context, error: "'taken'", name: 'string' })) },
  { status: 409, schema: responseSchema(type({ ...context, error: "'in_use'", usage })) },
  {
    status: 422,
    schema: responseSchema(
      type({
        ...context,
        error: "'deadline_before_project_start'",
        workItemId: 'string',
        projectDayZero: 'string',
      }),
    ),
  },
] as const;

/** Reads the complete tree and this account's conditional undo state. */
export const getWorkItems = defineEndpointShape({
  method: 'GET',
  path: '/api/projects/:id/work-items',
  operationId: 'getApiProjectsByIdWork-items',
  policies: readPolicies,
  params,
  responses: [
    {
      kind: 'json',
      status: 200,
      schema: responseSchema(workItemTree.and({ undoable: 'boolean', redoable: 'boolean' })),
    },
  ],
  refusals: [
    ...genericRefusals,
    { status: 404, schema: responseSchema(type({ error: "'not_found'" })) },
  ],
  document: { summary: 'Read the project work-item tree.' },
});

/** Applies all 36 command kinds atomically; semantic parsing precedes the 200-command cap. */
export const applyProjectCommands = defineEndpointShape({
  method: 'POST',
  path: '/api/projects/:id/commands',
  operationId: 'postApiProjectsByIdCommands',
  policies: writePolicies,
  params,
  body: planCommandsBody,
  responses: [
    {
      kind: 'json',
      status: 200,
      schema: responseSchema(appliedResults.and({ undoable: 'boolean', redoable: 'boolean' })),
    },
  ],
  refusals: batchRefusals,
  document: { summary: 'Apply a batch of commands to a project, all or none.' },
});

/** Directory requests retain plan kinds so project_required keeps its command index. */
export const applyDirectoryCommands = defineEndpointShape({
  method: 'POST',
  path: '/api/directory/commands',
  operationId: 'postApiDirectoryCommands',
  policies: writePolicies,
  body: planCommandsBody,
  responses: [{ kind: 'json', status: 200, schema: commandResults }],
  refusals: batchRefusals,
  document: { summary: 'Apply a batch of directory commands, all or none.' },
});
const undoResponses = [
  {
    kind: 'json',
    status: 200,
    schema: responseSchema(type({ done: 'string', detail: 'string | null' })),
  },
] as const;
const undoRefusals = [
  ...writeRefusals,
  { status: 403, schema: responseSchema(type({ error: "'forbidden'" })) },
  { status: 404, schema: responseSchema(type({ error: "'not_found'" })) },
  {
    status: 409,
    schema: responseSchema(
      type({ error: "'nothing_to_undo' | 'stale_undo'", detail: 'string | null' }),
    ),
  },
] as const;
/** Reverses this account's last unchanged project batch. */
export const undoProject = defineEndpointShape({
  method: 'POST',
  path: '/api/projects/:id/undo',
  operationId: 'postApiProjectsByIdUndo',
  policies: writePolicies,
  params,
  responses: undoResponses,
  refusals: undoRefusals,
  document: { summary: 'Undo a project batch.' },
});
/** Reapplies this account's last reversed project batch. */
export const redoProject = defineEndpointShape({
  method: 'POST',
  path: '/api/projects/:id/redo',
  operationId: 'postApiProjectsByIdRedo',
  policies: writePolicies,
  params,
  responses: undoResponses,
  refusals: undoRefusals,
  document: { summary: 'Redo a project batch.' },
});
