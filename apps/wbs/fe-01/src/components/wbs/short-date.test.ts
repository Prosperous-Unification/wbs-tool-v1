import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MalformedDayError, shortInstant, shortIsoDate } from './short-date';

/** Somebody's today, in 2026. */
const IN_2026 = new Date(2026, 6, 15);

/**
 * A zone behind UTC, which is where the parsing fault this module exists to
 * avoid actually shows up.
 *
 * It cannot be entered from inside this suite: vitest hands each worker a
 * `process.env` proxy, and assigning `TZ` on it never reaches the Date engine
 * — watched, `Intl.DateTimeFormat().resolvedOptions().timeZone` unchanged and
 * `new Date('2026-06-01').getDate()` still 1. So the case is run where a zone
 * really can be set: a `bun` of its own, with `TZ` in its environment.
 */
const BEHIND_UTC = 'America/Los_Angeles';

/**
 * Runs `script` in a fresh bun with `TZ` set, and hands back what it printed.
 *
 * A subprocess rather than a stub, because the thing under test is how a real
 * date engine behaves in a real zone — a fake `Date` would be this file's
 * opinion about timezones standing in for a platform's.
 */
function inZone(zone: string, script: string): string {
  return execFileSync('bun', ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, TZ: zone },
  }).trim();
}

/**
 * This module, by a path a subprocess can import.
 *
 * From the working directory rather than from `import.meta.url`, which vite
 * rewrites to a URL with no file scheme. Asserted rather than assumed: a
 * missing file would make the subprocess fail for a reason that has nothing to
 * do with timezones, and the failure would name the wrong thing.
 */
const MODULE = resolve(process.cwd(), 'src/components/wbs/short-date.ts');
if (!existsSync(MODULE)) {
  throw new Error(`short-date.ts is not at ${MODULE}; this suite runs from apps/fe-01.`);
}

describe('a calendar day, printed as somebody reads one', () => {
  it('drops the year while it is the reader’s own', () => {
    expect(shortIsoDate('2026-06-01', IN_2026)).toBe('1 Jun');
    expect(shortIsoDate('2026-11-24', IN_2026)).toBe('24 Nov');
  });

  it('carries the year when it is not, as two digits behind an apostrophe', () => {
    // Never ambiguous: a plan that runs into next year prints that year on the
    // days that are in it, so a bare `1 Jun` always means this year. Two digits
    // since 2026-09-13, because the year is what the date columns are sized by
    // and Dany asked for them narrower — see `offYear`.
    expect(shortIsoDate('2027-06-01', IN_2026)).toBe("1 Jun '27");
    expect(shortIsoDate('2025-06-01', IN_2026)).toBe("1 Jun '25");
    // A year ending in one digit is still two: `'05`, never `'5`.
    expect(shortIsoDate('2105-06-01', IN_2026)).toBe("1 Jun '05");
  });

  it('reads either side of a year boundary as the year it is in', () => {
    expect(shortIsoDate('2026-12-31', IN_2026)).toBe('31 Dec');
    expect(shortIsoDate('2027-01-01', IN_2026)).toBe("1 Jan '27");
  });

  it('prints the day the string says, for a reader west of UTC', () => {
    // The fault this function exists to avoid, run in the zone that produces
    // it. `new Date('2026-06-01')` is midnight **UTC** and `getDate()` answers
    // locally, so a formatter that parsed its input would print the day before
    // for everybody west of Greenwich. A project's dates are calendar days —
    // no time, no zone, nothing to convert.
    //
    // The first half of the answer is the precondition: without it this is a
    // check that cannot fail, because a subprocess whose `TZ` did not take
    // would agree with the assertion for the wrong reason.
    //
    // Proof: `shortIsoDate` reimplemented as `new Date(iso)` read through
    // `getDate()`/`getMonth()`/`getFullYear()`, this failed on `expected '31|31
    // May' to be '31|1 Jun'`. Watched, 2026-08-09.
    const printed = inZone(
      BEHIND_UTC,
      `const { shortIsoDate } = await import(${JSON.stringify(MODULE)});` +
        `process.stdout.write(new Date('2026-06-01').getDate() + '|' + shortIsoDate('2026-06-01', new Date(2026, 6, 15)));`,
    );

    expect(printed).toBe('31|1 Jun');
  });

  it('refuses anything that is not a calendar day, rather than printing one', () => {
    // Unknown is not OK: every string reaching this comes from be-01's own
    // `IsoDate`, so anything else is a fault in this application. An em-dash
    // for it would look exactly like a row that has no day.
    // Proof: the `parts === null` throw replaced by `return iso`, this failed
    // on `expected [Function] to throw an error`. Watched, 2026-08-09.
    expect(() => shortIsoDate('2026-6-1', IN_2026)).toThrow(MalformedDayError);
    expect(() => shortIsoDate('', IN_2026)).toThrow(MalformedDayError);
    expect(() => shortIsoDate('2026-06-01T00:00:00Z', IN_2026)).toThrow(MalformedDayError);
    // The shape can match and the day still not exist, which is what the
    // pattern alone cannot refuse.
    expect(() => shortIsoDate('2026-13-01', IN_2026)).toThrow(MalformedDayError);
    expect(() => shortIsoDate('2026-06-00', IN_2026)).toThrow(MalformedDayError);
  });
});

describe('an instant, printed in the browser’s own zone', () => {
  it('prints the day, dropping the year while it is the reader’s own', () => {
    expect(shortInstant(new Date(2026, 5, 1, 9, 30).getTime(), IN_2026)).toBe('1 Jun');
  });

  it('carries the year when it is not', () => {
    expect(shortInstant(new Date(2027, 5, 1, 9, 30).getTime(), IN_2026)).toBe("1 Jun '27");
  });

  it('reads a UTC midnight as the day it is in the zone it is read in', () => {
    // The stated cost of having no display-timezone concept, asserted rather
    // than assumed: an instant is a point in time, and the day it falls on is
    // the reader's own machine's answer. Midnight UTC on 1 June is still the
    // evening of 31 May in Los Angeles — and that is what a reader there
    // should see, because that is when it happened for them.
    //
    // Run in a zone behind UTC for the same reason as above: in this machine's
    // own zone the two answers coincide and the assertion would be empty.
    const printed = inZone(
      BEHIND_UTC,
      `const { shortInstant } = await import(${JSON.stringify(MODULE)});` +
        `process.stdout.write(shortInstant(Date.UTC(2026, 5, 1), new Date(2026, 6, 15)));`,
    );

    expect(printed).toBe('31 May');
    // And the calendar-day formatter, handed the same day as a string, does
    // not move it — which is the whole reason there are two of these.
    expect(shortIsoDate('2026-06-01', IN_2026)).toBe('1 Jun');
  });

  it('refuses an epoch that is not a time', () => {
    expect(() => shortInstant(Number.NaN, IN_2026)).toThrow(MalformedDayError);
  });
});
