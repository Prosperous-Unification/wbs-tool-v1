import {
  defineEndpointShape,
  requestSchema,
  responseSchema,
  type SchemaShape,
} from '@wbs/contracts';
import { type } from 'arktype';
import { describe, expect, spyOn, test } from 'bun:test';
import { Elysia } from 'elysia';

import {
  bind,
  type BoundEndpoint,
  EMPTY,
  type EndpointReply,
  type IdentityResolver,
  type RequestFailure,
} from '../endpoint';
import { mountEndpoints } from './mount';

const origin = 'https://app.example';
const refusalShapes = [
  {
    status: 400,
    schema: responseSchema(type({ error: "'invalid_body' | 'invalid_query' | 'invalid_json'" })),
  },
  { status: 401, schema: responseSchema(type({ error: "'unauthenticated' | 'unauthorized'" })) },
  {
    status: 403,
    schema: responseSchema(type({ error: "'insufficient_scope' | 'invalid_origin'" })),
  },
  { status: 429, schema: responseSchema(type({ error: "'rate_limited'" })) },
] as const;
const echoShape = defineEndpointShape({
  method: 'POST',
  path: '/echo',
  operationId: 'echo',
  policies: [{ kind: 'origin', when: 'always-unsafe-with-session-cookie' }],
  body: requestSchema(type({ text: 'string', 'nested?': { name: 'string' } })),
  responses: [{ kind: 'json', status: 200, schema: responseSchema(type({ echoed: 'string' })) }],
  refusals: refusalShapes,
  document: { summary: 'Echo' },
});
const writeShape = defineEndpointShape({
  ...echoShape,
  policies: [
    { kind: 'origin', when: 'always-unsafe-with-session-cookie' },
    { kind: 'identity', require: 'write-scope' },
  ],
});
const resolveIdentity: IdentityResolver = (requirement, request) => {
  if (requirement === 'internal')
    return Promise.resolve(
      request.headers.get('x-internal-auth') === 'internal'
        ? { ok: true, principal: { kind: 'internal' } }
        : { ok: false, status: 401, body: { error: 'unauthorized' } },
    );
  const token = request.headers.get('authorization');
  if (token === 'Bearer outage') throw new Error('account store offline');
  if (token !== 'Bearer read' && token !== 'Bearer write') {
    return Promise.resolve({ ok: false, status: 401, body: { error: 'unauthenticated' } });
  }
  if (requirement === 'write-scope' && token === 'Bearer read') {
    return Promise.resolve({ ok: false, status: 403, body: { error: 'insufficient_scope' } });
  }
  return Promise.resolve({
    ok: true,
    principal: { id: 'ada', username: 'Ada', scopes: ['read', 'write'] },
  });
};
function request(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://backend.example/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}
function appFor(endpoints: readonly BoundEndpoint[]) {
  return mountEndpoints(endpoints, { appOrigin: origin, resolveIdentity });
}

describe('endpoint policies before Elysia parsing', () => {
  test('refuses malformed JSON with a read-only token before parsing or writing', async () => {
    const writes: string[] = [];
    const app = appFor([
      bind(writeShape, (input) => {
        writes.push(input.body.text);
        return Promise.resolve({ ok: true, status: 200, body: { echoed: input.body.text } });
      }),
    ]);
    const response = await app.handle(request('{', { authorization: 'Bearer read' }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'insufficient_scope' });
    expect(writes).toEqual([]);
    expect(
      (await app.handle(request('{"text":"allowed"}', { authorization: 'Bearer write' }))).status,
    ).toBe(200);
    expect(writes).toEqual(['allowed']);
  });
  test('refuses anonymous identity and preserves an unexpected account-store failure', async () => {
    const app = appFor([
      bind(writeShape, (input) =>
        Promise.resolve({
          ok: true,
          status: 200,
          body: { echoed: input.body.text },
        }),
      ),
    ]);
    expect((await app.handle(request('{'))).status).toBe(401);
    expect((await app.handle(request('{', { authorization: 'Bearer outage' }))).status).toBe(500);
  });
  test('blocks missing or foreign cookie origins while admitting bearer-only writes', async () => {
    const writes: string[] = [];
    const app = appFor([
      bind(writeShape, (input) => {
        writes.push(input.body.text);
        return Promise.resolve({ ok: true, status: 200, body: { echoed: input.body.text } });
      }),
    ]);
    const origins: Record<string, string>[] = [{}, { origin: 'https://foreign.example' }];
    for (const headers of origins) {
      const response = await app.handle(
        request('{', {
          ...headers,
          cookie: '__Host-wbs_access=token',
          authorization: 'Bearer write',
        }),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'invalid_origin' });
    }
    expect(writes).toEqual([]);
    expect(
      (
        await app.handle(
          request('{"text":"cookie"}', {
            origin,
            cookie: '__Host-wbs_session=token',
            authorization: 'Bearer write',
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await app.handle(request('{"text":"bearer"}', { authorization: 'Bearer write' }))).status,
    ).toBe(200);
    expect(writes).toEqual(['cookie', 'bearer']);
  });
  test('always checks login-style origin without relying on OIDC configuration or cookies', async () => {
    const login = defineEndpointShape({
      ...echoShape,
      policies: [{ kind: 'origin', when: 'always' }],
    });
    const app = appFor([
      bind(login, (input) =>
        Promise.resolve({ ok: true, status: 200, body: { echoed: input.body.text } }),
      ),
    ]);
    expect((await app.handle(request('{"text":"login"}'))).status).toBe(403);
    expect((await app.handle(request('{"text":"login"}', { origin }))).status).toBe(200);
  });
  test('checks internal identity before parsing', async () => {
    const internal = defineEndpointShape({
      ...echoShape,
      policies: [{ kind: 'identity', require: 'internal' }],
    });
    const app = appFor([
      bind(internal, (input) =>
        Promise.resolve({
          ok: true,
          status: 200,
          body: { echoed: input.body.text },
        }),
      ),
    ]);
    const refused = await app.handle(request('{'));
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'unauthorized' });
    expect(
      (await app.handle(request('{"text":"internal"}', { 'x-internal-auth': 'internal' }))).status,
    ).toBe(200);
  });
});

describe('endpoint request and response boundaries', () => {
  test('refuses unknown nested request fields and malformed JSON with declared envelopes', async () => {
    const writes: string[] = [];
    const app = appFor([
      bind(echoShape, (input) => {
        writes.push(input.body.text);
        return Promise.resolve({ ok: true, status: 200, body: { echoed: input.body.text } });
      }),
    ]);
    const invalid = await app.handle(request('{"text":"x","nested":{"name":"n","extra":true}}'));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'invalid_body' });
    expect(writes).toEqual([]);
    const malformed = await app.handle(request('{'));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'invalid_json' });
  });
  test('validates both successful and refusal replies against their declared status', async () => {
    const success: BoundEndpoint = {
      shape: echoShape,
      handle: () => Promise.resolve({ ok: true, status: 200, body: { echoed: 42 } }),
    };
    const refusal: BoundEndpoint = {
      shape: echoShape,
      handle: () => Promise.resolve({ ok: false, status: 429, body: { error: 'invalid_body' } }),
    };
    expect((await appFor([success]).handle(request('{"text":"x"}'))).status).toBe(500);
    expect((await appFor([refusal]).handle(request('{"text":"x"}'))).status).toBe(500);
  });
  test('keeps empty and JSON-null replies distinct', async () => {
    const empty = defineEndpointShape({
      method: 'GET',
      path: '/empty',
      operationId: 'empty',
      policies: [],
      responses: [{ kind: 'empty', status: 204 }],
      refusals: [],
      document: { summary: 'Empty' },
    });
    const nullable = defineEndpointShape({
      method: 'GET',
      path: '/null',
      operationId: 'null',
      policies: [],
      responses: [{ kind: 'json', status: 200, schema: responseSchema(type('null')) }],
      refusals: [],
      document: { summary: 'Null' },
    });
    const app = appFor([
      bind(empty, () => Promise.resolve({ ok: true, status: 204, body: EMPTY })),
      bind(nullable, () => Promise.resolve({ ok: true, status: 200, body: null })),
    ]);
    const emptyReply = await app.handle(new Request('https://backend.example/empty'));
    expect(emptyReply.status).toBe(204);
    expect(await emptyReply.text()).toBe('');
    const nullReply = await app.handle(new Request('https://backend.example/null'));
    expect(nullReply.status).toBe(200);
    expect(await nullReply.text()).toBe('null');
  });
  test('preserves redirect Location and all three Set-Cookie headers', async () => {
    const redirect = defineEndpointShape({
      method: 'GET',
      path: '/callback',
      operationId: 'callback',
      policies: [],
      responses: [{ kind: 'empty', status: 302 }],
      refusals: [],
      document: { summary: 'Callback' },
    });
    const app = appFor([
      bind(redirect, () =>
        Promise.resolve({
          ok: true,
          status: 302,
          body: EMPTY,
          headers: [
            ['Location', '/'],
            ['Set-Cookie', 'one=1'],
            ['Set-Cookie', 'two=2'],
            ['Set-Cookie', 'three=3'],
          ],
        }),
      ),
    ]);
    const response = await app.handle(new Request('https://backend.example/callback'));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/');
    expect(response.headers.getSetCookie()).toEqual(['one=1', 'two=2', 'three=3']);
    expect(await response.text()).toBe('');
  });
  test('renders declared text with its content type', async () => {
    const metrics = defineEndpointShape({
      method: 'GET',
      path: '/metrics',
      operationId: 'metrics',
      policies: [],
      responses: [{ kind: 'text', status: 200, contentType: 'text/plain; version=0.0.4' }],
      refusals: [],
      document: { summary: 'Metrics' },
    });
    const app = appFor([
      bind(metrics, () => Promise.resolve({ ok: true, status: 200, text: 'probe_count 1\n' })),
    ]);
    const response = await app.handle(new Request('https://backend.example/metrics'));
    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4');
    expect(await response.text()).toBe('probe_count 1\n');
  });
});

