/**
 * Where the work has got to: three statuses, per step, and the one rule that
 * turns a row's steps into a reading of the row.
 *
 * Dany, 2026-08-18: _"maybe we should augment actual days by completion
 * status?"_ — asked the day after actuals shipped, and the reason it is the
 * right question is in `openspec/changes/actual-days/design.md` D3: an actual
 * with no completion state beside it cannot tell **"took 8 days, finished"**
 * from **"8 days so far"**, and those two mean opposite things for every
 * successor. This module is the vocabulary that tells them apart.
 *
 * It lives in `@wbs/domain` rather than in be-01 because it is a **rule both
 * apps share**, in the sense `effectiveTeamsOf` is: the API derives an item's
 * status for its payload, and a face that folds a subset of rows — a filtered
 * table, a collapsed branch, a card — has to derive the same answer from the
 * same fold or the two disagree on screen about a plan neither of them changed.
 */

/**
 * What one step has said about its own work on one work item — its
 * **progress**, in `CONTEXT.md`'s word.
 *
 * **Two values, because the third is the absence of a row.** "Unknown" is
 * never stored: it is what a work item with no `step_progress` row for that step
 * reads as, exactly as an unstated capacity and an unrecorded actual are
 * absences rather than zeroes (`project_team_capacity` and `actual` in be-01's
 * `schema.ts`). Storing it would give two spellings of "nobody has said" — no
 * row, and a row saying nothing — and every reader would have to handle both.
 *
 * **No `blocked` and no `cancelled`**, and that is a refusal rather than an
 * omission: each extra state is a question the engine must answer the day it
 * starts reading this — what a blocked predecessor does to its successors'
 * floor, whether a cancelled step's estimate leaves the plan's totals — and the
 * engine is not reading this yet. Three states can be added to; a fourth shipped
 * now would be a meaning nobody has agreed, stored on real plans, in rows the
 * next change has to interpret.
 */
export type StepState = 'in_progress' | 'done';

/**
 * What a **work item** reads as — its **status**. Derived from its steps on
 * every read and never stored, for the reason every derived figure in this tool
 * is: two spellings of one fact is how "the item says done and a step has no
 * actual" happens. The row's cell that sets it writes every step instead
 * (`WorkItemService.setStatus`, ADR 0024), so the fold and the cell cannot
 * disagree.
 *
 * `unknown` was spelled `not_started` until 2026-09-12, when the status got a
 * face: nothing had ever stored the value, and "not started" claims to know
 * something about work nobody has spoken about. Dany's word, and the honest one.
 */
export type WorkItemStatus = 'unknown' | StepState;

/** The two states a step may be stored in, in the order a face should offer them. */
export const STEP_STATES: readonly StepState[] = ['in_progress', 'done'];

/** Nothing has been said about this work, by anybody, for any step. */
export const UNKNOWN = 'unknown';

/**
 * The two statuses a row's Status cell offers, in the order it offers them.
 * `in_progress` is not among them: it is a step's statement and arises on a row
 * only from the fold — see {@link agree}.
 */
export const SETTABLE_STATUSES = ['unknown', 'done'] as const;
export type SettableStatus = (typeof SETTABLE_STATUSES)[number];

/** Whether a value off the wire is one of the two states a step may be put in. */
export function isStepState(value: unknown): value is StepState {
  return value === 'in_progress' || value === 'done';
}

/** Whether a value off the wire is a status a row's cell may set. */
export function isSettableStatus(value: unknown): value is SettableStatus {
  return value === 'unknown' || value === 'done';
}

/**
 * Two readings of one thing, combined: **they agree, or the thing is in
 * progress.**
 *
 * That is the whole rule, and it is the answer to "what is an item whose steps
 * disagree". Dev finished and QA has not started is not a finished item and it
 * is not an untouched one — it is an item somebody is part-way through, which is
 * the only reading that is true of every plan it can arise on.
 *
 * **`done` is therefore unanimous.** An item is finished when every step with
 * work on it says so, and one silent step is enough to keep it in progress. The
 * alternative — done as soon as any step says done — would let a plan report
 * finished work that nobody has tested, which is precisely the claim a
 * completion state exists to stop somebody making by accident.
 *
 * Associative, commutative and idempotent, which is what lets a parent be
 * folded from its children's statuses rather than from every leaf step beneath
 * it: both routes reach the same answer, so there is no ordering of the tree
 * that changes what a branch reads as.
 */
export function agree(a: WorkItemStatus, b: WorkItemStatus): WorkItemStatus {
  return a === b ? a : 'in_progress';
}

/**
 * The status a collection reads as: {@link agree} across all of it, and
 * {@link UNKNOWN} when there is nothing in it.
 *
 * Empty means nobody has said anything — an item with no steps, a branch with no
 * leaves, a plan on its first day. Reading that as "unknown" rather than as
 * "done vacuously" is the same choice `rollUp` makes when it leaves an
 * unestimated step absent instead of zero: an empty statement is not a
 * statement.
 */
export function statusOf(statuses: Iterable<WorkItemStatus>): WorkItemStatus {
  let answer: WorkItemStatus | null = null;
  for (const status of statuses) answer = answer === null ? status : agree(answer, status);
  return answer ?? UNKNOWN;
}
