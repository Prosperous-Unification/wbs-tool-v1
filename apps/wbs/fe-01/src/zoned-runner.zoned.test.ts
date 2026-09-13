import { describe, expect, it } from 'vitest';

/**
 * The zoned runner asserting its own zone.
 *
 * `vitest.zoned.config.ts` exists so that zone-sensitive cases have a process
 * that **started** under a non-UTC zone; a case cannot arrange that for itself,
 * because the timezone is read once before a test file loads. Nothing inside a
 * zoned case can tell the difference between "the runner is in Auckland" and
 * "the runner is in UTC and my fixture happens to be zone-free" — under UTC the
 * local-midnight fault they exist to catch returns the correct answer, so every
 * one of them would go green with the zone silently gone.
 *
 * This file is that difference, said once. If `TZ=Pacific/Auckland` is ever
 * dropped from the `test` target's second invocation, or the config stops being
 * reached, this fails here rather than leaving a row of vacuous greens
 * elsewhere.
 */
describe('the zoned runner', () => {
  it('started under Pacific/Auckland rather than the suite-wide UTC', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Pacific/Auckland');
  });

  it('turns a local-midnight construction into the day before, which is the fault', () => {
    // The exact expression task 4.3a's negative injects, and the exact reason
    // that negative cannot be watched in the UTC run: here it is `2026-08-18`,
    // there it is `2026-08-19` and indistinguishable from the correct answer.
    expect(new Date('2026-08-19T00:00:00').toISOString().slice(0, 10)).toBe('2026-08-18');
    // And the control that says the fault is the *construction*, not the
    // string: ECMAScript parses a date-only string as UTC, so this round trip
    // answers `2026-08-19` under any zone at all. A negative written against
    // this form would have been green — round-5 Sol review, Important 9.
    expect(new Date('2026-08-19').toISOString().slice(0, 10)).toBe('2026-08-19');
  });
});