describe('endpoint metadata and asynchronous boundaries', () => {
  test('preserves decoded params, last query value, raw duplicates, headers and arrived HEAD', async () => {
    const calls: unknown[] = [];
    const shape = defineEndpointShape({
      method: 'GET',
      path: '/lookup/:id',
      operationId: 'lookup',
      policies: [],
      params: requestSchema(type({ id: 'string' })),
      query: requestSchema(type({ q: 'string' })),
      responses: [
        { kind: 'json', status: 200, schema: responseSchema(type({ found: 'boolean' })) },
      ],
      refusals: refusalShapes,
      document: { summary: 'Lookup' },
    });
    const app = appFor([
      bind(shape, (input) => {
        calls.push({
          params: input.params,
          query: input.query,
          method: input.request.method,
          duplicates: input.request.url.searchParams.getAll('q'),
          header: input.request.headers.get('x-probe'),
          principalPresent: 'principal' in input,
          body: input.body,
        });
        return Promise.resolve({ ok: true, status: 200, body: { found: true } });
      }),
    ]);
    const response = await app.handle(
      new Request('https://backend.example/lookup/a%20b?q=first&q=last', {
        method: 'HEAD',
        headers: { 'x-probe': 'present', cookie: '__Host-wbs_session=x' },
      }),
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        params: { id: 'a b' },
        query: { q: 'last' },
        method: 'HEAD',
        duplicates: ['first', 'last'],
        header: 'present',
        principalPresent: false,
        body: undefined,
      },
    ]);
    const invalid = await app.handle(new Request('https://backend.example/lookup/a?q=x&extra=y'));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'invalid_query' });
    expect(calls).toHaveLength(1);
  });
  test('uses declared validation status and refuses invalid params before the handler', async () => {
    const calls: string[] = [];
    const shape = defineEndpointShape({
      method: 'GET',
      path: '/lookup/:id',
      operationId: 'lookup',
      policies: [],
      params: requestSchema(type({ id: "'known'" })),
      responses: [{ kind: 'json', status: 200, schema: responseSchema(type('string')) }],
      refusals: [{ status: 422, schema: responseSchema(type({ error: "'invalid_params'" })) }],
      document: { summary: 'Lookup' },
    });
    const app = appFor([
      bind(shape, ({ params }) => {
        calls.push(params.id);
        return Promise.resolve({ ok: true, status: 200, body: params.id });
      }),
    ]);
    const invalid = await app.handle(new Request('https://backend.example/lookup/other'));
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ error: 'invalid_params' });
    expect(calls).toEqual([]);
    expect((await app.handle(new Request('https://backend.example/lookup/known'))).status).toBe(
      200,
    );
    expect(calls).toEqual(['known']);
  });
  test('awaits asynchronous request and reply validators and preserves validator outages', async () => {
    const events: string[] = [];
    const bodySchema = asynchronous(echoShape.body, events, 'request');
    const replySchema = asynchronous(echoShape.responses[0].schema, events, 'response');
    const shape = defineEndpointShape({
      ...echoShape,
      body: bodySchema,
      responses: [{ kind: 'json', status: 200, schema: replySchema }],
    });
    const app = appFor([
      bind(shape, (input) => {
        events.push('handler');
        return Promise.resolve({ ok: true, status: 200, body: { echoed: input.body.text } });
      }),
    ]);
    expect((await app.handle(request('{"text":"x"}'))).status).toBe(200);
    expect(events).toEqual(['request', 'handler', 'response']);
    events.length = 0;
    expect((await app.handle(request('{"text":42}'))).status).toBe(400);
    expect(events).toEqual(['request']);
    const wrongReply: BoundEndpoint = {
      shape,
      handle: () => Promise.resolve({ ok: true, status: 200, body: { echoed: 42 } }),
    };
    expect((await appFor([wrongReply]).handle(request('{"text":"x"}'))).status).toBe(500);
    const outage = {
      ...echoShape.body,
      validator: {
        '~standard': {
          version: 1 as const,
          vendor: 'probe',
          validate: async () => {
            await Promise.resolve();
            throw new Error('schema unavailable');
          },
        },
      },
    };
    const broken = defineEndpointShape({ ...echoShape, body: outage });
    expect(
      (
        await appFor([
          bind(broken, () => Promise.resolve({ ok: true, status: 200, body: { echoed: 'never' } })),
        ]).handle(request('{"text":"x"}'))
      ).status,
    ).toBe(500);
  });
  test('rejects resolver principal mismatches before handler invocation', async () => {
    let calls = 0;
    for (const requirement of ['internal', 'signed-in'] as const) {
      const shape = defineEndpointShape({
        ...echoShape,
        policies: [{ kind: 'identity', require: requirement }],
      });
      const app = mountEndpoints(
        [
          bind(shape, () => {
            calls++;
            return Promise.resolve({ ok: true, status: 200, body: { echoed: 'wrong' } });
          }),
        ],
        {
          appOrigin: origin,
          resolveIdentity: () =>
            Promise.resolve({
              ok: true,
              principal:
                requirement === 'internal'
                  ? { id: 'ada', username: 'Ada', scopes: ['read'] }
                  : { kind: 'internal' },
            }),
        },
      );
      expect((await app.handle(request('{"text":"x"}'))).status).toBe(500);
    }
    expect(calls).toBe(0);
  });
  test('admits static and parameter siblings with their own ordered policies', async () => {
    const seen: string[] = [];
    const dynamic = defineEndpointShape({
      ...writeShape,
      path: '/echo/:id',
      operationId: 'dynamic',
    });
    const fixed = defineEndpointShape({
      ...echoShape,
      path: '/echo/fixed',
      operationId: 'fixed',
      policies: [],
    });
    const app = appFor([
      bind(dynamic, () => {
        seen.push('dynamic');
        return Promise.resolve({ ok: true, status: 200, body: { echoed: 'dynamic' } });
      }),
      bind(fixed, () => {
        seen.push('fixed');
        return Promise.resolve({ ok: true, status: 200, body: { echoed: 'fixed' } });
      }),
    ]);
    const send = (path: string) =>
      new Request(`https://backend.example${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"text":"x"}',
      });
    expect((await app.handle(send('/echo/fixed'))).status).toBe(200);
    expect((await app.handle(send('/echo/other'))).status).toBe(401);
    expect((await app.handle(send('/missing'))).status).toBe(404);
    expect(seen).toEqual(['fixed']);
  });
  test('refuses successful error envelopes even when the JSON schema is permissive', async () => {
    const shape = defineEndpointShape({
      ...echoShape,
      responses: [{ kind: 'json', status: 200, schema: responseSchema(type('object')) }],
    });
    const endpoint: BoundEndpoint = {
      shape,
      handle: () => Promise.resolve({ ok: true, status: 200, body: { error: 'invalid_body' } }),
    };
    expect((await appFor([endpoint]).handle(request('{"text":"x"}'))).status).toBe(500);
  });
  test('rejects undeclared statuses and mismatched empty, text and JSON representations', async () => {
    const empty = defineEndpointShape({
      ...echoShape,
      responses: [{ kind: 'empty', status: 204 }],
    });
    const text = defineEndpointShape({
      ...echoShape,
      responses: [{ kind: 'text', status: 200, contentType: 'text/plain' }],
    });
    const cases: BoundEndpoint[] = [
      {
        shape: echoShape,
        handle: () => Promise.resolve({ ok: true, status: 201, body: { echoed: 'x' } }),
      },
      {
        shape: echoShape,
        handle: () => Promise.resolve({ ok: false, status: 503, body: { error: 'snapshot_busy' } }),
      },
      { shape: echoShape, handle: () => Promise.resolve({ ok: true, status: 200, text: 'x' }) },
      {
        shape: text,
        handle: () => Promise.resolve({ ok: true, status: 200, body: { echoed: 'x' } }),
      },
      { shape: empty, handle: () => Promise.resolve({ ok: true, status: 200, body: null }) },
      // A broken untyped binding crosses the heterogeneous adapter boundary.
      {
        shape: empty,
        handle: () => Promise.resolve({ ok: true, status: 204, body: null }),
      } as unknown as BoundEndpoint,
    ];
    for (const endpoint of cases)
      expect((await appFor([endpoint]).handle(request('{"text":"x"}'))).status).toBe(500);
  });
});

function asynchronous<T>(shape: SchemaShape<T>, events: string[], label: string): SchemaShape<T> {
  return {
    ...shape,
    validator: {
      '~standard': {
        version: 1,
        vendor: 'async-probe',
        validate: async (value) => {
          await Promise.resolve();
          events.push(label);
          return shape.validator['~standard'].validate(value);
        },
      },
    },
  };
}

describe('endpoint declaration failures and status preservation', () => {
  test('preserves declared 405, 429, 501 and 503 refusals and their headers', async () => {
    const refusals = [
      {
        status: 405,
        body: { error: 'method_not_allowed' },
        schema: responseSchema(type({ error: "'method_not_allowed'" })),
      },
      {
        status: 429,
        body: { error: 'rate_limited' },
        schema: responseSchema(type({ error: "'rate_limited'" })),
      },
      {
        status: 501,
        body: {
          error: 'unsupported_body_version',
          savedPlanId: 'saved',
          body: 'input',
          version: 2,
          supported: [1],
        },
        schema: responseSchema(
          type({
            error: "'unsupported_body_version'",
            savedPlanId: 'string',
            body: "'input'",
            version: 'number',
            supported: 'number[]',
          }),
        ),
      },
      {
        status: 503,
        body: { error: 'snapshot_busy' },
        schema: responseSchema(type({ error: "'snapshot_busy'" })),
      },
    ] as const;
    for (const refusal of refusals) {
      const shape = defineEndpointShape({ ...echoShape, refusals: [refusal] });
      const endpoint: BoundEndpoint = {
        shape,
        handle: () =>
          Promise.resolve({
            ok: false,
            status: refusal.status,
            body: refusal.body,
            headers: [['Allow', 'GET']],
          }),
      };
      const response = await appFor([endpoint]).handle(request('{"text":"x"}'));
      expect(response.status).toBe(refusal.status);
      expect(await response.json()).toEqual(refusal.body);
      expect(response.headers.get('allow')).toBe('GET');
    }
  });
  test('throws for missing validation refusals and unexpected handler failures', async () => {
    const shape = defineEndpointShape({ ...echoShape, refusals: [] });
    let calls = 0;
    const app = appFor([
      bind(shape, () => {
        calls++;
        throw new Error('storage offline');
      }),
    ]);
    expect((await app.handle(request('{"text":42}'))).status).toBe(500);
    expect(calls).toBe(0);
    expect((await app.handle(request('{"text":"valid"}'))).status).toBe(500);
    expect(calls).toBe(1);
  });
  test('refuses a second binding that disagrees with its admitted endpoint', async () => {
    const seen: string[] = [];
    const first = bind(echoShape, () => {
      seen.push('first');
      return Promise.resolve({ ok: true, status: 200, body: { echoed: 'first' } });
    });
    const second = bind(echoShape, () => {
      seen.push('second');
      return Promise.resolve({ ok: true, status: 200, body: { echoed: 'second' } });
    });
    expect((await appFor([first, second]).handle(request('{"text":"valid"}'))).status).toBe(500);
    expect(seen).toEqual([]);
  });
  test('refuses a text representation on a JSON null endpoint', async () => {
    const shape = defineEndpointShape({
      ...echoShape,
      responses: [{ kind: 'json', status: 200, schema: responseSchema(type('null')) }],
    });
    const endpoint: BoundEndpoint = {
      shape,
      handle: () => Promise.resolve({ ok: true, status: 200, text: 'wrong' }),
    };
    expect((await appFor([endpoint]).handle(request('{"text":"valid"}'))).status).toBe(500);
  });
});

test('retains preparse policies and repeated headers when composed into a parent Elysia app', async () => {
  const app = new Elysia().use(
    appFor([
      bind(writeShape, () =>
        Promise.resolve({
          ok: true,
          status: 200,
          body: { echoed: 'composed' },
          headers: [
            ['Set-Cookie', 'one=1'],
            ['Set-Cookie', 'two=2'],
          ],
        }),
      ),
    ]),
  );
  expect((await app.handle(request('{', { authorization: 'Bearer read' }))).status).toBe(403);
  expect((await app.handle(request('{', { authorization: 'Bearer outage' }))).status).toBe(500);
  const allowed = await app.handle(request('{"text":"x"}', { authorization: 'Bearer write' }));
  expect(allowed.status).toBe(200);
  expect(allowed.headers.getSetCookie()).toEqual(['one=1', 'two=2']);
});

test('leaves an unrelated legacy route parser and error boundary intact', async () => {
  const app = new Elysia()
    .use(
      appFor([
        bind(echoShape, () => Promise.resolve({ ok: true, status: 200, body: { echoed: 'x' } })),
      ]),
    )
    .post('/legacy', ({ body }) => body);
  const response = await app.handle(
    new Request('https://backend.example/legacy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    }),
  );
  expect(response.status).toBe(400);
});

test('delivers resolved user and internal principals and follows declared policy order', async () => {
  const seen: string[] = [];
  const user = appFor([
    bind(writeShape, (input) => {
      seen.push(input.principal.id);
      return Promise.resolve({ ok: true, status: 200, body: { echoed: input.principal.username } });
    }),
  ]);
  expect(
    (await user.handle(request('{"text":"x"}', { authorization: 'Bearer write' }))).status,
  ).toBe(200);
  const internal = defineEndpointShape({
    ...echoShape,
    policies: [{ kind: 'identity', require: 'internal' }],
  });
  const trusted = appFor([
    bind(internal, (input) => {
      seen.push(input.principal.kind);
      return Promise.resolve({ ok: true, status: 200, body: { echoed: input.principal.kind } });
    }),
  ]);
  expect(
    (await trusted.handle(request('{"text":"x"}', { 'x-internal-auth': 'internal' }))).status,
  ).toBe(200);
  expect(seen).toEqual(['ada', 'internal']);
  let resolutions = 0;
  const ordered = mountEndpoints(
    [
      bind(writeShape, () => {
        throw new Error('must not run');
      }),
    ],
    {
      appOrigin: origin,
      resolveIdentity: (requirement, metadata) => {
        resolutions++;
        return resolveIdentity(requirement, metadata);
      },
    },
  );
  const refusal = await ordered.handle(request('{', { cookie: '__Host-wbs_session=x' }));
  expect(refusal.status).toBe(403);
  expect(await refusal.json()).toEqual({ error: 'invalid_origin' });
  expect(resolutions).toBe(0);
});

test('preserves unexpected decoder failures instead of labeling them malformed JSON', async () => {
  const parse = JSON.parse;
  const decoder = spyOn(JSON, 'parse').mockImplementation((source: string, reviver) => {
    if (source === '{"text":"decoder-outage"}') throw new Error('decoder unavailable');
    const decoded: unknown = parse(source, reviver);
    return decoded;
  });
  try {
    const app = appFor([
      bind(echoShape, () => Promise.resolve({ ok: true, status: 200, body: { echoed: 'never' } })),
    ]);
    expect((await app.handle(request('{"text":"decoder-outage"}'))).status).toBe(500);
  } finally {
    decoder.mockRestore();
  }
});

test('accepts every same-status JSON, text and refusal alternative', async () => {
  const shape = defineEndpointShape({
    ...echoShape,
    responses: [
      { kind: 'json', status: 200, schema: responseSchema(type({ first: 'string' })) },
      {
        kind: 'json',
        status: 200,
        schema: asynchronous(responseSchema(type({ second: 'string' })), [], 'reply'),
      },
      { kind: 'text', status: 200, contentType: 'text/plain' },
    ],
    refusals: [
      { status: 400, schema: responseSchema(type({ error: "'invalid_body'" })) },
      { kind: 'empty', status: 400 },
      {
        status: 400,
        schema: asynchronous(responseSchema(type({ error: "'invalid_query'" })), [], 'refusal'),
      },
    ],
  });
  const replies: EndpointReply[] = [
    { ok: true, status: 200, body: { first: 'one' } },
    { ok: true, status: 200, body: { second: 'two' } },
    { ok: true, status: 200, text: 'three' },
    { ok: false, status: 400, body: { error: 'invalid_body' } },
    // Proof: deleting the empty declaration made this response 500 with an undeclared-refusal error.
    { ok: false, status: 400, body: EMPTY },
    { ok: false, status: 400, body: { error: 'invalid_query' } },
  ];
  for (const reply of replies) {
    const response = await appFor([{ shape, handle: () => Promise.resolve(reply) }]).handle(
      request('{"text":"x"}'),
    );
    expect(response.status).toBe(reply.status);
    expect(await response.text()).toBe(
      'text' in reply ? reply.text : reply.body === EMPTY ? '' : JSON.stringify(reply.body),
    );
  }
  const wrong: BoundEndpoint = {
    shape,
    handle: () => Promise.resolve({ ok: true, status: 200, body: { neither: true } }),
  };
  expect((await appFor([wrong]).handle(request('{"text":"x"}'))).status).toBe(500);
});

test('rejects mixed internal and user policies before mounting an erased endpoint table', () => {
  for (const policies of [
    [
      { kind: 'identity', require: 'signed-in' },
      { kind: 'identity', require: 'internal' },
    ],
    [
      { kind: 'identity', require: 'internal' },
      { kind: 'identity', require: 'write-scope' },
    ],
  ] as const) {
    const endpoint: BoundEndpoint = {
      shape: { ...echoShape, policies },
      handle: () => Promise.resolve({ ok: true, status: 200, body: { echoed: 'never' } }),
    };
    expect(() => appFor([endpoint])).toThrow('incompatible identity policies');
  }
});

test('refuses every nonempty undeclared request body without calling the handler', async () => {
  const { body: declaredBody, ...withoutBody } = echoShape;
  void declaredBody;
  const shape = defineEndpointShape(withoutBody);
  let calls = 0;
  const app = appFor([
    bind(shape, () => {
      calls++;
      return Promise.resolve({ ok: true, status: 200, body: { echoed: 'empty' } });
    }),
  ]);
  for (const payload of ['{}', 'null', '{', ' ', 'unexpected']) {
    const response = await app.handle(request(payload));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_body' });
  }
  expect(calls).toBe(0);
  const empty = await app.handle(request(''));
  expect(empty.status).toBe(200);
  expect(calls).toBe(1);
});

test('refuses undeclared query fields while deriving unschematized path params', async () => {
  const shape = defineEndpointShape({ ...echoShape, path: '/echo/:id' });
  const seen: string[] = [];
  const app = appFor([
    bind(shape, (input) => {
      seen.push(input.params.id);
      return Promise.resolve({ ok: true, status: 200, body: { echoed: input.params.id } });
    }),
  ]);
  const send = (suffix: string) =>
    new Request(`https://backend.example/echo/known${suffix}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"text":"x"}',
    });
  const rejected = await app.handle(send('?extra=x'));
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toEqual({ error: 'invalid_query' });
  expect(seen).toEqual([]);
  expect((await app.handle(send(''))).status).toBe(200);
  expect(seen).toEqual(['known']);
});

