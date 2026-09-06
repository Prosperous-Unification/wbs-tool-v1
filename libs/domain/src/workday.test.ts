import { describe, expect, it } from 'bun:test';

import {
  addCalendarDays,
  addWorkdays,
  calendarDaysBetween,
  deadlineOffsetOf,
  firstWorkdayOf,
  isIsoDate,
  isMonday,
  isWeekend,
  lastWorkdayOf,
  nextWorkday,
  previousWorkday,
  snapWorkdays,
  wholeDaysCovering,
  withinDrift,
  workdaysBetween,
} from './workday';

// 2026-08-06 is a Thursday; 08 and 09 are the Saturday and Sunday after it.
const THURSDAY = '2026-08-06';
const FRIDAY = '2026-08-07';
const SATURDAY = '2026-08-08';
const SUNDAY = '2026-08-09';
const MONDAY = '2026-08-10';

describe('isIsoDate', () => {
  it('accepts a real day and refuses everything else', () => {
    expect(isIsoDate(THURSDAY)).toBe(true);
    // Shape alone is not enough: `Date.parse` rolls this into March, so a
    // check that only tested the pattern would call it a day.
    expect(isIsoDate('2026-02-31')).toBe(false);
    for (const bad of ['2026-8-6', '06/08/2026', '', 'tomorrow', null, 20260806])
      expect(isIsoDate(bad)).toBe(false);
  });
});

describe('isWeekend', () => {
  it('is true on Saturday and Sunday only', () => {
    expect([THURSDAY, FRIDAY, MONDAY].map(isWeekend)).toEqual([false, false, false]);
    expect([SATURDAY, SUNDAY].map(isWeekend)).toEqual([true, true]);
  });
});

describe('nextWorkday', () => {
  it('leaves a workday alone and moves a weekend to Monday', () => {
    expect(nextWorkday(FRIDAY)).toBe(FRIDAY);
    expect(nextWorkday(SATURDAY)).toBe(MONDAY);
    expect(nextWorkday(SUNDAY)).toBe(MONDAY);
  });
});

describe('addWorkdays', () => {
  it('steps over the weekend', () => {
    expect(addWorkdays(THURSDAY, 1)).toBe(FRIDAY);
    // The one that matters: Friday plus one working day is Monday, not Saturday.
    expect(addWorkdays(FRIDAY, 1)).toBe(MONDAY);
    expect(addWorkdays(THURSDAY, 5)).toBe('2026-08-13');
  });

  it('starts a plan that begins on a weekend on the Monday', () => {
    expect(addWorkdays(SATURDAY, 0)).toBe(MONDAY);
  });

  it('floors a fractional offset — half a day is not half a date', () => {
    expect(addWorkdays(THURSDAY, 3.4)).toBe(addWorkdays(THURSDAY, 3));
  });

  it('reads a whole day arriving with a drifted bit as that whole day', () => {
    // A chained schedule accumulates `finish = start + days` in doubles:
    // 1/6 + 49/6 + 4/6 arrives as 8.999999999999998, and a bare floor read
    // that ninth day as the eighth — a row starting a whole day early.
    expect(addWorkdays(MONDAY, 8.999999999999998)).toBe(addWorkdays(MONDAY, 9));
    // The mirror drift: 45/6 + 25/6 + 20/6 arrives as 15.000000000000002.
    // Harmless to a floor, but the same snap covers it here so both discrete
    // boundaries treat one drifted value as one day.
    expect(addWorkdays(MONDAY, 15.000000000000002)).toBe(addWorkdays(MONDAY, 15));
  });

  it('still floors a genuine fraction near a boundary — 14.9 is real work', () => {
    // 14.9 is a tenth of a day short of 15: someone's estimate, not drift.
    // Snapping it up would move a date by a day the plan never contained.
    expect(addWorkdays(MONDAY, 14.9)).toBe(addWorkdays(MONDAY, 14));
  });

  it('refuses to walk backwards', () => {
    // Nothing happens before the plan's own start, and quietly counting into
    // last week is the kind of answer that reads as deliberate.
    expect(() => addWorkdays(THURSDAY, -1)).toThrow(/zero or more/);
  });

  it('crosses a month and a year without drifting', () => {
    // 2026-12-31 is a Thursday, so +1 workday is the Friday, +2 is Monday 4 Jan.
    expect(addWorkdays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addWorkdays('2026-12-31', 2)).toBe('2027-01-04');
  });
});

