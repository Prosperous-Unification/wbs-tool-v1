export { STEP_POSITION_STEP } from '@wbs/domain';

import type { Assignment } from './directory-store';
import type { WriteStamp } from './write-stamp';

export interface Step {
  id: string;
  projectId: string;
  name: string;
  /**
   * Where this step sits in the project's step order — see `schema.ts` for why
   * the order has to be stored rather than read off the rows as they arrive.
   */
  position: number;
}

/**
 * A step as a caller offers it. The project decides where in its order the step
 * lands, in the same transaction that writes it: two clients adding a step at
 * once would otherwise both read the same last place.
 */
export type NewStep = Omit<Step, 'position'>;

/** Why a step could not be added or renamed. Both are states of the project, not faults. */
type StepWriteRefusal = 'taken' | 'not_found';

export type StepWritten = { ok: true; step: Step } | { ok: false; reason: StepWriteRefusal };

/**
 * What points at one step, read for the refusal that names it.
 *
 * The estimates are a count because a count is all anyone can act on. The
 * assignments are **every assignment in the project**, not only this step's:
 * whether a work item's assumed assignee moves when this step goes depends on
 * what it holds for the *other* steps, so the answer cannot be computed from
 * this step's rows alone. See `assumedAssigneeFlips`.
 */
export interface StepUsageRows {
  estimates: number;
  /**
   * How many actuals this step holds — a count, for {@link StepUsageRows.estimates}'
   * reason.
   *
   * Counted separately rather than added to the estimates, and counted **at
   * all**, because an actual is somebody's typing about work that has already
   * happened: a step removal that took one silently would delete the only record
   * of a week somebody spent. A step with no estimate and one actual is `in_use`.
   */
  actuals: number;
  /**
   * How many work items have said where this step's work has got to — a count,
   * for {@link StepUsageRows.estimates}' reason.
   *
   * Counted separately and counted **at all** for {@link StepUsageRows.actuals}'
   * reason, one table over: a statement is somebody's, and a step removal that
   * took one silently would turn finished work back into work nobody has
   * started, on a plan somebody is reading. A step with no estimate, no actual
   * and one stated row is `in_use`.
   */
  progress: number;
  /**
   * How many figures in the units that are not days this step holds — a count
   * of **rows**, so one pair holding a token estimate and an hours fact counts
   * two, for {@link StepUsageRows.estimates}' reason.
   *
   * Counted separately and counted **at all** for {@link StepUsageRows.actuals}'
   * reason in a third table: `token_actual` and `hours_actual` are records of
   * work that has already happened, and a removal that took them silently would
   * delete the only account of what a step's work cost. `token_estimate` is
   * counted with them rather than with the day-estimates because they share a
   * table and a key, and a count that split one table by its discriminator
   * would be reporting a schema rather than a loss.
   *
   * Rows rather than pairs because the primary key is the triple: two of the
   * three metrics on one pair are two separate statements somebody made, and
   * "1 figure" for them would understate what the cascade takes.
   */
  measures: number;
  assignments: readonly Assignment[];
}

/** What one confirmed removal took with it. */
export interface StepRemoval {
  estimates: number;
  actuals: number;
  progress: number;
  /** Rows, not pairs — {@link StepUsageRows.measures}. */
  measures: number;
  assignments: number;
  /** Every work item that lost an estimate, an actual, a state, a figure or an assignment, and whose revision therefore moved. */
  workItemIds: readonly string[];
}

/**
 * What the removal's own transaction decided, which is the only answer that
 * counts.
 *
 * `in_use` carries the usage the **transaction** read, not the usage anybody
 * counted earlier: an estimate written between a caller's count and its
 * confirmation is what this refusal is for.
 *
 * `not_found` is the loser of two removals of one step — and a step id that
 * belongs to another project, which is the same absence from this project's
 * point of view.
 */
export type StepRemoved =
  | { ok: true; removal: StepRemoval }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'in_use'; usage: StepUsageRows };

export interface StepStore {
  /** In step order, which is the order every reader of a project's steps gets. */
  listByProject(projectId: string): Promise<Step[]>;
  /** By id alone: the caller checks the step belongs to the project it was asked about. */
  findById(stepId: string): Promise<Step | null>;
  /**
   * Adds a step, or refuses a name the project already holds.
   *
   * Refused by the unique index rather than by asking first: two clients adding
   * `Design` at the same moment both pass a check-then-insert. Moves the
   * project's revision in the same transaction — a step is a satellite of the
   * project, and adding one changes what every estimate in it means.
   *
   * The step lands last in the project's step order, and the written step
   * carries the place it took.
   */
  add(step: NewStep, stamp: WriteStamp): Promise<StepWritten>;
  /** The same rules as {@link StepStore.add}, and `not_found` for a step that has gone. */
  rename(stepId: string, name: string, stamp: WriteStamp): Promise<StepWritten>;
  /**
   * What points at the step right now — a **fast path** for the refusal, never
   * the authority for it. Between this answer and any delete, anybody may write.
   * {@link StepStore.remove} is what decides.
   */
  usageOf(projectId: string, stepId: string): Promise<StepUsageRows>;
  /**
   * Counts what points at the step, refuses an unconfirmed removal that would
   * take any of it, and otherwise deletes the step's estimates, its assignments
   * and the step row — all in **one** transaction, bumping the project and every
   * work item that lost one of them.
   *
   * The count lives inside the transaction because it is the decision: a caller
   * that asked without `cascade` never consented to take anything, so an
   * estimate written after that caller's own count must refuse it rather than be
   * deleted by it.
   *
   * The estimates are deleted explicitly because `estimate.step_id` has no
   * cascade: a bare delete of the row hits the foreign key and answers 500. The
   * **actuals** are deleted explicitly for exactly the same reason, and counted
   * for a stronger one — see {@link StepUsageRows.actuals}. The **stated
   * progress** goes the same way and is counted the same way, see
   * {@link StepUsageRows.progress}.
   */
  remove(
    projectId: string,
    stepId: string,
    cascade: boolean,
    stamp: WriteStamp,
  ): Promise<StepRemoved>;
}
