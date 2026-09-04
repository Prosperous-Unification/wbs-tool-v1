import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SavedPlanListEntryView, SavedPlanSaveResult } from './saved-plan-api';
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
  settle(result: SavedPlanSaveResult): Promise<void>;
  reject(fault: unknown): Promise<void>;
} => {
  const calls: unknown[][] = [];
  let resolveWith: ((result: SavedPlanSaveResult) => void) | null = null;
  let rejectWith: ((fault: unknown) => void) | null = null;
  const deps: SaveDeps = {
    save: (...args: unknown[]) => {
      calls.push(args);
      return new Promise<SavedPlanSaveResult>((resolve, reject) => {
        resolveWith = resolve;
        rejectWith = reject;
      });
    },
  } as SaveDeps;
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

    await fake.settle({ outcome: 'saved', savedPlan: ROW });
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
    await fake.settle({ outcome: 'saved', savedPlan: ROW });
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
    await fake.settle({ outcome: 'saved', savedPlan: ROW });
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
   * The two refusals arrive as states rather than throws, because 8.5 says them
   * in different words and a `quota` without its sentence names no limit.
   */
  itDom('keeps a busy snapshot and a quota refusal apart', async () => {
    const busy = deferredSave();
    const heldBusy = renderHook(() => useSavedPlanSave(busy.deps, 'p1'));
    act(() => {
      heldBusy.result.current.save();
    });
    await busy.settle({ outcome: 'snapshot_busy' });
    expect(heldBusy.result.current.state).toEqual({ kind: 'busy' });

    const quota = deferredSave();
    const heldQuota = renderHook(() => useSavedPlanSave(quota.deps, 'p1'));
    act(() => {
      heldQuota.result.current.save();
    });
    await quota.settle({ outcome: 'quota', refusal: 'ten saved plans per project' });
    expect(heldQuota.result.current.state).toEqual({
      kind: 'quota',
      refusal: 'ten saved plans per project',
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
