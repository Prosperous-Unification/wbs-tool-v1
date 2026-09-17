import { type } from 'arktype';

import { defineEndpointShape } from './endpoint-shape';
import { planDocumentRequest } from './plan-document-shapes';
import { responseSchema } from './schema-shape';

const createdNames = type({
  teams: 'string[]',
  people: 'string[]',
  tags: 'string[]',
  services: 'string[]',
  types: 'string[]',
  externalSystems: 'string[]',
});

export const importSummary = responseSchema(
  type({
    projectId: 'string',
    rows: 'number.integer >= 0',
    created: createdNames,
    solutionRef: "'kept' | 'left-off' | 'none'",
  }),
);

const malformedImport = responseSchema(
  type({
    error:
      "'invalid_body' | 'unsupported_version' | 'unknown_ref' | 'cycle' | 'ancestor' | 'deadline_before_project_start'",
    path: 'string',
    detail: 'string | null',
  }),
);

/** Restores one archival plan as a new caller-owned project. */
export const importProject = defineEndpointShape({
  method: 'POST',
  path: '/api/projects/import',
  operationId: 'postApiProjectsImport',
  // Proof: removing write scope made the mounted valid reader import return 201;
  // moving policy admission after parsing made its malformed request return 400 invalid_body.
  policies: [
    { kind: 'origin', when: 'always-unsafe-with-session-cookie' },
    { kind: 'identity', require: 'write-scope' },
  ],
  body: planDocumentRequest,
  bodyMedia: ['application/json'],
  responses: [{ kind: 'json', status: 201, schema: importSummary }],
  refusals: [
    { kind: 'import-refusal', status: 400, schema: malformedImport },
    { status: 401, schema: responseSchema(type({ error: "'unauthenticated'" })) },
    {
      status: 403,
      schema: responseSchema(type({ error: "'invalid_origin' | 'insufficient_scope'" })),
    },
    {
      kind: 'import-refusal',
      status: 409,
      schema: responseSchema(
        type({
          error: "'engine_unavailable' | 'source_refused'",
          path: 'string',
          detail: 'string | null',
        }),
      ),
    },
  ],
  document: { summary: 'Import an archival plan as a new project.' },
});
