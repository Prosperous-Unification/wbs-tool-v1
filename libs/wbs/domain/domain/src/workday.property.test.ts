import { describe, expect, it } from 'bun:test';
import fc from 'fast-check';

import {
  addWorkdays,
  type DeadlineOffset,
  deadlineOffsetOf,
  type IsoDate,
  previousWorkday,
  workdaysBetween,
} from './workday';

const DAY_MS = 86_400_000;

/**
 * The loop `addWorkdays` was until 2026-09-02, kept here as the oracle.
 *
 * Copied rather than imported on purpose: the point is to compare the closed
 * form against an independent implementation of the same rule, and an oracle
 * that called the thing under test would prove nothing. It is deliberately the
 * naive walk — a `Date` per calendar day, weekends included and then skipped —
 * because that is what shipped and what every date in the repo was computed
 * with.
 */
function addWorkdaysByWalking(from: IsoDate, workdays: number): IsoDate {
  let at = new Date(`${from}T00:00:00Z`);
  while (at.getUTCDay() === 0 || at.getUTCDay() === 6) {
    at = new Date(at.getTime() + DAY_MS);
  }
  for (let moved = 0; moved < Math.floor(workdays); moved += 1) {
    do {
      at = new Date(at.getTime() + DAY_MS);
    } while (at.getUTCDay() === 0 || at.getUTCDay() === 6);
  }
  return at.toISOString().slice(0, 10);
}

/** The same, for `workdaysBetween`. */
function workdaysBetweenByWalking(from: IsoDate, to: IsoDate): number {
  const weekdayOn = (date: IsoDate): Date => {
    let at = new Date(`${date}T00:00:00Z`);
    while (at.getUTCDay() === 0 || at.getUTCDay() === 6) at = new Date(at.getTime() + DAY_MS);
    return at;
  };
  const start = weekdayOn(from);
  const end = weekdayOn(to);
  if (end.getTime() <= start.getTime()) return 0;
  let count = 0;
  let at = start;
  while (at.getTime() < end.getTime()) {
    at = new Date(at.getTime() + DAY_MS);
    if (at.getUTCDay() !== 0 && at.getUTCDay() !== 6) count += 1;
  }
  return count;
}

/** Walk backward from a date to the nearest workday. */
function previousWorkdayByWalking(date: IsoDate): IsoDate {
  let at = new Date(`${date}T00:00:00Z`);
  while (at.getUTCDay() === 0 || at.getUTCDay() === 6) {
    at = new Date(at.getTime() - DAY_MS);
  }
  return at.toISOString().slice(0, 10);
}

/** The same, for `deadlineOffsetOf`. */
function deadlineOffsetOfByWalking(projectStart: IsoDate, deadline: IsoDate): DeadlineOffset {
  // Day zero is the first workday on or after projectStart
  let dayZero = new Date(`${projectStart}T00:00:00Z`);
  while (dayZero.getUTCDay() === 0 || dayZero.getUTCDay() === 6) {
    dayZero = new Date(dayZero.getTime() + DAY_MS);
  }

  // The deadline rolls backward to the nearest workday
  let at = new Date(`${deadline}T00:00:00Z`);
  while (at.getUTCDay() === 0 || at.getUTCDay() === 6) {
    at = new Date(at.getTime() - DAY_MS);
  }

  // If rolled deadline is before day zero, it's before project start
  if (at.getTime() < dayZero.getTime()) {
    return { kind: 'before-project-start' };
  }

  // Count workdays from dayZero to at
  let count = 0;
  let current = dayZero;
  while (current.getTime() < at.getTime()) {
    current = new Date(current.getTime() + DAY_MS);
    if (current.getUTCDay() !== 0 && current.getUTCDay() !== 6) {
      count += 1;
    }
  }

  return { kind: 'offset', offset: count };
}

/**
 * A `DeadlineOffset` as one comparable string.
 *
 * Reading `.offset` off the union to compare two of them does not typecheck —
 * `before-project-start` has no such field, which is the whole reason the
 * variant exists — and a per-case `if` inside the loop would compare the two
 * kinds under different rules. One string compares both kinds under one.
 */
function shown(at: DeadlineOffset): string {
  return at.kind === 'offset' ? `offset ${String(at.offset)}` : at.kind;
}

/** A week that covers every start weekday, both weekend days included. */
const A_WEEK: IsoDate[] = [
  '2026-06-01', // Monday
  '2026-06-02',
  '2026-06-03',
  '2026-06-04',
  '2026-06-05', // Friday
  '2026-06-06', // Saturday
  '2026-06-07', // Sunday
];

const isoDate = fc
  .integer({ min: 0, max: 20_000 })
  .map((days) => new Date(days * DAY_MS).toISOString().slice(0, 10));

/**
 * The closed form is the loop, for every offset anybody can plan.
 *
 * `addWorkdays` and `workdaysBetween` walked a calendar day at a time until
 * 2026-09-02, allocating a `Date` per day — weekends included, and then skipped.
 * The scheduler calls the first per slice per read and the chart calls it per
 * bar, so this is not a micro-optimisation: a 250-workday plan of 200 rows was a
 * quarter of a million allocations per read.
 *
 * Replacing arithmetic that every date in the tool comes out of needs more than
 * a few examples, which is what this file is: 3,500 exhaustive pairs (every
 * offset 0..500 from each of seven start days, weekend starts included) plus a
 * thousand random ones, each compared against the walk that shipped.
 *
 * Proof that the comparison bites, both faults watched 2026-09-02. The `+ 3`
 * origin shift in `workdayIndexOf` changed to `+ 2` fails the sweep on
 * `+ "2026-06-01+0: 2026-06-02 ≠ 2026-06-01"` and 3,499 more, and the random
 * case with it. And `workdaysBetween`'s subtraction replaced by the **calendar**
 * difference fails on `+ "2026-06-01→2026-06-06: 7 ≠ 5"` — the weekend counted.
 *
 * One fault is **not** detectable, and it is worth saying which: clamping with
 * `Math.min(days % 7, 4)` in `workdayIndexOf` changes nothing, because
 * `nextWorkday` has already moved every input off a weekend. That precondition
 * is what makes the two forms equal, and it is the one thing `workdayIndexOf`
 * cannot be asked to answer without it.
 */
