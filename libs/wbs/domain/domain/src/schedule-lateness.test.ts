import { describe, expect, it } from 'bun:test';

import type { PlannedRow } from './derive-numbers';
import type { Schedule, ScheduledSlice, Slice } from './schedule';
import { schedule, sliceKey } from './schedule';

/**
 * `lateBy` on every scheduled slice — tasks.md 5.2, the output half of slice 5.
 *
 * **The field carries the number, not a boolean, and `null` is "not late".**
 * `N >= 1` whenever it is set, so a row can never read `Late by 0 workdays`:
 * the spec's `N >= 1 when late` is expressed in the type rather than trusted to
 * every reader of it. A slice with no effective deadline and a slice that met
 * its deadline are both `null`, and deliberately not distinguished here — "how
 * late is this" has one answer for both, and whether a row *has* a deadline is
 * a question about the work item, which the row already knows.
 *
 * **Why it is read off the slice at all rather than recomputed by each caller.**
 * `workdaysLateBy` was exported in run 1 and `schedule-deadline-order.test.ts`
 * called it directly to check 4.5's late row — which proves the arithmetic and
 * proves nothing about the engine, because the test supplied the deadline
 * offset itself. Every caller that recomputes has to re-fold the ancestors to
 * find the effective offset first (see the parent case below), and a caller
 * that folds differently reports a different day. So the engine, which has
 * already folded, publishes the answer.
 *
 * Deadline offsets here are whole workdays from day zero, as everywhere in this
 * engine; `lastWorkdayOf(start, finish)` is the day the slice is still ON, so
 * the comparison is inclusive and a slice finishing on its deadline day is on
 * time. That reading is 4.2's single predicate and is not restated as a `<=`
 * anywhere below.
 */

const DEV = 'step-dev';

let position = 0;
const item = (
  id: string,
  parentId: string | null = null,
  priority: number | null = null,
): PlannedRow => ({
  id,
  parentId,
  position: (position += 10),
  frozenNumber: null,
  priority,
});

const slice = (
  workItemId: string,
  stepId: string,
  days: number | null,
  personId: string | null = null,
): Slice => ({ workItemId, stepId, days, personId, width: 1, poolIds: [] });

/** One slice's schedule, or a throw — a missing key is a broken fixture, not a null. */
const planned = (found: Schedule, workItemId: string, stepId: string): ScheduledSlice => {
  const one = found.slices.get(sliceKey(workItemId, stepId));
  if (one === undefined) throw new Error(`no slice for ${workItemId}/${stepId}`);
  return one;
};

const withDeadlines = (
  rows: readonly PlannedRow[],
  slices: readonly Slice[],
  deadlines: ReadonlyMap<string, number>,
  notBefore: ReadonlyMap<string, number> = new Map(),
): Schedule => schedule(rows, [], slices, notBefore, new Map(), 'whole-item', deadlines);

