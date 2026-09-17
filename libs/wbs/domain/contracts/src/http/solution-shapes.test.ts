import { expect, test } from 'bun:test';

import { documentFromShapes } from './document-from-shapes';
import { projectWithSteps } from './project-response';
import { validateSchema } from './schema-shape';
import { readSolution } from './solution-shapes';

const response = {
  project: {
    id: 'project',
    name: 'Plan',
    ownerId: 'owner',
    restricted: true,
    estimateMethod: 'pert' as const,
    depReach: 'anchor-slice' as const,
    pertWeights: { optimistic: 1, realistic: 4, pessimistic: 1 },
    estimateRounding: 'ceil' as const,
    startDate: '2026-09-06',
    solutionRef: { slug: 'solution', url: 'https://example.com/solution' },
    revision: 2,
    createdAt: 1,
    optimizationEnabled: true,
    scheduleEngine: 'optimized' as const,
    scheduleObjective: 'time' as const,
  },
  steps: [{ id: 'step', projectId: 'project', name: 'Build', position: 10 }],
};

test('emits the existing solution operation and required slug plus complete project response', () => {
  const operation = documentFromShapes([readSolution]).paths['/plans/by-solution/{slug}']?.['get'];
  expect(operation?.operationId).toBe('getPlansBy-solutionBySlug');
  expect(operation?.parameters).toEqual([
    { in: 'path', name: 'slug', required: true, schema: { type: 'string' } },
  ]);
  expect(operation?.responses['200']?.content?.['application/json']?.schema).toMatchObject({
    properties: {
      project: { required: Object.keys(response.project).sort() },
      steps: { items: { required: ['id', 'name', 'position', 'projectId'] } },
    },
  });
});

test('validates every required project and step field without stripping additive properties', async () => {
  expect((await validateSchema(projectWithSteps, response)).issues).toBeUndefined();
  for (const field of Object.keys(response.project)) {
    const project = Object.fromEntries(
      Object.entries(response.project).filter(([key]) => key !== field),
    );
    expect((await validateSchema(projectWithSteps, { ...response, project })).issues).toBeDefined();
  }
  for (const [field, value] of [
    ['estimateMethod', 'guess'],
    ['depReach', 'all'],
    ['estimateRounding', 'truncate'],
    ['scheduleEngine', 'slow'],
    ['scheduleObjective', 'cost'],
  ] as const) {
    expect(
      (
        await validateSchema(projectWithSteps, {
          ...response,
          project: { ...response.project, [field]: value },
        })
      ).issues,
    ).toBeDefined();
  }
  expect(
    (
      await validateSchema(projectWithSteps, {
        ...response,
        steps: [{ id: 'step', name: 'Build', position: 10 }],
      })
    ).issues,
  ).toBeDefined();
  const enriched = {
    ...response,
    project: { ...response.project, createdBy: 'owner' },
    steps: response.steps.map((step) => ({ ...step, updatedAt: 3 })),
  };
  expect(await validateSchema(projectWithSteps, enriched)).toEqual({ value: enriched });
  expect((await validateSchema(readSolution.params, {})).issues).toBeDefined();
  expect(
    (await validateSchema(readSolution.params, { slug: 'solution', extra: 'x' })).issues,
  ).toBeDefined();
});
