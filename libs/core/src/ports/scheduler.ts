import type { PlanInfeasibleItem } from '@wbs/contracts/solver/plan-infeasible';
import type {
  DependencyEdge,
  DependencyReach,
  PlannedRow,
  PoolSizes,
  Schedule,
  ScheduleEngine,
  Slice,
  SolverFailureReason,
  SolverObjectiveName,
} from '@wbs/domain';
import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';

export interface ScheduleAsk {
  readonly projectId: string;
  readonly input: ScheduleInput;
  readonly engine: ScheduleEngine;
  readonly objective: SolverObjectiveName;
  readonly enabled: boolean;
  readonly mode: 'live' | 'capture';
}

/**
 * Everything the plan read knows and the optimized adapter needs, and nothing
 * it has to look up again.
 *
 * The whole {@link ScheduleInput}, rather than a hash the service computed,
 * keeps hashing in the adapter that owns the cache key. `objective` is explicit
 * because it is a project setting and the adapter receives no project row.
 * Budget and contract version are deliberately absent: they belong to the
 * installed adapter, so a caller cannot serve an answer from another runtime's
 * cache identity.
 */
export interface OptimizedScheduleAsk {
  readonly projectId: string;
  readonly objective: SolverObjectiveName;
  readonly input: ScheduleInput;
  /** False reads identity only: it neither allocates a generation nor admits work. */
  readonly enabled: boolean;
}

export type OptimizationVariantState =
  | {
      readonly state: 'ready';
      /** Whether the published schedule is proved, unfinished, or Fast retained at the floor. */
      readonly proof: 'proven' | 'incomplete' | 'quantisation-floor';
    }
  | { readonly state: 'pending' }
  | { readonly state: 'retrying' }
  | { readonly state: 'failed'; readonly reason: SolverFailureReason }
  | { readonly state: 'corrupt'; readonly message: string }
  | { readonly state: 'plan-infeasible'; readonly items: readonly PlanInfeasibleItem[] }
  | { readonly state: 'idle' };

export interface OptimizedScheduleRead {
  readonly inputHash: string;
  readonly generation: number | null;
  readonly contractVersion: string;
  readonly budgetMs: number;
  readonly variants: Readonly<Record<SolverObjectiveName, OptimizationVariantState>>;
  /**
   * Both variants' materialized schedules, null for one that is not ready.
   * Both remain available so Fast and either selected objective can be compared
   * without re-decoding cache rows.
   */
  readonly schedules: Readonly<Record<SolverObjectiveName, Schedule | null>>;
}

/** One installed optimized capability, with live and non-admitting capture reads together. */
export interface OptimizedScheduleAdapter {
  readLive(ask: OptimizedScheduleAsk): OptimizedScheduleRead;
  readCaptured(ask: OptimizedScheduleAsk): OptimizedScheduleRead;
}

export interface EngineUnavailable {
  readonly kind: 'engine_unavailable';
  readonly error: 'engine_unavailable';
  readonly engine: 'optimized';
}

export type ScheduleRead =
  | EngineUnavailable
  | {
      readonly kind: 'scheduled';
      readonly fast: Schedule;
      readonly optimization: OptimizedScheduleRead | null;
    };

/** Synchronous Fast scheduling over the canonical input's seven fields. */
export type FastScheduler = (
  rows: readonly PlannedRow[],
  edges: readonly DependencyEdge[],
  slices: readonly Slice[],
  notBefore: ReadonlyMap<string, number>,
  poolSizes: PoolSizes,
  reach: DependencyReach,
  deadlines: ReadonlyMap<string, number>,
) => Schedule;

/** Installed scheduling capabilities and their non-waiting read. */
export interface Scheduler {
  supports(engine: ScheduleEngine): boolean;
  read(ask: ScheduleAsk): ScheduleRead;
}

/**
 * Whether *this deployment* can honour optimized scheduling at all.
 *
 * A predicate rather than a boolean, and never constructed by hand — see
 * {@link optimizerWiring}. The distinction it draws is not about a project: it
 * is about whether an optimized cache is wired into the process the settings
 * PATCH just landed in.
 */
export type OptimizerAvailability = () => boolean;
