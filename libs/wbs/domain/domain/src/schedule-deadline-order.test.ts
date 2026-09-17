import { describe, expect, it } from 'bun:test';

import type { PlannedRow } from './derive-numbers';
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
    // AC #3's determinism clause, in its weakest form: one input, run twice.
    // It cannot fail — `schedule` is pure and both arms hand it the identical
    // array — so it is kept as a smoke case and the claim it is named for is
    // proved by the permutation case below, which is the one that can fail.
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

  it('schedules the same plan from either row order when two slices tie on every key', () => {
    // AC #3's determinism clause where it can actually break. Every comparison
    // in `goesFirst` ties here: same person, same duration, same deadline and
    // therefore the same slack, the same unleveled start and float, the same
    // number — `frozenNumber` is reported verbatim and `deriveNumbers` enforces
    // no uniqueness on it — and both are one-slice items, so both sit at step
    // index 0. A comparator whose last key is that step index leaves the pair
    // unresolved in both directions, and the eligible set is a heap, so the
    // insertion order decides: reversing these rows reverses which of them
    // takes `kat` on day 0.
    //
    // The rows carry their positions with them, so the two arms are the same
    // plan written down in a different order rather than two plans — the
    // numbers, the tree and the slices are identical, and only the array order
    // moves.
    const rows: PlannedRow[] = [
      { id: 'a', parentId: null, position: 10, frozenNumber: '010', priority: 1 },
      { id: 'b', parentId: null, position: 20, frozenNumber: '010', priority: 1 },
    ];
    const slices = [slice('a', DEV, 2, 'kat'), slice('b', DEV, 2, 'kat')];
    const deadlines = new Map([
      ['a', 6],
      ['b', 6],
    ]);

    const forward = withDeadlines(rows, slices, deadlines);
    const reversed = withDeadlines([...rows].reverse(), slices, deadlines);

    // Asserted on the placements and not on the map's entries: the map is
    // filled in node order, so its iteration order follows the rows either way
    // and a stringified comparison would fail on a plan that is the same one.
    for (const id of ['a', 'b']) {
      expect(planned(reversed, id, DEV)).toMatchObject({
        earliestStart: planned(forward, id, DEV).earliestStart,
        earliestFinish: planned(forward, id, DEV).earliestFinish,
      });
    }
    expect(planned(forward, 'a', DEV)).toMatchObject({ earliestStart: 0 });
    expect(planned(forward, 'b', DEV)).toMatchObject({ earliestStart: 2, boundBy: 'person' });
  });

  it('refuses a NUL in either half of a slice key rather than merging two slices', () => {
    // The other half of the same determinism claim, and the one the round-3
    // review found: the comparator's last two rules are total only while two
    // different work items cannot share a key, and `sliceKey` joins its halves
    // with a NUL that nothing used to reject. A work item id ending in one and
    // a step id beginning with one produce a single key from two different
    // pairs, and each being its own group's only slice they also share
    // `at === 0` — so `goesFirst` would be false both ways and the row order
    // would decide again.
    //
    // Refused at the key rather than ordered around: the pair is also one row
    // overwriting the other in `Schedule.slices`, so a plan that reached the
    // comparator with it is already a plan with a slice missing.
    const collide = () => sliceKey('a\u0000b', 'c');
    expect(sliceKey('a', 'b')).toBe(sliceKey('a', 'b'));
    expect(collide).toThrow(/neither a work item id nor a step id may contain a NUL/);
    expect(() => sliceKey('a', 'b\u0000c')).toThrow(
      /neither a work item id nor a step id may contain a NUL/,
    );

    // The scheduler refuses the plan rather than silently losing a row.
    const rows = [item('a\u0000b'), item('x')];
    const slices = [slice('a\u0000b', DEV, 2, 'kat'), slice('x', DEV, 2, 'kat')];
    expect(() => withDeadlines(rows, slices, new Map())).toThrow(
      /neither a work item id nor a step id may contain a NUL/,
    );
  });
});

/**
 * tasks.md 4.5, under its corrected name.
 *
 * The describe was called `a deadline never moves work earlier and never
 * overrides a floor`, and the first half of that is false here: winning a
 * minimum-slack queue *is* moving earlier, and the first case above has `b`
 * starting at 2 undeadlined and at 0 deadlined. It was then called `a deadline
 * decides an order, never a date`, which is false the other way — the order
 * the leveller acts on *is* a date, by that same counterexample.
 *
 * The rule these two cases prove is the one now in the name: a deadline enters
 * only where the comparator chooses between slices that are already eligible,
 * and the hard lower bounds — a slice's floor, its dependencies, its earlier
 * steps — are untouched by it.
 */
describe('a deadline changes placement only through ready-set order', () => {
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
    // Read off the slice rather than recomputed here (5.2). The earlier form
    // called `workdaysLateBy` with the deadline offset the test itself supplied,
    // which proves the arithmetic and says nothing about what the engine
    // published — the same fixture would have passed with the field absent.
    expect(only.lateBy).toBe(5);
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
