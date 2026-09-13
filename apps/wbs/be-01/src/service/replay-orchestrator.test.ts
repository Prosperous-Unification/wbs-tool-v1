import { makeTestDb } from '@wbs/validation/fixtures';
import type { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';

import { DrizzleEventLogStore } from '../repository/event-log';
import { OPEN } from '../repository/gate';
import { ReplayBuffer } from './replay-buffer';
import { ReplayOrchestrator } from './replay-orchestrator';

const BOOT_SQL = `
  CREATE TABLE event_sequencer (subscription TEXT PRIMARY KEY, next_seq INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription TEXT NOT NULL,
    seq INTEGER NOT NULL,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX event_log_sub_seq ON event_log(subscription, seq);
`;

const open: Database[] = [];

afterEach(() => {
  for (const client of open.splice(0)) client.close();
});

/**
 * A log, a buffer, and a way to record into both — the same pairing
 * `GatewayBroadcaster` makes at runtime.
 */
async function bootstrap(options: { maxEvents?: number; bufferSize?: number } = {}) {
  const db = await makeTestDb({ migrationsFolder: null });
  const client = (db as unknown as { $client: Database }).$client;
  client.run(BOOT_SQL);
  open.push(client);

  const log = new DrizzleEventLogStore(db, OPEN);
  const buffer = new ReplayBuffer({
    maxPerSubscription: options.bufferSize ?? 100,
    maxAgeMs: 5 * 60_000,
    now: () => 1_000,
  });
  const orchestrator = new ReplayOrchestrator({ log, buffer, maxEvents: options.maxEvents });

  async function record(subscription: string, message: unknown): Promise<number> {
    const recorded = await log.recordEvent(subscription, message, 1_000);
    buffer.record(subscription, recorded.seq, message);
    return recorded.seq;
  }

  /** Records straight to the log, leaving the buffer without the event. */
  async function recordUnbuffered(subscription: string, message: unknown): Promise<number> {
    return (await log.recordEvent(subscription, message, 1_000)).seq;
  }

  return { orchestrator, record, recordUnbuffered, log, buffer };
}

describe('ReplayOrchestrator', () => {
  it('replays the events after the requested sequence, in order', async () => {
    const { orchestrator, record } = await bootstrap();
    await record('project:a', { n: 0 });
    await record('project:a', { n: 1 });
    await record('project:a', { n: 2 });

    const outcome = await orchestrator.replay({ 'project:a': 0 });

    expect(outcome['project:a']).toEqual({
      status: 'replaying',
      events: [
        { seq: 1, message: { n: 1 } },
        { seq: 2, message: { n: 2 } },
      ],
    });
  });

  it('replays nothing for a client that is already current', async () => {
    const { orchestrator, record } = await bootstrap();
    await record('project:a', { n: 0 });

    expect(await orchestrator.replay({ 'project:a': 0 })).toEqual({
      'project:a': { status: 'replaying', events: [] },
    });
  });

  it('replays nothing for a subscription that has never recorded an event', async () => {
    const { orchestrator } = await bootstrap();

    expect(await orchestrator.replay({ 'project:untouched': -1 })).toEqual({
      'project:untouched': { status: 'replaying', events: [] },
    });
  });

  it('falls back to the log when the buffer starts after the requested point', async () => {
    const { orchestrator, recordUnbuffered, record, buffer } = await bootstrap();
    await recordUnbuffered('project:a', { n: 0 });
    await recordUnbuffered('project:a', { n: 1 });
    await record('project:a', { n: 2 });

    // The buffer holds only the last event, so it cannot start at seq 1.
    expect(buffer.oldestSeq('project:a')).toBe(2);

    expect(await orchestrator.replay({ 'project:a': 0 })).toEqual({
      'project:a': {
        status: 'replaying',
        events: [
          { seq: 1, message: { n: 1 } },
          { seq: 2, message: { n: 2 } },
        ],
      },
    });
  });

  it('denies a range retention has already removed', async () => {
    const { orchestrator, log, recordUnbuffered } = await bootstrap();
    await recordUnbuffered('project:a', { n: 0 });
    await recordUnbuffered('project:a', { n: 1 });
    await recordUnbuffered('project:a', { n: 2 });
    await log.pruneBeyond(1);

    expect(await orchestrator.replay({ 'project:a': 0 })).toEqual({
      'project:a': { status: 'denied', reason: 'out_of_range' },
    });
  });

  it('denies a range larger than the cap rather than truncating it', async () => {
    const { orchestrator, record } = await bootstrap({ maxEvents: 3 });
    for (let n = 0; n < 5; n++) await record('project:a', { n });

    expect(await orchestrator.replay({ 'project:a': 0 })).toEqual({
      'project:a': { status: 'denied', reason: 'out_of_range' },
    });
  });

  it('replays a range exactly at the cap', async () => {
    const { orchestrator, record } = await bootstrap({ maxEvents: 3 });
    for (let n = 0; n < 4; n++) await record('project:a', { n });

    const outcome = await orchestrator.replay({ 'project:a': 0 });
    expect(outcome['project:a']).toMatchObject({ status: 'replaying' });
    expect((outcome['project:a'] as { events: unknown[] }).events).toHaveLength(3);
  });

  it('denies a client claiming a sequence the stream has never reached', async () => {
    const { orchestrator, record } = await bootstrap();
    await record('project:a', { n: 0 });

    // A restored database, or a client talking to the wrong deployment. Either
    // way it is behind something this server cannot produce, so it must refetch.
    expect(await orchestrator.replay({ 'project:a': 7 })).toEqual({
      'project:a': { status: 'denied', reason: 'out_of_range' },
    });
  });

  it('answers each subscription independently', async () => {
    const { orchestrator, record, recordUnbuffered, log } = await bootstrap();
    await record('project:fresh', { n: 0 });
    await recordUnbuffered('project:pruned', { n: 0 });
    await recordUnbuffered('project:pruned', { n: 1 });
    await log.pruneBeyond(1);

    expect(await orchestrator.replay({ 'project:fresh': -1, 'project:pruned': -1 })).toEqual({
      'project:fresh': { status: 'replaying', events: [{ seq: 0, message: { n: 0 } }] },
      'project:pruned': { status: 'denied', reason: 'out_of_range' },
    });
  });

  it('replays from the start when the client has seen nothing', async () => {
    const { orchestrator, record } = await bootstrap();
    await record('project:a', { n: 0 });
    await record('project:a', { n: 1 });

    const outcome = await orchestrator.replay({ 'project:a': -1 });
    expect(
      (outcome['project:a'] as { events: { seq: number }[] }).events.map((e) => e.seq),
    ).toEqual([0, 1]);
  });
});

describe('ReplayOrchestrator — cross-review findings', () => {
  it('serves from the log when the buffer has aged out of the range', async () => {
    // agy, critical. `covers` asked `oldestSeq`, which did not evict, so a
    // buffer holding only expired entries answered "I have your range" — and
    // `since`, which does evict, then returned nothing. The client was refused
    // a replay the event log could have served in full.
    const db = await makeTestDb({ migrationsFolder: null });
    const client = (db as unknown as { $client: Database }).$client;
    client.run(BOOT_SQL);
    open.push(client);

    let now = 1_000;
    const log = new DrizzleEventLogStore(db, OPEN);
    const buffer = new ReplayBuffer({
      maxPerSubscription: 100,
      maxAgeMs: 60_000,
      now: () => now,
    });
    const orchestrator = new ReplayOrchestrator({ log, buffer });

    for (const n of [0, 1]) {
      const recorded = await log.recordEvent('project:a', { n }, now);
      buffer.record('project:a', recorded.seq, { n });
    }

    // Six minutes of nobody editing this project.
    now += 6 * 60_000;

    expect(await orchestrator.replay({ 'project:a': 0 })).toEqual({
      'project:a': { status: 'replaying', events: [{ seq: 1, message: { n: 1 } }] },
    });
  });
});
