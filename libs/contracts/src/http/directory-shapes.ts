import { type } from 'arktype';

import { defineEndpointShape } from './endpoint-shape';
import { responseSchema } from './schema-shape';

const namedRow = type({ id: 'string', name: 'string' });
// Proof: removing identity returned200 instead of401 in the mounted
// requires-identity case in directory.controller.db.test.ts.
const policies = [{ kind: 'identity', require: 'signed-in' }] as const;
const refusals = [
  {
    status: 400,
    schema: responseSchema(type({ error: "'invalid_query' | 'invalid_params' | 'invalid_body'" })),
  },
  { status: 401, schema: responseSchema(type({ error: "'unauthenticated'" })) },
] as const;

/**
 * Reads the global teams directory for a signed-in account.
 * Proof: optional serviceIds admitted a damaged row,200 instead of500 in the
 * mounted damaged-directory case. Adding a tolerant query declaration returned
 *200 instead of400 in the mounted undeclared-query case.
 */
export const listTeams = defineEndpointShape({
  method: 'GET',
  path: '/api/teams',
  operationId: 'getApiTeams',
  policies,
  responses: [
    {
      kind: 'json',
      status: 200,
      schema: responseSchema(
        type({ teams: type({ id: 'string', name: 'string', serviceIds: 'string[]' }).array() }),
      ),
    },
  ],
  refusals,
  document: { summary: 'List teams.' },
});

/**
 * Reads people with their kind and complete team memberships.
 * Proof: optional kind, optional teamIds and unrestricted kind each returned200
 * instead of500 in the mounted damaged-directory case. Using requestSchema
 * rejected additive audit fields,500 instead of200 in the mounted audit case.
 */
export const listPeople = defineEndpointShape({
  method: 'GET',
  path: '/api/people',
  operationId: 'getApiPeople',
  policies,
  responses: [
    {
      kind: 'json',
      status: 200,
      schema: responseSchema(
        type({
          people: type({
            id: 'string',
            name: 'string',
            kind: "'person' | 'agent'",
            teamIds: 'string[]',
          }).array(),
        }),
      ),
    },
  ],
  refusals,
  document: { summary: 'List people.' },
});

/** Reads the global tags directory for a signed-in account. */
export const listTags = defineEndpointShape({
  method: 'GET',
  path: '/api/tags',
  operationId: 'getApiTags',
  policies,
  responses: [
    { kind: 'json', status: 200, schema: responseSchema(type({ tags: namedRow.array() })) },
  ],
  refusals,
  document: { summary: 'List tags.' },
});

/** Reads the global services directory for a signed-in account. */
export const listServices = defineEndpointShape({
  method: 'GET',
  path: '/api/services',
  operationId: 'getApiServices',
  policies,
  responses: [
    { kind: 'json', status: 200, schema: responseSchema(type({ services: namedRow.array() })) },
  ],
  refusals,
  document: { summary: 'List services.' },
});

/** Reads the global work-item-types directory for a signed-in account. */
export const listWorkItemTypes = defineEndpointShape({
  method: 'GET',
  path: '/api/work-item-types',
  operationId: 'getApiWork-item-types',
  policies,
  responses: [
    {
      kind: 'json',
      status: 200,
      schema: responseSchema(type({ workItemTypes: namedRow.array() })),
    },
  ],
  refusals,
  document: { summary: 'List work-item-types.' },
});

/** Reads the global external-systems directory for a signed-in account. */
export const listExternalSystems = defineEndpointShape({
  method: 'GET',
  path: '/api/external-systems',
  operationId: 'getApiExternal-systems',
  policies,
  responses: [
    {
      kind: 'json',
      status: 200,
      schema: responseSchema(type({ externalSystems: namedRow.array() })),
    },
  ],
  refusals,
  document: { summary: 'List external-systems.' },
});