describe('snapWorkdays', () => {
  it('snaps drift on both sides of a whole day, and nothing else', () => {
    expect(snapWorkdays(8.999999999999998)).toBe(9);
    expect(snapWorkdays(15.000000000000002)).toBe(15);
    expect(snapWorkdays(15)).toBe(15);
    expect(snapWorkdays(0)).toBe(0);
    // Real fractions pass through untouched — a half-day is work, not error.
    expect(snapWorkdays(14.9)).toBe(14.9);
    expect(snapWorkdays(0.5)).toBe(0.5);
    expect(snapWorkdays(3.6666666666666665)).toBe(3.6666666666666665);
  });
});

describe('firstWorkdayOf', () => {
  it('reads drift on either side of a whole day as that whole day', () => {
    // 1/6 + 49/6 + 4/6 arrives as 8.999999999999998: the ninth day with a
    // drifted bit, and a bare floor read it as the eighth.
    expect(firstWorkdayOf(8.999999999999998)).toBe(9);
    expect(firstWorkdayOf(15.000000000000002)).toBe(15);
    expect(firstWorkdayOf(9)).toBe(9);
    expect(firstWorkdayOf(0)).toBe(0);
  });

  it('still floors a genuine fraction — half a day is not half a date', () => {
    expect(firstWorkdayOf(3.5)).toBe(3);
    expect(firstWorkdayOf(14.9)).toBe(14);
  });
});

describe('lastWorkdayOf', () => {
  it('is the day containing the finish, not the day it would spill into', () => {
    // A two-day span 3 → 5 is still on workday 4 and never on workday 5.
    expect(lastWorkdayOf(3, 5)).toBe(4);
    expect(lastWorkdayOf(0, 1)).toBe(0);
  });

  it('keeps a zero-length span on its own start day', () => {
    expect(lastWorkdayOf(5, 5)).toBe(5);
    // A fractional zero-length span sits inside its start's day.
    expect(lastWorkdayOf(3.5, 3.5)).toBe(3);
  });

  it('reads drift on either side of a whole day as that whole day', () => {
    // The drifted fifteenth day: a bare ceil made it the fifteenth *offset* —
    // one whole workday late, which over a weekend is three calendar days.
    expect(lastWorkdayOf(0, 15.000000000000002)).toBe(14);
    expect(lastWorkdayOf(0, 8.999999999999998)).toBe(8);
    // And the drifted start of a zero-length span keeps the same day be-01's
    // `startsOn` names for it.
    expect(lastWorkdayOf(8.999999999999998, 8.999999999999998)).toBe(9);
  });

  it('still rounds a genuine fraction as real work — 14.9 is inside day 14', () => {
    expect(lastWorkdayOf(0, 14.9)).toBe(14);
    expect(lastWorkdayOf(0, 14.5)).toBe(14);
  });
});

describe('wholeDaysCovering', () => {
  it('counts the cells a span needs, drift snapped and fractions covered', () => {
    expect(wholeDaysCovering(6)).toBe(6);
    // One drifted bit is not a seventh cell.
    expect(wholeDaysCovering(6.000000000000001)).toBe(6);
    expect(wholeDaysCovering(8.999999999999998)).toBe(9);
    // A real fraction still needs the cell it reaches into.
    expect(wholeDaysCovering(14.9)).toBe(15);
    expect(wholeDaysCovering(5.5)).toBe(6);
    expect(wholeDaysCovering(0)).toBe(0);
  });
});

