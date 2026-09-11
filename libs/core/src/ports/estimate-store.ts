import type { WriteStamp } from './write-stamp';

export interface StoredEstimate {
  workItemId: string;
  stepId: string;
  optimistic: number;
  realistic: number;
  pessimistic: number;
}

/**
 * What a write that names a step answers when the step is not there.
 *
 * The **store**'s answer rather than a driver error for the service to
 * classify (D6, `docs/2026-09-05-ports-and-adapters-plan.md` §3.2). SQLite says
 * `FOREIGN KEY constraint failed` and names no column, so only the store — the
 * one thing that knows which references it just wrote — can say which of them
 * was the missing one. A service that read the driver's message would be
 * reading SQLite's, and a second source would have to produce that message to
 * be understood.
 *
 * `unknown_step` and nothing else: a foreign key that failed over a work item
 * or a person that has gone is still an unknown, and is still thrown. A step
 * removed while a client had it on screen is an ordinary race a caller can act
 * on; the others are invariants nothing should be able to break.
 */
export type StepWriteOutcome = 'written' | 'unknown_step';

export interface EstimateStore {
  listByProject(projectId: string): Promise<StoredEstimate[]>;
  /** Writes one work item's estimate for one step, replacing any earlier one. */
  set(estimate: StoredEstimate, stamp: WriteStamp): Promise<StepWriteOutcome>;
  /**
   * Takes away one work item's estimate for one step, leaving every other
   * step on that work item and that step on every other work item alone.
   *
   * Removing one that is not stored is not an error: the state asked for is
   * the state left, and two people emptying the same three boxes must not turn
   * the second one into a failure on screen.
   */
  remove(workItemId: string, stepId: string, stamp: WriteStamp): Promise<void>;
  /**
   * Moves every estimate from one work item to another.
   *
   * Used in both directions by the same rule: an estimated work item that gains
   * its first child hands the estimate down, and a work item whose last child is
   * deleted takes it back. Neither is a merge — a parent never holds estimates of
   * its own while it has children.
   */
  moveAll(fromWorkItemId: string, toWorkItemId: string, stamp: WriteStamp): Promise<void>;
}
