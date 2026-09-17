import { expect, it } from 'bun:test';

import { documentFromShapes } from './document-from-shapes';
import { readHistory } from './history-shapes';

it('emits the history path and both optional query filters from the actual shared shape', () => {
  const operation = documentFromShapes([readHistory]).paths['/api/projects/{id}/history']?.['get'];
  expect(operation?.operationId).toBe('getApiProjectsByIdHistory');
  expect(operation?.parameters).toEqual([
    { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    { name: 'kind', in: 'query', required: false, schema: { type: 'string' } },
    { name: 'workItemId', in: 'query', required: false, schema: { type: 'string' } },
  ]);
  expect(operation?.responses['200']).toMatchObject({
    content: { 'application/json': { schema: { properties: { events: { type: 'array' } } } } },
  });
  expect(operation?.responses['404']).toBeDefined();
});
