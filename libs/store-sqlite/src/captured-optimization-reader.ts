import type {
  OptimizedScheduleAdapter,
  OptimizedScheduleAsk,
  OptimizedScheduleRead,
} from '@wbs/core';
import type { Schedule } from '@wbs/domain';

import type { Drizzle } from './db';
import { readGeneration } from './optimization-generation';
import {
  optimizationVariantState,
  type OptimizedCacheKey,
  type OptimizedPair,
  optimizedVariantIsLive,
  readOptimizedPair,
} from './optimized-schedule-cache';
import { scheduleInputHash } from './schedule-input-hash';
import type { SolverObjectiveName } from './schema';

export interface CapturedOptimizationReaderOptions {
  readonly contractVersion: string;
  readonly budgetMs: number;
  readonly now: () => number;
}

/**
 * Builds the read-only optimized view for a detached captured input.
 *
 * The lookup reads the exact hash/version/budget key and current liveness. It
 * never allocates a generation, reserves capacity, queues work or starts a
 * solver, so a save cannot change runtime scheduling state.
 */
export function capturedOptimizationReaderOf(
  db: Drizzle,
  options: CapturedOptimizationReaderOptions,
): OptimizedScheduleAdapter['readCaptured'] {
  return (ask) => readCapturedOptimization(db, options, ask);
}

function readCapturedOptimization(
  db: Drizzle,
  options: CapturedOptimizationReaderOptions,
  ask: OptimizedScheduleAsk,
): OptimizedScheduleRead {
  const key: OptimizedCacheKey = {
    projectId: ask.projectId,
    inputHash: scheduleInputHash(ask.input),
    contractVersion: options.contractVersion,
    budgetMs: options.budgetMs,
  };
  const generation = readGeneration(db, ask.projectId, options.contractVersion)?.generation ?? null;
  const pair = readOptimizedPair(db, key);
  const now = options.now();
  const live = (objective: SolverObjectiveName): boolean =>
    generation !== null && optimizedVariantIsLive(db, key, generation, objective, now);

  return {
    ...key,
    generation,
    variants: {
      pri: optimizationVariantState(pair.pri, live('pri')),
      time: optimizationVariantState(pair.time, live('time')),
    },
    schedules: { pri: scheduleOf(pair, 'pri'), time: scheduleOf(pair, 'time') },
  };
}

function scheduleOf(pair: OptimizedPair, objective: SolverObjectiveName): Schedule | null {
  const outcome = pair[objective];
  return outcome.kind === 'ok' ? outcome.result.schedule : null;
}
