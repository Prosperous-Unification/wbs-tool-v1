import { type PrintedDay, printedDay } from './short-date';
import { type TreeRow } from './wbs-rows';

/**
 * One row's two printed days, worked out from scratch.
 *
 * Exported so it can be **counted**: three readers ask for a row's span per
 * render — the Start cell, the Finish cell and the Start sentence — and
 * {@link WbsTable} holds a per-render map in front of this so only the first
 * pays. A function called from inside the file that declares it cannot be seen
 * by `vi.mock`, and the check for that map is a call count.
 */
export function spanOfRow(
  row: TreeRow,
  showSchedule: (days: number) => string,
): { start: PrintedDay; finish: PrintedDay } {
  // One `today` for both ends of one row, so a render that straddles midnight
  // cannot print a start off this year and a finish off the next.
  const today = new Date();
  return {
    start: printedDay(row.dates?.startsOn ?? null, today, () =>
      showSchedule(row.schedule.earliestStart),
    ),
    finish: printedDay(row.dates?.endsOn ?? null, today, () =>
      showSchedule(row.schedule.earliestFinish),
    ),
  };
}
