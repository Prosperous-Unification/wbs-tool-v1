import { expect, test } from 'bun:test';

import { documentFromShapes } from './document-from-shapes';
import { validateSchema } from './schema-shape';
import { addStep, removeStep, renameStep } from './step-shapes';

test('emits the existing step operation names, name bodies and optional string cascade', () => {
  const document = documentFromShapes([addStep, renameStep, removeStep]);
  const add = document.paths['/api/projects/{id}/steps']?.['post'];
  const rename = document.paths['/api/projects/{id}/steps/{stepId}']?.['patch'];
  const remove = document.paths['/api/projects/{id}/steps/{stepId}']?.['delete'];
  expect(add?.operationId).toBe('postApiProjectsByIdSteps');
  expect(rename?.operationId).toBe('patchApiProjectsByIdStepsByStepId');
  expect(remove?.operationId).toBe('deleteApiProjectsByIdStepsByStepId');
  expect(add?.requestBody?.content['application/json']?.schema).toMatchObject({
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  });
  expect(remove?.parameters).toEqual([
    { in: 'path', name: 'id', required: true, schema: { type: 'string' } },
    { in: 'path', name: 'stepId', required: true, schema: { type: 'string' } },
    { in: 'query', name: 'cascade', required: false, schema: { type: 'string' } },
  ]);
  expect(remove?.requestBody).toBeUndefined();
  expect(remove?.responses['204']).toEqual({ description: 'Success' });
});

test('keeps names structural and cascade textual while refusing undeclared inputs', async () => {
  expect((await validateSchema(addStep.body, { name: '   ' })).issues).toBeUndefined();
  expect(
    (await validateSchema(renameStep.body, { name: 'Design', extra: true })).issues,
  ).toBeDefined();
  expect((await validateSchema(removeStep.query, { cascade: '1' })).issues).toBeUndefined();
  expect(
    (await validateSchema(removeStep.query, { cascade: 'true', extra: true })).issues,
  ).toBeDefined();
});

test('declares the full step response and each usage count and assumed-assignee field', () => {
  const document = documentFromShapes([addStep, removeStep]);
  const add = document.paths['/api/projects/{id}/steps']?.['post'];
  expect(add?.responses['200']?.content?.['application/json']?.schema).toMatchObject({
    properties: {
      step: {
        properties: {
          id: { type: 'string' },
          projectId: { type: 'string' },
          name: { type: 'string' },
          position: { type: 'number' },
        },
        required: ['id', 'name', 'position', 'projectId'],
      },
    },
  });
  const remove = document.paths['/api/projects/{id}/steps/{stepId}']?.['delete'];
  expect(remove?.responses['409']?.content?.['application/json']?.schema).toMatchObject({
    properties: {
      inUse: {
        required: [
          'actuals',
          'assignments',
          'assumedAssignees',
          'estimates',
          'measures',
          'progress',
        ],
        properties: {
          assumedAssignees: { items: { required: ['assumedAfter', 'assumedNow', 'workItemId'] } },
        },
      },
    },
  });
});
