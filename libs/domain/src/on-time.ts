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
  return lastWorkdayOf(start, finish) <= deadlineOffset;
}
