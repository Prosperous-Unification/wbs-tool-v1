import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';
import { describe, expect, it } from 'bun:test';

import {
  decodePlanInfeasible,
  encodePlanInfeasible,
  planInfeasibleResultOf,
} from './plan-infeasible-dto';

const INPUT: ScheduleInput = {
  rows: [
    { id: 'parent', parentId: null, position: 10, frozenNumber: null, priority: null },
    { id: 'a', parentId: 'parent', position: 10, frozenNumber: null, priority: null },
    { id: 'b', parentId: 'parent', position: 20, frozenNumber: null, priority: null },
  ],
  edges: [],
  slices: [
    { workItemId: 'a', stepId: 'dev', days: 1, personId: null, width: 1, poolIds: [] },
    { workItemId: 'b', stepId: 'dev', days: 1, personId: null, width: 1, poolIds: [] },
  ],
  notBefore: new Map(),
  poolSizes: new Map(),
  reach: 'whole-item',
  deadlines: new Map([
    ['parent', 8],
    ['b', 5],
  ]),
};

describe('plan-infeasible cache DTO', () => {
  it('records one effective deadline per bound leaf and preserves its owner', () => {
    const result = planInfeasibleResultOf(INPUT);

    expect(result).toEqual({
      items: [
        { ownerWorkItemId: 'parent', boundWorkItemId: 'a', effectiveDeadlineOffset: 8 },
        { ownerWorkItemId: 'b', boundWorkItemId: 'b', effectiveDeadlineOffset: 5 },
      ],
    });
    expect(decodePlanInfeasible(encodePlanInfeasible(result))).toEqual(result);
  });

  it('rejects malformed items and duplicate bound work items', () => {
    expect(() =>
      decodePlanInfeasible({
        dtoVersion: 1,
        items: [{ ownerWorkItemId: 'a', boundWorkItemId: 'b', effectiveDeadlineOffset: '5' }],
      }),
    ).toThrow(/effectiveDeadlineOffset/);
    expect(() =>
      decodePlanInfeasible({
        dtoVersion: 1,
        items: [
          { ownerWorkItemId: 'a', boundWorkItemId: 'b', effectiveDeadlineOffset: 5 },
          { ownerWorkItemId: 'parent', boundWorkItemId: 'b', effectiveDeadlineOffset: 8 },
        ],
      }),
    ).toThrow(/duplicate boundWorkItemId b/);
  });
});
