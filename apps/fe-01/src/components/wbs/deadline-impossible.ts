import { deadlineOffsetOf, isIsoDate } from '@wbs/domain/workday';

/**
 * Whether a stored deadline resolves **before the project's day zero** — the
 * `work-item-deadline` §2.3 case where somebody moved the project start past a
 * date that was legal when it was typed.
 *
 * **Not a second opinion about lateness.** `Late by N workdays` is be-01's
 * number and slice 9.2's doctrine is that the view never recomputes it. This is
 * a different predicate — *whether* a date falls before day zero, not *how far*
 * a plan misses it — and it is answered by calling the one function be-01's own
 * write boundary calls (`work-item.service.ts`'s `deadline_before_project_start`
 * refusal), so the two sides share an implementation rather than holding two
 * opinions.
 *
 * Three modelled absences, all false and none of them a warning:
 *
 * - **No deadline.** Nothing to be impossible.
 * - **No project start date.** With no day zero there is nothing for a date to
 *   fall before, which is the reasoning be-01 applies to the same state; the
 *   table's cell is already rendered disabled there and a disabled cell wearing
 *   a warning would be claiming to know something it cannot.
 * - **Either value is not a calendar date.** {@link deadlineOffsetOf} throws on
 *   one, and neither a render nor a download is the moment to take a surface
 *   down over a byte the server sent.
 *
 * **This file exists because three faces ask the question.** It was private to
 * `wbs-table.tsx` while the table's `Due` cell was the only reader; the plan
 * export and the mobile card (TASK-291) are the second and third, and a
 * predicate copied into three files is three chances to answer §2.3
 * differently. The rule the `priorityBandOf` column comment states for bands
 * applies unchanged here: one function, and no face holds a fourth opinion.
 */
export const deadlineBeforeProjectStart = (
  startDate: string | null,
  deadline: string | null,
): boolean => {
  if (startDate === null || deadline === null) return false;
  if (!isIsoDate(startDate) || !isIsoDate(deadline)) return false;
  return deadlineOffsetOf(startDate, deadline).kind === 'before-project-start';
};

/**
 * What a surface says about a work item deadline the project has moved past,
 * in a sentence.
 *
 * **"Before the project's first working day", not "before the project starts".**
 * The two differ, and the difference is visible on screen: a project starting
 * Saturday 2026-08-08 with a deadline of that same Saturday is impossible —
 * day zero rolls forward to Monday the 10th and the deadline rolls back to
 * Friday the 7th — while the two dates the reader can see are *equal*. A
 * project starting Saturday the 8th with a deadline of Sunday the 9th is
 * impossible with the start *earlier* than the deadline. Either sentence about
 * raw calendar order would be a cell contradicting itself. Round 1's OpenAI
 * seat, Important 1.
 *
 * The wording is exactly true whenever the predicate fires: the first working
 * day is a workday at or after the project start, and if the deadline were on
 * or after it then the last workday on-or-before the deadline would be too, so
 * the predicate would not have fired.
 */
export const DEADLINE_BEFORE_START =
  "This work item deadline falls before the project's first working day, so nothing can finish by it. The date is kept; move the work item deadline or the project start.";

/**
 * The same fact as a **cell value** rather than as a sentence to a reader.
 *
 * A spreadsheet column is sorted and filtered, so what goes in it is a state
 * and not a paragraph: {@link DEADLINE_BEFORE_START} tells somebody looking at
 * one row what to do about it, and this groups every unreachable row in a
 * downloaded plan together under one exact string. Both are derived from the
 * same predicate and neither is derived from the other's text, which is why
 * they are two constants beside each other rather than one sliced.
 *
 * The clause is word-for-word the one above so a reader who has seen the
 * screen recognises the sheet, and it names *work item* deadlines nowhere
 * because the column header already does — see the export's own column.
 */
export const DEADLINE_UNREACHABLE_CELL = "before the project's first working day";
