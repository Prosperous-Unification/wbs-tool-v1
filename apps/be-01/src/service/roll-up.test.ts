import { describe, expect, it } from 'bun:test';

import type {
  MeasureMetric,
  StoredActual,
  StoredEstimate,
  StoredMeasure,
  StoredProgress,
  WorkItem,
} from '../repository';
import {
  rollUp,
  rollUpActuals,
  rollUpItemStates,
  rollUpMeasures,
  rollUpProgress,
  workedRolesOf,
} from './roll-up';

const item = (id: string, parentId: string | null): WorkItem => ({
  id,
  projectId: 'p',
  parentId,
  position: 10,
  name: id,
  notes: '',
  frozenNumber: null,
  priority: null,
  startNoEarlierThan: null,
  serviceTeamId: null,
  serviceId: null,
  maxParallel: 1,
  revision: 0,
});

const held = (
  workItemId: string,
  roleId: string,
  optimistic: number,
  realistic: number,
  pessimistic: number,
): StoredEstimate => ({ workItemId, roleId, optimistic, realistic, pessimistic });

describe('rollUp', () => {
  it('gives a leaf its own estimate', () => {
    const totals = rollUp([item('a', null)], [held('a', 'dev', 1, 2, 3)]);

    expect(totals.get('a')?.get('dev')).toEqual({ optimistic: 1, realistic: 2, pessimistic: 3 });
  });

  it('sums two children into their parent', () => {
    const rows = [item('parent', null), item('one', 'parent'), item('two', 'parent')];
    const estimates = [held('one', 'dev', 1, 2, 3), held('two', 'dev', 2, 3, 4)];

    const totals = rollUp(rows, estimates);

    expect(totals.get('parent')?.get('dev')).toEqual({
      optimistic: 3,
      realistic: 5,
      pessimistic: 7,
    });
  });

  it('sums through more than one level', () => {
    const rows = [item('root', null), item('mid', 'root'), item('leaf', 'mid')];

    const totals = rollUp(rows, [held('leaf', 'dev', 1, 1, 1)]);

    expect(totals.get('root')?.get('dev')).toEqual({
      optimistic: 1,
      realistic: 1,
      pessimistic: 1,
    });
  });

  it('reports a role no descendant estimated as absent, not zero', () => {
    // Zero and absent look the same in a table and mean opposite things: "no QA
    // needed" against "nobody has estimated the QA".
    const rows = [item('parent', null), item('one', 'parent')];

    const totals = rollUp(rows, [held('one', 'dev', 1, 2, 3)]);

    expect(totals.get('parent')?.has('qa')).toBe(false);
    expect(totals.get('parent')?.get('qa')).toBeUndefined();
  });

  it('keeps roles apart when only one child has each', () => {
    const rows = [item('parent', null), item('one', 'parent'), item('two', 'parent')];
    const estimates = [held('one', 'dev', 1, 2, 3), held('two', 'qa', 4, 5, 6)];

    const totals = rollUp(rows, estimates);

    expect(totals.get('parent')?.get('dev')).toEqual({
      optimistic: 1,
      realistic: 2,
      pessimistic: 3,
    });
    expect(totals.get('parent')?.get('qa')).toEqual({
      optimistic: 4,
      realistic: 5,
      pessimistic: 6,
    });
  });

  it('ignores an estimate stored against a work item that has children', () => {
    // The service refuses to write one, so this is defence against a row that
    // predates the rule. Counting it would double the parent's total.
    const rows = [item('parent', null), item('one', 'parent')];
    const estimates = [held('parent', 'dev', 99, 99, 99), held('one', 'dev', 1, 2, 3)];

    const totals = rollUp(rows, estimates);

    expect(totals.get('parent')?.get('dev')).toEqual({
      optimistic: 1,
      realistic: 2,
      pessimistic: 3,
    });
  });
});

const recorded = (workItemId: string, roleId: string, days: number): StoredActual => ({
  workItemId,
  roleId,
  days,
  recordedAt: 1000,
});

