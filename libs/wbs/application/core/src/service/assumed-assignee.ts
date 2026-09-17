import type { Assignment } from '../ports/directory-store';

/**
 * Who a work item's assignments are taken to cover every step with, or nobody.
 *
 * Exactly one assignment means that person is doing the lot; two or more means
 * each is doing their own, and none means nobody has been named. Derived rather
 * than stored, so assigning a second step ends the assumption without anything
 * being rewritten — see `assignment` in `schema.ts`, and **assumed assignee** in
 * `CONTEXT.md`.
 *
 * One function rather than the rule written twice: the tree reports this as
 * `doesEveryStep`, and removing a step asks what it would become. Two
 * implementations of it would drift, and the drift would show up as a
 * confirmation that named the wrong people.
 */
export function assumedAssignee(byStep: Readonly<Record<string, string>>): string | null {
  const named = Object.values(byStep);
  return named.length === 1 ? (named[0] ?? null) : null;
}

/** One work item whose assumed assignee a step's removal would change. */
export interface AssumedAssigneeFlip {
  workItemId: string;
  /** Who is assumed to be covering every step now, or nobody. */
  assumedNow: string | null;
  /** Who would be, once the step and its assignments have gone. */
  assumedAfter: string | null;
}

/**
 * Every work item whose assumed assignee moves when `stepId` is removed.
 *
 * Removing a step deletes its assignments, which can leave a work item holding
 * exactly one — silently promoting somebody to covering every step — or leave
 * it holding none, which takes the assumption away. Neither is a row anybody
 * wrote, so a removal that did not name them would change who the plan says is
 * doing the work without saying so.
 *
 * Takes **every** assignment in the project rather than the step's own: what a
 * work item is assumed to be is decided by what it holds for the other steps.
 *
 * Sorted by work item id, because a confirmation that lists the same work items
 * in a different order each time reads as a different answer.
 *
 * Proof: with the comparison dropped, so that every work item holding the step
 * is named, `leaves alone a work item that keeps its answer` fails — a work
 * item assumed by nobody before and after was reported as changing; watched
 * 2026-08-08.
 */
export function assumedAssigneeFlips(
  assignments: readonly Assignment[],
  stepId: string,
): AssumedAssigneeFlip[] {
  const byWorkItem = new Map<string, Record<string, string>>();
  for (const each of assignments) {
    byWorkItem.set(each.workItemId, {
      ...(byWorkItem.get(each.workItemId) ?? {}),
      [each.stepId]: each.personId,
    });
  }
  const flips: AssumedAssigneeFlip[] = [];
  for (const [workItemId, byStep] of byWorkItem) {
    // Untouched by this removal: it holds nothing for the step, so the reading
    // of its assignments cannot have moved. `hasOwn` rather than an undefined
    // check, because the index type says `string` and the linter is right that
    // the comparison can never be true as far as the type is concerned.
    if (!Object.hasOwn(byStep, stepId)) continue;
    const left = Object.fromEntries(Object.entries(byStep).filter(([each]) => each !== stepId));
    const assumedNow = assumedAssignee(byStep);
    const assumedAfter = assumedAssignee(left);
    if (assumedNow === assumedAfter) continue;
    flips.push({ workItemId, assumedNow, assumedAfter });
  }
  return flips.sort((a, b) => (a.workItemId < b.workItemId ? -1 : 1));
}
