import { inMemoryPlanEvents } from '@wbs/store-memory/history-fixture';
import { inMemoryEventLog } from '@wbs/store-memory/replay-fixture';
import { describe, expect, it } from 'bun:test';

import type { PlanEvent } from '../ports/plan-event-store';
import { RetentionTimer, type Swept } from './retention-timer';

/**
 * A schedule a test advances by hand.
 *
 * Real `setInterval` would make this file the slowest in the suite and flaky
 * under load, and the thing under test is the sweeping, not the clock.
 */
function fakeSchedule() {
  let tick: (() => void) | null = null;
  let cleared = 0;
  let scheduled = 0;
  return {
    every: (_milliseconds: number, fn: () => void) => {
      tick = fn;
      scheduled += 1;
      return () => {
        cleared += 1;
      };
    },
    scheduledCount: () => scheduled,
    advance: () => {
      if (tick === null) throw new Error('the timer never started');
      tick();
    },
    clearedCount: () => cleared,
  };
}

/** The options the timer needs beyond its schedule, so a test can name only what it varies. */
const rethrow = (err: unknown): never => {
  throw err;
};

async function seed(count: number) {
  const log = inMemoryEventLog();
  for (let n = 0; n < count; n++) await log.record('project:a', { n });
  return log;
}

/** A fixed moment, so a cutoff a year back is a number a reader can check. */
const NOW = Date.UTC(2026, 7, 17);
const DAY_MS = 24 * 60 * 60_000;

function event(id: string, daysAgo: number): PlanEvent {
  return {
    id,
    projectId: 'p',
    userId: 'u',
    kind: 'estimate',
    label: `estimate ${id}`,
    workItemId: 'w1',
    stepId: 'r1',
    before: { do: 'clear_estimate' },
    after: { do: 'set_estimate' },
    createdAt: NOW - daysAgo * DAY_MS,
  };
}

/** The options every case shares beyond what it varies. Written out so a new required one lands here once. */
const history = () => inMemoryPlanEvents();
const internal = { principal: { kind: 'internal' as const } };

describe('RetentionTimer', () => {
  it('prunes the log on every tick', async () => {
    const log = await seed(5);
    const schedule = fakeSchedule();
    const swept: number[] = [];
    const timer = new RetentionTimer({
      ...internal,
      repo: log,
      maxPerSubscription: 2,
      planEvents: history(),
      planEventRetentionDays: 365,
      now: () => NOW,
      intervalMs: 1_000,
      onSweep: (removed) => swept.push(removed.eventLog),
      onError: (err) => {
        throw err;
      },
      intervals: schedule,
    });

    timer.start();
    schedule.advance();
    await timer.stop();

    expect(swept).toEqual([3]);
    expect(await log.oldestSeq('project:a')).toBe(3);
    // The sequence does not move backwards when rows go, so a client resuming
    // after a prune is refused rather than told it is up to date.
    expect(await log.latestSeq('project:a')).toBe(4);
  });

  it('keeps sweeping after one sweep fails', async () => {
    // A locked database is transient. Stopping on it would turn a blip into
    // permanent unbounded growth in the same file the domain lives in.
    const log = await seed(5);
    let calls = 0;
    const failing = {
      ...log,
      pruneBeyond: (max: number) => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('database is locked'));
        return log.pruneBeyond(max);
      },
    };
    const schedule = fakeSchedule();
    const errors: unknown[] = [];
    const swept: number[] = [];
    const timer = new RetentionTimer({
      ...internal,
      repo: failing,
      maxPerSubscription: 2,
      planEvents: history(),
      planEventRetentionDays: 365,
      now: () => NOW,
      intervalMs: 1_000,
      onSweep: (removed) => swept.push(removed.eventLog),
      onError: (err) => errors.push(err),
      intervals: schedule,
    });

    timer.start();
    schedule.advance();
    // A macrotask, so every microtask the failed sweep queued has run and the
    // timer is idle again. `await Promise.resolve()` is one turn and leaves the
    // sweep still in flight, which the timer correctly refuses to double.
    await new Promise((resolve) => setTimeout(resolve, 0));
    schedule.advance();
    await timer.stop();

    expect(errors).toHaveLength(1);
    expect(swept).toEqual([3]);
  });

  it('stops the schedule and waits for a sweep already running', async () => {
    const log = await seed(5);
    const schedule = fakeSchedule();
    let released: () => void = () => undefined;
    const slow = {
      ...log,
      pruneBeyond: () =>
        new Promise<number>((resolve) => {
          released = () => {
            resolve(0);
          };
        }),
    };
    let finished = false;
    const timer = new RetentionTimer({
      ...internal,
      repo: slow,
      maxPerSubscription: 2,
      planEvents: history(),
      planEventRetentionDays: 365,
      now: () => NOW,
      intervalMs: 1_000,
      onSweep: () => {
        finished = true;
      },
      onError: (err) => {
        throw err;
      },
      intervals: schedule,
    });

    timer.start();
    schedule.advance();
    const stopping = timer.stop();
    released();
    await stopping;

    expect(finished).toBe(true);
    expect(schedule.clearedCount()).toBe(1);
  });

  it('does not start a second schedule', async () => {
    // The `clearedCount` assertion alone was vacuous — agy caught it. A `start`
    // that scheduled nothing at all still set a handle for `stop` to clear, so
    // the test passed against a timer that never ran. Both numbers are asserted
    // now: one schedule created, and the second `start` adding none.
    const log = await seed(1);
    const schedule = fakeSchedule();
    const timer = new RetentionTimer({
      ...internal,
      repo: log,
      maxPerSubscription: 2,
      planEvents: history(),
      planEventRetentionDays: 365,
      now: () => NOW,
      intervalMs: 1_000,
      onError: rethrow,
      intervals: schedule,
    });

    timer.start();
    timer.start();
    await timer.stop();

    expect(schedule.scheduledCount()).toBe(1);
    expect(schedule.clearedCount()).toBe(1);
  });

  it('does not start a sweep on top of one still running', async () => {
    // codex, medium. Every tick started another sweep and overwrote `inFlight`,
    // so `stop()` waited only for the newest one and `process.exit(0)` could
    // land in the middle of an older DELETE — against a file the other
    // deployment colour is also using.
    const log = await seed(5);
    let started = 0;
    let release: () => void = () => undefined;
    const slow = {
      ...log,
      pruneBeyond: () => {
        started += 1;
        return new Promise<number>((resolve) => {
          release = () => {
            resolve(0);
          };
        });
      },
    };
    const schedule = fakeSchedule();
    const timer = new RetentionTimer({
      ...internal,
      repo: slow,
      maxPerSubscription: 2,
      planEvents: history(),
      planEventRetentionDays: 365,
      now: () => NOW,
      intervalMs: 1_000,
      onError: rethrow,
      intervals: schedule,
    });

    timer.start();
    schedule.advance();
    schedule.advance();
    schedule.advance();

    expect(started).toBe(1);

    const stopping = timer.stop();
    release();
    await stopping;

    // And the next tick after it finished would have swept again, had one come.
    expect(started).toBe(1);
  });
});

