import { expect, test } from 'bun:test';

import { documentFromShapes } from './document-from-shapes';
import { forwardInternal, resumeInternal } from './internal-http-shapes';
import { type SchemaShape, validateSchema } from './schema-shape';

test('emits both existing internal operations with the explicit legacy cursor array alternative', () => {
  const document = documentFromShapes([forwardInternal, resumeInternal]);
  expect(document.paths['/internal/forward']?.['post']?.operationId).toBe('postInternalForward');
  const resume = document.paths['/internal/resume']?.['post'];
  expect(resume?.operationId).toBe('postInternalResume');
  expect(resume?.requestBody?.content['application/json']?.schema).toMatchObject({
    properties: {
      resume_points: {
        anyOf: [
          { type: 'array', items: { type: 'number' } },
          { type: 'object', additionalProperties: { type: 'number' } },
        ],
      },
    },
  });
  expect(
    Object.keys(document.paths['/internal/forward']?.['post']?.requestBody?.content ?? {}),
  ).toEqual(['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data']);
});

test('preserves arbitrary forward payloads and numeric cursor arrays while rejecting undeclared envelopes', async () => {
  for (const message of [null, ['hello', 'world'], { arbitrary: { key: 1 } }]) {
    expect(
      (await validateSchema(forwardInternal.body, { message, trace_id: 't' })).issues,
    ).toBeUndefined();
  }
  expect((await validateSchema(forwardInternal.body, { trace_id: 't' })).issues).toBeDefined();
  expect(
    (await validateSchema(forwardInternal.body, { message: {}, trace_id: 't', extra: 1 })).issues,
  ).toBeDefined();
  for (const resume_points of [[], [-1, 0.5], { p: -1, q: 0.5 }]) {
    expect(
      (await validateSchema(resumeInternal.body, { resume_points, trace_id: 't' })).issues,
    ).toBeUndefined();
  }
  expect(
    (await validateSchema(resumeInternal.body, { resume_points: ['bad'], trace_id: 't' })).issues,
  ).toBeDefined();
});

test('validates finite replay outcomes and ack while preserving opaque historical message JSON', async () => {
  const ack = forwardInternal.responses[0].schema;
  const replay = resumeInternal.responses[0].schema;
  expect((await validateSchema(ack, { ack: 'true' })).issues).toBeDefined();
  expect((await validateSchema(ack, { ack: true, push_responses: {} })).issues).toBeDefined();
  for (const outcome of [
    { status: 'replaying' },
    { status: 'denied', reason: 'unavailable' },
    { status: 'replaying', events: [{ seq: '0', message: {} }] },
    { status: 'replaying', events: [{ seq: 0 }] },
  ]) {
    expect((await validateSchema(replay, { p: outcome })).issues).toBeDefined();
  }
  const historical = {
    p: {
      status: 'replaying' as const,
      events: [{ seq: 0, message: ['old', { nested: null }], future: true }],
    },
    q: { status: 'denied' as const, reason: 'out_of_range' as const },
  };
  expect(await validateSchema(replay, historical)).toEqual({ value: historical });
});

test('keeps numeric cursor inference at the ordered-schema boundary', () => {
  type ResumeBody = typeof resumeInternal.body extends SchemaShape<infer Body> ? Body : never;
  const cursor: ResumeBody['resume_points'] = [-1, 0.5];
  // @ts-expect-error The schema boundary restores numeric cursors, not unknown.
  const invalid: ResumeBody['resume_points'] = ['not a cursor'];
  expect(cursor).toEqual([-1, 0.5]);
  expect(invalid).toBeDefined();
});
