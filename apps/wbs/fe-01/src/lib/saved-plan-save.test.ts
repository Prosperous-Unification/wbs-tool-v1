import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SavedPlanListEntryView, SavedPlanSaveReply } from './saved-plan-api';
import type { SaveDeps } from './saved-plan-save';
import { useSavedPlanSave } from './saved-plan-save';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

const ROW: SavedPlanListEntryView = {
  id: 'sp1',
  name: '2026-09-04 07:40:12 UTC',
  createdBy: 'ada',
  createdAt: 1_788_507_612_000,
  inputBytes: 4096,
  scheduleBytes: 2048,
  scheduleAbsentReason: null,
};

const savedReply = (savedPlan: SavedPlanListEntryView): SavedPlanSaveReply => ({
  kind: 'success',
  representation: 'json',
  status: 201,
  headers: new Headers(),
  body: { savedPlan },
});
const busyReply = (): SavedPlanSaveReply => ({
  kind: 'refusal',
  representation: 'json',
  status: 503,
  headers: new Headers(),
  body: { error: 'snapshot_busy' },
});
const quotaReply = (): SavedPlanSaveReply => ({
  kind: 'refusal',
  representation: 'json',
  status: 409,
  headers: new Headers(),
  body: { error: 'quota', refusal: { limit: 'plan_count', asked: 11, allowed: 10 } },
});

/**
 * A `save` whose answer is handed over when the case says so.
 *
 * Deferred rather than pre-resolved because every interesting thing about this
 * hook happens *during* the request: the second press, the unmount, the state
 * the button is in while the user waits. A fake that resolves immediately can
 * assert none of them.
 */
