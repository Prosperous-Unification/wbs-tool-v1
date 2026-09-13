import type { StepWriteOutcome } from './estimate-store';
import type { WriteStamp } from './write-stamp';

/**
 * The days one step spent on one work item, and when somebody said so.
 *
 * One number rather than a trio: an estimate is a guess about a range and an
 * actual is a fact about what happened.
 */
export interface StoredActual {
  workItemId: string;
  stepId: string;
  days: number;
  /** When the number was typed, in epoch milliseconds. */
  recordedAt: number;
}

/** One actual row's whole identity: the pair its primary key is. */
export interface ActualKey {
  workItemId: string;
  stepId: string;
}

/**
 * Reading and writing the days actually spent.
 *
 * Deliberately the same four methods as {@link EstimateStore}, in the same
 * order, doing the same things to a table with the same key. Actuals follow
 * estimates through every structural change — the hand-down when a leaf gains
 * its first child, the hand-up when a parent loses its last, the copy a
 * duplication makes, the restore an undo runs — and the way to keep those two
 * sets of rules from drifting is for the second store to have no shape of its
 * own to drift into.
 */
export interface ActualStore {
  /** Every actual in the project, in step order within each work item. */
  listByProject(projectId: string): Promise<StoredActual[]>;
  /** Writes one work item's actual for one step, replacing any earlier one. */
  set(actual: StoredActual, stamp: WriteStamp): Promise<StepWriteOutcome>;
  /**
   * Takes away one work item's actual for one step, leaving every other step on
   * that work item and that step on every other work item alone.
   *
   * Removing one that is not stored is not an error, for
   * {@link EstimateStore.remove}'s reason: the state asked for is the state
   * left.
   */
  remove(workItemId: string, stepId: string, stamp: WriteStamp): Promise<void>;
  /**
   * Moves every actual from one work item to another, exactly as
   * {@link EstimateStore.moveAll} does and at the same call sites.
   *
   * A leaf that gains its first child stops holding figures of its own — its
   * numbers become the sum of what is below it — so an actual left behind would
   * be a row no reader can see and no writer can reach: invisible, not zero, and
   * back on screen if the child is ever deleted.
   */
  moveAll(fromWorkItemId: string, toWorkItemId: string, stamp: WriteStamp): Promise<void>;
}
