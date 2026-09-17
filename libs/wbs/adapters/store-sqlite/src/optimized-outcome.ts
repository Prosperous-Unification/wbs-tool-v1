import { type ProjectEvent, type RecordedEvent, subscriptionFor } from '@wbs/core';

import type { Drizzle } from './db';
import type { EventLogTransactionalWrite } from './event-log';
import {
  type OutcomeWrite,
  type OutcomeWriteResult,
  storeOptimizedOutcomeIn,
} from './optimized-schedule-cache';

export type ScheduleOptimizedEvent = Extract<ProjectEvent, { type: 'schedule_optimized' }>;
export type ScheduleOptimizationFailedEvent = Extract<
  ProjectEvent,
  { type: 'schedule_optimization_failed' }
>;
export type ScheduleOptimizationInfeasibleEvent = Extract<
  ProjectEvent,
  { type: 'schedule_optimization_infeasible' }
>;
export type OptimizationOutcomeEvent =
  ScheduleOptimizedEvent | ScheduleOptimizationFailedEvent | ScheduleOptimizationInfeasibleEvent;

export interface RecordedOptimizedOutcome {
  readonly result: OutcomeWriteResult;
  readonly subscription?: string;
  readonly recorded?: RecordedEvent;
  readonly event?: OptimizationOutcomeEvent;
}

/** Atomically store one validated result and its durable replay record. */
export function storeOptimizedOutcomeAndRecord(
  db: Drizzle,
  eventLog: EventLogTransactionalWrite,
  write: OutcomeWrite,
): RecordedOptimizedOutcome {
  return db.transaction((tx) => {
    const result = storeOptimizedOutcomeIn(tx, write);
    if (result !== 'stored') return { result };
    const identity = {
      projectId: write.claim.projectId,
      generation: write.claim.generation,
      inputHash: write.inputHash,
      objective: write.claim.objective,
      contractVersion: write.claim.contractVersion,
      budgetMs: write.claim.budgetMs,
    };
    const event: OptimizationOutcomeEvent =
      write.outcome.kind === 'ok'
        ? { type: 'schedule_optimized', ...identity }
        : write.outcome.kind === 'failed'
          ? {
              type: 'schedule_optimization_failed',
              ...identity,
              failureReason: write.outcome.reason,
            }
          : { type: 'schedule_optimization_infeasible', ...identity };
    const subscription = subscriptionFor(write.claim.projectId);
    const recorded = eventLog.recordEventIn(tx, subscription, event, write.now);
    return { result, subscription, recorded, event };
  });
}