describe('rollUpActuals', () => {
  it('gives a leaf its own recorded days', () => {
    const totals = rollUpActuals([item('a', null)], [recorded('a', 'dev', 8)]);

    expect(totals.get('a')?.get('dev')).toBe(8);
  });

  it('sums two children into their parent, per role', () => {
    const rows = [item('parent', null), item('one', 'parent'), item('two', 'parent')];

    const totals = rollUpActuals(rows, [
      recorded('one', 'dev', 2),
      recorded('two', 'dev', 3),
      recorded('two', 'qa', 1),
    ]);

    expect(totals.get('parent')?.get('dev')).toBe(5);
    expect(totals.get('parent')?.get('qa')).toBe(1);
  });

  it('sums through more than one level', () => {
    const rows = [item('root', null), item('mid', 'root'), item('leaf', 'mid')];

    const totals = rollUpActuals(rows, [recorded('leaf', 'dev', 4)]);

    expect(totals.get('root')?.get('dev')).toBe(4);
  });

  it('leaves a role nobody recorded absent rather than zero', () => {
    // The rule the table rests on, at the fold. `has` and not the value,
    // because `0` and `undefined` are both falsy and only one of them is the
    // answer this asserts.
    const rows = [item('parent', null), item('one', 'parent')];

    const totals = rollUpActuals(rows, [recorded('one', 'dev', 2)]);

    expect(totals.get('parent')?.has('qa')).toBe(false);
    expect(totals.get('parent')?.get('dev')).toBe(2);
  });

  it('keeps a recorded zero, which is not the same as nobody having said', () => {
    const rows = [item('parent', null), item('one', 'parent')];

    const totals = rollUpActuals(rows, [recorded('one', 'dev', 0)]);

    expect(totals.get('parent')?.has('dev')).toBe(true);
    expect(totals.get('parent')?.get('dev')).toBe(0);
  });

  it('gives a parent an empty map when nothing under it was recorded', () => {
    const rows = [item('parent', null), item('one', 'parent')];

    const totals = rollUpActuals(rows, []);

    expect(totals.get('parent')?.size).toBe(0);
    expect(totals.get('one')?.size).toBe(0);
  });

  it('ignores a row stored on a work item that has children, as the estimates do', () => {
    // A parent reports what is below it. A row left on a row that has since
    // gained a child is invisible here — which is why the write path moves it
    // down instead of leaving it, and why that move has its own test.
    const rows = [item('parent', null), item('one', 'parent')];

    const totals = rollUpActuals(rows, [recorded('parent', 'dev', 99), recorded('one', 'dev', 2)]);

    expect(totals.get('parent')?.get('dev')).toBe(2);
  });
});

const measured = (
  workItemId: string,
  roleId: string,
  metric: MeasureMetric,
  value: number,
): StoredMeasure => ({ workItemId, roleId, metric, value, recordedAt: 1 });

describe('rollUpMeasures', () => {
  it('gives a leaf its own figure in the metric asked for', () => {
    const totals = rollUpMeasures(
      [item('a', null)],
      [measured('a', 'dev', 'token_actual', 512345)],
      'token_actual',
    );

    expect(totals.get('a')?.get('dev')).toBe(512345);
  });

  it('sums two children into their parent, per role', () => {
    const rows = [item('parent', null), item('one', 'parent'), item('two', 'parent')];

    const totals = rollUpMeasures(
      rows,
      [
        measured('one', 'dev', 'token_estimate', 1000),
        measured('two', 'dev', 'token_estimate', 2500),
        measured('two', 'qa', 'token_estimate', 400),
      ],
      'token_estimate',
    );

    expect(totals.get('parent')?.get('dev')).toBe(3500);
    expect(totals.get('parent')?.get('qa')).toBe(400);
  });

  it('sums through more than one level', () => {
    const rows = [item('root', null), item('mid', 'root'), item('leaf', 'mid')];

    const totals = rollUpMeasures(
      rows,
      [measured('leaf', 'dev', 'hours_actual', 6)],
      'hours_actual',
    );

    expect(totals.get('root')?.get('dev')).toBe(6);
  });

  it('folds one metric without seeing the others on the same pair', () => {
    // The reason this function takes a metric at all. One pair, three units:
    // adding across them would be adding tokens to hours, and the only thing
    // stopping it is that each call sees one unit's rows.
    const rows = [item('parent', null), item('one', 'parent')];
    const stored = [
      measured('one', 'dev', 'token_estimate', 1000),
      measured('one', 'dev', 'token_actual', 1400),
      measured('one', 'dev', 'hours_actual', 3),
    ];

    expect(rollUpMeasures(rows, stored, 'token_estimate').get('parent')?.get('dev')).toBe(1000);
    expect(rollUpMeasures(rows, stored, 'token_actual').get('parent')?.get('dev')).toBe(1400);
    expect(rollUpMeasures(rows, stored, 'hours_actual').get('parent')?.get('dev')).toBe(3);
  });

  it('leaves a role absent per metric rather than reporting it as zero', () => {
    // Absence is the primary key's third column arriving at the read path: the
    // same role, present in one unit and absent in another. `has` rather than
    // the value, because `0` and `undefined` are both falsy and only one of
    // them is what this asserts.
    const rows = [item('parent', null), item('one', 'parent')];
    const stored = [measured('one', 'dev', 'token_actual', 900)];

    expect(rollUpMeasures(rows, stored, 'token_actual').get('parent')?.get('dev')).toBe(900);
    expect(rollUpMeasures(rows, stored, 'hours_actual').get('parent')?.has('dev')).toBe(false);
    expect(rollUpMeasures(rows, stored, 'token_actual').get('parent')?.has('qa')).toBe(false);
  });

  it('keeps a recorded zero, which is not the same as nobody having said', () => {
    const rows = [item('parent', null), item('one', 'parent')];

    const totals = rollUpMeasures(
      rows,
      [measured('one', 'dev', 'hours_actual', 0)],
      'hours_actual',
    );

    expect(totals.get('parent')?.has('dev')).toBe(true);
    expect(totals.get('parent')?.get('dev')).toBe(0);
  });

  it('gives a parent an empty map when nothing under it was recorded in that metric', () => {
    const rows = [item('parent', null), item('one', 'parent')];

    const totals = rollUpMeasures(rows, [], 'token_estimate');

    expect(totals.get('parent')?.size).toBe(0);
    expect(totals.get('one')?.size).toBe(0);
  });

  it('ignores a figure stored against a work item that has children, as the days do', () => {
    const rows = [item('parent', null), item('one', 'parent')];

    const totals = rollUpMeasures(
      rows,
      [
        measured('parent', 'dev', 'token_actual', 99999),
        measured('one', 'dev', 'token_actual', 20),
      ],
      'token_actual',
    );

    expect(totals.get('parent')?.get('dev')).toBe(20);
  });
});