describe('bound request refusal hooks', () => {
  test('classifies earlier command semantics before a later structural failure without admitting input', async () => {
    const shape = defineEndpointShape({
      ...echoShape,
      body: requestSchema(
        type({ commands: type({ kind: "'setActual'", days: 'number' }).array() }),
      ),
      refusals: [
        {
          status: 400,
          schema: responseSchema(
            type({ error: "'invalid_actual'", at: 'number', kind: "'setActual'" }),
          ),
        },
      ],
    });
    let calls = 0;
    const failures: unknown[] = [];
    const app = appFor([
      bind(
        shape,
        () => {
          calls++;
          return Promise.resolve({ ok: true, status: 200, body: { echoed: 'valid' } });
        },
        {
          classifyRequestFailure: (failure) => {
            failures.push(failure);
            const rejected = failure.rejected;
            if (
              typeof rejected !== 'object' ||
              rejected === null ||
              !('commands' in rejected) ||
              !Array.isArray(rejected.commands)
            )
              throw new Error('unexpected probe input');
            const earlier: unknown = rejected.commands[0];
            if (
              typeof earlier !== 'object' ||
              earlier === null ||
              !('days' in earlier) ||
              earlier.days !== -1
            )
              throw new Error('earlier command lost');
            return {
              ok: false,
              status: 400,
              body: { error: 'invalid_actual', at: 0, kind: 'setActual' },
            };
          },
        },
      ),
    ]);
    const response = await app.handle(
      request('{"commands":[{"kind":"setActual","days":-1},{"kind":"setActual","days":"wrong"}]}'),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_actual', at: 0, kind: 'setActual' });
    expect(calls).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      part: 'body',
      code: 'invalid_body',
      request: { method: 'POST' },
    });
    expect((failures[0] as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
    expect((await app.handle(request('{"commands":[{"kind":"setActual","days":1}]}'))).status).toBe(
      200,
    );
    expect(calls).toBe(1);
    expect(failures).toHaveLength(1);
  });
  test('checks callback HEAD and duplicate keys before query validation or consumption, after policies', async () => {
    const shape = defineEndpointShape({
      method: 'GET',
      path: '/callback',
      operationId: 'callbackPrevalidation',
      policies: [{ kind: 'identity', require: 'signed-in' }],
      query: requestSchema(type({ state: 'string', code: 'string' })),
      responses: [{ kind: 'empty', status: 302 }],
      refusals: [
        {
          status: 400,
          schema: responseSchema(type({ error: "'invalid_query' | 'duplicate_parameter'" })),
        },
        { status: 401, schema: responseSchema(type({ error: "'unauthenticated'" })) },
        { status: 405, schema: responseSchema(type({ error: "'method_not_allowed'" })) },
      ],
      document: { summary: 'Callback probe' },
    });
    let consumed = 0;
    let prevalidated = 0;
    const app = appFor([
      bind(
        shape,
        () => {
          consumed++;
          return Promise.resolve({ ok: true, status: 302, body: EMPTY });
        },
        {
          prevalidate: (metadata) => {
            prevalidated++;
            if (metadata.method === 'HEAD')
              return {
                ok: false,
                status: 405,
                body: { error: 'method_not_allowed' },
                headers: [['Allow', 'GET']],
              };
            const seen = new Set<string>();
            for (const key of metadata.url.searchParams.keys()) {
              if (seen.has(key))
                return { ok: false, status: 400, body: { error: 'duplicate_parameter' } };
              seen.add(key);
            }
            return null;
          },
        },
      ),
    ]);
    const send = (method: string, query: string, authorized = true) =>
      app.handle(
        new Request(`https://backend.example/callback${query}`, {
          method,
          headers: authorized ? { authorization: 'Bearer write' } : {},
        }),
      );
    const head = await send('HEAD', '?extra=x');
    expect(head.status).toBe(405);
    expect(head.headers.get('allow')).toBe('GET');
    expect(head.headers.getSetCookie()).toEqual([]);
    const duplicate = await send('GET', '?state=x&code=a&code=b&extra=x');
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toEqual({ error: 'duplicate_parameter' });
    expect(duplicate.headers.getSetCookie()).toEqual([]);
    expect(consumed).toBe(0);
    expect((await send('HEAD', '?extra=x', false)).status).toBe(401);
    expect(prevalidated).toBe(2);
    expect((await send('GET', '?state=x&code=a')).status).toBe(302);
    expect(consumed).toBe(1);
  });
  test('accepts arbitrary singleton query keys and refuses a repeated key before the handler', async () => {
    const shape = defineEndpointShape({
      method: 'GET',
      path: '/open-query',
      operationId: 'openQuery',
      policies: [],
      query: requestSchema(type({ '[string]': 'string' })),
      queryMode: 'arbitrary-singleton',
      responses: [{ kind: 'json', status: 200, schema: responseSchema(type({ seen: 'string' })) }],
      refusals: [
        {
          status: 400,
          schema: responseSchema(type({ error: "'invalid_query' | 'duplicate_parameter'" })),
        },
      ],
      document: { summary: 'Open query' },
    });
    const seen: Record<string, string>[] = [];
    const failures: RequestFailure[] = [];
    const app = appFor([
      bind(
        shape,
        ({ query }) => {
          seen.push(query);
          return Promise.resolve({
            ok: true,
            status: 200,
            body: { seen: query['provider_extra'] },
          });
        },
        {
          classifyRequestFailure: (failure) => {
            failures.push(failure);
            return Promise.resolve({
              ok: false,
              status: 400,
              body: {
                error:
                  failure.part === 'query' && failure.duplicate !== undefined
                    ? 'duplicate_parameter'
                    : 'invalid_query',
              },
            });
          },
        },
      ),
    ]);
    const accepted = await app.handle(
      new Request('https://backend.example/open-query?provider_extra=a%20b&state=s'),
    );
    expect(accepted.status).toBe(200);
    expect(seen).toEqual([{ provider_extra: 'a b', state: 's' }]);
    const duplicate = await app.handle(
      new Request('https://backend.example/open-query?state=first&provider_extra=x&state=last'),
    );
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toEqual({ error: 'duplicate_parameter' });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      part: 'query',
      code: 'invalid_query',
      duplicate: 'state',
      rejected: { state: 'last', provider_extra: 'x' },
    });
    expect(seen).toHaveLength(1);
  });
  test('validates classifier status and body, rejects successful hook replies, and preserves hook failures', async () => {
    const boundaries = [
      {
        classifyRequestFailure: () => ({ ok: false, status: 429, body: { error: 'invalid_body' } }),
      },
      { classifyRequestFailure: () => ({ ok: true, status: 200, body: { echoed: 'bypass' } }) },
      { prevalidate: () => ({ ok: true, status: 200, body: { echoed: 'bypass' } }) },
      { prevalidate: () => ({ ok: false, status: 429, body: { error: 'invalid_body' } }) },
      {
        classifyRequestFailure: () => {
          throw new Error('classifier outage');
        },
      },
      {
        prevalidate: () => {
          throw new Error('prevalidation outage');
        },
      },
    ];
    let calls = 0;
    for (const boundary of boundaries) {
      // Intentionally broken untyped composition crosses the erased table boundary.
      const endpoint = {
        shape: echoShape,
        handle: () => {
          calls++;
          return Promise.resolve({ ok: true, status: 200, body: { echoed: 'never' } });
        },
        ...boundary,
      } as unknown as BoundEndpoint;
      expect((await appFor([endpoint]).handle(request('{"text":42}'))).status).toBe(500);
    }
    expect(calls).toBe(0);
  });
});

