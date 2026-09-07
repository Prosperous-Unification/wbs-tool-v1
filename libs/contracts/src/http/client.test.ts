import { type } from 'arktype';
import { describe, expect, test } from 'bun:test';

import { clientFromShapes, preflightRequest } from './client';
import { ClientConfigurationError } from './client-error';
import { fetchTransport } from './client-fetch';
import type { ClientTransport, TransportReply } from './client-types';
import { defineEndpointShape } from './endpoint-shape';
import { retryProjectOptimization } from './project-shapes';
import { requestSchema, responseSchema, type SchemaShape } from './schema-shape';

const read = defineEndpointShape({
  method: 'GET',
  path: '/projects/:id',
  operationId: 'readProject',
  policies: [],
  query: requestSchema(type({ 'filter?': 'string' })),
  responses: [
    {
      kind: 'json',
      status: 200,
      schema: responseSchema(type({ project: { id: 'string', name: 'string' } })),
    },
  ],
  refusals: [
    { status: 429, schema: responseSchema(type({ error: "'rate_limited'" })) },
    { status: 503, schema: responseSchema(type({ error: "'snapshot_busy'" })) },
    {
      status: 501,
      schema: responseSchema(
        type({
          error: "'unsupported_body_version'",
          savedPlanId: 'string',
          body: "'input' | 'schedule'",
          version: 'number',
          supported: 'number[]',
        }),
      ),
    },
  ],
  document: { summary: 'Read' },
});
const write = defineEndpointShape({
  method: 'POST',
  path: '/projects/:id',
  operationId: 'writeProject',
  policies: [],
  body: requestSchema(type({ name: 'string' })),
  responses: [{ kind: 'empty', status: 204 }],
  refusals: [],
  document: { summary: 'Write' },
});
const headers = { 'content-type': 'application/json', 'x-probe': 'preserved' };
const good = { project: { id: 'p', name: 'Plan' } };
const input = { params: { id: 'p' } };

function returning(reply: TransportReply): ClientTransport {
  return () => Promise.resolve(reply);
}

