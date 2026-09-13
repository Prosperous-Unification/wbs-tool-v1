import type { EventLogStore } from '../ports/event-log-store';
import type { PlanEventStore } from '../ports/plan-event-store';

export function runRetention(
  repo: Pick<EventLogStore, 'pruneBeyond'>,
  opts: { maxPerSubscription: number },
): Promise<number> {
  return repo.pruneBeyond(opts.maxPerSubscription);
}

/** A day in milliseconds, so the retention window is stated in the unit it is argued in. */
const DAY_MS = 24 * 60 * 60_000;

/**
 * Takes the old end off the plan's history, and answers how many events went.
 *
 * **By age, and that is the whole rule.** The event log is pruned by count
 * because it is a resume buffer and a client that has been away long enough is
 * refused rather than served stale events; a history pruned by count would evict
 * the morning's estimate changes on an afternoon of editing, which is the
 * property that already disqualifies `command_journal` from being a history at
 * all. See {@link PLAN_EVENT_RETENTION_DAYS}.
 *
 * A separate function from {@link runRetention} rather than an argument to it:
 * the two sweeps prune different tables by different rules, and one function
 * taking a mode would have to be read twice to see which rule ran.
 */
export function runPlanEventRetention(
  repo: Pick<PlanEventStore, 'pruneOlderThan'>,
  opts: { now: number; retainDays: number },
): Promise<number> {
  return repo.pruneOlderThan(opts.now - opts.retainDays * DAY_MS);
}
