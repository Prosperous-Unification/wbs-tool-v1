import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';
import { describe, expect, it } from 'bun:test';

import { scheduleInputHash } from './schedule-input-hash';

const INPUT: ScheduleInput = {
  rows: [
    { id: 'a', parentId: null, position: 10, frozenNumber: '1', priority: 2 },
    { id: 'b', parentId: null, position: 20, frozenNumber: null, priority: 3 },
  ],
  edges: [{ predecessorId: 'a', successorId: 'b' }],
  slices: [
    {
      workItemId: 'a',
      stepId: 'build',
      days: 2,
      personId: 'person-1',
      width: 1,
      poolIds: ['team-2', 'team-1'],
    },
  ],
  notBefore: new Map([['a', 4]]),
  poolSizes: new Map([['team-1', 2]]),
  reach: 'anchor-slice',
  deadlines: new Map([['b', 9]]),
};

describe('scheduleInputHash', () => {
  it('keeps the established SHA-256 address for all seven scheduler arguments', () => {
    // Proof: changing the adapter to SHA-1 produced
    // db508ad760d4acd7813774dd6674d5e7cbaf47d3 instead of this address.
    expect(scheduleInputHash(INPUT)).toBe(
      'e35e9e9c28d2d392bfca660c9892de1682ddbf7e86ede0878bd8eafa26167e14',
    );
  });
});