test('classifies params, query, body and JSON failures with their exact rejected boundary values', async () => {
  const shape = defineEndpointShape({
    ...echoShape,
    path: '/echo/:id',
    params: requestSchema(type({ id: "'known'" })),
    query: requestSchema(type({ q: "'known'" })),
    refusals: [
      { status: 422, schema: responseSchema(type({ error: "'malformed'", field: "'body'" })) },
    ],
  });
  const failures: RequestFailure[] = [];
  const app = appFor([
    bind(
      shape,
      () => {
        throw new Error('must not run');
      },
      {
        classifyRequestFailure: (failure) => {
          failures.push(failure);
          return Promise.resolve({
            ok: false,
            status: 422,
            body: { error: 'malformed', field: 'body' },
          });
        },
      },
    ),
  ]);
  const cases = [
    {
      path: '/echo/wrong?q=known',
      source: '{"text":"x"}',
      part: 'params',
      code: 'invalid_params',
      rejected: { id: 'wrong' },
      issues: true,
    },
    {
      path: '/echo/known?q=wrong',
      source: '{"text":"x"}',
      part: 'query',
      code: 'invalid_query',
      rejected: { q: 'wrong' },
      issues: true,
    },
    {
      path: '/echo/known?q=known',
      source: '{"text":42}',
      part: 'body',
      code: 'invalid_body',
      rejected: { text: 42 },
      issues: true,
    },
    {
      path: '/echo/known?q=known',
      source: '{',
      part: 'body',
      code: 'invalid_json',
      rejected: '{',
      issues: false,
    },
  ];
  for (const candidate of cases) {
    const response = await app.handle(
      new Request(`https://backend.example${candidate.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: candidate.source,
      }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'malformed', field: 'body' });
    const failure = failures.at(-1);
    expect(failure).toMatchObject({
      part: candidate.part,
      code: candidate.code,
      rejected: candidate.rejected,
    });
    expect(failure?.request.url.pathname).toBe(
      new URL(`https://backend.example${candidate.path}`).pathname,
    );
    expect(failure?.issues !== undefined).toBe(candidate.issues);
  }
  expect(failures).toHaveLength(4);
});

test('awaits metadata prevalidation before reading a request body', async () => {
  let release: (refusal: {
    ok: false;
    status: 403;
    body: { error: 'invalid_origin' };
  }) => void = () => {
    throw new Error('prevalidation has not started');
  };
  let entered: () => void = () => {
    throw new Error('prevalidation signal missing');
  };
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const app = appFor([
    bind(
      echoShape,
      () => {
        throw new Error('must not run');
      },
      {
        prevalidate: () =>
          new Promise((resolve) => {
            release = resolve;
            entered();
          }),
      },
    ),
  ]);
  const inbound = request('{');
  const response = app.handle(inbound);
  await started;
  expect(inbound.bodyUsed).toBe(false);
  release({ ok: false, status: 403, body: { error: 'invalid_origin' } });
  expect((await response).status).toBe(403);
  expect(inbound.bodyUsed).toBe(false);
});

test('decodes declared URL encoded and multipart bodies without coercing or dropping fields', async () => {
  const app = appFor([
    bind(
      defineEndpointShape({
        ...echoShape,
        bodyMedia: ['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data'],
      }),
      ({ body }) => Promise.resolve({ ok: true, status: 200, body: { echoed: body.text } }),
    ),
  ]);
  for (const media of ['urlencoded', 'multipart']) {
    for (const entries of [
      [['text', '  Form + value  ']],
      [
        ['text', 'first'],
        ['text', 'second'],
      ],
      [
        ['text', 'valid'],
        ['extra', 'x'],
      ],
    ]) {
      const body = media === 'urlencoded' ? new URLSearchParams() : new FormData();
      for (const [name, value] of entries) body.append(name, value);
      const inbound = new Request('https://backend.example/echo', { method: 'POST', body });
      const response = await app.handle(inbound);
      expect(response.status).toBe(entries.length === 1 ? 200 : 400);
      expect(await response.json()).toEqual(
        entries.length === 1 ? { echoed: '  Form + value  ' } : { error: 'invalid_body' },
      );
      expect(inbound.bodyUsed).toBe(true);
    }
  }
  const form = new FormData();
  form.append('text', new File([new Uint8Array([255, 0, 128])], 'binary.bin'));
  const response = await app.handle(
    new Request('https://backend.example/echo', { method: 'POST', body: form }),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'invalid_body' });
});

