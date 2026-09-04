import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SavedPlanListEntryView } from './saved-plan-api';
import type { ShelfWatchDeps } from './saved-plan-shelf';
import { readShelf, useSavedPlanShelf, watchShelf } from './saved-plan-shelf';

// fe-01 tests require jsdom; only Vitest provides it. Skip under plain `bun test`.
const hasDom = typeof document !== 'undefined';
const itDom = hasDom ? it : it.skip;

const ROW: SavedPlanListEntryView = {
  id: 'sp1',
  name: 'before the re-plan',
  createdBy: 'ada',
  createdAt: 1_788_501_600_000,
  inputBytes: 4096,
  scheduleBytes: 2048,
  scheduleAbsentReason: null,
};

describe('reading a project’s shelf', () => {
  it('does not ask for a list a node cannot answer', async () => {
    // **The case that closes 6.4.** The probe and the sentence were both written
    // before this function, and each is asserted against its own input — so a
    // build where the probe is never invoked passed all of them. This is the
    // assertion neither of them can make: the answer is *used*.
    // Negative, MEASURED on h2puni at b9940187 and reverted with dirty=0
    // re-asserted: delete the `if (!available)` line and this file is 4 pass /
    // 1 fail, the one being this case. It reddens on the *returned state* —
    // `{ kind: 'ready', rows: [ROW] }` where `{ kind: 'unavailable' }` was
    // expected — so `resolves.toEqual` throws and the spy assertion below never
    // runs. Stated because the obvious guess is the other way round. The spy is
    // still not redundant: it is the only thing that would catch a build that
    // answered `unavailable` and asked for the list anyway, which is a shape no
    // assertion on the return value can see.
    const list = vi.fn(() => Promise.resolve([ROW]));
    await expect(
      readShelf({ available: () => Promise.resolve(false), list }, 'p1'),
    ).resolves.toEqual({ kind: 'unavailable' });
    expect(list).not.toHaveBeenCalled();
  });

  it('reads the rows once the node says it has the routes', async () => {
    const list = vi.fn(() => Promise.resolve([ROW]));
    await expect(
      readShelf({ available: () => Promise.resolve(true), list }, 'p1'),
    ).resolves.toEqual({ kind: 'ready', rows: [ROW] });
    expect(list).toHaveBeenCalledWith('p1');
  });

  it('separates a refused probe from a probe that answered no', async () => {
    // A document that could not be read is a fault to report; a document that
    // was read and lacked the paths is a node to upgrade. One try block covering
    // both would collapse them, and the reader would be told to upgrade a server
    // that is merely behind a broken proxy.
    await expect(
      readShelf(
        { available: () => Promise.reject(new Error('http_500')), list: () => Promise.resolve([]) },
        'p1',
      ),
    ).resolves.toEqual({ kind: 'error', code: 'http_500' });
  });

  it('carries be-01’s own code out of a failed read', async () => {
    await expect(
      readShelf(
        {
          available: () => Promise.resolve(true),
          list: () => Promise.reject(new Error('not_found')),
        },
        'p1',
      ),
    ).resolves.toEqual({ kind: 'error', code: 'not_found' });
  });

  it('shows whatever was thrown when something throws a non-Error', async () => {
    // Every throw in the API layer is an Error carrying be-01's code. On the day
    // one is not, showing what arrived beats erasing it behind 'unknown'.
    // Negative, MEASURED and reverted with dirty=0 re-asserted: `String(fault)`
    // replaced by the literal `'unknown'` is 4 pass / 1 fail, the one being this
    // case. The arm is load-bearing rather than defensive decoration.
    await expect(
      readShelf(
        {
          available: () => Promise.resolve(true),
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rejecting with a non-Error is the branch under test, and the rule is right about the production code it is aimed at: this is the one place the shape has to be written down literally, because the fault has to arrive as a bare string for `codeOf`'s `String(fault)` arm to be reached at all.
          list: () => Promise.reject('a bare string'),
        },
        'p1',
      ),
    ).resolves.toEqual({ kind: 'error', code: 'a bare string' });
  });
});

