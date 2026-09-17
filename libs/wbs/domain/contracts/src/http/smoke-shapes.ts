import { type } from 'arktype';

import { defineEndpointShape } from './endpoint-shape';
import { requestSchema, responseSchema } from './schema-shape';

/** The deploy smoke echoes text through the same validated boundary as domain endpoints. */
export const smokeEcho = defineEndpointShape({
  method: 'POST',
  path: '/api/smoke/echo',
  operationId: 'postApiSmokeEcho',
  // Proof: removing this policy makes smoke.integration.test.ts's cookie case
  // receive400 instead of403 before malformed JSON.
  policies: [{ kind: 'origin', when: 'always-unsafe-with-session-cookie' }],
  // Proof: using the tolerant wrapper admits the extra object,200 instead of400
  // in smoke.integration.test.ts's undeclared-input case.
  body: requestSchema(type({ text: 'string' })),
  bodyMedia: ['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data'],
  // Proof: widening echoed to unknown admits the injected invalid service reply,
  //200 instead of500 in smoke.integration.test.ts's response-boundary case.
  responses: [{ kind: 'json', status: 200, schema: responseSchema(type({ echoed: 'string' })) }],
  refusals: [
    {
      status: 400,
      schema: responseSchema(type({ error: "'invalid_body' | 'invalid_json' | 'invalid_query'" })),
    },
    { status: 403, schema: responseSchema(type({ error: "'invalid_origin'" })) },
  ],
  document: { summary: 'Echo text through the backend.' },
});