test('models malformed multipart syntax but preserves unexpected parser and stream failures', async () => {
  const app = appFor([
    bind(
      defineEndpointShape({
        ...echoShape,
        bodyMedia: ['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data'],
      }),
      ({ body }) => Promise.resolve({ ok: true, status: 200, body: { echoed: body.text } }),
    ),
  ]);
  for (const contentType of ['multipart/form-data', 'multipart/form-data; boundary=abc']) {
    const response = await app.handle(request('broken', { 'content-type': contentType }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_body' });
  }
  const parser = spyOn(Response.prototype, 'formData').mockRejectedValue(
    new TypeError('parser unavailable'),
  );
  try {
    expect(
      (await app.handle(request('broken', { 'content-type': 'multipart/form-data; boundary=abc' })))
        .status,
    ).toBe(500);
  } finally {
    parser.mockRestore();
  }
  const broken = new Request('https://backend.example/echo', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=abc' },
    body: new ReadableStream({
      start(controller) {
        controller.error(new TypeError('stream unavailable'));
      },
    }),
  });
  expect((await app.handle(broken)).status).toBe(500);
});

test('checks policies and metadata before consuming form bodies', async () => {
  const guarded = appFor([
    bind(writeShape, () => {
      throw new Error('unreachable');
    }),
  ]);
  const denied = request('broken', {
    'content-type': 'multipart/form-data; boundary=abc',
    authorization: 'Bearer read',
  });
  expect((await guarded.handle(denied)).status).toBe(403);
  expect(denied.bodyUsed).toBe(false);
  const prevalidated = appFor([
    bind(
      echoShape,
      () => {
        throw new Error('unreachable');
      },
      {
        prevalidate: () => ({ ok: false, status: 403, body: { error: 'invalid_origin' } }),
      },
    ),
  ]);
  const refused = request('broken', { 'content-type': 'multipart/form-data; boundary=abc' });
  expect((await prevalidated.handle(refused)).status).toBe(403);
  expect(refused.bodyUsed).toBe(false);
});

test('refuses missing or undeclared body media without guessing JSON from the bytes', async () => {
  const app = appFor([
    bind(echoShape, ({ body }) =>
      Promise.resolve({ ok: true, status: 200, body: { echoed: body.text } }),
    ),
  ]);
  for (const media of [
    undefined,
    'text/plain',
    'application/x-custom',
    'application/octet-stream',
    'application/x-www-form-urlencoded',
    'multipart/form-data; boundary=x',
  ]) {
    for (const source of ['{"text":"valid"}', '{']) {
      const inbound = request(source);
      if (media === undefined) inbound.headers.delete('content-type');
      else inbound.headers.set('content-type', media);
      const response = await app.handle(inbound);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_body' });
    }
  }
});

test('rejects malformed erased media configuration when mounting', () => {
  for (const bodyMedia of [[], ['text/plain'], ['application/json']]) {
    const shape = {
      ...echoShape,
      bodyMedia,
      ...(bodyMedia[0] === 'application/json' ? { body: undefined } : {}),
    };
    expect(() =>
      appFor([
        {
          shape: shape as unknown as typeof echoShape,
          handle: () => Promise.resolve({ ok: true, status: 200, body: { echoed: 'x' } }),
        },
      ]),
    ).toThrow();
  }
});

test('rejects a malformed erased arbitrary-singleton query when mounting', () => {
  const endpoint: BoundEndpoint = {
    shape: { ...echoShape, queryMode: 'arbitrary-singleton' } as unknown as typeof echoShape,
    handle: () => Promise.resolve({ ok: true, status: 200, body: { echoed: 'x' } }),
  };
  expect(() => appFor([endpoint])).toThrow('arbitrary-singleton query');
});

test('refuses an array masquerading as an optional-only object before invoking the mounted handler', async () => {
  let calls = 0;
  const shape = defineEndpointShape({
    ...echoShape,
    body: requestSchema(type({ patch: { 'name?': 'string' } })),
  });
  const app = appFor([
    bind(shape, () => {
      calls++;
      return Promise.resolve({ ok: true, status: 200, body: { echoed: 'ok' } });
    }),
  ]);
  const refused = await app.handle(request('{"patch":[]}'));
  expect(refused.status).toBe(400);
  expect(await refused.json()).toEqual({ error: 'invalid_body' });
  expect(calls).toBe(0);
  expect((await app.handle(request('{"patch":{}}'))).status).toBe(200);
  expect(calls).toBe(1);
});

test('distinguishes absent required bodies from explicitly empty form and JSON bytes', async () => {
  const shape = defineEndpointShape({
    ...echoShape,
    body: requestSchema(type({ 'name?': 'string' })),
    bodyMedia: ['application/json', 'application/x-www-form-urlencoded'],
  });
  let calls = 0;
  const app = appFor([
    bind(shape, () => {
      calls++;
      return Promise.resolve({ ok: true, status: 200, body: { echoed: 'empty' } });
    }),
  ]);
  for (const media of ['application/json', 'application/x-www-form-urlencoded']) {
    const absent = await app.handle(
      new Request('https://backend.example/echo', {
        method: 'POST',
        headers: { 'content-type': media },
      }),
    );
    expect(absent.status).toBe(400);
    expect(await absent.json()).toEqual({ error: 'invalid_body' });
  }
  expect(calls).toBe(0);
  const emptyForm = await app.handle(
    request('', { 'content-type': 'application/x-www-form-urlencoded' }),
  );
  expect(emptyForm.status).toBe(200);
  expect(calls).toBe(1);
  const emptyJson = await app.handle(request(''));
  expect(emptyJson.status).toBe(400);
  expect(await emptyJson.json()).toEqual({ error: 'invalid_json' });
  expect(calls).toBe(1);
});
