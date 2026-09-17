import { describe, expect, it } from 'bun:test';

import { isOnTime, workdaysLateBy } from './on-time';

describe('isOnTime', () => {
  it('counts the day a slice finishes on as a day it met', () => {
    // Two days from workday 3 is still ON workday 4, so a deadline of 4 holds.
    expect(isOnTime(3, 5, 4)).toBe(true);
    expect(isOnTime(3, 5, 3)).toBe(false);
  });

  it('reads a fractional finish as the whole workday it is still on', () => {
    // Half a day is not half a date: a slice finishing 4.5 days in occupies
    // workday 4 and no more.
    expect(isOnTime(3, 4.5, 4)).toBe(true);
    expect(isOnTime(3, 4.5, 3)).toBe(false);
  });

  it('reads accumulated drift as the whole day it is, not a day more', () => {
    // Three PERT sixths summing to exactly 5 arrive as 5.000000000000002.
    // `lastWorkdayOf` snaps that before the ceil, so the deadline it meets is
    // the one the estimates add up to rather than the one after it.
    expect(isOnTime(0, 5.000000000000002, 4)).toBe(true);
  });

  // WATCHED RED W1. Replacing `lastWorkdayOf(start, finish)` in the predicate
  // with a bare `Math.ceil(snapWorkdays(finish)) - 1` — dropping the `max`
  // term — reddens this case alone:
  //
  //   `is late for a zero-duration milestone standing past its deadline`
  //   expected false, received true
  //
  // A milestone has start === finish, so the bare form answers `s - 1` and
  // reports a milestone standing a full day past its deadline as on time. No
  // fixture with a duration can produce this red: once `finish > start`,
  // `ceil(finish) - 1` is already at or above `floor(start)` and the `max` term
  // changes nothing. Watched 2026-09-06.
  it('is late for a zero-duration milestone standing past its deadline', () => {
    // Deadline day 6; the milestone stands on day 7.
    expect(isOnTime(7, 7, 6)).toBe(false);
    // And on time when it stands on the deadline day itself.
    expect(isOnTime(6, 6, 6)).toBe(true);
  });

  it('meets a day-zero deadline only at day zero', () => {
    expect(isOnTime(0, 0, 0)).toBe(true);
    expect(isOnTime(0, 1, 0)).toBe(true);
    expect(isOnTime(1, 1, 0)).toBe(false);
  });
});

describe('workdaysLateBy', () => {
  it('is zero exactly when the slice met its deadline', () => {
    // The definition isOnTime is built on, asserted as the identity it is: a
    // second `<=` living in the predicate is how a row reads late with no
    // number beside it, or reads `Late by 0`.
    for (const [start, finish, deadline] of [
      [3, 5, 4],
      [3, 5, 3],
      [3, 4.5, 4],
      [7, 7, 6],
      [0, 0, 0],
      [1, 1, 0],
    ] as const) {
      expect(workdaysLateBy(start, finish, deadline) === 0).toBe(isOnTime(start, finish, deadline));
    }
  });

  it('counts whole workdays past the deadline, never fewer than one when late', () => {
    // Two days from workday 3 is still on workday 4, so a deadline of 3 is
    // missed by exactly one workday.
    expect(workdaysLateBy(3, 5, 3)).toBe(1);
    expect(workdaysLateBy(3, 5, 0)).toBe(4);
    expect(workdaysLateBy(3, 5, 4)).toBe(0);
  });

  it('counts a weekend as no time at all, because the axis is workdays', () => {
    // Offsets are workday offsets before they reach here. A Friday deadline
    // missed into the following Monday is one workday late, not three calendar
    // days — which is the whole reason the copy has to say `workdays`.
    expect(workdaysLateBy(5, 5, 4)).toBe(1);
  });

  it('counts a zero-duration milestone from the day it stands on', () => {
    expect(workdaysLateBy(7, 7, 6)).toBe(1);
    expect(workdaysLateBy(6, 6, 6)).toBe(0);
  });
});