describe('RetentionTimer, on the plan’s history', () => {
  it('prunes the history by age on every tick, and the log by count on the same one', async () => {
    // The two tables and the two rules, on one sweep. A year and a day old goes;
    // a day short of a year stays; the event log is pruned by count beside it, so
    // this also says the history sweep did not replace the log sweep.
    //
    // Proof: the `runPlanEventRetention` call in `RetentionTimer.sweep` replaced
    // by `const planEvents = 0`, and this fails on a `toEqual` diff —
    // `{eventLog: 3, planEvents: 0}` where `{eventLog: 3, planEvents: 2}` was
    // owed — with both stale events still held. 6 pass, 2 fail; watched
    // 2026-08-17.
    const log = await seed(5);
    const events = inMemoryPlanEvents([event('old', 366), event('older', 730), event('kept', 364)]);
    const schedule = fakeSchedule();
    const swept: Swept[] = [];
    const timer = new RetentionTimer({
      ...internal,
      repo: log,
      maxPerSubscription: 2,
      planEvents: events,
      planEventRetentionDays: 365,
      now: () => NOW,
      intervalMs: 1_000,
      onSweep: (removed) => swept.push(removed),
      onError: rethrow,
      intervals: schedule,
    });

    timer.start();
    schedule.advance();
    await timer.stop();

    expect(swept).toEqual([{ eventLog: 3, planEvents: 2 }]);
    expect(events.held.map((each) => each.id)).toEqual(['kept']);
  });

  it('keeps an event a day short of the window, so the boundary is not off by one', async () => {
    // 365 days exactly is inside the window: the cutoff is `now - 365 days` and the
    // delete is strictly older than it. Asserted because a boundary nobody probed
    // is a boundary nobody knows, and this one silently deletes a year of history
    // in the wrong direction.
    const events = inMemoryPlanEvents([event('exactly', 365)]);
    const schedule = fakeSchedule();
    const timer = new RetentionTimer({
      ...internal,
      repo: await seed(1),
      maxPerSubscription: 2,
      planEvents: events,
      planEventRetentionDays: 365,
      now: () => NOW,
      intervalMs: 1_000,
      onError: rethrow,
      intervals: schedule,
    });

    timer.start();
    schedule.advance();
    await timer.stop();

    expect(events.held.map((each) => each.id)).toEqual(['exactly']);
  });

  it('keeps sweeping after a history sweep fails', async () => {
    // The log's own rule, asserted for the second table: a locked database is
    // transient, and stopping would turn a blip into permanent unbounded growth in
    // the file the domain lives in.
    const events = inMemoryPlanEvents([event('old', 400)]);
    let calls = 0;
    const failing = {
      ...events,
      pruneOlderThan: (cutoff: number) => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('database is locked'));
        return events.pruneOlderThan(cutoff);
      },
    };
    const schedule = fakeSchedule();
    const errors: unknown[] = [];
    const timer = new RetentionTimer({
      ...internal,
      repo: await seed(1),
      maxPerSubscription: 2,
      planEvents: failing,
      planEventRetentionDays: 365,
      now: () => NOW,
      intervalMs: 1_000,
      onError: (err) => errors.push(err),
      intervals: schedule,
    });

    timer.start();
    schedule.advance();
    await new Promise((resolve) => setTimeout(resolve, 0));
    schedule.advance();
    await timer.stop();

    expect(errors).toHaveLength(1);
    expect(events.held).toEqual([]);
  });
});
