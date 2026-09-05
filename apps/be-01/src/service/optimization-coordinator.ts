import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';
import { scheduleInputHash } from '@wbs/domain/canonical-schedule-input';

import type { Drizzle } from '../repository/db';
import {
  bindSolverSlot,
  reserveSolverSlot,
  type SolverSlotAdmission,
} from '../repository/optimization-admission';
import { allocateGeneration } from '../repository/optimization-generation';
import {
  readOptimizedPairAndSpawn,
  type SpawnRequest,
} from '../repository/optimized-schedule-cache';
import type { SolverObjectiveName } from '../repository/schema';
import type { OptimizedScheduleReader } from './optimized-schedule-reader';

export interface OptimizationCoordinatorOptions {
  readonly db: Drizzle;
  readonly contractVersion: string;
  readonly budgetMs: number;
  /** Stable for this backend process; generated once at coordinator boot. */
  readonly ownerId: string;
  /** Read once per plan-read admission attempt. */
  readonly now: () => number;
  /** Fresh 128-bit token source; the production root supplies `randomUUID`. */
  readonly attemptToken: () => string;
  /**
   * The launcher boundary, called only after SQLite returned this attempt's
   * counted `starting` row. Slice 6.2b binds that row to the launcher PID.
   */
  readonly spawn: ReservedSpawner;
}

type ReservedAdmission = Extract<SolverSlotAdmission, { kind: 'reserved' }>;

/** Everything the launcher needs from the read and its successful reservation. */
export interface ReservedSpawnRequest extends SpawnRequest {
  readonly generation: number;
  readonly admission: ReservedAdmission;
}

/** The launcher's small control surface before it may exec the solver. */
export interface ReservedSolverChild {
  readonly pid: number;
  readonly verdict: (verdict: 'bound' | 'abort') => void;
  readonly kill: () => void;
}

export type ReservedSpawner = (request: ReservedSpawnRequest) => ReservedSolverChild;

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
    if (ask.input.slices.length === 0 || ask.input.slices.every((slice) => slice.days === 0)) {
      return null;
    }

    const inputHash = scheduleInputHash(ask.input);
    const now = this.options.now();
    const generation = allocateGeneration(
      this.options.db,
      ask.projectId,
      this.options.contractVersion,
      inputHash,
      now,
    );
    const pair = readOptimizedPairAndSpawn(
      this.options.db,
      {
        projectId: ask.projectId,
        inputHash,
        contractVersion: this.options.contractVersion,
        budgetMs: this.options.budgetMs,
      },
      (request) => {
        const admission = reserveSolverSlot(this.options.db, {
          projectId: request.key.projectId,
          contractVersion: request.key.contractVersion,
          generation,
          objective: request.objective,
          budgetMs: request.key.budgetMs,
          ownerId: this.options.ownerId,
          attemptToken: this.options.attemptToken(),
          now,
        });
        if (admission.kind === 'reserved') {
          const child = this.options.spawn({ ...request, generation, admission });
          const bound = bindSolverSlot(this.options.db, {
            projectId: request.key.projectId,
            contractVersion: request.key.contractVersion,
            generation,
            objective: request.objective,
            budgetMs: request.key.budgetMs,
            attemptToken: admission.attemptToken,
            pid: child.pid,
          });
          child.verdict(bound ? 'bound' : 'abort');
          if (!bound) child.kill();
        }
      },
    );
    const outcome = pair[ask.objective];
    return outcome.kind === 'ok' ? outcome.result.schedule : null;
  };
}