describe('calendarDaysBetween', () => {
  it('counts every day between two dates, weekends among them', () => {
    // The one the Gantt's calendar scale is built on: Friday to Monday is three
    // days on a calendar and one on a workday axis.
    expect(calendarDaysBetween(FRIDAY, MONDAY)).toBe(3);
    expect(calendarDaysBetween(THURSDAY, THURSDAY)).toBe(0);
    // Backwards is a real answer here, unlike `workdaysBetween`: this counts
    // days rather than expressing a constraint that may only push later.
    expect(calendarDaysBetween(MONDAY, FRIDAY)).toBe(-3);
  });

  it('crosses a month and a year without drifting', () => {
    expect(calendarDaysBetween('2026-08-30', '2026-09-02')).toBe(3);
    expect(calendarDaysBetween('2026-12-30', '2027-01-02')).toBe(3);
  });

  it('crosses a daylight-saving boundary as whole days', () => {
    // 2026-03-08 is the US spring-forward Sunday, so this pair is 47 hours
    // apart in New York and 48 in UTC. `TZ` is pinned around the assertion
    // because the fault this case exists for is only visible in a zone that has
    // a DST boundary here — see the `Proof:` on `calendarDaysBetween`.
    const zone = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      expect(calendarDaysBetween('2026-03-07', '2026-03-09')).toBe(2);
    } finally {
      process.env.TZ = zone;
    }
  });

  it('refuses a string that is not a calendar date', () => {
    expect(() => calendarDaysBetween(THURSDAY, '2026-02-31')).toThrow(/not a calendar date/);
    expect(() => calendarDaysBetween('tomorrow', THURSDAY)).toThrow(/not a calendar date/);
  });
});

