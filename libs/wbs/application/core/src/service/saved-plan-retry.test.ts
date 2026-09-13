import { describe, expect, it } from 'bun:test';

import type { SavedPlanSaveOutcome, SavedPlanSaveRequest } from './saved-plan.service';
import type { SavedPlanSaver } from './saved-plan-retry';
import {
  SAVED_PLAN_SAVE_BUDGET_MS,
  savedPlanRetryDelayMs,
  saveWithBoundedRetry,
} from './saved-plan-retry';

const REQUEST: SavedPlanSaveRequest = {
  projectId: 'p1',
  name: 'once more',
  createdBy: 'Ada Lovelace',
  createdById: null,
};

const BUSY: SavedPlanSaveOutcome = { outcome: 'snapshot_busy' };

/**
 * A clock the test advances **only** through the loop's own sleep.
 *
 * Nothing else moves it, so `elapsed` at the end is exactly the time the loop
 * asked to spend rather than the time this process happened to take. A test
 * that measured `Date.now()` here would be asserting a bound against its own
 * scheduler.
 */
const fakeClock = () => {
  let elapsed = 0;
  const slept: number[] = [];
  return {
    slept,
    nowMs: () => elapsed,
    sleep: (ms: number): Promise<void> => {
      slept.push(ms);
      elapsed += ms;
      return Promise.resolve();
    },
    elapsedMs: () => elapsed,
  };
};

/** Answers `snapshot_busy` for the first `busyTimes` calls, then `no_project`. */
const saverBusyFor = (
  busyTimes: number,
): SavedPlanSaver & { readonly seen: SavedPlanSaveRequest[] } => {
  const seen: SavedPlanSaveRequest[] = [];
  return {
    seen,
    save: (request: SavedPlanSaveRequest): Promise<SavedPlanSaveOutcome> => {
      seen.push(request);
      return Promise.resolve(seen.length <= busyTimes ? BUSY : { outcome: 'no_project' });
    },
  };
};

describe('savedPlanRetryDelayMs', () => {
  it('doubles from 50 ms and stops at 500', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(savedPlanRetryDelayMs)).toEqual([
      50, 100, 200, 400, 500, 500, 500,
    ]);
  });
});

describe('saveWithBoundedRetry', () => {
  it('does not retry an answer that is not snapshot_busy', async () => {
    const clock = fakeClock();
    const saver = saverBusyFor(0);

    const outcome = await saveWithBoundedRetry(saver, REQUEST, {
      nowMs: clock.nowMs,
      sleep: clock.sleep,
    });

    expect(outcome).toEqual({ outcome: 'no_project' });
    expect(saver.seen).toHaveLength(1);
    expect(clock.slept).toEqual([]);
  });

  it('retries the whole save, with the same request, until one is not busy', async () => {
    const clock = fakeClock();
    const saver = saverBusyFor(3);

    const outcome = await saveWithBoundedRetry(saver, REQUEST, {
      nowMs: clock.nowMs,
      sleep: clock.sleep,
    });

    expect(outcome).toEqual({ outcome: 'no_project' });
    expect(saver.seen).toHaveLength(4);
    // Every attempt is `save` called again from the top — nothing here narrows
    // the request between attempts, which is what makes the later capture a
    // capture of the same project rather than of a trimmed-down one.
    expect(saver.seen.every((seen) => seen === REQUEST)).toBe(true);
    expect(clock.slept).toEqual([50, 100, 200]);
  });

  it('gives up while it still has budget left rather than sleeping past it', async () => {
    const clock = fakeClock();
    const saver = saverBusyFor(Number.POSITIVE_INFINITY);

    const outcome = await saveWithBoundedRetry(saver, REQUEST, {
      budgetMs: 500,
      nowMs: clock.nowMs,
      sleep: clock.sleep,
    });

    expect(outcome).toEqual(BUSY);
    // 50 + 100 + 200 = 350; the next wait is 400, which would end at 750, so
    // it is never entered. The loop stops *under* the budget, and that is the
    // intended shape: the alternative is a wait that finishes after the answer
    // was already owed.
    expect(clock.slept).toEqual([50, 100, 200]);
    expect(clock.elapsedMs()).toBeLessThan(500);
    expect(saver.seen).toHaveLength(4);
  });

  it('still makes one attempt when there is no budget at all', async () => {
    const clock = fakeClock();
    const saver = saverBusyFor(Number.POSITIVE_INFINITY);

    const outcome = await saveWithBoundedRetry(saver, REQUEST, {
      budgetMs: 0,
      nowMs: clock.nowMs,
      sleep: clock.sleep,
    });

    // The budget bounds the retries. A caller that asked for a save and got
    // "the budget is spent" without anything having been tried would be told
    // about contention that was never observed.
    expect(outcome).toEqual(BUSY);
    expect(saver.seen).toHaveLength(1);
    expect(clock.slept).toEqual([]);
  });

  it('spends the default budget on attempts rather than on one acquire', async () => {
    const clock = fakeClock();
    const saver = saverBusyFor(Number.POSITIVE_INFINITY);

    await saveWithBoundedRetry(saver, REQUEST, { nowMs: clock.nowMs, sleep: clock.sleep });

    // The number that matters is not the count but that it is *many*: five
    // seconds of blocking acquire is one attempt and one read snapshot, and
    // this is the same five seconds spent asking repeatedly with the lock
    // never held while waiting.
    expect(saver.seen.length).toBeGreaterThan(5);
    expect(clock.elapsedMs()).toBeLessThan(SAVED_PLAN_SAVE_BUDGET_MS);
  });
});
