import { ValidationError } from '@wbs/validation';
import { expect, test } from 'bun:test';

import { type InternalCallContext, internalRoutes } from './internal.routes';

const request = {
  method: 'POST',
  url: new URL('https://backend.example/internal/forward'),
  headers: new Headers({ 'X-Client-Id': 'client', 'X-Connection-Id': 'connection' }),
};
const common = {
  params: {},
  query: undefined,
  principal: { kind: 'internal' as const },
  request,
};

test('direct internal bindings preserve opaque payload, trace and nullable context headers', async () => {
  const calls: { message: unknown; context: InternalCallContext }[] = [];
  const [forward] = internalRoutes({
    onForward: (message, context) => {
      calls.push({ message, context });
      return Promise.resolve({ push_responses: [null, { arbitrary: true }] });
    },
    onResume: () => Promise.resolve({}),
  });
  const payload = ['arbitrary', { old: null }];
  expect(
    await forward.handle({ ...common, body: { message: payload, trace_id: 'trace' } }),
  ).toEqual({
    ok: true,
    status: 200,
    body: { ack: true, push_responses: [null, { arbitrary: true }] },
  });
  expect(calls[0]).toEqual({
    message: payload,
    context: { clientId: 'client', connectionId: 'connection', traceId: 'trace' },
  });
  await forward.handle({
    ...common,
    request: { ...request, headers: new Headers({ 'x-client-id': '' }) },
    body: { message: null, trace_id: '' },
  });
  expect(calls[1]?.context).toEqual({ clientId: '', connectionId: null, traceId: '' });
});

test('direct resume normalizes legacy array entries without narrowing numeric cursors', async () => {
  const calls: { points: Record<string, number>; context: InternalCallContext }[] = [];
  const [, resume] = internalRoutes({
    onForward: () => Promise.resolve({}),
    onResume: (points, context) => {
      calls.push({ points, context });
      return Promise.resolve({ p: { status: 'denied' as const, reason: 'out_of_range' as const } });
    },
  });
  expect(
    await resume.handle({ ...common, body: { resume_points: [-1, 0.5], trace_id: 'trace' } }),
  ).toEqual({ ok: true, status: 200, body: { p: { status: 'denied', reason: 'out_of_range' } } });
  expect(calls).toEqual([
    {
      points: { '0': -1, '1': 0.5 },
      context: { clientId: 'client', connectionId: 'connection', traceId: 'trace' },
    },
  ]);
});

test('both direct callbacks reject original errors including ValidationError', async () => {
  for (const failure of [
    new Error('store unavailable'),
    new ValidationError('trusted callback invalid'),
  ]) {
    const [forward, resume] = internalRoutes({
      onForward: () => {
        return Promise.reject(failure);
      },
      onResume: () => {
        return Promise.reject(failure);
      },
    });
    expect(
      await forward
        .handle({ ...common, body: { message: {}, trace_id: 't' } })
        .catch((cause: unknown) => cause),
    ).toBe(failure);
    expect(
      await resume
        .handle({ ...common, body: { resume_points: {}, trace_id: 't' } })
        .catch((cause: unknown) => cause),
    ).toBe(failure);
  }
});
