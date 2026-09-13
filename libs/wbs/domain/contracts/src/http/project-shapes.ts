import { type } from 'arktype';

import { defineEndpointShape } from './endpoint-shape';
import { project, projectWithSteps } from './project-response';
import { engineUnavailableRefusal } from './scheduler-shapes';
import { requestSchema, responseSchema } from './schema-shape';
import { workItemTree } from './work-item-response';

const params = requestSchema(type({ id: 'string' }));
// Proof: removing identity made the mounted unauthenticated project test receive 500 instead of 401.
const readPolicies = [{ kind: 'identity', require: 'signed-in' }] as const;
// Proof: weakening write scope made the mounted opened test receive 404 instead of 403.
// Removing identity made the complete production-route policy test receive 500 instead of 401
// for postApiProjects; removing Origin made it receive 404 instead of 403 for patchApiProjectsById.
const writePolicies = [
  { kind: 'origin', when: 'always-unsafe-with-session-cookie' },
  { kind: 'identity', require: 'write-scope' },
] as const;
const bodyMedia = [
  'application/json',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
] as const;
const readRefusals = [
  {
    status: 400,
    schema: responseSchema(type({ error: "'invalid_body' | 'invalid_query' | 'invalid_params'" })),
  },
  { status: 401, schema: responseSchema(type({ error: "'unauthenticated'" })) },
] as const;
const writeRefusals = [
  { status: 400, schema: responseSchema(type({ error: "'invalid_query' | 'invalid_params'" })) },
  { status: 401, schema: responseSchema(type({ error: "'unauthenticated'" })) },
  {
    status: 403,
    schema: responseSchema(type({ error: "'invalid_origin' | 'insufficient_scope'" })),
  },
] as const;
const bodyRefusals = [
  ...writeRefusals,
  { status: 400, schema: responseSchema(type({ error: "'invalid_json'" })) },
  { status: 422, schema: responseSchema(type({ error: "'invalid_body'" })) },
] as const;
const notFound = { status: 404, schema: responseSchema(type({ error: "'not_found'" })) } as const;

/** Creates a project with its ordered starting steps; empty names remain legal. */
export const createProject = defineEndpointShape({
  method: 'POST',
  path: '/api/projects',
  operationId: 'postApiProjects',
  policies: writePolicies,
  // Proof: a tolerant body made the mounted undeclared-create test receive 200 instead of 422.
  body: requestSchema(type({ name: 'string' })),
  bodyMedia,
  responses: [{ kind: 'json', status: 200, schema: projectWithSteps }],
  refusals: bodyRefusals,
  document: { summary: 'Create a project with its starting steps.' },
});

/** Lists complete project settings in the caller's recency order, with owner display names. */
export const listProjects = defineEndpointShape({
  method: 'GET',
  path: '/api/projects',
  operationId: 'getApiProjects',
  policies: readPolicies,
  responses: [
    {
      kind: 'json',
      status: 200,
      // Proof: optional ownerName or lastOpenedAt made the mounted list-metadata test receive
      // 200 instead of 500; strict reply fields instead rejected its additive fields with 500.
      schema: responseSchema(
        type({
          projects: project.and({ ownerName: 'string', lastOpenedAt: 'number | null' }).array(),
        }),
      ),
    },
  ],
  refusals: readRefusals,
  document: { summary: 'List projects in this account’s own order.' },
});

/** Records the caller's navigation without project write-access restrictions; write scope remains required. */
export const recordProjectOpen = defineEndpointShape({
  method: 'POST',
  path: '/api/projects/:id/opened',
  operationId: 'postApiProjectsByIdOpened',
  policies: writePolicies,
  params,
  responses: [{ kind: 'empty', status: 204 }],
  refusals: [
    ...writeRefusals,
    notFound,
    { status: 400, schema: responseSchema(type({ error: "'invalid_body'" })) },
  ],
  document: { summary: 'Record this account opening a project.' },
});

/** Exports the core tree without account-specific undo flags, as JSON or unquoted Markdown. */
export const exportProject = defineEndpointShape({
  method: 'GET',
  path: '/api/projects/:id/export',
  operationId: 'getApiProjectsByIdExport',
  // Proof: signed-in alone made the mounted export-scope test receive 404 instead of 403.
  policies: [{ kind: 'identity', require: 'read-scope' }],
  params,
  query: requestSchema(type({ format: "'json' | 'markdown'" })),
  responses: [
    // Proof: omitting the core declaration made the mounted deadline-export test admit
    // a row missing deadline: expected 500, received 200.
    { kind: 'json', status: 200, schema: responseSchema(workItemTree.and({ project })) },
    { kind: 'text', status: 200, contentType: 'text/markdown; charset=utf-8' },
  ],
  refusals: [
    ...readRefusals,
    notFound,
    engineUnavailableRefusal,
    { status: 403, schema: responseSchema(type({ error: "'insufficient_scope'" })) },
    { status: 400, schema: responseSchema(type({ error: "'unsupported_format'" })) },
  ],
  document: { summary: 'Export the project WBS and schedule as JSON or Markdown.' },
});

