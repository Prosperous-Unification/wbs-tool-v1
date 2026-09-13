import { describe, expect, it } from 'vitest';

import type { Days, StepView, WorkItemView } from '@/lib/wbs-api';

import { describeGaps, type EstimateGaps, findEstimateGaps } from './plan-completeness';

const DEV: StepView = { id: 'step-dev', name: 'Dev' };
const QA: StepView = { id: 'step-qa', name: 'QA' };
const STEPS = [DEV, QA];

const DAYS: Days = { optimistic: 2, realistic: 3, pessimistic: 8 };

/** One work item, as much of it as judging completeness reads. */
const item = (
  id: string,
  parentId: string | null,
  estimates: Record<string, Days> = {},
): Pick<WorkItemView, 'id' | 'parentId' | 'estimates'> => ({ id, parentId, estimates });

describe('findEstimateGaps', () => {
  it('names a leaf with no estimate at all as missing every step', () => {
    const gaps = findEstimateGaps([item('a', null)], STEPS);

    expect(gaps.leaves).toEqual([{ rowId: 'a', missingStepIds: ['step-dev', 'step-qa'] }]);
  });

  it('judges each step separately, so Dev alone is still incomplete', () => {
    // The nuance the whole change turns on: "estimated" is not one flag per
    // work item. A row someone has costed for Dev and not for QA plans a
    // release that is missing its testing, and the schedule under it reads as
    // if that work were free.
    const gaps = findEstimateGaps([item('a', null, { 'step-dev': DAYS })], STEPS);

    expect(gaps.leaves).toEqual([{ rowId: 'a', missingStepIds: ['step-qa'] }]);
  });

  it('never counts a parent, whose figures are rolled up from below', () => {
    // A parent's numbers are a sum of its children's. Counting it would report
    // a gap that nobody can fill — there is nothing to type into — and would
    // double-count the child that is the real gap.
    const gaps = findEstimateGaps([item('a', null), item('a1', 'a', {})], STEPS);

    expect(gaps.leaves.map((leaf) => leaf.rowId)).toEqual(['a1']);
  });

  it('counts a parent whose children are all estimated as nothing at all', () => {
    const gaps = findEstimateGaps(
      [item('a', null), item('a1', 'a', { 'step-dev': DAYS, 'step-qa': DAYS })],
      STEPS,
    );

    expect(gaps).toEqual({ leaves: [], perStep: [] });
  });

  it('has nothing to say about an empty project', () => {
    expect(findEstimateGaps([], STEPS)).toEqual({ leaves: [], perStep: [] });
  });

  it('has nothing to say when every leaf is estimated for every step', () => {
    const complete = { 'step-dev': DAYS, 'step-qa': DAYS };

    expect(findEstimateGaps([item('a', null, complete), item('b', null, complete)], STEPS)).toEqual(
      {
        leaves: [],
        perStep: [],
      },
    );
  });

  it('keeps the leaves in the order they were given, which is the order on screen', () => {
    // The badge walks this list, so its order is the order the eye travels
    // down the table. Sorting it any other way would send the focus jumping.
    const gaps = findEstimateGaps(
      [item('a', null), item('b', null, { 'step-dev': DAYS, 'step-qa': DAYS }), item('c', null)],
      STEPS,
    );

    expect(gaps.leaves.map((leaf) => leaf.rowId)).toEqual(['a', 'c']);
  });

  it('names the missing steps in the step list’s order, which is the column order', () => {
    const gaps = findEstimateGaps([item('a', null, { 'step-qa': DAYS })], STEPS);

    expect(gaps.leaves[0]?.missingStepIds).toEqual(['step-dev']);
  });

  it('counts the leaves missing each step, and leaves out a step nobody is missing', () => {
    const gaps = findEstimateGaps(
      [
        item('a', null),
        item('b', null, { 'step-dev': DAYS }),
        item('c', null, { 'step-dev': DAYS, 'step-qa': DAYS }),
      ],
      STEPS,
    );

    // Two leaves are incomplete for QA and one for Dev — three step-sized
    // gaps across two work items, which is why the two numbers are reported
    // separately rather than added up.
    expect(gaps.leaves).toHaveLength(2);
    expect(gaps.perStep).toEqual([
      { stepId: 'step-dev', stepName: 'Dev', count: 1 },
      { stepId: 'step-qa', stepName: 'QA', count: 2 },
    ]);
  });

  it('finds no gap in a project with no steps', () => {
    expect(findEstimateGaps([item('a', null)], [])).toEqual({ leaves: [], perStep: [] });
  });

  it('reads a stored zero trio as an estimate, because that is what it is', () => {
    // `0 / 0 / 0` is somebody saying this costs nothing, which is an answer.
    // A truthiness test on the stored value would read it as unestimated.
    const zero: Days = { optimistic: 0, realistic: 0, pessimistic: 0 };

    const gaps = findEstimateGaps([item('a', null, { 'step-dev': zero, 'step-qa': zero })], STEPS);

    expect(gaps.leaves).toEqual([]);
  });
});

describe('describeGaps', () => {
  const gaps = (perStep: EstimateGaps['perStep']): EstimateGaps => ({ leaves: [], perStep });

  it('names every step that is short, with its own count', () => {
    expect(
      describeGaps(
        gaps([
          { stepId: 'step-dev', stepName: 'Dev', count: 2 },
          { stepId: 'step-qa', stepName: 'QA', count: 3 },
        ]),
      ),
    ).toBe('2 missing Dev, 3 missing QA');
  });

  it('says one step on its own without a list', () => {
    expect(describeGaps(gaps([{ stepId: 'step-qa', stepName: 'QA', count: 1 }]))).toBe(
      '1 missing QA',
    );
  });
});
