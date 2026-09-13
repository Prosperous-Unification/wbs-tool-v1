import { type } from 'arktype';

import {
  InternalForwardRequest,
  InternalForwardResponse,
  InternalResumeResponse,
} from '../internal';
import { defineEndpointShape } from './endpoint-shape';
import { requestSchema, responseSchema } from './schema-shape';

/**
 * ArkType's unordered union removes the array as a subtype of the index map.
 * Its schema parser erases inference: the exact two runtime branches below and
 * their emitted anyOf are checked by internal-http-shapes.test.ts, which is the
 * boundary justifying this local type restoration.
 * Proof: widening this restoration to unknown produced TS2578 on the string-
 * cursor negative in internal-http-shapes.test.ts; restoring the numeric union
 * made the same isolated compiler check pass.
 * Proof: deleting the array branch returned422 instead of200 in the mounted
 * legacy-cursor case; a zero lower bound returned422 instead of200 in the
 * real replay-from-minus-one case (internal.integration.test.ts).
 */
const resumePoints = type
  .schema({
    branches: [
      { sequence: 'number', proto: 'Array' },
      { index: [{ signature: 'string', value: 'number' }], domain: 'object' },
    ],
    ordered: true,
  })
  .as<Record<string, number> | number[]>();

// Proof: removing identity reached malformed JSON parsing,400 instead of401
// in internal.integration.test.ts's pre-parse identity case.
const policies = [{ kind: 'identity', require: 'internal' }] as const;
// Proof: removing form media returned422 instead of200 in the mounted
// duplicate-payload forms case (http/elysia/internal.test.ts).
const bodyMedia = [
  'application/json',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
] as const;
const refusals = [
  {
    status: 400,
    schema: responseSchema(type({ error: "'invalid_params' | 'invalid_query' | 'invalid_json'" })),
  },
  { status: 401, schema: responseSchema(type({ error: "'unauthorized'" })) },
  { status: 422, schema: responseSchema(type({ error: "'invalid_body'" })) },
] as const;

/**
 * Acknowledges an arbitrary gateway payload without making the socket a write
 * authority. Forms preserve duplicate message values as an arbitrary array.
 * Proof: using responseSchema for the body admitted extra envelope fields,
 *200 instead of422 in internal.integration.test.ts's strict-body case.
 */
export const forwardInternal = defineEndpointShape({
  method: 'POST',
  path: '/internal/forward',
  operationId: 'postInternalForward',
  policies,
  body: requestSchema(InternalForwardRequest),
  bodyMedia,
  responses: [{ kind: 'json', status: 200, schema: responseSchema(InternalForwardResponse) }],
  refusals,
  document: { summary: 'Acknowledge a forwarded gateway message.' },
});

/**
 * Reads replay from legacy numeric cursors, including -1, fractions and arrays.
 * The explicit array arm preserves the old index-map parser's accepted inputs;
 * the binding interprets array indices as subscription keys through Object.entries.
 * Replay messages remain opaque historical JSON while outcome metadata is closed.
 * Proof: an unknown-valued response map admitted a missing events list,200
 * instead of500 in the mounted replay-reply case (http/elysia/internal.test.ts).
 */
export const resumeInternal = defineEndpointShape({
  method: 'POST',
  path: '/internal/resume',
  operationId: 'postInternalResume',
  policies,
  body: requestSchema(type({ resume_points: resumePoints, trace_id: 'string' })),
  bodyMedia,
  responses: [{ kind: 'json', status: 200, schema: responseSchema(InternalResumeResponse) }],
  refusals,
  document: { summary: 'Replay recorded events to one reconnecting gateway socket.' },
});
