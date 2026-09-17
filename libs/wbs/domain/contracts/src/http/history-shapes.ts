import { type } from 'arktype';

import { defineEndpointShape } from './endpoint-shape';
import { requestSchema, responseSchema } from './schema-shape';

/**
 * Persisted commands are opaque historical JSON: their writer may be an older release.
 * Known event metadata remains validated; before/after are deliberately not today's command union.
 * Proof: narrowing before to string makes history.controller.test.ts's historical
 * JSON case fail at response.json with SyntaxError: Failed to parse JSON.
 */
const historyEvent = type({
  id: 'string',
  projectId: 'string',
  userId: 'string',
  kind: 'string',
  label: 'string',
  workItemId: 'string | null',
  stepId: 'string | null',
  before: 'unknown',
  after: 'unknown',
  createdAt: 'number',
});

/** Reads optional comma-separated kinds; unknown kind names remain a valid empty result. */
export const readHistory = defineEndpointShape({
  method: 'GET',
  path: '/api/projects/:id/history',
  operationId: 'getApiProjectsByIdHistory',
  policies: [
    { kind: 'origin', when: 'always-unsafe-with-session-cookie' },
    { kind: 'identity', require: 'signed-in' },
  ],
  params: requestSchema(type({ id: 'string' })),
  // Proof: the tolerant wrapper gives unknown-query 200 instead of400 in
  // history.controller.test.ts; omitting this declaration removes both filters
  // from history-shapes.test.ts's actual emitted parameter list.
  query: requestSchema(type({ 'workItemId?': 'string', 'kind?': 'string' })),
  responses: [
    { kind: 'json', status: 200, schema: responseSchema(type({ events: historyEvent.array() })) },
  ],
  refusals: [
    {
      status: 400,
      schema: responseSchema(
        type({ error: "'invalid_params' | 'invalid_query' | 'invalid_body'" }),
      ),
    },
    { status: 401, schema: responseSchema(type({ error: "'unauthenticated'" })) },
    {
      status: 403,
      schema: responseSchema(type({ error: "'invalid_origin' | 'insufficient_scope'" })),
    },
    { status: 404, schema: responseSchema(type({ error: "'not_found'" })) },
  ],
  document: {
    summary:
      'Read one plan’s history, newest first, optionally filtered by workItemId and comma-separated kind.',
  },
});
