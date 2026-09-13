import type { MeasureMetric } from '@wbs/domain';

import type { StepWriteOutcome } from './estimate-store';
import type { WriteStamp } from './write-stamp';

/**
 * What one step's work on one work item cost in one unit that is not days, and
 * when somebody said so.
 *
 * `metric` is part of the identity rather than a property of it: the same pair
 * holding a token estimate, a token fact and an hours fact is three of these,
 * and each is absent on its own. See {@link stepMeasure} in `schema.ts` and
 * `openspec/changes/token-tracking/design.md` D1.
 */
export interface StoredMeasure {
  workItemId: string;
  stepId: string;
  metric: MeasureMetric;
  /** The figure itself — tokens or hours, in whatever `metric` says. */
  value: number;
  /** When the number was typed, in epoch milliseconds. */
  recordedAt: number;
}

/** One measure row's whole identity: the triple its primary key is. */
export interface MeasureKey {
  workItemId: string;
  stepId: string;
  metric: MeasureMetric;
}

/**
 * Reading and writing the figures that are not days.
 *
 * Deliberately the same four methods as {@link ActualStore}, in the same order,
 * doing the same things to a table whose key is that one's with a third column
 * on the end — and for the reason that store gives for being a copy of
 * {@link EstimateStore}. Measures follow their work item through every
 * structural change: the hand-down when a leaf gains its first child, the
 * hand-up when a parent loses its last, the restore an undo runs. The failure
 * this shape prevents is the one where estimates and actuals follow a subtree
 * and the tokens quietly do not.
 *
 * **The third key column reaches exactly one of these four.** {@link remove}
 * names one row, so it takes the metric; {@link set} carries it in the record.
 * {@link listByProject} and {@link moveAll} name no row and take none — the
 * first because the roll-up folds all three metrics from one read, the second
 * because a leaf gaining a child stops holding figures in every unit at once.
 */
export interface MeasureStore {
  /** Every measure in the project, in step order within each work item and metric order within each pair. */
  listByProject(projectId: string): Promise<StoredMeasure[]>;
  /**
   * Writes one work item's figure in one metric for one step, replacing any
   * earlier one in that metric and leaving the pair's other metrics alone.
   */
  set(measure: StoredMeasure, stamp: WriteStamp): Promise<StepWriteOutcome>;
  /**
   * Takes away one work item's figure in one metric for one step, leaving every
   * other metric on that pair, every other step on that work item and that step
   * on every other work item alone.
   *
   * Removing one that is not stored is not an error, for
   * {@link EstimateStore.remove}'s reason: the state asked for is the state
   * left. What it leaves behind is nobody having said, which is the absence of a
   * row and never a stored zero.
   */
  remove(
    workItemId: string,
    stepId: string,
    metric: MeasureMetric,
    stamp: WriteStamp,
  ): Promise<void>;
  /**
   * Moves every measure in every metric from one work item to another, exactly
   * as {@link ActualStore.moveAll} does and at the same call sites.
   *
   * A leaf that gains its first child stops holding figures of its own — its
   * numbers become the sum of what is below it — so a measure left behind would
   * be a row no reader can see and no writer can reach: invisible, not zero, and
   * back on screen if the child is ever deleted.
   */
  moveAll(fromWorkItemId: string, toWorkItemId: string, stamp: WriteStamp): Promise<void>;
}