describe('a missed deadline is reported in whole workdays', () => {
  it('reports the specified three workdays for a slice still on day 15 against day 12', () => {
    // The spec's own scenario, verbatim: "a slice whose last workday is offset
    // 15 against an effective deadline offset of 12" carries `Late by 3
    // workdays`. Six days of work behind a floor of 10 puts the slice on
    // workdays 10 through 15, so 15 is the day it is still on.
    const rows = [item('a')];
    const slices = [slice('a', DEV, 6, 'kat')];

    const found = withDeadlines(rows, slices, new Map([['a', 12]]), new Map([['a', 10]]));

    expect(planned(found, 'a', DEV)).toMatchObject({
      earliestStart: 10,
      earliestFinish: 16,
      lateBy: 3,
    });
  });

  it('reports null rather than zero for a slice that met its deadline', () => {
    // The reason `lateBy` is nullable rather than a number that happens to be
    // 0: a reader asking "is this late" gets one answer, and no label layer can
    // print `Late by 0 workdays` off a truthy check that a 0 would fail and a
    // rendered zero would satisfy.
    const rows = [item('a')];
    const slices = [slice('a', DEV, 2)];

    const found = withDeadlines(rows, slices, new Map([['a', 5]]));

    expect(planned(found, 'a', DEV).lateBy).toBeNull();
  });

  it('reports null for a slice with no deadline at all', () => {
    // The undeadlined plan, which is every plan in the tree today. Nothing to
    // miss, so nothing to report — and the field is still present, because a
    // reader that has to check for `undefined` is a reader that will forget.
    const rows = [item('a')];
    const slices = [slice('a', DEV, 2)];

    const found = withDeadlines(rows, slices, new Map());

    expect(planned(found, 'a', DEV).lateBy).toBeNull();
  });

  it('is on time on the deadline day itself, and late by one the day after', () => {
    // The inclusive boundary, as a pair so the off-by-one cannot hide. Two days
    // of work from day zero occupies workdays 0 and 1: a deadline of 1 is met,
    // and a deadline of 0 is missed by exactly one workday. The single-sided
    // form of this case passes against a predicate shifted either way.
    const rows = [item('a')];
    const slices = [slice('a', DEV, 2)];

    expect(planned(withDeadlines(rows, slices, new Map([['a', 1]])), 'a', DEV).lateBy).toBeNull();
    expect(planned(withDeadlines(rows, slices, new Map([['a', 0]])), 'a', DEV).lateBy).toBe(1);
  });

  it('measures a zero-duration milestone against the day it stands on', () => {
    // 4.4's milestone, read through the field instead of through the helper. A
    // milestone held to day 3 has no width, so `ceil(snapWorkdays(3)) - 1` is
    // 2 — the day *before* the one it stands on — and only the `max` term in
    // `lastWorkdayOf` puts it back on day 3. A deadline of 3 is therefore met
    // and a deadline of 2 is missed by one. No non-zero-duration fixture can
    // tell those two readings apart.
    const rows = [item('m')];
    const slices = [slice('m', DEV, 0)];
    const floor = new Map([['m', 3]]);

    expect(planned(withDeadlines(rows, slices, new Map([['m', 3]]), floor), 'm', DEV).lateBy).toBe(
      null,
    );
    expect(planned(withDeadlines(rows, slices, new Map([['m', 2]]), floor), 'm', DEV).lateBy).toBe(
      1,
    );
  });

  it('reads trailing zero steps from the positive work-item span but all-zero items as points', () => {
    const rows = [item('work'), item('milestone')];
    const slices = [
      slice('work', DEV, 4),
      slice('work', 'step-qa', 0),
      slice('milestone', DEV, 0),
      slice('milestone', 'step-qa', 0),
    ];
    const deadlines = new Map([
      ['work', 3],
      ['milestone', 3],
    ]);
    const floors = new Map([['milestone', 4]]);

    const found = withDeadlines(rows, slices, deadlines, floors);

    expect(planned(found, 'work', DEV).lateBy).toBeNull();
    expect(planned(found, 'work', 'step-qa').lateBy).toBeNull();
    expect(planned(found, 'milestone', DEV).lateBy).toBe(1);
    expect(planned(found, 'milestone', 'step-qa').lateBy).toBe(1);
  });
});

describe('lateness is measured against the effective deadline, not the authored one', () => {
  it("reports a leaf late against its parent's date when the leaf carries none", () => {
    // The case that makes the field worth publishing. `a` has no deadline of
    // its own; the date is on the parent, and the fold expands it down. A
    // caller reading the authored map would find nothing for `a` and report it
    // on time — which is the whole plan silently meeting a deadline it missed.
    const rows = [item('p'), item('a', 'p')];
    const slices = [slice('a', DEV, 4)];

    const found = withDeadlines(rows, slices, new Map([['p', 1]]));

    expect(planned(found, 'a', DEV)).toMatchObject({ earliestFinish: 4, lateBy: 2 });
  });

  it("takes the parent's earlier date over the leaf's own later one", () => {
    // The fold's rule, in the number: the *earliest* ancestor date binds, where
    // a floor takes the latest. `a` says day 9 and its parent says day 1, so
    // the leaf owes day 1 and is late by 2 — not on time against its own date,
    // and not late by some average of the two.
    const rows = [item('p'), item('a', 'p')];
    const slices = [slice('a', DEV, 4)];

    const found = withDeadlines(
      rows,
      slices,
      new Map([
        ['p', 1],
        ['a', 9],
      ]),
    );

    expect(planned(found, 'a', DEV).lateBy).toBe(2);
  });
});

describe('both slices of one work item answer for the same date', () => {
  it('reports the later step late and the earlier one on time under one deadline', () => {
    // A deadline is a fact about the work item, so both its steps read it — and
    // they are not both late, because they do not both run on the same days.
    // Four days of design then four of dev against a day-5 deadline: design is
    // still on day 3 and met it, dev is still on day 7 and missed it by 2. A
    // field written per work item rather than per slice reports one of these
    // two rows wrongly whichever way it rounds.
    const rows = [item('a')];
    const slices = [slice('a', 'step-design', 4), slice('a', DEV, 4)];

    const found = withDeadlines(rows, slices, new Map([['a', 5]]));

    expect(planned(found, 'a', 'step-design')).toMatchObject({ earliestFinish: 4, lateBy: null });
    expect(planned(found, 'a', DEV)).toMatchObject({ earliestFinish: 8, lateBy: 2 });
  });
});