describe('shape-derived client response boundary', () => {
  test('preserves a declared bodyless refusal through the portable client', async () => {
    const shape = defineEndpointShape({
      method: 'GET',
      path: '/callback',
      operationId: 'completeCallback',
      policies: [],
      responses: [{ kind: 'empty', status: 302 }],
      refusals: [{ kind: 'empty', status: 503 }],
      document: { summary: 'Complete callback' },
    });
    // Proof: decoding empty bodies only for successes returned
    // `{ kind: 'failure', failure: { code: 'invalid_response', reason: 'json', status: 503 } }`.
    expect(
      await clientFromShapes([shape], () =>
        Promise.resolve(new Response(null, { status: 503 })),
      ).completeCallback({}),
    ).toMatchObject({ kind: 'refusal', representation: 'empty', status: 503 });
  });

  test('validates an in-process response while retaining additive nested fields', async () => {
    const transport = returning({
      kind: 'json',
      status: 200,
      body: { project: { ...good.project, added: { future: true } } },
      headers,
    });
    const reply = await clientFromShapes([read], transport).readProject(input);
    expect(reply.kind).toBe('success');
    if (reply.kind !== 'success') throw new Error('expected JSON success');
    expect(reply.body.project.name).toBe('Plan');
    const expected = { project: { ...good.project, added: { future: true } } };
    expect(reply.body).toEqual(expected);
    expect(reply.headers.get('x-probe')).toBe('preserved');
  });
  test('refuses a backend-only known field type change', async () => {
    const reply = await clientFromShapes(
      [read],
      returning({ kind: 'json', status: 200, body: { project: { id: 'p', name: 42 } } }),
    ).readProject(input);
    expect(reply).toMatchObject({
      kind: 'failure',
      failure: { code: 'invalid_response', reason: 'schema', status: 200 },
    });
  });
  test.each([
    { status: 429, body: { error: 'rate_limited' } },
    { status: 503, body: { error: 'snapshot_busy' } },
    {
      status: 501,
      body: {
        error: 'unsupported_body_version',
        savedPlanId: 's',
        body: 'input',
        version: 2,
        supported: [1],
      },
    },
  ])(
    'validates refusal at status $status and rejects malformed details',
    async ({ status, body }) => {
      const accepted = await clientFromShapes(
        [read],
        returning({ kind: 'json', status, body }),
      ).readProject(input);
      expect(accepted).toMatchObject({ kind: 'refusal', status, body });
      const invalid = await clientFromShapes(
        [read],
        returning({ kind: 'json', status, body: { ...body, error: 42 } }),
      ).readProject(input);
      expect(invalid).toMatchObject({
        kind: 'failure',
        failure: { code: 'invalid_response', status },
      });
    },
  );
  test('refuses undeclared statuses and mismatched refusal status/body pairs', async () => {
    expect(
      await clientFromShapes(
        [read],
        returning({ kind: 'json', status: 201, body: good }),
      ).readProject(input),
    ).toMatchObject({ kind: 'failure', failure: { code: 'unexpected_status', status: 201 } });
    expect(
      await clientFromShapes(
        [read],
        returning({ kind: 'json', status: 429, body: { error: 'snapshot_busy' } }),
      ).readProject(input),
    ).toMatchObject({ kind: 'failure', failure: { code: 'invalid_response', status: 429 } });
  });
  test('awaits asynchronous validators and throws unexpected validator errors', async () => {
    const shape = defineEndpointShape({
      ...read,
      responses: [{ kind: 'json', status: 200, schema: asynchronous(read.responses[0].schema) }],
    });
    const client = clientFromShapes(
      [shape],
      returning({ kind: 'json', status: 200, body: { project: { id: 'p', name: 42 } } }),
    );
    expect(await client.readProject(input)).toMatchObject({
      kind: 'failure',
      failure: { code: 'invalid_response' },
    });
    const broken = {
      ...shape,
      responses: [
        {
          kind: 'json',
          status: 200,
          schema: {
            ...shape.responses[0].schema,
            validator: {
              '~standard': {
                version: 1,
                vendor: 'broken',
                validate: () => {
                  throw new Error('validator outage');
                },
              },
            },
          },
        },
      ],
    } as const;
    expect(
      await rejection(
        clientFromShapes(
          [broken],
          returning({ kind: 'json', status: 200, body: good }),
        ).readProject(input),
      ),
    ).toMatchObject({ message: 'validator outage' });
  });
  test('supports later response alternatives, JSON null, explicit empty and text', async () => {
    const shape = defineEndpointShape({
      ...read,
      responses: [
        { kind: 'json', status: 200, schema: responseSchema(type('null')) },
        ...read.responses,
        { kind: 'text', status: 200, contentType: 'text/plain' },
        { kind: 'empty', status: 302 },
      ],
    });
    for (const response of [
      { kind: 'json', status: 200, body: good },
      { kind: 'json', status: 200, body: null },
      { kind: 'text', status: 200, text: 'metrics' },
      {
        kind: 'empty',
        status: 302,
        headers: [
          ['Location', '/login'],
          ['Set-Cookie', 'one=1'],
          ['Set-Cookie', 'two=2'],
        ],
      },
    ] satisfies TransportReply[]) {
      const reply = await clientFromShapes([shape], returning(response)).readProject(input);
      expect(reply.kind).toBe('success');
      if (reply.kind !== 'success') throw new Error('expected success');
      expect(reply.representation).toBe(response.kind);
      if (reply.status === 302) {
        expect(reply.headers.get('location')).toBe('/login');
        expect(reply.headers.getSetCookie()).toEqual(['one=1', 'two=2']);
      }
    }
    expect(
      await clientFromShapes([read], returning({ kind: 'empty', status: 200 })).readProject(input),
    ).toMatchObject({ kind: 'failure', failure: { reason: 'representation' } });
  });
});

