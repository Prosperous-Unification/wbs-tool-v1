import { deadlineOffsetOf, type IsoDate } from './workday';

/**
 * The offset a deadline that resolves **before day zero** is read as.
 *
 * `-1` and not `0`, and not a dropped entry. Design §2.3: a project start moved
 * past a stored deadline is **legal** — the stored date is what the user typed
 * and the project moving under it does not make their input malformed — so the
 * date is read as *unmeetable*, never as *invalid* and never as *absent*.
 *
 * **Why a number at all.** `schedule()` takes offsets, so the alternatives are
 * to drop the entry or to clamp it. Dropping it reports the row **on time**,
 * which is the one answer that is certainly wrong: the deadline is not merely
 * missed, it was already impossible when the project moved. Clamping to `0`
 * says "due on day zero", and a slice that finishes on day zero then reads on
 * time — the same fault `deadlineOffsetOf` refuses at its own boundary and that
 * W3 watches, arriving one layer later.
 *
 * `-1` is the largest offset no placement can meet: `lastWorkdayOf` is at least
 * `0` for every slice, so the subtraction is at least `1` for all of them and
 * the row is late by every workday it stands on plus the one it owed — "late by
 * the whole span". It also sorts the row **first**, which is the honest
 * ordering: nothing on the plan is further past its date.
 *
 * **Recorded as a bounded assumption rather than found in the plan.** The
 * design says "late by the whole span" in prose and settles no number; this is
 * the encoding that makes the sentence true under the arithmetic 5.2 already
 * uses. What would falsify it: a decision that such a row should read a fixed
 * label instead of a count, in which case the *label* changes and this offset
 * does not — the row is still late, and still first.
 */
export const UNMEETABLE_DEADLINE_OFFSET = -1;

/**
 * Stored deadline dates resolved to the whole-workday offsets `schedule()`
 * reads — the **read-time** resolution of tasks.md 5.4.
 *
 * Keys are carried through untouched, including the ones that resolve
 * `before-project-start`: this function never drops a work item, because a work
 * item missing from the map is a work item with no deadline, and the two must
 * not be confused. `deadlineOffsetOf` decides every entry, so a weekend
 * deadline rolls **backward** here for the same reason it does there and there
 * is no second reading of a date in this library.
 *
 * The map it returns is the `deadlines` argument, and it is keyed **as
 * authored** — parents included, not pre-expanded to leaves. `leafDeadlinesOf`
 * inside `schedule()` owns the expansion, and doing it twice is how the hash
 * and the fold come to disagree about which day a leaf owes.
 */
export function deadlineOffsetsOf(
  projectStart: IsoDate,
  deadlines: ReadonlyMap<string, IsoDate>,
): Map<string, number> {
  const resolved = new Map<string, number>();
  for (const [workItemId, deadline] of deadlines) {
    const found = deadlineOffsetOf(projectStart, deadline);
    resolved.set(workItemId, found.kind === 'offset' ? found.offset : UNMEETABLE_DEADLINE_OFFSET);
  }
  return resolved;
}
