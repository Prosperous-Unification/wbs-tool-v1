/**
 * The months, as a reader writes them.
 *
 * Written out rather than taken from `Intl`, and that is deliberate: `Intl`
 * answers in the browser's locale, so one plan would read `1 Jun` for one
 * person and `1 juin` for another while the CSV, the Markdown export and every
 * `title` in the table stayed `2026-06-01`. The product has one language.
 */
const MONTHS: readonly string[] = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** A `YYYY-MM-DD` and nothing looser — no `2026-6-1`, no time, no zone suffix. */
const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A day this module was handed that is not a calendar day.
 *
 * Unknown is not OK: every string reaching {@link shortIsoDate} comes from
 * be-01's own `IsoDate`, so anything else is a fault in this application rather
 * than a state to model. Printing an em-dash for it would hide a broken column
 * behind a column that looks empty.
 */
export class MalformedDayError extends Error {
  constructor(given: string) {
    super(`"${given}" is not a YYYY-MM-DD calendar day.`);
    this.name = 'MalformedDayError';
  }
}

/**
 * The name of the month numbered `oneBased`, 1–12.
 *
 * @throws {MalformedDayError} for anything outside that range, which is
 * reachable from {@link shortIsoDate}: `2026-13-01` matches the shape and is
 * not a day.
 */
function monthNamed(oneBased: number, given: string): string {
  // The range, checked against this very array rather than against a written-out
  // 12: an index out of it reads as `undefined` at runtime and as a `string` to
  // the compiler, which is a guard the types would call dead while it was doing
  // the work. Asked as a question about the array instead.
  //
  // Proof: this line removed, `refuses anything that is not a calendar day`
  // failed on `expected [Function] to throw an error` with `2026-13-01`
  // printing `1 undefined 2026`. Watched, 2026-08-09.
  if (!Number.isInteger(oneBased) || oneBased < 1 || oneBased > MONTHS.length) {
    throw new MalformedDayError(given);
  }
  return MONTHS[oneBased - 1];
}

/**
 * A calendar day as somebody reads one: `1 Jun`, or `1 Jun '27` when the year
 * is not `today`'s ({@link offYear}).
 *
 * **The components are read out of the string and the string is never parsed
 * into a moment.** `new Date('2026-06-01')` is midnight **UTC**, and
 * `getDate()` on it answers in the reader's own zone — so every date on the
 * plan would print a day early for everybody west of Greenwich. A project's
 * dates are calendar days: they have no time, no zone, and nothing to convert.
 * {@link shortInstant} is the other function, for the things that really are
 * moments.
 *
 * The year is dropped only when it matches `today`'s, so the omission is never
 * ambiguous: a plan that runs into next year prints that year on the days that
 * are in it.
 *
 * @param iso the day, as be-01 holds it.
 * @param today the reader's own today, which is the year the omission is
 * measured against.
 * @throws {MalformedDayError} for anything that is not `YYYY-MM-DD`.
 */
export function shortIsoDate(iso: string, today: Date): string {
  const parts = CALENDAR_DAY.exec(iso);
  if (parts === null) throw new MalformedDayError(iso);
  // Present because the pattern matched three groups; `Number` on a `\d{2}`
  // cannot be NaN, and the ranges are checked below.
  const year = Number(parts[1]);
  const month = monthNamed(Number(parts[2]), iso);
  const day = Number(parts[3]);
  if (day < 1 || day > 31) throw new MalformedDayError(iso);
  return year === today.getFullYear()
    ? `${String(day)} ${month}`
    : `${String(day)} ${month} ${offYear(year)}`;
}

/**
 * A year that is not the reader's own, as a short date carries it: `'27`, the
 * apostrophe and the last two digits.
 *
 * Two digits and not four since 2026-09-13, because the year is what the Start
 * and End columns are sized by — {@link DAY_ENVELOPE} is the widest day this
 * prints, with the year on — and Dany asked for both columns narrower ("start
 * end can also be smaller"). The two digits it drops buy the 14px that took
 * `DATE_COLUMN_WIDTH` from 98 to 84; nothing else in the envelope could be
 * spared. Unambiguous all the same: a plan does not run a century, and the
 * apostrophe is what keeps `1 Jun '27` from reading as the 27th of anything.
 * The full `YYYY-MM-DD` stays where it was, in the cell's `title` and in
 * {@link DayReading.fullDate}.
 *
 * Padded, so a year ending in a single digit still reads as a year: `'05` and
 * not `'5`.
 */
function offYear(year: number): string {
  return `'${String(year % 100).padStart(2, '0')}`;
}

/**
 * A moment as the same kind of short date, in the browser's own zone.
 *
 * The stated cost: this product has no display-timezone concept, so the day an
 * instant falls on is whatever the reader's machine says it is, and two people
 * either side of a date line can read one instant as two days. That is a
 * decision rather than an oversight — the alternative is a timezone setting on
 * a product whose own dates are zone-free — and `short-date.test.ts` asserts
 * it rather than assuming it.
 *
 * Instants are the things that really happened at a point in time: when a
 * project was created, when somebody last edited it. A work item's dates are
 * not instants; see {@link shortIsoDate}.
 *
 * @throws {MalformedDayError} for an epoch that is not a time at all.
 */
export function shortInstant(epochMs: number, now: Date): string {
  const at = new Date(epochMs);
  const year = at.getFullYear();
  if (Number.isNaN(year)) throw new MalformedDayError(String(epochMs));
  const month = monthNamed(at.getMonth() + 1, String(epochMs));
  const day = at.getDate();
  return year === now.getFullYear()
    ? `${String(day)} ${month}`
    : `${String(day)} ${month} ${offYear(year)}`;
}

/**
 * One end of a work item's span as a renderer prints it, and the fuller fact
 * behind what is printed.
 *
 * Two fields rather than one string, because the short date is a **shortening**
 * — `1 Jun`, or `1 Jun '27` off the current year — and nothing that was
 * readable may become unreadable: the cell carries the whole `YYYY-MM-DD` in
 * its `title`. A workday offset and an em-dash have no fuller form, and say so
 * with a null rather than by repeating themselves.
 */
export interface PrintedDay {
  /** What the cell shows: a short date, a workday offset, or an em-dash. */
  text: string;
  /** The day in full, where the figure is a real date and not an offset. */
  iso: string | null;
}

/**
 * A scheduled day as it is printed: the short date where the plan is on a
 * calendar, and whatever the caller falls back to where it is not.
 *
 * The fallback is passed in rather than computed here because it is two
 * different sentences — a workday offset while the project has no start date,
 * an em-dash when the schedule could not be computed at all — and both belong
 * to the component that knows which is which.
 */
export const printedDay = (iso: string | null, today: Date, fallback: () => string): PrintedDay =>
  iso === null ? { text: fallback(), iso: null } : { text: shortIsoDate(iso, today), iso };