/** Reads project settings and ordered steps without a project ownership restriction. */
export const readProject = defineEndpointShape({
  method: 'GET',
  path: '/api/projects/:id',
  operationId: 'getApiProjectsById',
  policies: readPolicies,
  params,
  responses: [{ kind: 'json', status: 200, schema: projectWithSteps }],
  refusals: [...readRefusals, notFound],
  document: { summary: 'Read a project and its steps.' },
});

/** Structural weight validation leaves the all-zero sum to ProjectService's semantic refusal. */
// Proof: removing the lower bound changed the mounted structural-settings refusal
// from invalid_body to bad_pert_weights. Shared descriptor validation rejects Infinity.
const weight = type('number >= 0');
/** Shape-only date admission preserves the service's bad_start_date for impossible calendar days. */
// Proof: removing the date pattern changed that same test to bad_start_date.
const day = type('string')
  .matching(/^\d{4}-\d{2}-\d{2}$/)
  .or('null');

/** An empty object is a valid patch; omitted fields stay omitted and null clears nullable fields. */
export const patchProject = defineEndpointShape({
  method: 'PATCH',
  path: '/api/projects/:id',
  operationId: 'patchApiProjectsById',
  policies: writePolicies,
  params,
  // Proof: a tolerant patch admitted undeclared fields in the mounted nested-boundary test (422 → 200).
  body: requestSchema(
    type({
      'name?': 'string',
      'restricted?': 'boolean',
      'estimateMethod?': "'pert' | 'optimistic' | 'realistic' | 'pessimistic'",
      'depReach?': "'whole-item' | 'anchor-slice'",
      'pertWeights?': type({ optimistic: weight, realistic: weight, pessimistic: weight }),
      'estimateRounding?': "'exact' | 'floor' | 'round' | 'ceil'",
      'startDate?': day,
      'solutionRef?': type({ slug: 'string > 0', url: 'string > 0' }).or('null'),
      'optimizationEnabled?': 'boolean',
      // Proof: accepting any engine string made the mounted structural-settings test receive 500, not 422.
      'scheduleEngine?': "'fast' | 'optimized'",
      'scheduleObjective?': "'pri' | 'time'",
    }),
  ),
  bodyMedia,
  responses: [{ kind: 'json', status: 200, schema: responseSchema(type({ project })) }],
  refusals: [
    ...bodyRefusals,
    notFound,
    { status: 403, schema: responseSchema(type({ error: "'forbidden'" })) },
    {
      status: 422,
      schema: responseSchema(type({ error: "'bad_start_date' | 'bad_pert_weights'" })),
    },
    { status: 409, schema: responseSchema(type({ error: "'optimizer_unavailable'" })) },
  ],
  document: { summary: 'Update the addressed project’s settings.' },
});

const retryRefusal = responseSchema(
  type({ code: "'stale-input-hash'", currentInputHash: 'string' })
    .or({
      code: "'not-retryable'",
      state: "'ready' | 'pending' | 'retrying' | 'failed' | 'corrupt' | 'plan-infeasible' | 'idle'",
    })
    .or({ code: "'already-running'" }),
);

/** Retries one retained failed or corrupt optimizer variant against the current plan input. */
export const retryProjectOptimization = defineEndpointShape({
  method: 'POST',
  path: '/api/projects/:id/optimization/retry',
  operationId: 'postApiProjectsByIdOptimizationRetry',
  policies: writePolicies,
  params,
  // Proof: widening objective to string made the production-path Retry test receive 409 instead of 422.
  body: requestSchema(type({ objective: "'pri' | 'time'", inputHash: 'string' }), {
    undeclaredKeys: 'delete',
  }),
  bodyMedia,
  responses: [
    {
      kind: 'json',
      status: 202,
      schema: responseSchema(
        type({ state: "'retrying'", generation: 'number', inputHash: 'string' }),
      ),
    },
  ],
  refusals: [
    ...bodyRefusals,
    notFound,
    { status: 403, schema: responseSchema(type({ error: "'forbidden'" })) },
    { status: 409, schema: retryRefusal },
  ],
  document: { summary: 'Retry one failed or corrupt optimized schedule.' },
});
