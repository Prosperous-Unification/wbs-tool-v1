import { lastWorkdayOf } from './workday';

/**
 * Whether a slice standing at `start` and running to `finish` meets an
 * effective deadline of `deadlineOffset`, all three in whole days from day zero.
 *
 * **Written once, here, and referenced rather than re-derived.** Fast's
 * lateness label, the solver's hard finish constraint and the UI's
 * `Late by N workdays` all ask the same question, and three copies of it is
 * three chances to write the off-by-one differently. `finish <= deadline` does
 * not appear anywhere in the implementation: it is the wrong question.
 *
 * **The question is which whole workday the slice is still ON, not where its
 * fractional finish falls.** A deadline names a day, and a task occupies the
 * day it finishes on — so a two-day task starting on workday 3 is still on
 * workday 4, and a deadline of 4 is met. {@link lastWorkdayOf} is that reading,
 * and it is shared with every date be-01 prints and every bar fe-01 draws, so a
 * row reported late here is late on the same calendar the user is looking at.
 *
 * The `deadlineOffset` this takes is the **effective** one — the leaf's own
 * date folded against every ancestor's by `leafDeadlinesOf`. A leaf absent from
 * that fold has no deadline and is never asked.
 */
export function isOnTime(start: number, finish: number, deadlineOffset: number): boolean {
  return workdaysLateBy(start, finish, deadlineOffset) === 0;
}

/**
 * How many whole workdays late a slice is against its effective deadline, and
 * `0` when it met it.
 *
 * `N = lastWorkdayOf(start, finish) − deadlineOffset`, at least 1 whenever it is
 * late at all. This is the number the `Late by N workdays` label prints, and
 * {@link isOnTime} is defined as this being zero **rather than as its own
 * comparison** — one arithmetic, so the number on screen and the verdict that
 * put it there cannot disagree. Two functions each doing their own `<=` is how
 * a row reads `Late by 0 workdays`, or reads late with no number beside it.
 *
 * **Workdays, not calendar days,** because the offsets it subtracts are workday
 * offsets: a Friday deadline missed into the following Monday is late by one,
 * not by three. The copy has to say `workdays` for that reason and not as a
 * house style.
 *
 * The count and its label are deliberately in different layers. This is whole
 * workdays and nothing else; whether the sentence reads `1 workdays` is the
 * label's problem (slice 9.2), and the design does not settle it — flagged
 * 2026-09-06 rather than guessed at here.
 */
export function workdaysLateBy(start: number, finish: number, deadlineOffset: number): number {
  const lastDay = lastWorkdayOf(start, finish);
  return lastDay <= deadlineOffset ? 0 : lastDay - deadlineOffset;
}
