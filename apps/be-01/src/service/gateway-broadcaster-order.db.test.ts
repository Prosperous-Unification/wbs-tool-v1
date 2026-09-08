import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { systemTimers } from '@wbs/runtime-portable';
import { expect, it } from 'bun:test';

import { openDrizzle } from '../repository/db';
import { DrizzleEventLogStore } from '../repository/event-log';
import { OPEN } from '../repository/gate';
import { runMigrations } from '../repository/migrate';
import { GatewayBroadcaster } from './gateway-broadcaster';
import { PushClient } from './push-client';
import { ReplayBuffer } from './replay-buffer';

/** A transport barrier exposes the production publisher's record/push ordering. */
it('allows C to overtake recorded B while its push is held', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'wbs-broadcast-order-'));
  const path = join(folder, 'test.db');
  runMigrations(path, join(import.meta.dir, '..', '..', 'drizzle'));
  const eventLog = new DrizzleEventLogStore(openDrizzle(path), OPEN);
  let releaseB!: () => void;
  let startedB!: () => void;
  const heldB = new Promise<void>((resolve) => {
    releaseB = resolve;
  });
  const pushingB = new Promise<void>((resolve) => {
    startedB = resolve;
  });
  const delivered: { seq: number; message: { type: string } }[] = [];
  const broadcaster = new GatewayBroadcaster({
    eventLog,
    buffer: new ReplayBuffer({ maxPerSubscription: 100, maxAgeMs: 60_000 }),
    push: new PushClient({
      gwUrl: 'http://transport.test',
      secret: 'fixture',
      maxRetries: 0,
      timers: systemTimers,
      attemptMs: 5_000,
      overallMs: 15_000,
      fetchImpl: async (_url, init) => {
        if (typeof init?.body !== 'string') throw new Error('push body must be serialized JSON');
        const frame = JSON.parse(init.body) as { seq: number; message: { type: string } };
        if (frame.seq === 0) {
          startedB();
          await heldB;
        }
        delivered.push(frame);
        return Response.json({ delivered_to_sockets: 1 });
      },
    }),
  });
  const publishedB = broadcaster.publish('p1', { type: 'calendar_markers_changed' });
  try {
    await pushingB;
    expect(await eventLog.latestSeq('project:p1')).toBe(0);
    await broadcaster.publish('p1', { type: 'tree_replaced', workItems: [] });
    expect(delivered.map((frame) => frame.seq)).toEqual([1]);
    expect((await eventLog.rangeSince('project:p1', -1)).map((event) => event.seq)).toEqual([0, 1]);
    expect(delivered[0]?.message.type).toBe('tree_replaced');
  } finally {
    releaseB();
    await publishedB;
    rmSync(folder, { recursive: true, force: true });
  }
  expect(delivered.map((frame) => frame.seq)).toEqual([1, 0]);
});
