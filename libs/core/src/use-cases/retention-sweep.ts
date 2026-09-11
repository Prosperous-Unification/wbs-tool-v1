import type { InternalIdentity } from '../http/endpoint';
import type { AuthenticatedUser } from '../service/auth.service';
import { runPlanEventRetention, runRetention } from '../service/retention-job';

export interface RetentionSweepGraph {
  readonly eventLog: { pruneBeyond(maxPerSubscription: number): Promise<number> };
  readonly planEvents: { pruneOlderThan(cutoff: number): Promise<number> };
  readonly maxPerSubscription: number;
  readonly retainDays: number;
  readonly now: () => number;
}

export interface RetentionSweepInput {
  readonly principal: InternalIdentity | AuthenticatedUser;
}

export type RetentionSweepOutcome =
  | {
      readonly outcome: 'swept';
      readonly eventLogRemoved: number;
      readonly planEventsRemoved: number;
    }
  | { readonly outcome: 'forbidden' };

/** Runs both bounded retention rules for an internally admitted trigger. */
export async function retentionSweep(
  graph: RetentionSweepGraph,
  input: RetentionSweepInput,
): Promise<RetentionSweepOutcome> {
  if (!('kind' in input.principal)) {
    return { outcome: 'forbidden' };
  }
  const eventLogRemoved = await runRetention(graph.eventLog, {
    maxPerSubscription: graph.maxPerSubscription,
  });
  const planEventsRemoved = await runPlanEventRetention(graph.planEvents, {
    now: graph.now(),
    retainDays: graph.retainDays,
  });
  return { outcome: 'swept', eventLogRemoved, planEventsRemoved };
}
