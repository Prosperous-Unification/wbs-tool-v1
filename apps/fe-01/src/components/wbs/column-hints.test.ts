import { describe, expect, it } from 'vitest';

import { type ColumnHintState, hintFor, UnexplainedColumnError } from './column-hints';
import { POINTS } from './estimate-draft';
import { FIXED_COLUMNS, FLEXIBLE_COLUMNS } from './table-frame';

/** A project on a calendar, which is what the schedule columns hold real dates in. */
const ON_CALENDAR: ColumnHintState = { hasProjectStartDate: true };
/** A project with no start date, where the same columns hold day numbers. */
const OFF_CALENDAR: ColumnHintState = { hasProjectStartDate: false };

/**
 * A step's four columns, by the suffixes the table names them with. The step
 * half of the id is whatever the project called the step, so `r7` here stands
 * for any of them.
 */
const STEP_COLUMNS = ['r7-final', 'r7-assignee', ...POINTS.map((point) => `r7-${point}`)];

/**
 * Every column the table can render, in one list — every declared column,
 * hidden by default or not, the flexible one, and a step's four.
 *
 * Read off `table-frame`'s own exports rather than written out again, which is
 * the whole point of the test below it: a column added to the width table
 * without a sentence fails here, on the same line, without anybody remembering
 * to add it in two places.
 */
const EVERY_COLUMN = [...FIXED_COLUMNS, ...FLEXIBLE_COLUMNS, ...STEP_COLUMNS];

describe('every rendered column explains itself', () => {
  it.each(EVERY_COLUMN)('%s carries a hint in both states of the plan', (columnId) => {
    for (const state of [ON_CALENDAR, OFF_CALENDAR]) {
      const hint = hintFor(columnId, state);
      expect(hint.length).toBeGreaterThan(0);
      // A sentence, not a label: the shortest hint in the table is the Slack
      // column's two, and a heading echoed back at the reader would sit far
      // under this.
      expect(hint.length).toBeGreaterThan(40);
      expect(hint.trim()).toBe(hint);
    }
  });

  it('refuses an id nobody wrote a sentence for', () => {
    expect(() => hintFor('sparkline', ON_CALENDAR)).toThrow(UnexplainedColumnError);
  });
});

describe('the hints say what changing the column does to the plan', () => {
  it('names what a dependency actually waits for, which is not the row finishing', () => {
    expect(hintFor('depends', ON_CALENDAR)).toContain('first estimated step');
  });

  it('says the priority orders people and not dependencies', () => {
    expect(hintFor('priority', ON_CALENDAR)).toContain('never who skips their dependencies');
  });

  it('says the two dimensions that move no dates say so', () => {
    expect(hintFor('tag', ON_CALENDAR)).toContain('move no dates');
    expect(hintFor('service', ON_CALENDAR)).toContain('move no dates');
  });

  it('says parallelism is bounded by the team and switched off by a named person', () => {
    const hint = hintFor('in-parallel', ON_CALENDAR);
    expect(hint).toContain('never past the team’s size');
    expect(hint).toContain('never where somebody is named on the work');
  });

  it('says the schedule columns are computed, and how to read them off a calendar', () => {
    expect(hintFor('start', ON_CALENDAR)).toContain('Computed, not typed');
    expect(hintFor('start', ON_CALENDAR)).not.toContain('days from the start of the plan');
    expect(hintFor('finish', OFF_CALENDAR)).toContain('days from the start of the plan');
  });

  it('names the estimate arithmetic on the boxes it is done from', () => {
    expect(hintFor('r7-optimistic', ON_CALENDAR)).toContain('(o + 4r + p) ÷ 6');
    expect(hintFor('r7-pessimistic', ON_CALENDAR)).toContain('goes badly');
  });

  it('says a named assignee serialises that person’s own work', () => {
    expect(hintFor('r7-assignee', ON_CALENDAR)).toContain('one thing at a time');
  });

  it('says the earliest start is a floor rather than the day it happens', () => {
    expect(hintFor('not-before', ON_CALENDAR)).toContain('never earlier');
  });

  /**
   * The one hint that said a column does nothing while the scheduler was
   * already reading it. `schedule.ts`'s Fast comparator asks `slack` — the
   * deadline minus the deadline-free placement — and then `deadline` itself,
   * ahead of `priority`, so a deadline reorders who gets a person first; and
   * `libs/solver-py/src/wbs_solver/model.py` turns the same date into
   * `start + max(duration, 1) <= deadline`, a CP-SAT constraint an optimized
   * plan is refused for breaking. Both are shipped: the optimizer's three
   * choices are the radios in `optimization-settings.tsx`, and the date reaches
   * the solver through `buildSolverSlices`' `deadlineUnits`.
   *
   * Asserted as a **pair** — the ordering effect and the hard-constraint
   * effect — because a hint that names only Fast's would be as wrong for a
   * project on PRI as the old sentence was for every project.
   */
  it('says a deadline moves the plan, both ways the two shipped engines move it', () => {
    const hint = hintFor('deadline', ON_CALENDAR);
    expect(hint).toContain('scheduled first');
    expect(hint).toContain('optimized plan');
    expect(hint).toContain('reported late');
  });

  /**
   * The negative control for the case above, and the defect verbatim: the
   * shipped sentence read *"It constrains nothing on its own — the plan is
   * built the same way"*, and the emphasised half was false in both engines on
   * the day it was written. Kept as its own case so a rewrite that reintroduces
   * the claim fails on a line that quotes it rather than on a missing phrase.
   */
  it('never tells a reader the plan is built the same way with a deadline on it', () => {
    const hint = hintFor('deadline', ON_CALENDAR);
    expect(hint).not.toContain('constrains nothing');
    expect(hint).not.toContain('built the same way');
  });
});
