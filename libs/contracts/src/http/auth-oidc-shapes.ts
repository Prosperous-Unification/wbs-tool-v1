import { type } from 'arktype';

import { defineEndpointShape } from './endpoint-shape';
import { requestSchema, responseSchema } from './schema-shape';

const malformed = {
  status: 400,
  schema: responseSchema(
    type({ error: "'invalid_body' | 'invalid_query' | 'invalid_params' | 'invalid_json'" }),
  ),
} as const;
const sessionRefusal = {
  status: 401,
  schema: responseSchema(type({ error: "'invalid_oidc_session'" })),
} as const;
// Proof: removing Origin returned204 instead of403 in the mounted refresh/logout policy test.
const unsafe = [{ kind: 'origin', when: 'always-unsafe-with-session-cookie' }] as const;
const invalidOrigin = {
  status: 403,
  schema: responseSchema(type({ error: "'invalid_origin'" })),
} as const;

/** Starts an OIDC transaction for one browser and redirects to its provider. */
export const startOidcLogin = defineEndpointShape({
  method: 'GET',
  path: '/api/auth/login',
  operationId: 'getApiAuthLogin',
  policies: [],
  responses: [{ kind: 'empty', status: 302 }],
  refusals: [malformed],
  document: { summary: 'Start a browser OIDC login.' },
});
/** Provider callback parameters remain open; each raw key may occur only once. */
export const completeOidcLogin = defineEndpointShape({
  method: 'GET',
  path: '/api/auth/okta/callback',
  operationId: 'getApiAuthOktaCallback',
  policies: [],
  query: requestSchema(type({ '[string]': 'string' })),
  queryMode: 'arbitrary-singleton',
  responses: [{ kind: 'empty', status: 302 }],
  refusals: [
    malformed,
    {
      status: 400,
      schema: responseSchema(type({ error: "'duplicate_parameter'" })),
    },
    // Exchange classification deliberately carries no provider detail to the browser.
    { kind: 'empty', status: 400 },
    { kind: 'empty', status: 401 },
    { kind: 'empty', status: 409 },
    { kind: 'empty', status: 500 },
    { kind: 'empty', status: 503 },
    { status: 405, schema: responseSchema(type({ error: "'method_not_allowed'" })) },
  ],
  document: { summary: 'Complete one browser OIDC login.' },
});
/** Refreshes from the browser session correlation, including an expired access token. */
export const refreshOidcSession = defineEndpointShape({
  method: 'POST',
  path: '/api/auth/refresh',
  operationId: 'postApiAuthRefresh',
  policies: unsafe,
  responses: [{ kind: 'empty', status: 204 }],
  refusals: [malformed, invalidOrigin, sessionRefusal],
  document: { summary: 'Refresh the browser access cookie.' },
});
/** Deletes the local session before revoking the upstream refresh token. */
export const logoutOidcSession = defineEndpointShape({
  method: 'POST',
  path: '/api/auth/logout',
  operationId: 'postApiAuthLogout',
  policies: unsafe,
  responses: [{ kind: 'empty', status: 204 }],
  refusals: [malformed, invalidOrigin],
  document: { summary: 'End the browser session.' },
});