const deferredSave = (): {
  deps: SaveDeps;
  calls: unknown[][];
  settle(reply: SavedPlanSaveReply): Promise<void>;
  reject(fault: unknown): Promise<void>;
} => {
  const calls: unknown[][] = [];
  let resolveWith: ((reply: SavedPlanSaveReply) => void) | null = null;
  let rejectWith: ((fault: unknown) => void) | null = null;
  const deps: SaveDeps = {
    save: (...args: unknown[]) => {
      calls.push(args);
      return new Promise<SavedPlanSaveReply>((resolve, reject) => {
        resolveWith = resolve;
        rejectWith = reject;
      });
    },
  };
  const flush = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  return {
    deps,
    calls,
    settle: async (result) => {
      resolveWith?.(result);
      await flush();
    },
    reject: async (fault) => {
      rejectWith?.(fault);
      await flush();
    },
  };
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the Save plan action', () => {
  /**
   * A-1, asserted on the ARGUMENT COUNT and not only on the value.
   *
   * `calls[0]?.[1] === undefined` is true for a hook that passes an explicit
   * `undefined`, and also for one that passes nothing — but it is also true for
   * `save(projectId, someNameThatHappensToBeUndefined)`, which is the shape a
   * later "let the caller name it" change would arrive in. Asserting the whole
   * argument list says the rule once: this hook has no name to give, so it sends
   * one argument.
   */
  itDom('asks be-01 to name the record, by sending it no name at all', async () => {
    const fake = deferredSave();
    const held = renderHook(() => useSavedPlanSave(fake.deps, 'p1'));

    act(() => {
      held.result.current.save();
    });

    expect(fake.calls).toEqual([['p1']]);
    expect(held.result.current.state).toEqual({ kind: 'saving' });

    await fake.settle(savedReply(ROW));
    expect(held.result.current.state).toEqual({ kind: 'saved', savedPlan: ROW });
  });

  /**
   * The double-press, and the reason it is a defect rather than a nuisance.
   *
   * Every save writes a new immutable row. Two presses a second apart on a slow
   * connection therefore leave two checkpoints of the same plan, named one
   * second apart, both correct and neither one the user meant to make. The shelf
   * is chronological (AC #2), so the duplicate is not even easy to spot.
   */
  itDom('makes one checkpoint when the button is pressed twice, not two', async () => {
    const fake = deferredSave();
    const held = renderHook(() => useSavedPlanSave(fake.deps, 'p1'));

    act(() => {
      held.result.current.save();
      held.result.current.save();
    });

    expect(fake.calls).toHaveLength(1);

    // And the guard lifts once the first one lands — a hook that saves once per
    // mount would pass the assertion above and be useless.
    await fake.settle(savedReply(ROW));
    act(() => {
      held.result.current.save();
    });
    expect(fake.calls).toHaveLength(2);
  });

  /**
   * The in-flight window is exactly when a component can leave, and this case
   * asserts what is actually observable about that: **the save completes**.
   *
   * An earlier draft asserted the opposite thing — that nothing was written into
   * the departed component — by spying on `console.error`. Measured: deleting
   * the `mounted` ref the hook then carried left that case green. React 18
   * removed the setState-on-unmounted warning and the call is a no-op, so from
   * outside the component there is no difference to see. The assertion was
   * therefore documentation wearing an `expect`, and the guard it "covered"
   * could be deleted in silence.
   *
   * What a caller can still get wrong here is the request: aborting it, or
   * leaving `inFlight` latched so the next mount cannot save. Both are visible
   * on the fake.
   */
  itDom('lets a save that outlived its component finish rather than abandoning it', async () => {
    const fake = deferredSave();
    const held = renderHook(() => useSavedPlanSave(fake.deps, 'p1'));
    act(() => {
      held.result.current.save();
    });

    held.unmount();
    await fake.settle(savedReply(ROW));
    expect(fake.calls).toEqual([['p1']]);

    // The checkpoint is written server-side either way — a plan the user asked
    // to save is not un-saved by navigating — and a remount can save again.
    const again = renderHook(() => useSavedPlanSave(fake.deps, 'p1'));
    act(() => {
      again.result.current.save();
    });
    expect(fake.calls).toHaveLength(2);
  });

  /**
   * Sol I1, the half a component-local guard cannot cover.
   *
   * `ProjectPage` moves one `SavedPlanShelf` between the app-header row and the
   * cards renderer's toolbar sheet, so crossing 768px wide or 500px tall
   * unmounts the shelf and mounts a fresh one. A `useRef(false)` guard is
   * component-local, so the replacement starts with the lock open while the
   * first request is still running, and the reader's second press writes a
   * second immutable checkpoint of the same plan for one user action. The
   * window is a resize, not a rare race.
   */
  itDom('holds the save lock across a remount while the request is still running', async () => {
    const fake = deferredSave();
    const held = renderHook(() => useSavedPlanSave(fake.deps, 'p1'));
    act(() => {
      held.result.current.save();
    });
    expect(fake.calls).toHaveLength(1);

    held.unmount();
    const replaced = renderHook(() => useSavedPlanSave(fake.deps, 'p1'));

    // The replacement knows a save is running: the button it draws is disabled
    // for the same reason the departed one's was.
    expect(replaced.result.current.state).toEqual({ kind: 'saving' });
    act(() => {
      replaced.result.current.save();
    });
    expect(fake.calls).toHaveLength(1);

    // And the lock lifts when the request lands, not when a component does.
    await fake.settle(savedReply(ROW));
    act(() => {
      replaced.result.current.save();
    });
    expect(fake.calls).toHaveLength(2);
  });

  /**
   * Sol I1's second window. `SavedPlansPanel` refreshes the shelf when the save
   * state turns `saved`. be-01 does broadcast `saved_plans_changed` on a
   * successful save (TASK-255), but that event carries no per-request outcome
   * and is not emitted at all on `busy`, `quota` or `error` — so it cannot
   * deliver the request's terminal state to a replacement mount. Settling into
   * the component that has already been replaced therefore drops the
   * authoritative timestamp and every refusal message, and leaves the
   * replacement on `idle` — the failure `saved-plan-save.ts:176-180` records.
   */
  itDom('settles into the component that replaced the one that pressed Save', async () => {
    const fake = deferredSave();
    const held = renderHook(() => useSavedPlanSave(fake.deps, 'p1'));
    act(() => {
      held.result.current.save();
    });
    held.unmount();

    const replaced = renderHook(() => useSavedPlanSave(fake.deps, 'p1'));
    await fake.settle(savedReply(ROW));

    expect(replaced.result.current.state).toEqual({ kind: 'saved', savedPlan: ROW });
  });

  /**
   * Gemini round 15, and the half of I1 the first fix left open.
   *
   * A resize unmounts the shelf and mounts its replacement, and a request that
   * lands *between* the two belongs to neither. The answer must wait for
   * whoever arrives. be-01 does publish `saved_plans_changed` on a successful
   * save (TASK-255), so the row itself would eventually appear — but that event
   * carries no per-request outcome and is not emitted at all on `busy`, `quota`
   * or `error`, so it cannot deliver this request's terminal state to whoever
   * replaced the mount that pressed Save. Losing the answer here drops the
   * authoritative timestamp and every refusal message: the same finding arriving
   * through a narrower door.
   */
  itDom('hands a save that landed with nobody mounted to the next mount', async () => {
    const fake = deferredSave();
    const held = renderHook(() => useSavedPlanSave(fake.deps, 'p1'));
    act(() => {
      held.result.current.save();
    });
    held.unmount();

    await fake.settle(savedReply(ROW));
    const arrived = renderHook(() => useSavedPlanSave(fake.deps, 'p1'));

    expect(arrived.result.current.state).toEqual({ kind: 'saved', savedPlan: ROW });

    // Taken once. A third mount is a fresh reader, not a second confirmation of
    // somebody else's save, and would otherwise refresh the shelf for nothing.
    const later = renderHook(() => useSavedPlanSave(fake.deps, 'p1'));
    expect(later.result.current.state).toEqual({ kind: 'idle' });
  });

  /**
   * Sol M2 / Gemini m1, round 16: the injected boundary is allowed to be rude.
   *
   * The lock is written before `deps.save` is called, so a synchronous throw
   * used to escape with no settle behind it to release the entry — and that
   * entry outlives every mount, so the project's Save button was dead for the
   * rest of the session. The production API is `async` and cannot do this; the
   * `SaveDeps` type permits it, which is the whole reason this case exists.
   */
  itDom('releases the lock when the injected save throws instead of rejecting', () => {
    let attempts = 0;
    const deps: SaveDeps = {
      save: () => {
        attempts += 1;
        throw new Error('boom');
      },
    };
    const { result } = renderHook(() => useSavedPlanSave(deps, 'p1'));

    act(() => {
      result.current.save();
    });
    expect(result.current.state).toEqual({ kind: 'error', code: 'boom' });

    // Counted, not inferred from the state: a latched lock leaves the same
    // `error` on screen and refuses the second press silently, so only the
    // attempt count can tell a released lock from a dead button.
    act(() => {
      result.current.save();
    });
    expect(attempts).toBe(2);
  });

  /**
   * The lock is per project and per API, never global: two projects saving at
   * once is an ordinary thing for a reader with two tabs' worth of work, and a
   * shared flag would silently drop the second save.
   */
  itDom('locks one project at a time', async () => {
    const fake = deferredSave();
    const one = renderHook(() => useSavedPlanSave(fake.deps, 'p1'));
    const two = renderHook(() => useSavedPlanSave(fake.deps, 'p2'));

    act(() => {
      one.result.current.save();
      two.result.current.save();
    });

    expect(fake.calls).toEqual([['p1'], ['p2']]);
    expect(two.result.current.state).toEqual({ kind: 'saving' });
    await fake.settle(savedReply(ROW));
  });

  /**
   * The two refusals arrive as states rather than throws, because 8.5 says them
   * in different words and a `quota` without its sentence names no limit.
   */
  itDom('keeps a busy snapshot and a quota refusal apart', async () => {
    const busy = deferredSave();
    const heldBusy = renderHook(() => useSavedPlanSave(busy.deps, 'p1'));
    act(() => {
      heldBusy.result.current.save();
    });
    await busy.settle(busyReply());
    expect(heldBusy.result.current.state).toEqual({ kind: 'busy' });

    const quota = deferredSave();
    const heldQuota = renderHook(() => useSavedPlanSave(quota.deps, 'p1'));
    act(() => {
      heldQuota.result.current.save();
    });
    await quota.settle(quotaReply());
    expect(heldQuota.result.current.state).toEqual({
      kind: 'quota',
      refusal: { limit: 'plan_count', asked: 11, allowed: 10 },
    });
  });

  /**
   * A thrown code is shown rather than erased, and the button works again
   * afterwards — a failed save that latches the guard is a Save action that is
   * dead for the rest of the session.
   */
  itDom('shows the code a failed save threw, and lets the next press through', async () => {
    const fake = deferredSave();
    const held = renderHook(() => useSavedPlanSave(fake.deps, 'p1'));
    act(() => {
      held.result.current.save();
    });

    await fake.reject(new Error('http_503'));
    expect(held.result.current.state).toEqual({ kind: 'error', code: 'http_503' });

    act(() => {
      held.result.current.save();
    });
    expect(fake.calls).toHaveLength(2);
  });
});
