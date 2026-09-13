import type { StepState } from '@wbs/domain';

import type { StepWriteOutcome } from './estimate-store';
import type { WriteStamp } from './write-stamp';

/**
 * Where one step's work on one work item has got to, and when somebody said so.
 *
 * `state` is one of the two a step may be **stored** in. The third state — not
 * started — is the absence of this row, so it has no spelling here and cannot
 * be written by anybody: see {@link StepState} in `@wbs/domain`.
 */
export interface StoredProgress {
  workItemId: string;
  stepId: string;
  state: StepState;
  /** When somebody said so, in epoch milliseconds. */
  statedAt: number;
}

/** One progress row's whole identity: the pair its primary key is. */
export interface ProgressKey {
  workItemId: string;
  stepId: string;
}

/**
 * Reading and writing where the work has got to.
 *
 * Deliberately the same four methods as {@link ActualStore}, in the same order,
 * doing the same things to a table with the same key — and for the reason that
 * store gives for being a copy of {@link EstimateStore}. A state follows its
 * work item through every structural change: the hand-down when a leaf gains its
 * first child, the hand-up when a parent loses its last, the restore an undo
 * runs. The failure this shape prevents is the one where estimates and actuals
 * follow a subtree and the statement about them quietly does not — a branch that
 * comes back from an undo reading "not started" over work somebody finished.
 */
export interface StepProgressStore {
  /** Every stated step on every work item in the project, in step order within each. */
  listByProject(projectId: string): Promise<StoredProgress[]>;
  /** States one work item's step, replacing whatever it said before. */
  set(progress: StoredProgress, stamp: WriteStamp): Promise<StepWriteOutcome>;
  /**
   * Takes the statement back, leaving every other step on that work item and
   * that step on every other work item alone.
   *
   * Removing one that is not stored is not an error, for
   * {@link EstimateStore.remove}'s reason: the state asked for is the state
   * left. What it leaves behind is "not started", which is the absence of a row
   * and never a row saying so.
   */
  remove(workItemId: string, stepId: string, stamp: WriteStamp): Promise<void>;
  /**
   * Moves every statement from one work item to another, exactly as
   * {@link ActualStore.moveAll} does and at the same call sites.
   *
   * A leaf that gains its first child stops holding a state of its own — its
   * reading is folded from what is below it — so a row left behind would be
   * invisible to every reader and back on screen the day the child is deleted,
   * claiming work is finished that the plan has since moved on from.
   */
  moveAll(fromWorkItemId: string, toWorkItemId: string, stamp: WriteStamp): Promise<void>;
}
