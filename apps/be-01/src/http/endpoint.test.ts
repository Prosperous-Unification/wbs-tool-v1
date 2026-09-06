import { defineEndpointShape, requestSchema, responseSchema } from '@wbs/contracts';
import { type } from 'arktype';
import { describe, expect, test } from 'bun:test';

import { bind, EMPTY } from './endpoint';

const echoShape = defineEndpointShape({
  method: 'POST',
  path: '/probe/echo',
  operationId: 'echoProbe',
  policies: [],
  body: requestSchema(type({ text: 'string' })),
  responses: [{ kind: 'json', status: 200, schema: responseSchema(type({ echoed: 'string' })) }],
  refusals: [
    { status: 400, schema: responseSchema(type({ error: "'invalid_body'" })) },
    { status: 429, schema: responseSchema(type({ error: "'invalid_credentials'" })) },
  ],
  document: { summary: 'Echo a probe' },
});
const projectShape = defineEndpointShape({
  method: 'GET',
  path: '/projects/:id',
  operationId: 'readProjectProbe',
  policies: [{ kind: 'identity', require: 'signed-in' }],
  params: requestSchema(type({ id: 'string' })),
  responses: [{ kind: 'json', status: 200, schema: responseSchema(type({ id: 'string' })) }],
  refusals: [],
  document: { summary: 'Read a project probe' },
});
const openedShape = defineEndpointShape({
  method: 'POST',
  path: '/opened',
  operationId: 'openedProbe',
  policies: [],
  responses: [{ kind: 'empty', status: 204 }],
  refusals: [],
  document: { summary: 'Record an opening' },
});
const nullShape = defineEndpointShape({
  method: 'GET',
  path: '/null',
  operationId: 'nullProbe',
  policies: [],
  responses: [{ kind: 'json', status: 200, schema: responseSchema(type('null')) }],
  refusals: [],
  document: { summary: 'Return JSON null' },
});

const internalShape = defineEndpointShape({
  method: 'POST',
  path: '/internal/probe',
  operationId: 'internalProbe',
  policies: [{ kind: 'identity', require: 'internal' }],
  responses: [
    { kind: 'json', status: 200, schema: responseSchema(type({ identity: "'internal'" })) },
  ],
  refusals: [],
  document: { summary: 'Read the internal identity' },
});

