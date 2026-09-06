import type { PlanInfeasibleItem } from '@wbs/contracts/solver/plan-infeasible';
import type { Schedule } from '@wbs/domain';
import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';

import type { CachedOutcome } from '../repository/optimized-schedule-cache';
import type { SolverFailureReason, SolverObjectiveName } from '../repository/schema';

/**
 * Everything the plan read knows and the reader needs, and nothing it has to
 * look up again.
 *
 * The **whole `ScheduleInput`** rather than a hash the service computed: the
 * cache key's `inputHash` is 1.2's SHA-256 of 1.1's canonicalisation, and a
 * service that hashed here would be a second caller of that pair whose argument
 * order could drift from the writer's without either side failing. The reader
 * is the one place that turns a plan into a key, so it is the one place that
 * hashes.
 *
 * `objective` is passed rather than read off the project by the reader, because
 * the reader is handed no project: which of the cached pair is published is a
 * **setting** (3b.2's `schedule_objective`), and the service is what holds the
 * project row.
 *
 * `budgetMs` and the contract version are deliberately **absent**. They are key
 * columns the *reader* owns — a release's configured budget and
 * `SCHEDULER_CONTRACT_VERSION` — and a plan read that named either would be a
 * caller that could serve a 60 s answer to a 120 s release.
 */
export interface OptimizedScheduleAsk {
  readonly projectId: string;
  readonly objective: SolverObjectiveName;
  readonly input: ScheduleInput;
  /** False reads identity only: it neither allocates a generation nor admits work. */
  readonly enabled?: boolean;
}

export type OptimizationVariantState =
  | { readonly state: 'ready' }
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
  readonly selectedSchedule: Schedule | null;
}

/** Add the full-key liveness fact to one stored-row outcome. */
export function optimizationVariantState(
  outcome: CachedOutcome,
  live: boolean,
): OptimizationVariantState {
  if (outcome.kind === 'ok') return { state: 'ready' };
  if (outcome.kind === 'miss') return { state: live ? 'pending' : 'idle' };
  if (outcome.kind === 'failed') {
    return live ? { state: 'retrying' } : { state: 'failed', reason: outcome.reason };
  }
  if (outcome.kind === 'corrupt') {
    return live ? { state: 'retrying' } : { state: 'corrupt', message: outcome.reason };
  }
  return { state: 'plan-infeasible', items: outcome.certificate.items };
}

/**
 * The plan read's one question of the optimized cache: *what is the published
 * and live state for exactly this plan?*
 *
 * It returns the identity and both variants' seven-state projection as well as
 * the selected materialized schedule. `WorkItemService` therefore chooses Fast
 * from `ready` versus every other state without re-decoding cache rows or
 * guessing whether a slot is live.
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