describe('the closed form and the walk agree', () => {
  it('for every offset 0..500 from every day of a week', () => {
    const disagreements: string[] = [];
    for (const from of A_WEEK) {
      for (let workdays = 0; workdays <= 500; workdays += 1) {
        const closed = addWorkdays(from, workdays);
        const walked = addWorkdaysByWalking(from, workdays);
        if (closed !== walked)
          disagreements.push(`${from}+${String(workdays)}: ${closed} ≠ ${walked}`);
      }
    }
    expect(disagreements).toEqual([]);
    // The precondition: an empty sweep would also report no disagreement.
    expect(addWorkdays('2026-06-05', 1)).toBe('2026-06-08');
  });

  it('for a thousand random dates and offsets', () => {
    fc.assert(
      fc.property(isoDate, fc.integer({ min: 0, max: 2_000 }), (from, workdays) => {
        expect(addWorkdays(from, workdays)).toBe(addWorkdaysByWalking(from, workdays));
      }),
      { numRuns: 1_000, seed: 20_260_902 },
    );
  });

  it('and `workdaysBetween` is the same inverse it was', () => {
    const disagreements: string[] = [];
    for (const from of A_WEEK) {
      for (let ahead = -3; ahead <= 400; ahead += 1) {
        const to = new Date(new Date(`${from}T00:00:00Z`).getTime() + ahead * DAY_MS)
          .toISOString()
          .slice(0, 10);
        const closed = workdaysBetween(from, to);
        const walked = workdaysBetweenByWalking(from, to);
        if (closed !== walked) {
          disagreements.push(`${from}→${to}: ${String(closed)} ≠ ${String(walked)}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
    // A date before `from` is zero, not a negative — the clamp, asserted.
    expect(workdaysBetween('2026-06-08', '2026-06-01')).toBe(0);
  });

  it('round-trips: n workdays along is n workdays between', () => {
    fc.assert(
      fc.property(isoDate, fc.integer({ min: 0, max: 500 }), (from, workdays) => {
        expect(workdaysBetween(from, addWorkdays(from, workdays))).toBe(workdays);
      }),
      { numRuns: 500, seed: 20_260_902 },
    );
  });

  it('deadlineOffsetOf(s, addWorkdays(s, k)) is { kind: "offset", offset: k } for every s and k in 0..500', () => {
    const disagreements: string[] = [];
    for (const from of A_WEEK) {
      for (let offset = 0; offset <= 500; offset += 1) {
        const deadline = addWorkdays(from, offset);
        const closed = shown(deadlineOffsetOf(from, deadline));
        const expected = `offset ${String(offset)}`;
        if (closed !== expected) {
          disagreements.push(`${from}+${String(offset)}: got ${closed} expected ${expected}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  it('deadlineOffsetOf is the same inverse it was', () => {
    const disagreements: string[] = [];
    for (const from of A_WEEK) {
      for (let ahead = -10; ahead <= 400; ahead += 1) {
        const to = new Date(new Date(`${from}T00:00:00Z`).getTime() + ahead * DAY_MS)
          .toISOString()
          .slice(0, 10);
        const closed = shown(deadlineOffsetOf(from, to));
        const walked = shown(deadlineOffsetOfByWalking(from, to));
        if (closed !== walked) {
          disagreements.push(`${from}→${to}: got ${closed} expected ${walked}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
    // A deadline before the project's day zero rolls back to before-project-start
    expect(deadlineOffsetOf('2026-06-08', '2026-06-01')).toEqual({ kind: 'before-project-start' });
  });

  it('previousWorkday walks backward to the nearest workday', () => {
    const disagreements: string[] = [];
    for (const from of A_WEEK) {
      for (let behind = -3; behind <= 10; behind += 1) {
        const to = new Date(new Date(`${from}T00:00:00Z`).getTime() + behind * DAY_MS)
          .toISOString()
          .slice(0, 10);
        const closed = previousWorkday(to);
        const walked = previousWorkdayByWalking(to);
        if (closed !== walked) {
          disagreements.push(`${to}: ${closed} ≠ ${walked}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
    // A weekend day rolls backward to the preceding Friday
    expect(previousWorkday('2026-06-06')).toBe('2026-06-05');
    expect(previousWorkday('2026-06-07')).toBe('2026-06-05');
  });

  it('deadlineOffsetOf agrees with the backward walk for arbitrary date pairs', () => {
    // The loop above covers one week of starts exhaustively; this covers pairs
    // no hand-written week would reach — month and year boundaries, leap days,
    // and deadlines on either side of their own project start.
    fc.assert(
      fc.property(isoDate, fc.integer({ min: -400, max: 400 }), (projectStart, ahead) => {
        const deadline = new Date(new Date(`${projectStart}T00:00:00Z`).getTime() + ahead * DAY_MS)
          .toISOString()
          .slice(0, 10);
        expect(shown(deadlineOffsetOf(projectStart, deadline))).toBe(
          shown(deadlineOffsetOfByWalking(projectStart, deadline)),
        );
      }),
      { numRuns: 1000, seed: 20_260_906 },
    );
  });
});