/** These negative fixtures are compiled by the actual backend spec project. */
export function endpointTypeFixtures(path: `/${string}` = '/probe'): void {
  bind(echoShape, (input) => {
    // @ts-expect-error An unauthenticated endpoint has no principal property.
    void input.principal;
    return Promise.resolve({ ok: true, status: 200, body: { echoed: input.body.text } });
  });
  bind(projectShape, (input) => {
    const absentParam = 'wrong';
    // @ts-expect-error Parameters derive from this literal path.
    void input.params[absentParam];
    return Promise.resolve({ ok: true, status: 200, body: { id: input.principal.id } });
  });
  const successfulRefusal = (): Promise<{
    ok: true;
    status: 200;
    body: { echoed: string; error: 'invalid_body' };
  }> => Promise.resolve({ ok: true, status: 200, body: { echoed: 'x', error: 'invalid_body' } });
  // @ts-expect-error A successful body cannot carry a refusal envelope.
  bind(echoShape, successfulRefusal);
  const mismatchedRefusal = (): Promise<{
    ok: false;
    status: 400;
    body: { error: 'invalid_credentials' };
  }> => Promise.resolve({ ok: false, status: 400, body: { error: 'invalid_credentials' } });
  // @ts-expect-error The throttling body is not a declared 400 response.
  bind(echoShape, mismatchedRefusal);
  // @ts-expect-error This shape does not declare an empty success.
  bind(echoShape, () => Promise.resolve({ ok: true, status: 204, body: EMPTY }));
  // @ts-expect-error This shape does not declare a text response.
  bind(echoShape, () => Promise.resolve({ ok: true, status: 200, text: 'x' }));
  // @ts-expect-error This shape does not declare a redirect.
  bind(echoShape, () => Promise.resolve({ ok: true, status: 302, body: EMPTY }));
  const emptyInsteadOfNull = (): Promise<{ ok: true; status: 200; body: typeof EMPTY }> =>
    Promise.resolve({
      ok: true,
      status: 200,
      body: EMPTY,
    });
  // @ts-expect-error JSON null is different from an empty response.
  bind(nullShape, emptyInsteadOfNull);
  bind(internalShape, (input) => {
    // @ts-expect-error An internal principal is not a user account.
    void input.principal.id;
    return Promise.resolve({ ok: true, status: 200, body: { identity: input.principal.kind } });
  });
  bind(
    defineEndpointShape({ ...echoShape, policies: [{ kind: 'origin', when: 'always' }] }),
    (input) => {
      // @ts-expect-error Origin enforcement does not provide a principal.
      void input.principal;
      return Promise.resolve({ ok: true, status: 200, body: { echoed: input.body.text } });
    },
  );
  const variableIdentity = defineEndpointShape({
    ...echoShape,
    policies: [{ kind: 'identity', require: Math.random() > 0.5 ? 'internal' : 'signed-in' }],
  });
  bind(variableIdentity, (input) => {
    // @ts-expect-error A variable identity requirement must be narrowed before reading user fields.
    void input.principal.id;
    const name = 'kind' in input.principal ? input.principal.kind : input.principal.username;
    return Promise.resolve({ ok: true, status: 200, body: { echoed: name } });
  });
  const successFromClassifier = () => ({
    ok: true as const,
    status: 200 as const,
    body: { echoed: 'forbidden' },
  });
  bind(echoShape, () => Promise.resolve({ ok: true, status: 200, body: { echoed: 'x' } }), {
    // @ts-expect-error A request failure classifier can never admit the request with success.
    classifyRequestFailure: successFromClassifier,
  });
  bind(echoShape, () => Promise.resolve({ ok: true, status: 200, body: { echoed: 'x' } }), {
    // @ts-expect-error Metadata prevalidation can only refuse or continue with null.
    prevalidate: successFromClassifier,
  });
  const wrongClassifiedStatus = () => ({
    ok: false as const,
    status: 429 as const,
    body: { error: 'invalid_body' as const },
  });
  bind(echoShape, () => Promise.resolve({ ok: true, status: 200, body: { echoed: 'x' } }), {
    // @ts-expect-error The classifier must preserve the declared status/body correlation.
    classifyRequestFailure: wrongClassifiedStatus,
  });
  const mixedPolicies = [
    { kind: 'identity', require: 'signed-in' },
    { kind: 'identity', require: 'internal' },
  ] as const;
  // @ts-expect-error User and internal identity cannot share one principal input.
  defineEndpointShape({ ...echoShape, policies: mixedPolicies });
  const reversedPolicies = [
    { kind: 'identity', require: 'internal' },
    { kind: 'identity', require: 'read-scope' },
  ] as const;
  // @ts-expect-error Identity incompatibility is independent of policy order.
  defineEndpointShape({ ...echoShape, policies: reversedPolicies });
  // @ts-expect-error A slash-prefixed template is not a literal route path.
  defineEndpointShape({ ...echoShape, path });
  // @ts-expect-error A schema cannot omit the second parameter from a nested path.
  defineEndpointShape({ ...projectShape, path: '/projects/:id/steps/:stepId' });
  // @ts-expect-error An empty supplied params schema cannot drop a path parameter.
  defineEndpointShape({ ...projectShape, params: requestSchema(type({})) });
  // @ts-expect-error The params schema cannot rename a path parameter.
  defineEndpointShape({ ...projectShape, params: requestSchema(type({ wrong: 'string' })) });
  // @ts-expect-error The params schema cannot add a path parameter.
  defineEndpointShape({
    ...projectShape,
    params: requestSchema(type({ id: 'string', extra: 'string' })),
  });
}

describe('a typed endpoint without an HTTP adapter', () => {
  test('accepts literal input and returns the declared success', async () => {
    const endpoint = bind(echoShape, (input) =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: { echoed: input.body.text },
      }),
    );
    expect(
      await endpoint.handle({
        params: {},
        query: undefined,
        body: { text: 'hello' },
        request: {
          url: new URL('http://probe/probe/echo'),
          method: 'POST',
          headers: new Headers(),
        },
      }),
    ).toEqual({ ok: true, status: 200, body: { echoed: 'hello' } });
  });
  test('keeps EMPTY distinct from a declared JSON null', async () => {
    const opened = bind(openedShape, () => Promise.resolve({ ok: true, status: 204, body: EMPTY }));
    const nullable = bind(nullShape, () => Promise.resolve({ ok: true, status: 200, body: null }));
    const input = {
      params: {},
      query: undefined,
      body: undefined,
      request: { url: new URL('http://probe/'), method: 'POST', headers: new Headers() },
    };
    expect((await opened.handle(input)).body).toBe(EMPTY);
    expect((await opened.handle(input)).body).not.toBeNull();
    expect((await nullable.handle(input)).body).toBeNull();
  });
});
