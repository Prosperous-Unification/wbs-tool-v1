import type { OptimizedScheduleAdapter, OptimizerAvailability, Scheduler } from '@wbs/core';
import { schedule } from '@wbs/domain';
import { createScheduler } from '@wbs/runtime-portable';

/**
 * The reader the plan read consults and the availability predicate the settings
 * write is gated on, **derived from one argument**.
 *
 * The two halves go to two different services — `read` to `WorkItemService`,
 * `available` to `ProjectService` — and this type exists so they cannot be
 * given different answers.
 */
export interface OptimizerWiring {
  /** The scheduler handed to every live plan service. */
  readonly scheduler: Scheduler;
  /** True exactly when {@link OptimizerWiring.scheduler} supports optimized reads. */
  readonly available: OptimizerAvailability;
}

/** Fast-only scheduler for isolated service fixtures. */
export const fastScheduler = createScheduler(schedule);

/**
 * One reader in, both halves of the optimizer's wiring out.
 *
 * **The reason this is a factory and not two arguments to `services.ts`.** The
 * defect this closes is a settings PATCH that answers `200` to
 * `scheduleEngine: 'optimized'` in a process where `WorkItemService` was
 * constructed with no reader: the write succeeds, the event goes out, the
 * settings panel says optimized, and every plan read silently serves Fast. Both
 * review seats reached that independently on PR 203.
 *
 * A free `optimizerAvailable: boolean` on `ProjectService` would have closed it
 * only as long as nobody edited `services.ts` — the two arguments sit fourteen
 * lines apart there, and wiring the reader while forgetting the boolean (or the
 * reverse) restores the same lie with no test failing. Deriving the predicate
 * from the reader makes the wrong pair **unspellable**: there is one argument,
 * and `available` is a reading of it rather than a second claim about it.
 *
 * `read` is captured rather than re-read, because the argument is the whole of
 * what this knows; there is nothing else for the predicate to consult.
 */
export function optimizerWiring(optimized: OptimizedScheduleAdapter | undefined): OptimizerWiring {
  const scheduler = optimized === undefined ? fastScheduler : createScheduler(schedule, optimized);
  return { scheduler, available: () => scheduler.supports('optimized') };
}
export type { OptimizerAvailability } from '@wbs/core';