const said = (
  workItemId: string,
  roleId: string,
  state: 'in_progress' | 'done',
): StoredProgress => ({
  workItemId,
  roleId,
  state,
  statedAt: 1,
});

/** The fold and the reading in one call, as `tree()` runs them. */
function fold(
  rows: readonly WorkItem[],
  estimates: readonly StoredEstimate[],
  actuals: readonly StoredActual[],
  stated: readonly StoredProgress[],
) {
  const byRole = rollUpProgress(rows, stated, workedRolesOf(estimates, actuals, stated));
  return { byRole, states: rollUpItemStates(rows, byRole) };
}

describe('rollUpProgress', () => {
  it('gives a leaf its own state, and fills in the roles that have work and no statement', () => {
    const rows = [item('a', null)];

    const { byRole, states } = fold(
      rows,
      [held('a', 'qa', 1, 1, 1)],
      [],
      [said('a', 'dev', 'done')],
    );

    expect(byRole.get('a')?.get('dev')).toBe('done');
    // The role with an estimate and no statement: present in the fold as
    // `not_started`, which is what keeps the item off `done`.
    expect(byRole.get('a')?.get('qa')).toBe('not_started');
    expect(states.get('a')).toBe('in_progress');
  });

  it('reads a role nobody has spoken about and holds no work for as absent', () => {
    const rows = [item('a', null)];

    const { byRole, states } = fold(rows, [], [], []);

    expect(byRole.get('a')?.size).toBe(0);
    expect(states.get('a')).toBe('not_started');
  });

  it('counts a role with only a recorded day as work still to be spoken about', () => {
    const rows = [item('a', null)];

    const { states } = fold(
      rows,
      [],
      [{ workItemId: 'a', roleId: 'qa', days: 2, recordedAt: 1 }],
      [said('a', 'dev', 'done')],
    );

    expect(states.get('a')).toBe('in_progress');
  });

  it('agrees two children into their parent, per role', () => {
    const rows = [item('parent', null), item('one', 'parent'), item('two', 'parent')];

    const { byRole, states } = fold(
      rows,
      [],
      [],
      [said('one', 'dev', 'done'), said('two', 'dev', 'done')],
    );

    expect(byRole.get('parent')?.get('dev')).toBe('done');
    expect(states.get('parent')).toBe('done');
  });

  it('reads a branch whose children disagree as in progress', () => {
    const rows = [item('parent', null), item('one', 'parent'), item('two', 'parent')];

    const { byRole, states } = fold(
      rows,
      [held('two', 'dev', 1, 1, 1)],
      [],
      [said('one', 'dev', 'done')],
    );

    expect(byRole.get('parent')?.get('dev')).toBe('in_progress');
    expect(states.get('parent')).toBe('in_progress');
  });

  it('folds through more than one level', () => {
    const rows = [item('root', null), item('mid', 'root'), item('leaf', 'mid')];

    const { states } = fold(rows, [], [], [said('leaf', 'dev', 'done')]);

    expect(states.get('root')).toBe('done');
    expect(states.get('mid')).toBe('done');
  });

  it('keeps a branch off done while one of its rows has never been spoken about', () => {
    // The empty sibling holds no role at all, so the per-role fold cannot see
    // it — `{dev: done}` is all it answers. The item state is folded over the
    // children instead, and that is where the silence is counted.
    //
    // Proof: `rollUpItemStates` folded from the parent's own role map, and this
    // fails with `done` — a finished branch over an untouched row; watched
    // 2026-08-18.
    const rows = [item('parent', null), item('one', 'parent'), item('empty', 'parent')];

    const { byRole, states } = fold(rows, [], [], [said('one', 'dev', 'done')]);

    expect(byRole.get('parent')?.get('dev')).toBe('done');
    expect(states.get('parent')).toBe('in_progress');
  });

  it('ignores a statement naming a work item that is not in the rows', () => {
    // What a stale read looks like: the rows come from one query and the
    // statements from another, and a row deleted between the two must not throw.
    const rows = [item('a', null)];

    const { states } = fold(rows, [], [], [said('gone', 'dev', 'done')]);

    expect(states.get('a')).toBe('not_started');
    expect(states.has('gone')).toBe(false);
  });
});
