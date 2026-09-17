import { type } from 'arktype';

import { defineEndpointShape } from './endpoint-shape';
import { projectWithSteps } from './project-response';
import { requestSchema, responseSchema } from './schema-shape';

/**
 * Resolves an external solution's plan only for callers granted read scope.
 * Proof: signed-in instead of read-scope reached lookup,404 instead of403 in
 * the mounted no-read-scope case. A tolerant query declaration likewise reached
 * lookup,404 instead of400 in the undeclared-query case (project.controller.test.ts).
 * Omitting slug's descriptor made solution-shapes.test.ts's document consumer
 * throw: missing path parameter descriptor: slug.
 */
export const readSolution = defineEndpointShape({
  method: 'GET',
  path: '/plans/by-solution/:slug',
  operationId: 'getPlansBy-solutionBySlug',
  policies: [{ kind: 'identity', require: 'read-scope' }],
  params: requestSchema(type({ slug: 'string' })),
  responses: [{ kind: 'json', status: 200, schema: projectWithSteps }],
  refusals: [
    {
      status: 400,
      schema: responseSchema(
        type({ error: "'invalid_params' | 'invalid_query' | 'invalid_body'" }),
      ),
    },
    { status: 401, schema: responseSchema(type({ error: "'unauthenticated'" })) },
    { status: 403, schema: responseSchema(type({ error: "'insufficient_scope'" })) },
    { status: 404, schema: responseSchema(type({ error: "'not_found'" })) },
  ],
  document: { summary: 'Resolve a plan by its external solution slug.' },
});
