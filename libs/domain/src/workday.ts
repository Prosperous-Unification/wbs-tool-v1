/**
 * A calendar day, as `YYYY-MM-DD`. No time, no zone.
 *
 * A plan says "this starts on the 12th", never "at 09:00 UTC". Carrying a time
 * would mean carrying a timezone, and a project read in Kyiv and in London
 * would then disagree about which day a work item starts on.
 */
export type IsoDate = string;

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `value` is a date this module can work with, and a real day. */
export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  // `2026-02-31` matches the shape and is not a day. `Date.parse` accepts it
  // and rolls it into March, so the round-trip is the check.
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Parsed to midnight UTC, so every arithmetic below is whole days apart. */
function toUtc(date: IsoDate): Date {
  if (!isIsoDate(date)) throw new Error(`not a calendar date: ${JSON.stringify(date)}`);
  return new Date(`${date}T00:00:00Z`);
}

const asIso = (at: Date): IsoDate => at.toISOString().slice(0, 10);

/**
 * Whether a date falls on a Saturday or Sunday.
 *
 * Weekends only. Public holidays are deliberately absent: they differ by
 * country, by company and by year, and guessing them would put dates in a plan
 * that nobody can account for. A project that needs them needs a calendar it
 * owns, which is a decision rather than a default.
 */