describe('client request and transport boundary', () => {
  test('encodes path literals, slash-containing params, optional query and JSON body through fetch', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const transport = fetchTransport('https://example.test/base/', (url, init) => {
      sent.push({ url, init });
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const shape = defineEndpointShape({
      ...write,
      path: '/project notes/:id',
      query: requestSchema(type({ 'filter?': 'string' })),
    });
    const abort = new AbortController();
    const reply = await clientFromShapes([shape], transport).writeProject({
      params: { id: 'a/b ?#' },
      query: { filter: 'x&y' },
      body: { name: 'Plan' },
      headers: { 'x-wbs-token': 'credential' },
      signal: abort.signal,
    });
    expect(reply).toMatchObject({ kind: 'success', representation: 'empty', status: 204 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('https://example.test/project%20notes/a%2Fb%20%3F%23?filter=x%26y');
    expect(sent[0]?.init.body).toBe('{"name":"Plan"}');
    expect(new Headers(sent[0]?.init.headers).get('x-wbs-token')).toBe('credential');
    expect(sent[0]?.init.signal).toBe(abort.signal);
    expect(sent[0]?.init.redirect).toBe('manual');
  });
  test('validates request input before invoking transport and does not share calls', async () => {
    let calls = 0;
    const client = clientFromShapes([write], () => {
      calls++;
      return Promise.resolve({ kind: 'empty', status: 204 });
    });
    // A caller without TypeScript crosses the same runtime boundary.
    const malformed = { params: { id: 'p' }, body: { name: 'Plan', extra: true } };
    expect(await client.writeProject(malformed)).toMatchObject({
      kind: 'failure',
      failure: { code: 'invalid_request', part: 'body' },
    });
    expect(calls).toBe(0);
    await Promise.all([
      client.writeProject({ ...input, body: { name: 'a' } }),
      client.writeProject({ ...input, body: { name: 'b' } }),
    ]);
    expect(calls).toBe(2);
  });
  test('distinguishes transport failure and cancellation without invoking an already aborted request', async () => {
    const outage = new Error('network offline');
    expect(
      await clientFromShapes([read], () => Promise.reject(outage)).readProject(input),
    ).toMatchObject({ kind: 'failure', failure: { code: 'transport', cause: outage } });
    const abort = new AbortController();
    abort.abort();
    let called = false;
    const client = clientFromShapes([read], () => {
      called = true;
      return Promise.resolve({ kind: 'json', status: 200, body: good });
    });
    expect(await client.readProject({ ...input, signal: abort.signal })).toMatchObject({
      kind: 'failure',
      failure: { code: 'cancelled' },
    });
    expect(called).toBe(false);
  });
  test('refuses duplicate operation identifiers instead of replacing a method', () => {
    expect(() =>
      clientFromShapes(
        [read, { ...write, operationId: read.operationId }],
        returning({ kind: 'json', status: 200, body: good }),
      ),
    ).toThrow('Duplicate operationId');
  });
  test('parses Fetch replies without disguising malformed JSON or a proxy challenge', async () => {
    const client = clientFromShapes([read], () =>
      Promise.resolve(new Response('{', { status: 200, headers })),
    );
    expect(await client.readProject(input)).toMatchObject({
      kind: 'failure',
      failure: { code: 'invalid_response', reason: 'json', status: 200 },
    });
    const challenged = await clientFromShapes([read], () =>
      Promise.resolve(
        new Response('proxy', { status: 401, headers: { 'www-authenticate': 'Basic' } }),
      ),
    ).readProject(input);
    expect(challenged.kind).toBe('failure');
    if (challenged.kind !== 'failure' || challenged.failure.code !== 'unexpected_status')
      throw new Error('expected status failure');
    expect(challenged.failure.headers.get('www-authenticate')).toBe('Basic');
  });
});

function asynchronous<T>(schema: SchemaShape<T>): SchemaShape<T> {
  return {
    ...schema,
    validator: {
      '~standard': {
        version: 1,
        vendor: 'async',
        validate: async (value) => {
          await Promise.resolve(undefined);
          return schema.validator['~standard'].validate(value);
        },
      },
    },
  };
}

test('refuses malformed 501 detail despite its recognized error code', async () => {
  const reply = await clientFromShapes(
    [read],
    returning({
      kind: 'json',
      status: 501,
      body: {
        error: 'unsupported_body_version',
        savedPlanId: 's',
        body: 'input',
        version: 'future',
        supported: [1],
      },
    }),
  ).readProject(input);
  expect(reply).toMatchObject({
    kind: 'failure',
    failure: { code: 'invalid_response', reason: 'schema', status: 501 },
  });
});

test('accepts a later same-status asynchronous refusal schema', async () => {
  const shape = defineEndpointShape({
    ...read,
    refusals: [
      { status: 400, schema: responseSchema(type({ error: "'invalid_body'" })) },
      { status: 400, schema: asynchronous(responseSchema(type({ error: "'invalid_query'" }))) },
    ],
  });
  expect(
    await clientFromShapes(
      [shape],
      returning({ kind: 'json', status: 400, body: { error: 'invalid_query' } }),
    ).readProject(input),
  ).toMatchObject({ kind: 'refusal', status: 400, body: { error: 'invalid_query' } });
});

test('cancels while asynchronous response validation is held', async () => {
  let release: () => void = () => {
    throw new Error('validation not started');
  };
  const started = Promise.withResolvers<undefined>();
  const schema: SchemaShape<typeof good> = {
    ...read.responses[0].schema,
    validator: {
      '~standard': {
        version: 1,
        vendor: 'held',
        validate: async (value) => {
          started.resolve(undefined);
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return read.responses[0].schema.validator['~standard'].validate(value);
        },
      },
    },
  };
  const shape = defineEndpointShape({
    ...read,
    responses: [{ kind: 'json', status: 200, schema }],
  });
  const abort = new AbortController();
  const reply = clientFromShapes(
    [shape],
    returning({ kind: 'json', status: 200, body: good }),
  ).readProject({ ...input, signal: abort.signal });
  await started.promise;
  abort.abort();
  release();
  expect(await reply).toMatchObject({ kind: 'failure', failure: { code: 'cancelled' } });
});

test('keeps overlapping GET requests independent while their answers are held', async () => {
  const replies: ((reply: TransportReply) => void)[] = [];
  const client = clientFromShapes(
    [read],
    () =>
      new Promise((resolve) => {
        replies.push(resolve);
      }),
  );
  const first = client.readProject(input);
  const second = client.readProject(input);
  await Bun.sleep(0);
  expect(replies).toHaveLength(2);
  for (const release of replies) release({ kind: 'json', status: 200, body: good });
  expect((await first).kind).toBe('success');
  expect((await second).kind).toBe('success');
});

test('refuses a successful refusal envelope even with a permissive success schema', async () => {
  const shape = defineEndpointShape({
    ...read,
    responses: [{ kind: 'json', status: 200, schema: responseSchema(type('object')) }],
  });
  expect(
    await clientFromShapes(
      [shape],
      returning({ kind: 'json', status: 200, body: { error: 'rate_limited' } }),
    ).readProject(input),
  ).toMatchObject({ kind: 'failure', failure: { code: 'invalid_response' } });
});

test('refuses missing, extra and URL dot-segment params before transport', async () => {
  let calls = 0;
  const client = clientFromShapes([read], () => {
    calls++;
    return Promise.resolve({ kind: 'json', status: 200, body: good });
  });
  for (const params of [{}, { id: 'p', extra: 'x' }, { id: '.' }, { id: '..' }, { id: '' }]) {
    expect(await client.readProject({ params } as { params: { id: string } })).toMatchObject({
      kind: 'failure',
      failure: { code: 'invalid_request', part: 'params' },
    });
  }
  expect(calls).toBe(0);
});

test('passes omitted query fields and performs no implicit body encoding for GET', async () => {
  const captured: { url: string; init: RequestInit }[] = [];
  const client = clientFromShapes(
    [read],
    fetchTransport('https://example.test', (url, init) => {
      captured.push({ url, init });
      return Promise.resolve(Response.json(good));
    }),
  );
  expect((await client.readProject({ ...input, query: { filter: undefined } })).kind).toBe(
    'success',
  );
  expect(captured[0]?.url).toBe('https://example.test/projects/p');
  expect(captured[0]?.init.body).toBeUndefined();
  expect(new Headers(captured[0]?.init.headers).has('content-type')).toBe(false);
});

test('validates optional undefined body fields as the JSON representation sent by both transports', async () => {
  const shape = defineEndpointShape({
    ...write,
    body: requestSchema(type({ name: 'string', 'notes?': 'string' })),
  });
  const received: unknown[] = [];
  const client = clientFromShapes([shape], (_shape, supplied) => {
    received.push(supplied.body);
    return Promise.resolve({ kind: 'empty', status: 204 });
  });
  expect(
    (await client.writeProject({ ...input, body: { name: 'Plan', notes: undefined } })).kind,
  ).toBe('success');
  expect(received).toEqual([{ name: 'Plan' }]);
});

test('preflights synchronous request shapes without yielding and returns their wire normalization', () => {
  const preflight = preflightRequest(write, {
    ...input,
    body: { name: 'Plan', notes: undefined },
  });

  expect(preflight).not.toBeInstanceOf(Promise);
  expect(preflight).toMatchObject({
    kind: 'ready',
    input: { params: { id: 'p' }, body: { name: 'Plan' } },
  });
  expect(
    preflightRequest(write, { ...input, params: { id: '.' }, body: { name: 'Plan' } }),
  ).toMatchObject({ kind: 'failure', failure: { code: 'invalid_request', part: 'params' } });
});

test('forwards the Retry validator projected body to the transport', async () => {
  const received: unknown[] = [];
  const client = clientFromShapes([retryProjectOptimization], (_shape, supplied) => {
    received.push(supplied.body);
    return Promise.resolve({
      kind: 'json',
      status: 202,
      body: { state: 'retrying', generation: 1, inputHash: 'held-hash' },
    });
  });
  const supplied = {
    params: { id: 'p' },
    body: { objective: 'pri', inputHash: 'held-hash', ignored: 'future-field' },
  } as const;

  expect((await client.postApiProjectsByIdOptimizationRetry(supplied)).kind).toBe('success');
  // Proof: discarding the synchronous validator's value retained
  // `ignored: 'future-field'` in the body received here.
  expect(received).toEqual([{ objective: 'pri', inputHash: 'held-hash' }]);
});

test('forwards an asynchronous validator normalized value to the transport', async () => {
  const normalizing: SchemaShape<{ name: string }> = {
    ...write.body,
    validator: {
      '~standard': {
        version: 1,
        vendor: 'async-normalizing-probe',
        async validate(value: unknown) {
          await Promise.resolve(undefined);
          if (
            typeof value !== 'object' ||
            value === null ||
            !('name' in value) ||
            typeof value.name !== 'string'
          ) {
            return { issues: [{ message: 'name missing' }] };
          }
          return { value: { name: value.name } };
        },
      },
    },
  };
  const shape = defineEndpointShape({ ...write, body: normalizing });
  const received: unknown[] = [];
  const client = clientFromShapes([shape], (_shape, supplied) => {
    received.push(supplied.body);
    return Promise.resolve({ kind: 'empty', status: 204 });
  });
  const supplied = { ...input, body: { name: 'Plan', ignored: 'future-field' } };

  expect((await client.writeProject(supplied)).kind).toBe('success');
  // Proof: discarding the asynchronous validator's value retained
  // `ignored: 'future-field'` in the body received here.
  expect(received).toEqual([{ name: 'Plan' }]);
});

test('starts transport in the calling stack after synchronous request validation', async () => {
  const reply = Promise.withResolvers<TransportReply>();
  let calls = 0;
  const client = clientFromShapes([write], () => {
    calls += 1;
    return reply.promise;
  });

  const first = client.writeProject({ ...input, body: { name: 'One' } });
  const second = client.writeProject({ ...input, body: { name: 'Two' } });

  expect(calls).toBe(2);
  reply.resolve({ kind: 'empty', status: 204 });
  expect(await Promise.all([first, second])).toMatchObject([
    { kind: 'success' },
    { kind: 'success' },
  ]);
});

test('keeps preflight asynchronous when a request schema validates asynchronously', async () => {
  const shape = defineEndpointShape({ ...write, body: asynchronous(write.body) });
  const preflight = preflightRequest(shape, { ...input, body: { name: 'Plan' } });

  expect(preflight).toBeInstanceOf(Promise);
  expect(await preflight).toMatchObject({ kind: 'ready', input: { body: { name: 'Plan' } } });
});

test('reports non-JSON client bodies before transport without hiding unexpected serialization failures', async () => {
  let calls = 0;
  const client = clientFromShapes([write], () => {
    calls++;
    return Promise.resolve({ kind: 'empty', status: 204 });
  });
  const circular: Record<string, unknown> = { name: 'x' };
  circular['self'] = circular;
  for (const body of [circular, Symbol('not JSON'), { name: 1n }]) {
    expect(
      await client.writeProject({ ...input, body } as unknown as {
        params: { id: string };
        body: { name: string };
      }),
    ).toMatchObject({ kind: 'failure', failure: { code: 'invalid_request', part: 'body' } });
  }
  const broken = {
    get name(): string {
      throw new Error('application getter failed');
    },
  };
  expect(await rejection(client.writeProject({ ...input, body: broken }))).toMatchObject({
    message: 'application getter failed',
  });
  expect(calls).toBe(0);
});

test('preserves transport encoding failures when a composed transport corrupts validated input', async () => {
  const send = fetchTransport('https://example.test', () => Promise.resolve(Response.json(good)));
  for (const corrupt of [{ params: {} }, { query: ['wrong'] }, { query: { filter: 42 } }]) {
    const client = clientFromShapes([read], (shape, supplied) =>
      send(shape, { ...supplied, ...corrupt }),
    );
    expect(await rejection(client.readProject(input))).toBeInstanceOf(Error);
  }
});

test('cancels after held request validation and after a held transport without returning a success', async () => {
  let resolveTransport: (reply: TransportReply) => void = () => {
    throw new Error('transport not started');
  };
  const entered = Promise.withResolvers<undefined>();
  const abort = new AbortController();
  const client = clientFromShapes(
    [read],
    () =>
      new Promise((resolve) => {
        resolveTransport = resolve;
        entered.resolve(undefined);
      }),
  );
  const response = client.readProject({ ...input, signal: abort.signal });
  await entered.promise;
  abort.abort();
  resolveTransport({ kind: 'json', status: 200, body: good });
  expect(await response).toMatchObject({ kind: 'failure', failure: { code: 'cancelled' } });

  const validating = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const bodySchema: SchemaShape<{ name: string }> = {
    ...write.body,
    validator: {
      '~standard': {
        version: 1,
        vendor: 'held',
        validate: async (value) => {
          validating.resolve(undefined);
          await release.promise;
          return write.body.validator['~standard'].validate(value);
        },
      },
    },
  };
  const shape = defineEndpointShape({ ...write, body: bodySchema });
  const cancelled = new AbortController();
  let transported = false;
  const writing = clientFromShapes([shape], () => {
    transported = true;
    return Promise.resolve({ kind: 'empty', status: 204 });
  }).writeProject({ ...input, body: { name: 'x' }, signal: cancelled.signal });
  await validating.promise;
  cancelled.abort();
  release.resolve(undefined);
  expect(await writing).toMatchObject({ kind: 'failure', failure: { code: 'cancelled' } });
  expect(transported).toBe(false);
});

test('returns boundary failure for an unreadable Fetch response body', async () => {
  const outage = new Error('stream unavailable');
  const stream = new ReadableStream({
    start(controller) {
      controller.error(outage);
    },
  });
  const client = clientFromShapes([read], () =>
    Promise.resolve(new Response(stream, { status: 200, headers })),
  );
  expect(await client.readProject(input)).toMatchObject({
    kind: 'failure',
    failure: { code: 'transport', cause: outage },
  });
});

test('rejects blank operation identifiers consistently with shape document emission', () => {
  for (const operationId of ['', ' ', '\t'])
    expect(() =>
      clientFromShapes(
        [{ ...read, operationId }],
        returning({ kind: 'json', status: 200, body: good }),
      ),
    ).toThrow('operationId');
});

test('cancels an unread Fetch body before reporting an undeclared status', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const client = clientFromShapes([read], () =>
    Promise.resolve(new Response(stream, { status: 502 })),
  );
  expect(await client.readProject(input)).toMatchObject({
    kind: 'failure',
    failure: { code: 'unexpected_status', status: 502 },
  });
  expect(cancelled).toBe(true);
});

test('propagates a required response-body cleanup failure', async () => {
  const outage = new Error('cleanup failed');
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      throw outage;
    },
  });
  expect(
    await rejection(
      clientFromShapes([read], () =>
        Promise.resolve(new Response(stream, { status: 502 })),
      ).readProject(input),
    ),
  ).toMatchObject({ message: 'cleanup failed' });
});

