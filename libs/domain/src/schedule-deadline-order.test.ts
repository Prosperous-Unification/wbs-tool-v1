import { describe, expect, it } from 'bun:test';

import type { PlannedRow } from './derive-numbers';
import { workdaysLateBy } from './on-time';
import type { Schedule, ScheduledSlice, Slice } from './schedule';
import { schedule, sliceKey } from './schedule';

/**
 * Deadlines ordering the leveller's queue — tasks.md 5.1, and 4.5's proof that
 * ordering is all they do.
 *
 * Every case here is built around **contention**, exactly as
 * `schedule-priority.test.ts` is: two slices that could both start, wanting the
 * same person. That is the only situation the schedule has a choice in, and a
 * comparator is the only place a deadline is read. A case with no contention
 * would assert that the placement did not move, which is
 * `fast-golden-corpus.test.ts`'s job and is a different claim.
 *
 * **Each ordering case carries its own negative control**: the same fixture
 * scheduled with no deadlines, asserted to come out the *other* way round. A
 * case that only ran the deadlined arm would pass against a comparator that
 * ignored the map, because the four rules behind it might have wanted that
 * order anyway.
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

/** `schedule()` with the seventh argument and nothing else moved. */
const withDeadlines = (
  rows: readonly PlannedRow[],
  slices: readonly Slice[],
  deadlines: ReadonlyMap<string, number>,
  notBefore: ReadonlyMap<string, number> = new Map(),
): Schedule => schedule(rows, [], slices, notBefore, new Map(), 'whole-item', deadlines);

describe('minimum slack orders the ready set', () => {
  it('gives the person to the slice with less room, over the better priority', () => {
    // `a` outranks `b` and would take the person on priority alone. `b` is due
    // on day 3 against two days of work — slack 2 — where `a` has nine days of
    // room, so the date wins and the ranking waits.
    const rows = [item('a', null, 1), item('b', null, 9)];
    const slices = [slice('a', DEV, 2, 'kat'), slice('b', DEV, 2, 'kat')];
    const deadlines = new Map([
      ['a', 10],
      ['b', 3],
    ]);

    const found = withDeadlines(rows, slices, deadlines);

    expect(planned(found, 'b', DEV)).toMatchObject({ earliestStart: 0, earliestFinish: 2 });
    expect(planned(found, 'a', DEV)).toMatchObject({
      earliestStart: 2,
      earliestFinish: 4,
      boundBy: 'person',
    });

    // The negative control: the same fixture with the map empty is the answer
    // priority alone gives, which is the opposite one.
    const undeadlined = withDeadlines(rows, slices, new Map());
    expect(planned(undeadlined, 'a', DEV)).toMatchObject({ earliestStart: 0 });
    expect(planned(undeadlined, 'b', DEV)).toMatchObject({ earliestStart: 2, boundBy: 'person' });
  });

  it('separates equal slack by the earlier deadline, not by the shorter float', () => {
    // Both have four workdays of room: `a` is two days of work due on day 5,
    // `b` is five days of work due on day 8. Slack cannot tell them apart, and
    // the date can — `a` is due first, so `a` goes first.
    const rows = [item('a'), item('b')];
    const slices = [slice('a', DEV, 2, 'kat'), slice('b', DEV, 5, 'kat')];
    const deadlines = new Map([
      ['a', 5],
      ['b', 8],
    ]);

    const found = withDeadlines(rows, slices, deadlines);

    expect(planned(found, 'a', DEV)).toMatchObject({ earliestStart: 0, earliestFinish: 2 });
    expect(planned(found, 'b', DEV)).toMatchObject({ earliestStart: 2, boundBy: 'person' });

    // The negative control, and the reason this pair was chosen: with no
    // deadlines the float rule decides, and `b` is the longer job on a plan
    // whose finish it sets, so it has none and goes first.
    const undeadlined = withDeadlines(rows, slices, new Map());
    expect(planned(undeadlined, 'b', DEV)).toMatchObject({ earliestStart: 0 });
    expect(planned(undeadlined, 'a', DEV)).toMatchObject({ earliestStart: 5, boundBy: 'person' });
  });

  it('prefers the tighter slack over the earlier date when the two disagree', () => {
    // The case that makes slack load-bearing rather than a spelling of the
    // date. `b` is due first — day 5 against `a`'s day 6 — and `a` is the one
    // in trouble: five days of work due on day 6 has two days of room where
    // `b`'s two days due on day 5 has four. Ordering by the date alone would
    // start the comfortable job first and miss the tight one.
    const rows = [item('a'), item('b')];
    const slices = [slice('a', DEV, 5, 'kat'), slice('b', DEV, 2, 'kat')];
    const deadlines = new Map([
      ['a', 6],
      ['b', 5],
    ]);

    const found = withDeadlines(rows, slices, deadlines);

    expect(planned(found, 'a', DEV)).toMatchObject({ earliestStart: 0, earliestFinish: 5 });
    expect(planned(found, 'b', DEV)).toMatchObject({ earliestStart: 5, boundBy: 'person' });
  });

  it('puts a work item with no deadline behind one with a deadline, priority or not', () => {
    // `a` is the plan's only prioritised row and has no date; `b` has a date
    // twenty days out and no priority at all. Twenty days of room is still less
    // than none, so `b` goes first. An undeadlined slice sorting *ahead* on
    // priority is how a deadline becomes advisory.
    const rows = [item('a', null, 1), item('b')];
    const slices = [slice('a', DEV, 2, 'kat'), slice('b', DEV, 2, 'kat')];

    const found = withDeadlines(rows, slices, new Map([['b', 20]]));

    expect(planned(found, 'b', DEV)).toMatchObject({ earliestStart: 0, earliestFinish: 2 });
    expect(planned(found, 'a', DEV)).toMatchObject({ earliestStart: 2, boundBy: 'person' });
  });

  it('leaves two undeadlined slices in the priority order they already had', () => {
    // The fall-through, asserted rather than assumed: `c` is the only dated row
    // and takes the person first, and behind it the two undated rows are in
    // priority order — 1 before 9 — which is the rule this slice did not touch.
    const rows = [item('a', null, 1), item('b', null, 9), item('c')];
    const slices = [
      slice('a', DEV, 2, 'kat'),
      slice('b', DEV, 2, 'kat'),
      slice('c', DEV, 2, 'kat'),
    ];

    const found = withDeadlines(rows, slices, new Map([['c', 30]]));

    expect(planned(found, 'c', DEV)).toMatchObject({ earliestStart: 0 });
    expect(planned(found, 'a', DEV)).toMatchObject({ earliestStart: 2, boundBy: 'person' });
    expect(planned(found, 'b', DEV)).toMatchObject({ earliestStart: 4, boundBy: 'person' });
  });

  it('reads a deadline written on a parent, through the fold and not by leaf id', () => {
    // The date is on `p`, and the slice that has to hurry is `p/l` beneath it.
    // A comparator that looked the slice's own id up in the map would find
    // nothing, sort it as undeadlined, and hand the person to `x` — which is
    // the defect `leafDeadlinesOf` exists to prevent and which was live for a
    // month on the floor half of the same walk.
    const rows = [item('p'), item('l', 'p'), item('x', null, 1)];
    const slices = [slice('l', DEV, 2, 'kat'), slice('x', DEV, 2, 'kat')];

    const found = withDeadlines(rows, slices, new Map([['p', 4]]));

    expect(planned(found, 'l', DEV)).toMatchObject({ earliestStart: 0, earliestFinish: 2 });
    expect(planned(found, 'x', DEV)).toMatchObject({ earliestStart: 2, boundBy: 'person' });
  });

  it('schedules the same deadlined plan the same way twice', () => {
    // AC #3's determinism clause. Two slices that tie on slack *and* on date
    // fall all the way through to the plan's own order, and that order is a
    // total one, so there is no pair the comparator can leave unresolved.
    const rows = [item('a'), item('b')];
    const slices = [slice('a', DEV, 2, 'kat'), slice('b', DEV, 2, 'kat')];
    const deadlines = new Map([
      ['a', 6],
      ['b', 6],
    ]);

    const once = withDeadlines(rows, slices, deadlines);
    const again = withDeadlines(rows, slices, deadlines);

    expect(JSON.stringify([...again.slices])).toBe(JSON.stringify([...once.slices]));
    expect(planned(once, 'a', DEV)).toMatchObject({ earliestStart: 0 });
    expect(planned(once, 'b', DEV)).toMatchObject({ earliestStart: 2, boundBy: 'person' });
  });
});