describe('addCalendarDays', () => {
  it('walks over the weekend rather than round it', () => {
    // The difference from `addWorkdays` in one line: this is the axis the Gantt
    // draws weekend columns on, so Friday plus one is the Saturday.
    expect(addCalendarDays(FRIDAY, 1)).toBe(SATURDAY);
    expect(addCalendarDays(FRIDAY, 3)).toBe(MONDAY);
    expect(addCalendarDays(THURSDAY, 0)).toBe(THURSDAY);
  });

  it('crosses a month and a year', () => {
    expect(addCalendarDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('inverts calendarDaysBetween', () => {
    for (const days of [0, 1, 7, 33, 400]) {
      expect(calendarDaysBetween(THURSDAY, addCalendarDays(THURSDAY, days))).toBe(days);
    }
  });
});

describe('isMonday', () => {
  it('is true on Monday alone', () => {
    expect([THURSDAY, FRIDAY, SATURDAY, SUNDAY].map(isMonday)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(isMonday(MONDAY)).toBe(true);
  });
});

describe('workdaysBetween', () => {
  it('inverts addWorkdays for whole offsets', () => {
    for (const offset of [0, 1, 2, 5, 17, 40]) {
      expect(workdaysBetween(THURSDAY, addWorkdays(THURSDAY, offset))).toBe(offset);
    }
  });

  it('is zero for a date at or before the start', () => {
    // A constraint may only ever push a work item later, so a date before the
    // project's start is not a negative offset dragging the tree backwards.
    expect(workdaysBetween(MONDAY, THURSDAY)).toBe(0);
    expect(workdaysBetween(THURSDAY, THURSDAY)).toBe(0);
  });

  it('ignores the weekend between two dates', () => {
    expect(workdaysBetween(FRIDAY, MONDAY)).toBe(1);
  });
});

describe('withinDrift', () => {
  it('reads two roundings of one real number as the same point', () => {
    // The pair that made `schedule()` refuse the plan's own quantised baseline:
    // `days: 5/12, width: 5` is exactly 4 solver units, and 4 / 48 and
    // (5 / 12) / 5 are one ulp apart.
    expect(withinDrift(4 / 48, 5 / 12 / 5)).toBe(true);
    expect(4 / 48 === 5 / 12 / 5).toBe(false);
  });

  it('still sees a gap of one solver unit, which is the smallest real one', () => {
    // The window is only safe because the solver places integers: a start that
    // is genuinely early is early by at least 1/48 of a day, seven orders above
    // the window. Widen DRIFT past that and this fails.
    expect(withinDrift(0, 1 / 48)).toBe(false);
    expect(withinDrift(2, 2 - 1 / 48)).toBe(false);
  });
});

describe('previousWorkday', () => {
  it('rolls a weekend backward where nextWorkday rolls it forward', () => {
    expect(previousWorkday(MONDAY)).toBe(MONDAY);
    expect(previousWorkday(SATURDAY)).toBe(FRIDAY);
    expect(previousWorkday(SUNDAY)).toBe(FRIDAY);
    // The pair is the point: the same two dates answer Monday through
    // `nextWorkday`, and a deadline that took that answer would be handed the
    // whole weekend plus a Monday it was never given.
    expect(nextWorkday(SATURDAY)).toBe(MONDAY);
  });
});

describe('deadlineOffsetOf', () => {
  // 2026-08-03 is the Monday before THURSDAY, so day zero of a plan starting
  // there is 2026-08-03 itself and Friday the 7th is offset 4.
  const START_MONDAY = '2026-08-03';

  it('counts from the same day zero addWorkdays counts from', () => {
    expect(deadlineOffsetOf(START_MONDAY, START_MONDAY)).toEqual({ kind: 'offset', offset: 0 });
    expect(deadlineOffsetOf(START_MONDAY, FRIDAY)).toEqual({ kind: 'offset', offset: 4 });
    expect(deadlineOffsetOf(START_MONDAY, MONDAY)).toEqual({ kind: 'offset', offset: 5 });
  });

  it("takes the project's day zero from nextWorkday, not from the stored start", () => {
    // A plan stored as starting on a Saturday begins on the Monday, because
    // that is what `addWorkdays(start, 0)` names. So a Sunday deadline — one
    // calendar day AFTER that stored start — still falls before the axis.
    expect(addWorkdays(SATURDAY, 0)).toBe(MONDAY);
    expect(deadlineOffsetOf(SATURDAY, MONDAY)).toEqual({ kind: 'offset', offset: 0 });
    expect(deadlineOffsetOf(SATURDAY, SUNDAY)).toEqual({ kind: 'before-project-start' });
  });

  // WATCHED RED W3. Substituting `workdaysBetween` for `deadlineOffsetOf` —
  // the obvious way to write this, and the function that already exists —
  // fails both of these together, and neither alone is the red:
  //
  //   `grants a weekend deadline …`  expected { kind: 'offset', offset: 4 }
  //                                  received { kind: 'offset', offset: 5 }
  //   `refuses to turn a deadline …` expected { kind: 'before-project-start' }
  //                                  received { kind: 'offset', offset: 0 }
  //
  // The second is the one that matters and the one a weekend-only test cannot
  // see: `workdaysBetween` clamps a date before its origin to 0, so a deadline
  // the user typed in the past would arrive downstream as the STRICTEST
  // deadline the model can express, indistinguishable from a date somebody
  // chose. Watched 2026-09-06.
  it('never grants a weekend deadline the following Monday', () => {
    // Saturday the 8th is Friday the 7th's offset. `workdaysBetween` rolls it
    // forward to Monday the 10th and answers 5 — two calendar days of slack
    // nobody agreed to, on every weekend deadline in the plan.
    expect(deadlineOffsetOf(START_MONDAY, SATURDAY)).toEqual({ kind: 'offset', offset: 4 });
    expect(deadlineOffsetOf(START_MONDAY, SUNDAY)).toEqual({ kind: 'offset', offset: 4 });
    expect(workdaysBetween(START_MONDAY, SATURDAY)).toBe(5);
  });

  it('never turns a deadline before the plan into offset zero', () => {
    // There is no number for "before the project starts", and 0 is the worst
    // available lie: it is the tightest deadline on the axis.
    expect(deadlineOffsetOf(MONDAY, FRIDAY)).toEqual({ kind: 'before-project-start' });
    expect(deadlineOffsetOf(MONDAY, SATURDAY)).toEqual({ kind: 'before-project-start' });
    expect(workdaysBetween(MONDAY, FRIDAY)).toBe(0);
  });

  it('refuses a value that is not a calendar date at either end', () => {
    expect(() => deadlineOffsetOf(MONDAY, '2026-02-31')).toThrow(/not a calendar date/);
    expect(() => deadlineOffsetOf('not-a-date', MONDAY)).toThrow(/not a calendar date/);
  });
});
