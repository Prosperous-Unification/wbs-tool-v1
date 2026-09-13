import { type } from 'arktype';

import { defineEndpointShape } from './endpoint-shape';
import { requestSchema, responseSchema } from './schema-shape';

// Proof: admitting an extra boolean made the mounted extra-field request receive 400 instead of 422.
const credentials = requestSchema(type({ username: 'string', password: 'string' }));
const bodyMedia = [
  'application/json',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
] as const;
// Proof: removing this policy made the mounted malformed foreign-origin request receive 400 instead of 403.
const originPolicy = [{ kind: 'origin', when: 'always' }] as const;
const signedIn = responseSchema(
  type({ token: 'string', user: { id: 'string', username: 'string' } }),
);
const scope = type("'read' | 'write' | 'editor'");
const currentUser = responseSchema(
  type({ user: type({ id: 'string', username: 'string', scopes: scope.array() }).or('null') }),
);

/** Creates a password account and returns its local bearer or hardened browser session. */
export const registerPassword = defineEndpointShape({
  method: 'POST',
  path: '/api/auth/register',
  operationId: 'postApiAuthRegister',
  policies: originPolicy,
  body: credentials,
  bodyMedia,
  responses: [{ kind: 'json', status: 200, schema: signedIn }],
  refusals: [
    {
      status: 400,
      schema: responseSchema(
        type({ error: "'invalid_json' | 'invalid_query' | 'invalid_client' | 'invalid'" }),
      ),
    },
    { status: 403, schema: responseSchema(type({ error: "'invalid_origin'" })) },
    { status: 404, schema: responseSchema(type({ error: "'not_found'" })) },
    { status: 409, schema: responseSchema(type({ error: "'taken'" })) },
    { status: 422, schema: responseSchema(type({ error: "'invalid_body'" })) },
    { status: 429, schema: responseSchema(type({ error: "'rate_limited'" })) },
  ],
  document: { summary: 'Register a password account and start a session.' },
});

/** Verifies a password and returns its local bearer or hardened browser session. */
export const loginPassword = defineEndpointShape({
  method: 'POST',
  path: '/api/auth/login',
  operationId: 'postApiAuthLogin',
  policies: originPolicy,
  body: credentials,
  bodyMedia,
  responses: [{ kind: 'json', status: 200, schema: signedIn }],
  refusals: [
    {
      status: 400,
      schema: responseSchema(
        type({ error: "'invalid_json' | 'invalid_query' | 'invalid_client'" }),
      ),
    },
    { status: 401, schema: responseSchema(type({ error: "'invalid_credentials'" })) },
    { status: 403, schema: responseSchema(type({ error: "'invalid_origin'" })) },
    { status: 404, schema: responseSchema(type({ error: "'not_found'" })) },
    { status: 422, schema: responseSchema(type({ error: "'invalid_body'" })) },
    // Exhausted admission deliberately shares its body with the credential refusal.
    { status: 429, schema: responseSchema(type({ error: "'invalid_credentials'" })) },
  ],
  document: { summary: 'Start a session with a password account.' },
});

/** Resolves the current password or OIDC session, including an explicit signed-out state. */
export const readPasswordSession = defineEndpointShape({
  method: 'GET',
  path: '/api/auth/me',
  operationId: 'getApiAuthMe',
  // Authentication stays inside the handler because this protocol answers invalid_token, not unauthenticated.
  policies: [],
  responses: [{ kind: 'json', status: 200, schema: currentUser }],
  refusals: [
    {
      status: 400,
      schema: responseSchema(
        type({ error: "'invalid_body' | 'invalid_query' | 'invalid_params'" }),
      ),
    },
    { status: 401, schema: responseSchema(type({ error: "'invalid_token'" })) },
  ],
  document: { summary: 'Read the account behind the current session.' },
});
