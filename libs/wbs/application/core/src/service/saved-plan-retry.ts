import type { SavedPlanSaveOutcome, SavedPlanSaveRequest } from './saved-plan.service';

/**
 * The budget one save gets **in total, retries included** (design.md,
 * "Fail-fast, not queue"). It is deliberately not a `busy_timeout`: five
 * seconds spent inside a single blocking acquire and five seconds spent across
 * several fail-fast attempts are the same number and opposite behaviours, and
 * the spec's "refused, not serialised" is about which of the two happened.
 */
export const SAVED_PLAN_SAVE_BUDGET_MS = 5_000;

/** The first wait, and the ceiling the doubling stops at. */
const FIRST_DELAY_MS = 50;
const MAX_DELAY_MS = 500;

/**
 * How long to wait before the `priorAttempts`-th retry: 50, 100, 200, 400,
 * 500, 500…
 *
 * It backs off rather than spinning because **a retry is not a cheap
 * re-acquire.** Every attempt re-runs the whole capture — the project's rows
 * read inside one snapshot and the scheduler run over them — and only then
 * asks for the write lock; the lock is the last and cheapest step. A 50 ms
 * fixed interval would therefore re-schedule the plan a hundred times across a
 * five-second contention, which is real work done to lose a race. The ceiling
 * is there because the rival's transaction is bounded by its own body writes,
 * so waiting longer than half a second buys nothing.
 */
export function savedPlanRetryDelayMs(priorAttempts: number): number {
  const doubled = FIRST_DELAY_MS * 2 ** (priorAttempts - 1);
  return Math.min(doubled, MAX_DELAY_MS);
}

/**
 * Just the shape this needs, so the retry can be tested against a stub and a
 * caller can wrap anything that saves.
 */
export interface SavedPlanSaver {
  save(request: SavedPlanSaveRequest): Promise<SavedPlanSaveOutcome>;
}

export interface SavedPlanRetryOptions {
  /** Total budget for the call. Defaults to {@link SAVED_PLAN_SAVE_BUDGET_MS}. */
  readonly budgetMs?: number;
  /** Milliseconds since some fixed point. Injected so a test owns the clock. */
  readonly nowMs: () => number;
  /** Injected for the same reason, and as this loop's one interleaving point. */
  readonly sleep: (ms: number) => Promise<void>;
  /** The backoff. Defaults to {@link savedPlanRetryDelayMs}. */
  readonly delayMs?: (priorAttempts: number) => number;
}

/**
 * Saves, and on `snapshot_busy` tries again until the budget is spent.
 *
 * **This is a caller's policy and lives outside `SavedPlanService.save` on
 * purpose.** `save` is fail-fast by contract: it
 * refuses in about a millisecond and holds nothing while it does. Folding the
 * loop into it would take that contract away from every internal caller at
 * once — including the ones that want the refusal itself, such as a route that
 * reports "someone else is saving" to a user who can decide for themselves.
 *
 * **Each attempt is a whole new save, not a retried write.** That is the
 * property the spec cares about and the reason the retry is allowed at all: an
 * attempt that acquires the lock after the rival committed is a fresh save
 * over a **new read snapshot**, so the record it writes describes the project
 * as it was at that later instant — including any edit that landed in between
 * — rather than resurrecting the values the refused attempt had already
 * detached from the database. `save` re-captures and re-stamps `created_at`
 * from its own top, so calling it again is the whole mechanism; there is
 * nothing here that could reuse the first attempt's work even by accident.
 *
 * **What the budget bounds is honest:** no attempt *starts* once the budget is
 * gone, and no wait is entered that would end past it. It is not a promise
 * that the call returns within `budgetMs`, because an attempt already running
 * is a capture and a scheduler run and this loop cannot interrupt one. Saying
 * it the other way round would be a bound that the slowest project quietly
 * breaks.
 */
export async function saveWithBoundedRetry(
  saver: SavedPlanSaver,
  request: SavedPlanSaveRequest,
  options: SavedPlanRetryOptions,
): Promise<SavedPlanSaveOutcome> {
  const budgetMs = options.budgetMs ?? SAVED_PLAN_SAVE_BUDGET_MS;
  const nowMs = options.nowMs;
  const sleep = options.sleep;
  const delayMs = options.delayMs ?? savedPlanRetryDelayMs;

  const deadline = nowMs() + budgetMs;
  let priorAttempts = 0;
  // The first attempt is unconditional — the budget bounds the *retries*, and
  // a zero budget still has to answer the caller's save rather than refusing a
  // save nobody has tried yet.
  for (;;) {
    const outcome = await saver.save(request);
    if (outcome.outcome !== 'snapshot_busy') return outcome;
    priorAttempts += 1;
    const wait = delayMs(priorAttempts);
    // Both halves of the budget check, in one place: the wait must finish
    // before the deadline *and* leave the next attempt something to start
    // with. Testing only `nowMs() < deadline` here would enter a 500 ms sleep
    // with 1 ms left and hand back an answer half a second late.
    if (nowMs() + wait >= deadline) return outcome;
    await sleep(wait);
  }
}