export function isWeekend(date: IsoDate): boolean {
  const day = toUtc(date).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Whether a date is a Monday.
 *
 * The day a calendar week begins on, which is where the Gantt's calendar axis
 * puts its heavy gridline: on an axis of seven cells a week, every fifth line
 * falls on a Saturday and says nothing.
 */
export function isMonday(date: IsoDate): boolean {
  return toUtc(date).getUTCDay() === 1;
}

/**
 * How many calendar days `to` is after `from` — weekends counted, and negative
 * when `to` is the earlier of the two.
 *
 * The calendar counterpart of {@link workdaysBetween}, and what the Gantt's
 * calendar scale is built out of: a chart whose x unit is one calendar day has
 * to know that Friday to Monday is three days and not one. Negative is a real
 * answer here where it is not there — this counts days, while
 * {@link workdaysBetween} expresses a constraint that may only ever push later.
 *
 * The answer is a whole number for every pair this can be asked for, and that is
 * {@link toUtc}'s doing rather than a rounding: both ends are midnight UTC, so
 * their difference is a multiple of a day whatever either date's local zone did
 * that night.
 *
 * Proof: the two ends parsed as **local** midnight instead — `new Date(y, m-1,
 * d)` — which is the obvious way to write this and is wrong across a
 * daylight-saving boundary. `crosses a daylight-saving boundary as whole days`
 * alone failed, on `expected 1.9583333333333333 to be 2` for `2026-03-07` →
 * `2026-03-09` with `TZ=America/New_York`: 47 hours over the US spring-forward
 * Sunday. Watched 2026-08-09. Rounding that fault away is **not** the negative
 * — `Math.round` gives 2 either way, and a month-boundary case cannot see it
 * at all, which is the shape R5 exists to stop.
 *
 * @throws Whatever {@link toUtc} throws when either end is not a calendar date.
 */
export function calendarDaysBetween(from: IsoDate, to: IsoDate): number {
  return (toUtc(to).getTime() - toUtc(from).getTime()) / DAY_MS;
}

/**
 * The date `days` calendar days after `from` — over a weekend rather than
 * round it, which is the whole of the difference from {@link addWorkdays}.
 *
 * The inverse of {@link calendarDaysBetween}, and what names the date on each
 * cell of a calendar axis — weekend cells included, which is the one thing
 * `addWorkdays` can never answer.
 *
 * @throws Whatever {@link toUtc} throws when `from` is not a calendar date.
 */
export function addCalendarDays(from: IsoDate, days: number): IsoDate {
  return asIso(new Date(toUtc(from).getTime() + days * DAY_MS));
}

/**
 * How close to a whole day an offset must be before the difference is read as
 * floating-point drift rather than work.
 *
 * A schedule chains `finish = start + days` across work items, and doubles
 * accumulate: three PERT sixths that sum to exactly 15 arrive as
 * 15.000000000000002. At 1e-9 the window is about nine orders of magnitude
 * above any error a plan-sized chain of additions can accumulate, and about
 * eight below the smallest real fraction an estimate can carry (a sixth of a
 * day) — so it can never swallow work someone estimated.
 */
const DRIFT = 1e-9;

/**
 * `workdays` with accumulated floating-point drift removed: within {@link DRIFT}
 * of a whole day it **is** that whole day, and anything further is real work,
 * returned untouched.
 *
 * Applied only where a fractional number becomes a discrete one, because that
 * is the only step where a drifted bit can mint or eat a whole unit of
 * something; the engine's own numbers stay verbatim on the wire. Four such
 * sites: the discrete calendar boundaries {@link addWorkdays}' floor,
 * {@link firstWorkdayOf}, {@link lastWorkdayOf} and {@link wholeDaysCovering},
 * and — since 2026-09-03 — `durationUnits`' step onto the solver's integer
 * axis, whose unit is `1 / SOLVER_QUANTUM` of a day rather than a whole one.
 * The window survives that change of unit with room to spare: {@link DRIFT} is
 * chosen eight orders below a sixth of a day, and a sixth of a day is eight
 * solver units, so it is still nine orders below the smallest real fraction an
 * estimate can quantise to and still cannot swallow work somebody estimated.
 *
 * Proof: with the window widened to 0.5, `keeps a genuine fraction just shy of
 * a boundary as real work` (the production path, `work-item.service.test.ts`)
 * failed — a 14.9-day row's successor started `"2026-08-31"` where
 * `"2026-08-28"` was owed, a shared day rounded away as if it were drift —
 * and `still floors a genuine fraction near a boundary — 14.9 is real work`
 * (`workday.test.ts`) failed on the same pair of dates; watched 2026-08-10.
 */
export function snapWorkdays(workdays: number): number {
  const whole = Math.round(workdays);
  return Math.abs(workdays - whole) < DRIFT ? whole : workdays;
}

/**
 * Whether two workday values denote the **same** point on the axis, up to the
 * same accumulated drift {@link snapWorkdays} exists for.
 *
 * The sibling of that function for the case it cannot serve: it snaps a value
 * towards a WHOLE day, and two numbers can be one ulp apart at 0.083 of a day
 * with no whole number anywhere near them. That is exactly where the optimized
 * materialiser lands. A solver offset divides back to `k / SOLVER_QUANTUM`
 * while Fast reached the same real point through `days / width`, and the two
 * roundings need not produce the same double: over every width 1–1000 and
 * offset 1–480 whose real duration is an exact unit multiple, 53,451 of 480,000
 * pairs put the dequantised value strictly below Fast's and 52,691 strictly
 * above (measured 2026-09-04). Compared with a bare `<` the first group made
 * `schedule()` refuse the plan's own quantised baseline, and the second labelled
 * a slice sitting on its floor `'optimizer'`.
 *
 * **The window is safe here with nine orders to spare, and that is an argument
 * rather than a hope.** The smallest gap this comparison must still be able to
 * SEE is one solver unit — the solver places integers, so a start that is
 * genuinely early is early by at least `1 / SOLVER_QUANTUM` of a day, about
 * 0.0208 — while {@link DRIFT} is 1e-9. Widening it to 0.5 would swallow a real
 * unit; at 1e-9 it cannot swallow anything the model can express.
 */
export function withinDrift(a: number, b: number): boolean {
  return Math.abs(a - b) < DRIFT;
}

/**
 * The whole workday a span standing at `offset` begins on: {@link snapWorkdays},
 * then floor.
 *
 * One of the three discrete calendar readings, shared so that be-01's printed
 * dates and fe-01's Gantt are one arithmetic rather than two copies of a rule
 * — a copy with the snap left out reads a drifted 8.999999999999998 as day 8
 * and starts a row a whole day early on screen. A genuine fraction still
 * floors: half a day is not half a date, and the fraction stays in the
 * schedule, where it means something.
 *
 * Proof: the snap dropped from this floor (a bare `Math.floor(offset)`) and
 * one test failed in each tier — `reads drift on either side of a whole day
 * as that whole day` here; `holds the calendar steady when a chained finish
 * drifts below the whole day` (`work-item.service.test.ts`) on a successor
 * `startsOn` of `"2026-08-20"`, its predecessor's own last day, where
 * `"2026-08-21"` was owed; and `reads a drifted schedule as the same days
 * be-01 prints` (`gantt-panel.test.tsx`) on the bar's sentence losing
 * `13 Aug → 14 Aug` to a bare floor's 12 Aug. Watched 2026-08-10.
 */
export function firstWorkdayOf(offset: number): number {
  return Math.floor(snapWorkdays(offset));
}

/**
 * The last workday a span is still on: {@link snapWorkdays}, then `ceil − 1`,
 * and never before the span's own first workday.
 *
 * A task of any length occupies the day it finishes on, so a two-day task
 * starting on workday 3 is still on workday 4 and not on workday 5 — `ceil −
 * 1` rather than `finish - Number.EPSILON`, which silently does nothing at a
 * whole finish (see `datesOf` in be-01's `work-item.service.ts`, where this
 * arithmetic lived first). The clamp keeps a zero-length span — a parent with
 * nothing under it, an unestimated leaf — on the same day
 * {@link firstWorkdayOf} starts it.
 *
 * The snap is why this is here and not written inline where it is needed: a
 * chain of PERT sixths that sums to exactly 15 arrives as 15.000000000000002,
 * and a bare ceil reads the drifted bit as a sixteenth day — a Monday, three
 * calendar days late on screen.
 *
 * Proof, twice, both watched 2026-08-10:
 *
 * - the snap dropped (a bare `Math.ceil(finish) - 1`): `reads drift on either
 *   side of a whole day as that whole day` failed here, `ends a chain of PERT
 *   estimates on the day the estimates add up to` and `holds the calendar
 *   steady when a chained finish drifts above the whole day`
 *   (`work-item.service.test.ts`) failed on an `endsOn` of `"2026-08-31"`
 *   where `"2026-08-28"` was owed, and `reads a drifted schedule as the same
 *   days be-01 prints` (`gantt-panel.test.tsx`) failed on a `data-last-day`
 *   of `'5'` where `'4'` was owed.
 * - the `- 1` dropped, so a span's last day is the one it spills into: four
 *   cases failed here, and `reads the same dates under a bar as the row's
 *   Start and End cells` (`gantt-panel.test.tsx`) failed on `expected
 *   '2026-08-17' to be '2026-08-14'` — the same failure first watched
 *   2026-08-09 against the panel's own copy of this arithmetic, re-watched
 *   against the shared one.
 */
export function lastWorkdayOf(start: number, finish: number): number {
  return Math.max(firstWorkdayOf(start), Math.ceil(snapWorkdays(finish)) - 1);
}

/**
 * How many whole days cover a span `span` days long: {@link snapWorkdays},
 * then ceil.
 *
 * What sizes a chart axis: a horizon of 5.5 workdays needs six cells, and a
 * horizon of 6.000000000000001 is six days arriving with a drifted bit, not a
 * reason to mint a seventh cell that no mark can ever stand in.
 *
 * Proof: the snap dropped (a bare `Math.ceil(span)`) and `counts the cells a
 * span needs, drift snapped and fractions covered` failed here, with `does
 * not mint an axis cell from a drifted horizon` (`gantt-panel.test.tsx`)
 * failing beside it on a seventh cell — `['0' … '6']` where `['0' … '5']` was
 * owed. Watched 2026-08-10.
 */
export function wholeDaysCovering(span: number): number {
  return Math.ceil(snapWorkdays(span));
}

/** The first workday on or after `date` — `date` itself unless it is a weekend. */
export function nextWorkday(date: IsoDate): IsoDate {
  let at = toUtc(date);
  while (at.getUTCDay() === 0 || at.getUTCDay() === 6) at = new Date(at.getTime() + DAY_MS);
  return asIso(at);
}

/**
 * The first workday on or **before** `date` — `date` itself unless it is a
 * weekend.
 *
 * {@link nextWorkday} mirrored, and the direction is the whole point rather
 * than a symmetry for its own sake. A start date rolls forward because a plan
 * that begins on a Saturday begins on the Monday; a **deadline** must roll
 * backward, because "finish by Saturday the 15th" is a promise that the work is
 * done when that Saturday arrives, and rolling it to Monday the 17th hands out
 * two calendar days nobody agreed to. The two rules are opposite for the same
 * reason: each rolls towards the working day that keeps the constraint as
 * strong as the person who typed it meant it.
 */
export function previousWorkday(date: IsoDate): IsoDate {
  let at = toUtc(date);
  while (at.getUTCDay() === 0 || at.getUTCDay() === 6) at = new Date(at.getTime() - DAY_MS);
  return asIso(at);
}

/**
 * The date `workdays` working days after `from`, counting `from` as day zero.
 *
 * `addWorkdays(friday, 1)` is the following Monday, and `addWorkdays(x, 0)` is
 * the first workday on or after `x` — so a plan whose start date lands on a
 * Saturday begins on the Monday rather than reporting a day nobody works.
 *
 * Fractional offsets are floored: a task finishing 3.4 workdays in finishes on
 * the fourth working day, and half a day is not half a date. The fraction is
 * kept in the schedule, which is where it means something. The offset is put
 * through {@link snapWorkdays} first: an accumulated 8.999999999999998 is the
 * ninth day arriving with a drifted bit, and flooring it to 8 started a row a
 * whole day early on screen.
 *
 * Proof: the snap removed from this floor and `holds the calendar steady when
 * a chained finish drifts below the whole day` (`work-item.service.test.ts`)
 * failed — the successor started `"2026-08-20"`, its predecessor's own last
 * day, where `"2026-08-21"` was owed — with `reads a whole day arriving with
 * a drifted bit as that whole day` (`workday.test.ts`) failing beside it;
 * watched 2026-08-10.
 *
 * Negative offsets are refused rather than counted backwards. Nothing in this
 * plan happens before its own start, and silently walking into last week is
 * the kind of answer that reads as deliberate.
 */
/**
 * Which workday a **weekday** is, counted from an arbitrary fixed origin.
 *
 * The whole of what makes {@link addWorkdays} and {@link workdaysBetween}
 * closed-form rather than loops: a weekday's position in the sequence
 * Mon, Tue, … Fri, Mon, … is `5 · weeks + weekday`, so two of these subtract to
 * a workday count and one of them inverts back to a date.
 *
 * `+ 3` because 1970-01-01 was a **Thursday**, and the arithmetic wants a week
 * that begins on Monday. Only ever called on a date {@link nextWorkday} has
 * already moved off a weekend, and that precondition is load-bearing: a
 * Saturday would answer an index of `…5` that {@link dateOfWorkdayIndex} cannot
 * invert. It is also why a `Math.min(…, 4)` clamp here is indistinguishable —
 * `workday.property.test.ts` records that, because a reader who adds one should
 * know the tests cannot tell them apart.
 */
function workdayIndexOf(at: Date): number {
  const days = Math.floor(at.getTime() / DAY_MS) + 3;
  return Math.floor(days / 7) * 5 + (days % 7);
}

/** {@link workdayIndexOf} inverted: the weekday that many workdays along. */
function dateOfWorkdayIndex(index: number): Date {
  const days = Math.floor(index / 5) * 7 + (index % 5) - 3;
  return new Date(days * DAY_MS);
}

export function addWorkdays(from: IsoDate, workdays: number): IsoDate {
  if (!Number.isFinite(workdays) || workdays < 0) {
    throw new Error(`workdays must be zero or more, got ${String(workdays)}`);
  }
  // Closed form since 2026-09-02, where this walked a day at a time and built a
  // `Date` for each one — including the weekend days it then skipped. The
  // scheduler calls it per slice per read and the chart calls it per bar, so a
  // 250-workday plan was a quarter of a million allocations a read.
  //
  // Proof that it is the same function: `workday.property.test.ts` equates it
  // with the loop it replaced for every offset 0..500 from every weekday and
  // both weekend days, plus a thousand fast-check cases.
  const start = toUtc(nextWorkday(from));
  return asIso(dateOfWorkdayIndex(workdayIndexOf(start) + Math.floor(snapWorkdays(workdays))));
}

/**
 * How many working days `to` is after `from`, counting `from` as zero.
 *
 * The inverse of {@link addWorkdays} for whole offsets, which is what makes a
 * manual "start no earlier than this date" expressible to a scheduler that
 * counts in offsets. A date before `from` gives 0: the plan cannot start
 * before its own start, and a negative offset would drag the whole tree
 * backwards through a constraint meant only ever to push it later.
 */
export function workdaysBetween(from: IsoDate, to: IsoDate): number {
  const start = toUtc(nextWorkday(from));
  const end = toUtc(nextWorkday(to));
  // Closed form, for {@link addWorkdays}' reason and behind the same property
  // test. The clamp stays exactly where it was: a date before `from` is 0
  // rather than a negative, because a negative offset would drag the whole tree
  // backwards through a constraint meant only ever to push it later.
  if (end.getTime() <= start.getTime()) return 0;
  return workdayIndexOf(end) - workdayIndexOf(start);
}

/**
 * Where a stored deadline lands on the scheduler's workday axis, or the fact
 * that it lands before the axis begins.
 *
 * The variant exists because there is no number that can say
 * "before the project starts". Offset `0` is the plan's **first** working day,
 * so returning it for a deadline the user typed in the past would silently
 * replace their input with the strictest constraint the model can express —
 * and every downstream reader would take it for a date somebody chose. A caller
 * has to name the case to read past it.
 */
export type DeadlineOffset =
  | { readonly kind: 'offset'; readonly offset: number }
  | { readonly kind: 'before-project-start' };

/**
 * Which workday offset a `deadline` falls on, counted from `projectStart` the
 * way {@link addWorkdays} counts — so `deadlineOffsetOf(s, addWorkdays(s, k))`
 * is offset `k` for every workday `s` and every `k`, which is the property
 * `workday.property.test.ts` asserts.
 *
 * Two rules, and neither is {@link workdaysBetween}'s:
 *
 * - **The deadline rolls backward** through {@link previousWorkday}. A Saturday
 *   deadline is Friday's offset, not the following Monday's. `workdaysBetween`
 *   rolls both ends forward, so substituting it here quietly grants two extra
 *   calendar days on every weekend deadline.
 * - **Day zero is `nextWorkday(projectStart)`**, not `projectStart` itself,
 *   because that is the day `addWorkdays(projectStart, 0)` names and the whole
 *   axis is built on it. A rolled deadline strictly before that day is
 *   `before-project-start` and not offset `0`; `workdaysBetween` clamps it to
 *   `0` instead, which is the second half of the same substitution fault.
 *
 * Both halves of that fault are watched together in `workday.test.ts` (W3): a
 * test that catches only the weekend one passes with the impossible case turned
 * into the strictest possible deadline, which is a check that cannot fail for
 * the reason it was written.
 *
 * @throws Whatever {@link toUtc} throws when either date is not a calendar date.
 */
export function deadlineOffsetOf(projectStart: IsoDate, deadline: IsoDate): DeadlineOffset {
  const dayZero = toUtc(nextWorkday(projectStart));
  const at = toUtc(previousWorkday(deadline));
  if (at.getTime() < dayZero.getTime()) return { kind: 'before-project-start' };
  return { kind: 'offset', offset: workdayIndexOf(at) - workdayIndexOf(dayZero) };
}