test('rejects malformed normalized text before returning a typed text success', async () => {
  const shape = defineEndpointShape({
    ...read,
    responses: [{ kind: 'text', status: 200, contentType: 'text/plain' }],
  });
  const malformed = { kind: 'text', status: 200, text: 42 } as unknown as TransportReply;
  expect(await clientFromShapes([shape], returning(malformed)).readProject(input)).toMatchObject({
    kind: 'failure',
    failure: { code: 'invalid_response', status: 200 },
  });
});

test('throws for a trusted query declaration that cannot be represented on the wire', async () => {
  const shape = defineEndpointShape({ ...read, query: requestSchema(type({ filter: 'number' })) });
  const client = clientFromShapes(
    [shape],
    fetchTransport('https://example.test', () => Promise.resolve(Response.json(good))),
  );
  expect(await rejection(client.readProject({ ...input, query: { filter: 42 } }))).toMatchObject({
    message: 'Query schema must describe string values',
  });
});

async function rejection(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (cause) {
    return cause;
  }
  throw new Error('Expected promise to reject');
}

test('refuses JSON fetch configuration for a form-only declaration before sending', async () => {
  let sent = false;
  const shape = defineEndpointShape({ ...write, bodyMedia: ['multipart/form-data'] });
  const client = clientFromShapes(
    [shape],
    fetchTransport('https://example.test', () => {
      sent = true;
      return Promise.resolve(new Response(null, { status: 204 }));
    }),
  );
  expect(
    await rejection(client.writeProject({ params: { id: 'p' }, body: { name: 'x' } })),
  ).toBeInstanceOf(ClientConfigurationError);
  expect(sent).toBe(false);
});
