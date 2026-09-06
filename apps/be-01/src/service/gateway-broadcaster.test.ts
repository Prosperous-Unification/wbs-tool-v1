import { describe, expect, it } from 'bun:test';

import { inMemoryEventLog } from '../testing/replay-fixture';
import { type ProjectEvent, subscriptionFor } from './broadcast';
import { clockOf } from './clock';
import { GatewayBroadcaster } from './gateway-broadcaster';
import { type PushClient, PushFailed } from './push-client';
import { ReplayBuffer } from './replay-buffer';
import { ReplayOrchestrator } from './replay-orchestrator';
import { WriteLock } from './write-lock';

const EVENT: ProjectEvent = { type: 'tree_replaced', workItems: [] };

/** A push client that records what it was handed, or refuses everything. */
function fakePush(mode: 'accepts' | 'refuses' = 'accepts') {
  const pushed: { subscription: string; seq: number }[] = [];
  const client = {
    push(payload: { subscription: string; seq: number }) {
      if (mode === 'refuses') return Promise.reject(new PushFailed('gateway down'));
      pushed.push({ subscription: payload.subscription, seq: payload.seq });
      return Promise.resolve({ delivered: 1 });
    },
  } as unknown as PushClient;
  return { pushed, client };
}

function bootstrap(mode: 'accepts' | 'refuses' = 'accepts') {
  const log = inMemoryEventLog();
  const buffer = new ReplayBuffer({ maxPerSubscription: 100, maxAgeMs: 5 * 60_000 });
  const { pushed, client } = fakePush(mode);
  const failures: string[] = [];
  const broadcaster = new GatewayBroadcaster({
    eventLog: log,
    clock: clockOf({ now: () => 1_000 }),
    buffer,
    lock: new WriteLock(),
    push: client,
    onPushFailed: (_err, subscription) => failures.push(subscription),
  });
  return { broadcaster, log, buffer, pushed, failures };
}

describe('GatewayBroadcaster', () => {
  it('records the event and pushes it under the project subscription', async () => {
    const { broadcaster, log, pushed } = bootstrap();

    await broadcaster.publish('p-1', EVENT);

    expect(await log.latestSeq('project:p-1')).toBe(0);
    expect(pushed).toEqual([{ subscription: 'project:p-1', seq: 0 }]);
  });

  it('pushes an already-recorded event without recording it a second time', async () => {
    const { broadcaster, log, buffer, pushed } = bootstrap();
    const subscription = subscriptionFor('p-1');
    const recorded = await log.recordEvent(subscription, EVENT, 1_000);

    await broadcaster.pushRecorded(subscription, recorded, EVENT);

    expect(await log.latestSeq(subscription)).toBe(0);
    expect(buffer.oldestSeq(subscription)).toBe(0);
    expect(pushed).toEqual([{ subscription, seq: 0 }]);
  });

  it('keeps the event when the gateway refuses it', async () => {
    // The mutation already committed. Failing here would tell the caller their
    // edit did not happen, and the client that reconnects still gets it.
    const { broadcaster, log, failures } = bootstrap('refuses');

    await broadcaster.publish('p-1', EVENT);

    expect(failures).toEqual(['project:p-1']);
    expect(await log.latestSeq('project:p-1')).toBe(0);
  });

  it('reports the project’s latest sequence', async () => {
    const { broadcaster } = bootstrap();
    await broadcaster.publish('p-1', EVENT);
    await broadcaster.publish('p-1', EVENT);
    await broadcaster.publish('p-2', EVENT);

    expect(await broadcaster.latestSeq('p-1')).toBe(1);
    expect(await broadcaster.latestSeq('p-2')).toBe(0);
    expect(await broadcaster.latestSeq('p-never-edited')).toBe(-1);
  });

  it('fills the buffer the orchestrator replays from', async () => {
    // Proof: `this.opts.buffer.record(...)` deleted from `publish` and only this
    // test failed — with an empty buffer the orchestrator falls through to the
    // log, which answers identically, so nothing else could observe the loss.
    const { broadcaster, buffer, log } = bootstrap();
    await broadcaster.publish('p-1', EVENT);
    await broadcaster.publish('p-1', EVENT);

    expect(buffer.oldestSeq('project:p-1')).toBe(0);

    const bufferOnly = new ReplayOrchestrator({
      log: {
        ...log,
        rangeSince: () => Promise.reject(new Error('the log must not be consulted here')),
      },
      buffer,
    });
    expect(await bufferOnly.replay({ 'project:p-1': 0 })).toEqual({
      'project:p-1': { status: 'replaying', events: [{ seq: 1, message: EVENT }] },
    });
  });
});
