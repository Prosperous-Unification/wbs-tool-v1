import { type } from 'arktype';

import { responseSchema } from './schema-shape';

/** Complete stored project settings, shared by project reads, lists, writes and exports. */
export const project = type({
  id: 'string',
  name: 'string',
  ownerId: 'string',
  restricted: 'boolean',
  estimateMethod: "'pert' | 'optimistic' | 'realistic' | 'pessimistic'",
  depReach: "'whole-item' | 'anchor-slice'",
  pertWeights: { optimistic: 'number', realistic: 'number', pessimistic: 'number' },
  estimateRounding: "'exact' | 'floor' | 'round' | 'ceil'",
  startDate: 'string | null',
  solutionRef: type({ slug: 'string', url: 'string' }).or('null'),
  revision: 'number',
  createdAt: 'number',
  optimizationEnabled: 'boolean',
  scheduleEngine: "'fast' | 'optimized'",
  scheduleObjective: "'pri' | 'time'",
});

/**
 * A project's complete stored settings with its ordered steps, as read and
 * creation return them. Additive fields survive this wire boundary; internal
 * repository columns are excluded by the repository's own projection.
 * Proof: optional depReach admitted a damaged project,200 instead of500 in
 * project.controller.test.ts's solution-settings case. Using requestSchema
 * rejected its additive fields,500 instead of200 in the same mounted case.
 */
export const projectWithSteps = responseSchema(
  type({
    project,
    steps: type({ id: 'string', projectId: 'string', name: 'string', position: 'number' }).array(),
  }),
);
