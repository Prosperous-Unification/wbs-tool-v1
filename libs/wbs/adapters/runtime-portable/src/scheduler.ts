import type {
  FastScheduler,
  OptimizedScheduleAdapter,
  OptimizedScheduleAsk,
  OptimizedScheduleRead,
  ScheduleAsk,
  Scheduler,
} from '@wbs/core';
import { SOLVER_OBJECTIVES } from '@wbs/domain';

/** Builds the synchronous scheduler view over installed runtime adapters. */
export function createScheduler(
  fast: FastScheduler,
  optimized?: OptimizedScheduleAdapter,
): Scheduler {
  return {
    supports: (engine) => engine === 'fast' || optimized !== undefined,
    read: (ask) => readSchedule(fast, optimized, ask),
  };
}

function readSchedule(
  fast: FastScheduler,
  optimized: OptimizedScheduleAdapter | undefined,
  ask: ScheduleAsk,
): ReturnType<Scheduler['read']> {
  // Proof: removing this guard returned a scheduled Fast plan instead of
  // engine_unavailable in scheduler.test.ts; Fast ran before the assertion.
  if (ask.enabled && ask.engine === 'optimized' && optimized === undefined) {
    return { kind: 'engine_unavailable', error: 'engine_unavailable', engine: 'optimized' };
  }

  const fastSchedule = fast(
    ask.input.rows,
    ask.input.edges,
    ask.input.slices,
    ask.input.notBefore,
    ask.input.poolSizes,
    ask.input.reach,
    // Proof: dropping this seventh argument removed the literal
    // Map { "leaf" => 9 } from both recorded Fast calls in scheduler.test.ts.
    ask.input.deadlines,
  );
  if (optimized === undefined) {
    return { kind: 'scheduled', fast: fastSchedule, optimization: null };
  }

  const optimizationAsk: OptimizedScheduleAsk = {
    projectId: ask.projectId,
    objective: ask.objective,
    input: ask.input,
    enabled: ask.enabled,
  };
  const optimization =
    ask.mode === 'live'
      ? optimized.readLive(optimizationAsk)
      : optimized.readCaptured(optimizationAsk);
  // Proof: removing this check let a ready PRI variant with a null schedule
  // return `kind: scheduled` in scheduler.test.ts instead of throwing.
  assertReadySchedules(optimization);
  return { kind: 'scheduled', fast: fastSchedule, optimization };
}

function assertReadySchedules(read: OptimizedScheduleRead): void {
  for (const objective of SOLVER_OBJECTIVES) {
    if (read.variants[objective].state === 'ready' && read.schedules[objective] === null) {
      throw new Error(`optimized scheduler reported ready without a ${objective} schedule`);
    }
  }
}
