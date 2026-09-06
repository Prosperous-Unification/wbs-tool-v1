import { ValidationError } from '@wbs/validation';
import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';

import { type InternalDeps, internalRoutes } from '../../controller/internal.routes';
import { testAuthService } from '../../testing/auth-fixture';
import { identityResolver } from '../identity';
import { mountEndpoints } from './mount';

const secret = 'internal-test-secret';
function appFor(deps: InternalDeps) {
  return new Elysia().use(
    mountEndpoints(internalRoutes(deps), {
      appOrigin: 'https://app.example',
      resolveIdentity: identityResolver(testAuthService(), secret),
    }),
  );
}
function request(route: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://backend.example/internal/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-auth': secret, ...headers },
    body: JSON.stringify(body),
  });
}

test('mounted internal forms preserve duplicate arbitrary payloads and all context headers', async () => {
  const calls: unknown[] = [];
  const app = appFor({
    onForward: (message, context) => {
      calls.push({ message, context });
      return Promise.resolve({});
    },
    onResume: () => Promise.resolve({}),
  });
  for (const media of ['urlencoded', 'multipart']) {
    const form = media === 'urlencoded' ? new URLSearchParams() : new FormData();
    form.append('message', 'hello');
    form.append('message', 'world');
    form.append('trace_id', 'trace');
    const response = await app.handle(
      new Request('https://backend.example/internal/forward', {
        method: 'POST',
        headers: {
          'x-internal-auth': secret,
          'x-client-id': 'client',
          'x-connection-id': 'connection',
        },
        body: form,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ack: true });
  }
  expect(calls).toEqual(
    Array.from({ length: 2 }, () => ({
      message: ['hello', 'world'],
      context: { clientId: 'client', connectionId: 'connection', traceId: 'trace' },
    })),
  );
});

test('mounted resume admits legacy arrays and fractional cursors with unchanged entries', async () => {
  const calls: Record<string, number>[] = [];
  const app = appFor({
    onForward: () => Promise.resolve({}),
    onResume: (points) => {
      calls.push(points);
      return Promise.resolve({});
    },
  });
  for (const resume_points of [[], [-1, 0.5], { p: -1, q: 0.5 }]) {
    const response = await app.handle(request('resume', { resume_points, trace_id: 't' }));
    expect(response.status).toBe(200);
  }
  expect(calls).toEqual([{}, { '0': -1, '1': 0.5 }, { p: -1, q: 0.5 }]);
});

test('mounted internal callbacks keep unknown validation failures as server failures', async () => {
  for (const failure of [
    new Error('unavailable'),
    new ValidationError('trusted callback invalid'),
  ]) {
    const app = appFor({
      onForward: () => {
        return Promise.reject(failure);
      },
      onResume: () => {
        return Promise.reject(failure);
      },
    });
    expect((await app.handle(request('forward', { message: {}, trace_id: 't' }))).status).toBe(500);
    expect((await app.handle(request('resume', { resume_points: {}, trace_id: 't' }))).status).toBe(
      500,
    );
  }
});

test('mounted internal replies validate replay events and denial reasons before trusting them', async () => {
  for (const response of [
    { p: { status: 'replaying' } },
    { p: { status: 'replaying', events: [{ seq: '0', message: {} }] } },
    { p: { status: 'replaying', events: [{ seq: 0 }] } },
    { p: { status: 'denied', reason: 'unavailable' } },
  ]) {
    const app = appFor({
      onForward: () => Promise.resolve({}),
      onResume: () => Promise.resolve(response as never),
    });
    expect((await app.handle(request('resume', { resume_points: {}, trace_id: 't' }))).status).toBe(
      500,
    );
  }
  const historical = {
    p: {
      status: 'replaying' as const,
      events: [{ seq: 0, message: ['old', { value: null }], future: true }],
    },
    q: { status: 'denied' as const, reason: 'out_of_range' as const },
  };
  const app = appFor({
    onForward: () => Promise.resolve({}),
    onResume: () => Promise.resolve(historical),
  });
  const response = await app.handle(request('resume', { resume_points: {}, trace_id: 't' }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(historical);
});
