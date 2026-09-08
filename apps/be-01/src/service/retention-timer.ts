import type { PlanEventStore } from '../repository';
import type { EventLogStore } from '../repository/event-log';
import { runPlanEventRetention, runRetention } from './retention-job';

/** What one sweep removed, per table, because the two are pruned by different rules. */
export interface Swept {
  eventLog: number;
  planEvents: number;
}

export interface RetentionTimerOptions {
  repo: EventLogStore;
  maxPerSubscription: number;
  /**
   * The plan's history. **Required, not optional**, and for the reason
   * `runRetention` itself was once a function with no caller: an optional store
   * here would let a process run with history retention silently absent, and a
   * table growing forever in the file the domain lives in looks exactly like a
   * healthy one from outside until the day it does not.
   */
  planEvents: PlanEventStore;
  /** How long a recorded event lives; {@link PLAN_EVENT_RETENTION_DAYS} in production. */
  planEventRetentionDays: number;
  intervalMs: number;
  /** Reported per sweep; the process decides whether that is worth a log line. */
  onSweep?: (removed: Swept) => void;
  /**
   * A sweep that threw. Required: the event log growing without bound is exactly
   * the failure this timer exists to prevent, and a silently dead timer looks
   * identical to a healthy one from outside.
   */
  onError: (err: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** The clock the history's cutoff is measured from. Injected so a test can name a day. */
  now?: () => number;
}

/**
 * Prunes the event log and the plan's history on a schedule, for as long as the
 * process runs.
 *
 * Without it `runRetention` had no caller at all: the log grew by one row per
 * edit, forever, in the same SQLite file the domain lives in. It also makes the
 * replay orchestrator's `out_of_range` reachable — a refusal that could never
 * happen would be a branch nothing ever took.
 *
 * The two tables are swept on one tick and by different rules — the log by count,
 * the history by age — which is why one sweep reports {@link Swept} rather than a
 * number. A history pruned by count would be a second undo stack.
 */
export class RetentionTimer {
  private handle: unknown = null;
  private inFlight: Promise<void> | null = null;
  private readonly set: (fn: () => void, ms: number) => unknown;
  private readonly clear: (handle: unknown) => void;
  private readonly now: () => number;

  constructor(private readonly opts: RetentionTimerOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.set = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    // The handle is opaque to callers by design — only this pairing of
    // `setInterval` and `clearInterval` knows where it came from.
    this.clear =
      opts.clearInterval ??
      ((handle) => {
        clearInterval(handle as ReturnType<typeof setInterval>);
      });
  }

  /**
   * Proof: the body of this replaced with `this.handle = 'never-scheduled'` and
   * three of the four tests failed — the schedule is what they observe, not a
   * flag saying it was requested.
   */
  start(): void {
    if (this.handle !== null) return;
    this.handle = this.set(() => {
      // A tick arriving while a sweep is still running is dropped, not queued.
      // Overwriting `inFlight` meant `stop()` waited for the newest sweep and
      // `process.exit(0)` could land inside an older DELETE — against a file
      // the other deployment colour is also writing to.
      if (this.inFlight !== null) return;
      this.inFlight = this.sweep().finally(() => {
        this.inFlight = null;
      });
    }, this.opts.intervalMs);
  }

  /**
   * Whether a schedule is currently in place.
   *
   * Exists so a test can assert that the *process* started the timer, not just
   * that the class can start one. `runRetention` sat with no production caller
   * for a whole change; a `start()` nobody calls is the same failure one layer up.
   */
  isRunning(): boolean {
    return this.handle !== null;
  }

  /** Stops the schedule and waits for a sweep already running. */
  async stop(): Promise<void> {
    if (this.handle !== null) {
      this.clear(this.handle);
      this.handle = null;
    }
    await this.inFlight;
  }

  private async sweep(): Promise<void> {
    try {
      const eventLog = await runRetention(this.opts.repo, {
        maxPerSubscription: this.opts.maxPerSubscription,
      });
      // After the log, and not in parallel with it: both are DELETEs against one
      // SQLite file that the other deployment colour is also writing to, and
      // SQLite serialises writers anyway. Sequential is what the reported numbers
      // describe.
      //
      // Proof: this replaced by `const planEvents = 0`, and `prunes the history by
      // age on every tick, and the log by count on the same one` fails on a
      // `toEqual` diff of `{eventLog: 3, planEvents: 0}` against
      // `{eventLog: 3, planEvents: 2}`, with both stale events still in the store;
      // `keeps sweeping after a history sweep fails` goes red beside it on
      // `Expected length: 1 / Received length: 0`, because a sweep that never runs
      // never fails. 6 pass, 2 fail; watched 2026-08-17.
      const planEvents = await runPlanEventRetention(this.opts.planEvents, {
        now: this.now(),
        retainDays: this.opts.planEventRetentionDays,
      });
      this.opts.onSweep?.({ eventLog, planEvents });
    } catch (err) {
      // Caught, reported, and the schedule left running: one failed sweep is a
      // locked database or a transient I/O error, and stopping would turn a
      // recoverable blip into permanent unbounded growth.
      this.opts.onError(err);
    }
  }
}
