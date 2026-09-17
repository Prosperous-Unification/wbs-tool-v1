import { describe, expect, it } from 'bun:test';

import type { Assignment } from '../index';
import { assumedAssignee, assumedAssigneeFlips } from './assumed-assignee';

const assigned = (workItemId: string, stepId: string, personId: string): Assignment => ({
  workItemId,
  stepId,
  personId,
});

describe('assumedAssignee', () => {
  it('is the lone assignee, and nobody once there are two', () => {
    expect(assumedAssignee({ dev: 'ada' })).toBe('ada');
    expect(assumedAssignee({ dev: 'ada', qa: 'grace' })).toBeNull();
    expect(assumedAssignee({})).toBeNull();
  });

  it('is nobody when one person holds two steps', () => {
    // Two rows, so nothing is being assumed: that person was named for both
    // steps rather than covering one nobody was named for.
    expect(assumedAssignee({ dev: 'ada', qa: 'ada' })).toBeNull();
  });
});

describe('assumedAssigneeFlips', () => {
  it('names the work item where removing a step starts the assumption', () => {
    const flips = assumedAssigneeFlips(
      [assigned('strip', 'dev', 'ada'), assigned('strip', 'qa', 'grace')],
      'qa',
    );

    expect(flips).toEqual([{ workItemId: 'strip', assumedNow: null, assumedAfter: 'ada' }]);
  });

  it('names the work item where removing a step ends the assumption', () => {
    const flips = assumedAssigneeFlips([assigned('strip', 'qa', 'grace')], 'qa');

    expect(flips).toEqual([{ workItemId: 'strip', assumedNow: 'grace', assumedAfter: null }]);
  });

  it('leaves alone a work item that keeps its answer', () => {
    // Three assignees before and two after: nobody was assumed either way, so
    // this work item's answer has not moved and naming it would be noise in a
    // confirmation somebody has to read.
    const flips = assumedAssigneeFlips(
      [
        assigned('strip', 'dev', 'ada'),
        assigned('strip', 'qa', 'grace'),
        assigned('strip', 'design', 'kat'),
      ],
      'design',
    );

    expect(flips).toEqual([]);
  });

  it('leaves alone a work item with no assignment on the step', () => {
    const flips = assumedAssigneeFlips([assigned('strip', 'dev', 'ada')], 'qa');

    expect(flips).toEqual([]);
  });

  it('names every work item that moves, in one answer', () => {
    const flips = assumedAssigneeFlips(
      [
        assigned('strip', 'dev', 'ada'),
        assigned('strip', 'qa', 'grace'),
        assigned('sand', 'qa', 'kat'),
        assigned('paint', 'dev', 'ada'),
      ],
      'qa',
    );

    expect(flips).toEqual([
      { workItemId: 'sand', assumedNow: 'kat', assumedAfter: null },
      { workItemId: 'strip', assumedNow: null, assumedAfter: 'ada' },
    ]);
  });
});
