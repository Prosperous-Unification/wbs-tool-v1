import { describe, expect, it, vi } from 'vitest';

import type { SavedPlanListEntryView } from './saved-plan-api';
import { readShelf, watchShelf } from './saved-plan-shelf';

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
    const stop = watchShelf(
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
    const stop = watchShelf(
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