describe('watching a project’s shelf', () => {
  /** Resolves once everything already queued as a microtask has run. */
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

  const fakeStream = () => {
    let fire: (() => void) | undefined;
    const unsubscribe = vi.fn();
    return {
      unsubscribe,
      broadcast: () => fire?.(),
      subscribe: vi.fn((_projectId: string, onChange: () => void) => {
        fire = onChange;
        return { unsubscribe };
      }),
    };
  };

  it('emits the first read and subscribes once', async () => {
    const stream = fakeStream();
    const onState = vi.fn();
    watchShelf(
      {
        available: () => Promise.resolve(true),
        list: () => Promise.resolve([ROW]),
        subscribe: stream.subscribe,
      },
      'p1',
      onState,
    );
    await settled();
    expect(onState).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenCalledWith({ kind: 'ready', rows: [ROW] });
    expect(stream.subscribe).toHaveBeenCalledTimes(1);
    expect(stream.subscribe).toHaveBeenCalledWith('p1', expect.any(Function));
  });

  it('re-reads and emits again when the project changes', async () => {
    // The payload is ignored on purpose, exactly as subscribeToProject ignores
    // it: a saved plan is immutable but the *list* is not, and re-reading is one
    // request and always right.
    const stream = fakeStream();
    const onState = vi.fn();
    const list = vi.fn(() => Promise.resolve([ROW]));
    watchShelf(
      { available: () => Promise.resolve(true), list, subscribe: stream.subscribe },
      'p1',
      onState,
    );
    await settled();
    stream.broadcast();
    await settled();
    expect(list).toHaveBeenCalledTimes(2);
    expect(onState).toHaveBeenCalledTimes(2);
    // Still one subscription. A re-read that resubscribed would double the
    // fan-out on every edit, and the second socket would be invisible from here.
    expect(stream.subscribe).toHaveBeenCalledTimes(1);
  });

  it('never subscribes to a node that cannot answer the question', async () => {
    // 6.4's reasoning one level up. There is nothing to listen for: the list has
    // no route on this node, so a socket opened here is a reconnect loop behind
    // a surface that can never render rows.
    // Negative: drop the `if (state.kind === 'unavailable') return;` line and
    // this reddens on subscribe having been called once.
    const stream = fakeStream();
    const onState = vi.fn();
    watchShelf(
      {
        available: () => Promise.resolve(false),
        list: () => Promise.resolve([ROW]),
        subscribe: stream.subscribe,
      },
      'p1',
      onState,
    );
    await settled();
    expect(onState).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenCalledWith({ kind: 'unavailable' });
    expect(stream.subscribe).not.toHaveBeenCalled();
  });

  it('emits nothing after the caller stops, including from a read in flight', async () => {
    // The trap project-stream.ts names in its own unsubscribe: the loop that
    // outlived its subscriber. Stopping between the request and its answer is
    // the ordinary case for a component that unmounts, not a rare one.
    const stream = fakeStream();
    const onState = vi.fn();
    const { stop } = watchShelf(
      {
        available: () => Promise.resolve(true),
        list: () => Promise.resolve([ROW]),
        subscribe: stream.subscribe,
      },
      'p1',
      onState,
    );
    stop();
    await settled();
    expect(onState).not.toHaveBeenCalled();
    expect(stream.subscribe).not.toHaveBeenCalled();
  });

  it('unsubscribes the stream it opened when the caller stops', async () => {
    const stream = fakeStream();
    const { stop } = watchShelf(
      {
        available: () => Promise.resolve(true),
        list: () => Promise.resolve([ROW]),
        subscribe: stream.subscribe,
      },
      'p1',
      vi.fn(),
    );
    await settled();
    stop();
    expect(stream.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('re-reads on a caller’s refresh, which no broadcast would have caused', async () => {
    // **The hole this exists to fill.** `saved-plan.controller.ts` publishes
    // nothing — not on save, not on rename, not on delete — so the broadcast
    // this watch listens to is the *plan's*, and a user's own checkpoint is the
    // one change that never reaches it. The assertion is on `list` being asked
    // a second time with no broadcast fired at all: a build whose refresh did
    // nothing would still pass every other case in this file, because every
    // other case gets its second read from the stream.
    const stream = fakeStream();
    const list = vi.fn(() => Promise.resolve([ROW]));
    const watch = watchShelf(
      { available: () => Promise.resolve(true), list, subscribe: stream.subscribe },
      'p1',
      vi.fn(),
    );
    await settled();
    expect(list).toHaveBeenCalledTimes(1);

    watch.refresh();
    await settled();
    expect(list).toHaveBeenCalledTimes(2);
    // And it re-used the subscription rather than opening a second one: the
    // `stream ??=` in `read` is what makes a refresh cheap.
    expect(stream.subscribe).toHaveBeenCalledTimes(1);
  });

  it('asks nothing at all when a stopped watch is refreshed', async () => {
    // A `refresh` handed to a component outlives that component by as long as
    // its last save takes, so this is the ordinary path and not a rare one. The
    // state guards in `read` already make it unobservable; what they do not do
    // is stop the two requests. Negative: drop the `if (!stopped)` and this
    // reddens on `available`, with the probe and the list both asked on behalf
    // of a reader who has gone.
    const stream = fakeStream();
    const available = vi.fn(() => Promise.resolve(true));
    const list = vi.fn(() => Promise.resolve([ROW]));
    const watch = watchShelf({ available, list, subscribe: stream.subscribe }, 'p1', vi.fn());
    await settled();
    watch.stop();

    watch.refresh();
    await settled();
    expect(available).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('does not let a slow read overwrite the answer to a newer question', async () => {
    // Two broadcasts in quick succession leave two reads in flight, and whichever
    // resolves LAST wins unless the older one is dropped. That is roughly a coin
    // flip in the wild, and losing it shows the reader a list from before the
    // change that prompted the refresh — AC #4's "collaboration updates do not
    // replace the user's active comparison unexpectedly", one surface down.
    // Negative: drop `mine !== generation` from the guard and this reddens with
    // the stale rows as the last emission.
    //
    // Reachable only from the second read onwards, which is why the first one is
    // released first: reads after the first start from the subscription, and the
    // subscription does not exist until a read has resolved.
    const stream = fakeStream();
    const onState = vi.fn();
    const stale: SavedPlanListEntryView = { ...ROW, id: 'stale', name: 'before the refresh' };
    const pending: ((rows: SavedPlanListEntryView[]) => void)[] = [];
    const release = (rows: SavedPlanListEntryView[]) => {
      const next = pending.shift();
      if (!next) throw new Error('no read was in flight');
      next(rows);
    };
    const list = vi.fn(
      () => new Promise<SavedPlanListEntryView[]>((resolve) => pending.push(resolve)),
    );
    watchShelf(
      { available: () => Promise.resolve(true), list, subscribe: stream.subscribe },
      'p1',
      onState,
    );
    await settled();
    release([ROW]);
    await settled();

    stream.broadcast();
    await settled();
    stream.broadcast();
    await settled();
    expect(pending).toHaveLength(2);

    // The newer question is answered first, the older one second.
    const newer = pending.pop();
    if (!newer) throw new Error('the second refresh never asked');
    newer([ROW]);
    await settled();
    release([stale]);
    await settled();

    expect(onState).toHaveBeenLastCalledWith({ kind: 'ready', rows: [ROW] });
  });
});

describe('the shelf as React state', () => {
  afterEach(() => {
    cleanup();
  });

  /** Resolves once everything already queued as a microtask has run. */
  const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

  /**
   * One project's fake wiring, plus the handle to fire its broadcast.
   *
   * Returned as a stable object because the hook has `deps` in its dependency
   * array: a fresh literal per render is exactly the re-subscribe loop the
   * hook's JSDoc says a caller must not write, and building one here would test
   * the mistake rather than the hook.
   */
  const fakeDeps = (rows: readonly SavedPlanListEntryView[] = [ROW]) => {
    let fire: (() => void) | undefined;
    // Stops delivering, which `subscribeToProject`'s own `unsubscribe` really
    // does. `watchShelf`'s `stopped` flag suppresses the *state*, not the
    // request — a fake that kept firing after being unsubscribed would report a
    // second read that no real stream can produce, and this file measured
    // exactly that on its first gate run.
    const unsubscribe = vi.fn(() => {
      fire = undefined;
    });
    const list = vi.fn(() => Promise.resolve([...rows]));
    const deps: ShelfWatchDeps = {
      available: () => Promise.resolve(true),
      list,
      subscribe: (_projectId, onChange) => {
        fire = onChange;
        return { unsubscribe };
      },
    };
    return { deps, list, unsubscribe, broadcast: () => fire?.() };
  };

  itDom('starts on loading and holds the rows the read answered', async () => {
    const wiring = fakeDeps();
    const held = renderHook(() => useSavedPlanShelf(wiring.deps, 'p1'));

    // Before the first read resolves. `loading` and not an empty `ready`: "no
    // plans saved yet" is a claim about the project, and this component has not
    // yet been told anything about the project.
    expect(held.result.current.state).toEqual({ kind: 'loading' });

    await flush();
    expect(held.result.current.state).toEqual({ kind: 'ready', rows: [ROW] });
  });

  itDom('stops watching when the component unmounts', async () => {
    // **The case only a renderer can make.** `watchShelf` already proves the
    // stop it hands back silences an in-flight read; what nothing else proves
    // is that the effect's cleanup *calls* it. Negative: drop the
    // `watch.stop()` from the returned cleanup and this reddens — the
    // subscription outlives the component and every later broadcast writes
    // state into something nobody is rendering.
    //
    // Asserted on `unsubscribe` and on the silence after it, never on
    // `held.result.current`: React freezes an unmounted hook's last value, so a
    // post-unmount `setState` is a leak the result object cannot see.
    const wiring = fakeDeps();
    const held = renderHook(() => useSavedPlanShelf(wiring.deps, 'p1'));
    await flush();
    expect(wiring.unsubscribe).not.toHaveBeenCalled();

    held.unmount();
    expect(wiring.unsubscribe).toHaveBeenCalledTimes(1);

    wiring.broadcast();
    await flush();
    expect(wiring.list).toHaveBeenCalledTimes(1);
  });

  itDom('hands back one refresh identity that always drives the live watch', async () => {
    // Two facts in one case because they are one design decision. The identity
    // is stable so that a `save` callback taking `refresh` as a dependency does
    // not re-create itself on every project change; the ref is what keeps that
    // stable function pointed at the *current* watch, so a refresh after a
    // project change re-reads p2 and not the closed-over p1.
    //
    // Negative: return `watch.refresh` from the hook directly instead of the
    // `useCallback` and the identity assertion reddens; drop the
    // `live.current = watch.refresh` and the second project's `list` is never
    // asked a second time.
    const first = fakeDeps([ROW]);
    const other: SavedPlanListEntryView = { ...ROW, id: 'sp2', name: 'after the re-plan' };
    const second = fakeDeps([other]);
    const held = renderHook(({ deps, id }) => useSavedPlanShelf(deps, id), {
      initialProps: { deps: first.deps, id: 'p1' },
    });
    await flush();
    const refresh = held.result.current.refresh;

    held.rerender({ deps: second.deps, id: 'p2' });
    await flush();
    expect(held.result.current.refresh).toBe(refresh);
    expect(second.list).toHaveBeenCalledTimes(1);

    act(() => {
      refresh();
    });
    await flush();
    expect(second.list).toHaveBeenCalledTimes(2);
    // The watch p1 left behind is not driven by it: that one was stopped.
    expect(first.list).toHaveBeenCalledTimes(1);
  });

  itDom('goes back to loading rather than showing the last project’s rows', async () => {
    // AC #4, read side. The first read of `p2` resolves a request later, and
    // leaving `p1`'s rows up until then states — with a name, an author and a
    // timestamp — that they were saved in a project they were never in.
    // Negative: drop the `setState({ kind: 'loading' })` from the effect and
    // this reddens on the middle assertion with `p1`'s rows still current.
    const other: SavedPlanListEntryView = { ...ROW, id: 'sp2', name: 'after the re-plan' };
    const first = fakeDeps([ROW]);
    const second = fakeDeps([other]);
    const held = renderHook(({ deps, id }) => useSavedPlanShelf(deps, id), {
      initialProps: { deps: first.deps, id: 'p1' },
    });
    await flush();
    expect(held.result.current.state).toEqual({ kind: 'ready', rows: [ROW] });

    held.rerender({ deps: second.deps, id: 'p2' });
    expect(held.result.current.state).toEqual({ kind: 'loading' });
    // And the first project's socket is closed rather than left open behind it.
    expect(first.unsubscribe).toHaveBeenCalledTimes(1);

    await flush();
    expect(held.result.current.state).toEqual({ kind: 'ready', rows: [other] });
  });
});
