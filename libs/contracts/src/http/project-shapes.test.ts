import { expect, test } from 'bun:test';

import { documentFromShapes } from './document-from-shapes';
import { projectWithSteps } from './project-response';
import {
  createProject,
  exportProject,
  listProjects,
  patchProject,
  readProject,
  recordProjectOpen,
} from './project-shapes';
import { validateSchema } from './schema-shape';

const shapes = [
  createProject,
  listProjects,
  recordProjectOpen,
  exportProject,
  readProject,
  patchProject,
] as const;

test('preserves six operation ids and declares both export representations without undo flags', () => {
  expect(shapes.map((shape) => shape.operationId)).toEqual([
    'postApiProjects',
    'getApiProjects',
    'postApiProjectsByIdOpened',
    'getApiProjectsByIdExport',
    'getApiProjectsById',
    'patchApiProjectsById',
  ]);
  expect(createProject.responses[0].schema).toBe(projectWithSteps);
  expect(readProject.responses[0].schema).toBe(projectWithSteps);
  const document = documentFromShapes(shapes);
  const content = document.paths['/api/projects/{id}/export']?.['get']?.responses['200']?.content;
  expect(Object.keys(content ?? {})).toEqual(['application/json', 'text/markdown; charset=utf-8']);
  expect(content?.['application/json']?.schema).toMatchObject({
    type: 'object',
    properties: { project: { type: 'object' }, workItems: { type: 'array' } },
  });
  expect(content?.['application/json']?.schema).not.toHaveProperty('properties.undoable');
  expect(content?.['application/json']?.schema).not.toHaveProperty('properties.redoable');
  expect(document.paths['/api/projects/{id}']?.['patch']?.requestBody).toMatchObject({
    required: true,
  });
});

test('allows empty names and empty patches while rejecting unknown nested fields', async () => {
  expect(await validateSchema(createProject.body, { name: '' })).toEqual({ value: { name: '' } });
  expect(await validateSchema(patchProject.body, {})).toEqual({ value: {} });
  for (const body of [
    undefined,
    null,
    [],
    { extra: 1 },
    { pertWeights: { optimistic: 1, realistic: 4, pessimistic: 1, extra: 1 } },
    { solutionRef: { slug: 's', url: 'u', extra: 1 } },
  ])
    expect((await validateSchema(patchProject.body, body)).issues).toBeDefined();
  expect((await validateSchema(createProject.body, { name: 'n', extra: 1 })).issues).toBeDefined();
});

test('keeps structural and semantic settings rules distinct', async () => {
  const semantic = {
    startDate: '2026-02-31',
    pertWeights: { optimistic: 0, realistic: 0, pessimistic: 0 },
    solutionRef: { slug: 's', url: 'not-a-url' },
  };
  expect(await validateSchema(patchProject.body, semantic)).toEqual({ value: semantic });
  expect(await validateSchema(patchProject.body, { startDate: null, solutionRef: null })).toEqual({
    value: { startDate: null, solutionRef: null },
  });
  for (const body of [
    { startDate: 'notaday' },
    { pertWeights: { optimistic: Infinity, realistic: 4, pessimistic: 1 } },
    { pertWeights: { optimistic: -1, realistic: 4, pessimistic: 1 } },
    { scheduleEngine: 'future' },
    { scheduleObjective: 'future' },
    { optimizationEnabled: 'true' },
  ])
    expect((await validateSchema(patchProject.body, body)).issues).toBeDefined();
});
