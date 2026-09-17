import { type } from 'arktype';

import { defineEndpointShape } from './endpoint-shape';
import { requestSchema, responseSchema } from './schema-shape';

const projectParams = requestSchema(type({ id: 'string' }));
const markerParams = requestSchema(type({ id: 'string', markerId: 'string' }));
const marker = type({
  id: 'string',
  projectId: 'string',
  date: 'string',
  name: 'string',
  color: 'string',
  createdAt: 'number',
});
const markerReply = responseSchema(type({ marker }));
const readPolicies = [{ kind: 'identity', require: 'signed-in' }] as const;
// Proof: removing origin or changing write-scope to signed-in independently returned
// 201 instead of 403 in the mounted cookie-origin/write-scope marker test.
const writePolicies = [
  { kind: 'origin', when: 'always-unsafe-with-session-cookie' },
  { kind: 'identity', require: 'write-scope' },
] as const;
const common = [
  {
    status: 400,
    schema: responseSchema(
      type({ error: "'invalid_params' | 'invalid_query' | 'invalid_json' | 'invalid_body'" }),
    ),
  },
  { status: 401, schema: responseSchema(type({ error: "'unauthenticated'" })) },
  {
    status: 403,
    schema: responseSchema(type({ error: "'invalid_origin' | 'insufficient_scope'" })),
  },
  { status: 403, schema: responseSchema(type({ error: "'forbidden'" })) },
] as const;
const collection = [
  ...common,
  { status: 404, schema: responseSchema(type({ error: "'not_found'" })) },
  { status: 409, schema: responseSchema(type({ error: "'taken'" })) },
] as const;
// Proof: widening field to string returned 404 instead of 500 in the mounted
// malformed-known-field matrix (http/elysia/calendar-marker.test.ts).
const addressed = [
  ...common,
  { status: 404, schema: responseSchema(type({ error: "'not_found'", 'field?': "'markerId'" })) },
  { status: 409, schema: responseSchema(type({ error: "'taken'", 'field?': "'markerId'" })) },
] as const;
const writable = [
  ...addressed,
  {
    status: 422,
    schema: responseSchema(
      type({ error: "'malformed'", field: "'body' | 'markerId' | 'date' | 'name' | 'color'" }),
    ),
  },
  { status: 422, schema: responseSchema(type({ error: "'contrast'", field: "'color'" })) },
] as const;
const bodyMedia = [
  'application/json',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
] as const;

/** Reads axis annotations separately from the scheduled project projection. */
export const listCalendarMarkers = defineEndpointShape({
  method: 'GET',
  path: '/api/projects/:id/calendar-markers',
  operationId: 'getApiProjectsByIdCalendar-markers',
  policies: readPolicies,
  params: projectParams,
  responses: [
    { kind: 'json', status: 200, schema: responseSchema(type({ markers: marker.array() })) },
  ],
  refusals: collection,
  document: { summary: 'List project calendar markers.' },
});

/**
 * Creates an annotation. markerId avoids colliding with the project path's id
 * when MCP flattens the operation arguments; the domain row still calls it id.
 * Proof: renaming this body property to id made calendar-marker-shapes.test.ts
 * in mcp-01 throw that id was declared as both a path and body input.
 */
export const createCalendarMarker = defineEndpointShape({
  method: 'POST',
  path: '/api/projects/:id/calendar-markers',
  operationId: 'postApiProjectsByIdCalendar-markers',
  policies: writePolicies,
  params: projectParams,
  body: requestSchema(
    type({ 'markerId?': 'string', date: 'string', name: 'string', 'color?': 'string | null' }),
  ),
  bodyMedia,
  responses: [{ kind: 'json', status: 201, schema: markerReply }],
  refusals: writable,
  document: { summary: 'Create a calendar marker.' },
});

/**
 * Declares the writable columns for MCP's flat object inputs. Exactly-one
 * cardinality remains the binding's semantic check; undeclared fields are rejected.
 */
export const updateCalendarMarker = defineEndpointShape({
  method: 'PATCH',
  path: '/api/projects/:id/calendar-markers/:markerId',
  operationId: 'patchApiProjectsByIdCalendar-markersByMarkerId',
  policies: writePolicies,
  params: markerParams,
  // Proof: responseSchema here admitted an immutable date and returned 200, expected 422,
  // in the mounted undeclared-input test.
  body: requestSchema(type({ 'name?': 'string', 'color?': 'string | null' })),
  bodyMedia,
  responses: [{ kind: 'json', status: 200, schema: markerReply }],
  refusals: writable,
  document: { summary: 'Rename or recolor a calendar marker.' },
});

/** Removes one annotation without adding a command journal entry. */
export const removeCalendarMarker = defineEndpointShape({
  method: 'DELETE',
  path: '/api/projects/:id/calendar-markers/:markerId',
  operationId: 'deleteApiProjectsByIdCalendar-markersByMarkerId',
  policies: writePolicies,
  params: markerParams,
  responses: [{ kind: 'empty', status: 204 }],
  refusals: addressed,
  document: { summary: 'Delete a calendar marker.' },
});
