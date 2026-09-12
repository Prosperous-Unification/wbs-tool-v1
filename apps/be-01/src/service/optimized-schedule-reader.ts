import type { OptimizedScheduleAsk, OptimizedScheduleRead } from '@wbs/core';

export { optimizationVariantState } from '../repository/optimized-schedule-cache';
export type {
  OptimizationVariantState,
  OptimizedScheduleAsk,
  OptimizedScheduleRead,
} from '@wbs/core';

/**
 * The plan read's one question of the optimized cache: *what is the published
 * and live state for exactly this plan?*
 *
 * It returns the identity, both variants' seven-state projection, and both
 * materialized schedules. `WorkItemService` therefore chooses Fast from `ready`
 * versus every other state, and compares every ready variant with Fast, without
 * re-decoding cache rows or guessing whether a slot is live.
 *
 * Synchronous, because every implementation is a SQLite read on the same
 * connection the plan read is already using and 4.1's `readOptimizedPair` is
 * itself synchronous. An `async` port here would make the plan read await a
 * promise that never yields, and would let a future implementation wait on a
 * solve — which is the timer-shaped coupling slice 4 is built to refuse.
 *
 * **It may not throw for anything the cache models.** The plan read calls it
 * outside its own `try`, so a throw is a defect and is reported as one rather
 * than being relabelled "your dependencies run in a circle".
 */
export type OptimizedScheduleReader = (ask: OptimizedScheduleAsk) => OptimizedScheduleRead;
