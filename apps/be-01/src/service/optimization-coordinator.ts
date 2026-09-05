import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';
import { scheduleInputHash } from '@wbs/domain/canonical-schedule-input';

import type { Drizzle } from '../repository/db';
import {
  readOptimizedPairAndSpawn,
  type Spawner,
} from '../repository/optimized-schedule-cache';
import type { SolverObjectiveName } from '../repository/schema';
import type { OptimizedScheduleReader } from './optimized-schedule-reader';

export interface OptimizationCoordinatorOptions {
  readonly db: Drizzle;
  readonly contractVersion: string;
  readonly budgetMs: number;
  /**
   * Admission's process boundary. Slice 6.1 owns the request; slices 6.2–6.4
   * provide the SQLite slot and child lifecycle behind this port.
   */
  readonly spawn: Spawner;
}

/**
 * The synchronous plan-read half of the optimizer coordinator (tasks.md 6.1).
 *
 * A cache hit returns immediately. A miss also returns immediately, after
 * requesting admission for each absent objective; the child never sits on the
 * request path. Exact-key `failed` and `corrupt` rows remain terminal until an
 * explicit Retry because {@link readOptimizedPairAndSpawn} admits only misses.
 */
export class OptimizationCoordinator {
  constructor(private readonly options: OptimizationCoordinatorOptions) {}

  /**
   * The reader wired into {@link WorkItemService}. It is an arrow so handing it
   * to the service cannot lose the coordinator instance as `this`.
   */
  readonly read: OptimizedScheduleReader = (ask: {
    readonly projectId: string;
    readonly objective: SolverObjectiveName;
    readonly input: ScheduleInput;
  }) => {
    const pair = readOptimizedPairAndSpawn(
      this.options.db,
      {
        projectId: ask.projectId,
        inputHash: scheduleInputHash(ask.input),
        contractVersion: this.options.contractVersion,
        budgetMs: this.options.budgetMs,
      },
      this.options.spawn,
    );
    const outcome = pair[ask.objective];
    return outcome.kind === 'ok' ? outcome.result.schedule : null;
  };
}