describe('a deadline never moves work earlier and never overrides a floor', () => {
  it('starts a leaf at its floor even when the floor stands after its deadline', () => {
    // tasks.md 4.5. `a` is due on day 2 and may not start before day 6. The
    // floor is the answer, `notBefore` is the reason, and the row is reported
    // late by the five workdays between the day it is still on and the day it
    // owed — the plan is not rewritten to make the date true, and the date is
    // not rejected for being impossible.
    const rows = [item('a')];
    const slices = [slice('a', DEV, 2, 'kat')];

    const found = withDeadlines(rows, slices, new Map([['a', 2]]), new Map([['a', 6]]));
    const only = planned(found, 'a', DEV);

    expect(only).toMatchObject({ earliestStart: 6, earliestFinish: 8, boundBy: 'notBefore' });
    expect(workdaysLateBy(only.earliestStart, only.earliestFinish, 2)).toBe(5);
  });

  it('costs the queue what going first is worth, and buys nothing with it', () => {
    // The other half of 4.5, and the one a comparator makes easy to get wrong.
    // `b` is due on day 1 and already five workdays past saving, so it takes
    // the queue ahead of `a` — and it still starts on day 4, because its floor
    // says so. Being first in the queue is not being early: the only thing the
    // deadline bought was `a`'s place, and `a` pays for it.
    const rows = [item('a'), item('b')];
    const slices = [slice('a', DEV, 3, 'kat'), slice('b', DEV, 3, 'kat')];

    const found = withDeadlines(rows, slices, new Map([['b', 1]]), new Map([['b', 4]]));

    expect(planned(found, 'b', DEV)).toMatchObject({
      earliestStart: 4,
      earliestFinish: 7,
      boundBy: 'notBefore',
    });
    expect(planned(found, 'a', DEV)).toMatchObject({ earliestStart: 7, boundBy: 'person' });
  });
});
