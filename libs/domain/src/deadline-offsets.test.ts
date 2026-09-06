import { describe, expect, it } from 'bun:test';

import { deadlineOffsetsOf, UNMEETABLE_DEADLINE_OFFSET } from './deadline-offsets';
import type { PlannedRow } from './derive-numbers';
import type { Schedule, ScheduledSlice, Slice } from './schedule';
import { schedule, sliceKey } from './schedule';

/**
 * Stored dates resolved to offsets, and what happens to the ones that resolve
 * before day zero — the **domain half** of tasks.md 5.4.
 *
 * The other half is a storage claim (the stored value is not rewritten and the
 * request is not rejected) and waits on slice 1's column. This file owns the
 * part that needs no column at all: given the dates, what does Fast report?
 *
 * **Every case here goes through `schedule()` as well as through the
 * converter.** A converter tested alone proves an arithmetic; the sentence 5.4
 * actually makes is "and is reported late by the whole span", and only the
 * engine can be asked that.
 */

/** A Monday, so day zero is the project start itself and no roll is hiding. */
const START = '2026-06-08';
const DEV = 'step-dev';

let position = 0;
const item = (id: string): PlannedRow => ({
  id,
  parentId: null,
  position: (position += 10),
  frozenNumber: null,
  priority: null,
});

const slice = (workItemId: string, days: number, personId: string | null = null): Slice => ({
  workItemId,
  stepId: DEV,
  days,
  personId,
  width: 1,
  poolIds: [],
});

const planned = (found: Schedule, workItemId: string): ScheduledSlice => {
  const one = found.slices.get(sliceKey(workItemId, DEV));
  if (one === undefined) throw new Error(`no slice for ${workItemId}`);
  return one;
};

const scheduledWith = (
  rows: readonly PlannedRow[],
  slices: readonly Slice[],
  deadlines: ReadonlyMap<string, string>,
): Schedule =>
  schedule(
    rows,
    [],
    slices,
    new Map(),
    new Map(),
    'whole-item',
    deadlineOffsetsOf(START, deadlines),
  );

describe('stored dates become the offsets the engine reads', () => {
  it('resolves a date on day zero to offset 0 and a later one to its workday count', () => {
    // The ordinary path, and the one that says the converter is `deadlineOffsetOf`
    // and not a second reading of a date: 2026-06-08 is day zero, 2026-06-12 is
    // the Friday of the same week, and 2026-06-15 is the Monday after — four
    // workdays on and five, because the weekend is not counted.
    expect(
      deadlineOffsetsOf(
        START,
        new Map([
          ['a', '2026-06-08'],
          ['b', '2026-06-12'],
          ['c', '2026-06-15'],
        ]),
      ),
    ).toEqual(
      new Map([
        ['a', 0],
        ['b', 4],
        ['c', 5],
      ]),
    );
  });

  it('rolls a weekend deadline backward, exactly as the single resolver does', () => {
    // Saturday the 13th is Friday the 12th's offset, not the following Monday's.
    // Asserted here as well as in `workday.property.test.ts` because a converter
    // that re-derived the roll would be a second answer to the same question,
    // and the map is where a second answer would first be invisible.
    expect(deadlineOffsetsOf(START, new Map([['a', '2026-06-13']]))).toEqual(new Map([['a', 4]]));
  });

  it('carries an item whose date resolves before day zero rather than dropping it', () => {
    // The distinction the whole file turns on: an item absent from this map has
    // **no deadline**, and an item whose date fell before the plan began has one
    // it cannot meet. A converter that skipped the entry would collapse the two
    // and report the row on time.
    const resolved = deadlineOffsetsOf(
      START,
      new Map([
        ['a', '2026-06-01'],
        ['b', '2026-06-12'],
      ]),
    );

    expect(resolved.has('a')).toBe(true);
    expect(resolved.get('a')).toBe(UNMEETABLE_DEADLINE_OFFSET);
    expect(resolved.size).toBe(2);
  });

  it('returns an empty map for an empty one, which is the no-deadline plan', () => {
    expect(deadlineOffsetsOf(START, new Map())).toEqual(new Map());
  });
});

describe('a deadline that fell before the project began is unmeetable, not invalid', () => {
  it('reports the row late by every workday it stands on', () => {
    // 5.4's sentence, in the number. Three days of work from day zero occupies
    // workdays 0, 1 and 2, and the date it owed was before any of them — so it
    // is late by three, the whole span. Nothing threw and nothing was rejected:
    // the project moved under a date the user typed, and that is legal.
    const found = scheduledWith([item('a')], [slice('a', 3)], new Map([['a', '2026-06-01']]));

    expect(planned(found, 'a')).toMatchObject({ earliestFinish: 3, lateBy: 3 });
  });

  it('is late on day zero itself, which a clamp to 0 would call on time', () => {
    // The case that makes `-1` load-bearing rather than a spelling of "early".
    // A one-day item finishing on day zero meets **every** offset a clamp could
    // produce, so this is the one fixture whose failure under the clamp is a row
    // reported as having MET a date from before the plan existed rather than
    // merely as having missed it by the wrong number. Measured: under the clamp
    // the three-day case above also fails, at `2` instead of `3`; under the drop
    // both read `null`. Three symptoms, and this is the one that says on time.
    const found = scheduledWith([item('a')], [slice('a', 1)], new Map([['a', '2026-06-01']]));

    expect(planned(found, 'a')).toMatchObject({ earliestFinish: 1, lateBy: 1 });
  });

  it('takes the queue ahead of a row that can still make its date', () => {
    // The ordering half, and the reason the encoding is an offset rather than a
    // flag: nothing on the plan is further past its date, so it sorts first
    // under 5.1's minimum slack with no special case anywhere. `b` is due on the
    // Friday and has room; `a`'s date is gone. One person, so exactly one of
    // them can go first.
    const found = scheduledWith(
      [item('a'), item('b')],
      [slice('a', 2, 'kat'), slice('b', 2, 'kat')],
      new Map([
        ['a', '2026-06-01'],
        ['b', '2026-06-12'],
      ]),
    );

    expect(planned(found, 'a')).toMatchObject({ earliestStart: 0, lateBy: 2 });
    expect(planned(found, 'b')).toMatchObject({
      earliestStart: 2,
      boundBy: 'person',
      lateBy: null,
    });
  });
});
