import { expect, test } from 'bun:test';

import { documentFromShapes } from './document-from-shapes';
import type { EndpointShape } from './endpoint-shape';
import { health, metrics } from './infrastructure-shapes';
import { validateSchema } from './schema-shape';
import { httpShapes } from './shapes';

async function declaresInvalidBody(shape: EndpointShape): Promise<boolean> {
  for (const refusal of shape.refusals) {
    if (!('schema' in refusal)) continue;
    if (
      refusal.status === 400 &&
      (await validateSchema(refusal.schema, { error: 'invalid_body' })).issues === undefined
    )
      return true;
  }
  return false;
}

test('declares public health JSON and Prometheus text without request input', () => {
  const document = documentFromShapes([health, metrics]);
  expect([health.operationId, metrics.operationId]).toEqual(['getHealth', 'getMetrics']);
  expect(health.policies).toEqual([]);
  expect(metrics.policies).toEqual([]);
  expect(document.paths['/health']?.['get']?.responses).toMatchObject({
    '200': { content: { 'application/json': {} } },
    '400': { content: { 'application/json': {} } },
    '503': { content: { 'application/json': {} } },
  });
  expect(document.paths['/metrics']?.['get']?.responses).toEqual({
    '200': {
      description: 'Success',
      content: { 'text/plain; version=0.0.4': { schema: { type: 'string' } } },
    },
    '500': {
      description: 'Failure',
      content: { 'text/plain; version=0.0.4': { schema: { type: 'string' } } },
    },
    '400': {
      description: 'Refusal',
      content: {
        'application/json': {
          schema: {
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: { error: { const: 'invalid_body' } },
            required: ['error'],
          },
        },
      },
    },
  });
});

test('every GET shape declares the adapter invalid-body refusal as a 400', async () => {
  for (const shape of httpShapes) {
    if (shape.method !== 'GET') continue;
    const declared = await declaresInvalidBody(shape);
    expect({ operationId: shape.operationId, declared }).toEqual({
      operationId: shape.operationId,
      declared: true,
    });
  }
});

test('health distinguishes ready, migration and dependency states while retaining commit metadata', async () => {
  const ready = health.responses[0];
  const unavailable = health.refusals[0];
  expect(await validateSchema(ready.schema, { status: 'ok', commit: null })).toEqual({
    value: { status: 'ok', commit: null },
  });
  for (const status of ['migrating', 'database_unreachable', 'schema_missing'] as const) {
    expect(
      await validateSchema(unavailable.schema, {
        error: 'dependency_unavailable',
        status,
        commit: 'abc',
      }),
    ).toEqual({
      value: { error: 'dependency_unavailable', status, commit: 'abc' },
    });
  }
  expect(
    (
      await validateSchema(unavailable.schema, {
        error: 'dependency_unavailable',
        status: 'ok',
        commit: null,
      })
    ).issues,
  ).toBeDefined();
  expect(
    (
      await validateSchema(unavailable.schema, {
        error: 'dependency_unavailable',
        status: 'database_unreachable',
      })
    ).issues,
  ).toBeDefined();
});
