import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { systemTimers } from '@wbs/runtime-portable';
import { DeadlineClock } from '@wbs/runtime-portable/testing';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { drizzleOuterTransaction, openDrizzle } from '../repository/db';
import { DrizzleEventLogRepo } from '../repository/event-log';
import { WriteCoordinator } from '../repository/gate';
import { runMigrations } from '../repository/migrate';
import { subscriptionFor } from './broadcast';
import { GatewayBroadcaster } from './gateway-broadcaster';
import { PushClient } from './push-client';
import { ReplayBuffer } from './replay-buffer';

const FOLDER = join(import.meta.dir, '..', '..', 'drizzle');

/**
 * The event log survives an unrelated batch's rollback.
 *
 * Sol's Critical on PR 204, verified against the code before it was written
 * down. `services.ts` builds the event log on the one shared `Drizzle` handle,
 * which is the handle `PlanCommandRunner` holds its outer transaction open on
 * (ADR 0007). A publisher that is not part of the batch — a saved-plan save, a
 * step add, `DeferringBroadcaster.send` draining a *previous* batch's queue —
 * used to write its `recordEvent` row as a savepoint inside whatever
 * transaction happened to be open. The rollback then erased the durable row and
 * the sequencer advance **after** the live push had already left the process: a
 * connected collaborator saw the change, a reconnecting one replayed nothing,
 * and the sequencer could hand the number out twice.
 *
 * On a real database, with the real lock and the real outer transaction,
 * because the whole defect is a property of the connection those three share.
 * `recordingBroadcaster` has no transaction at all, so no fixture can see this.
 */
describe('the durable record of a project event', () => {
  const dirs: string[] = [];
  let db: ReturnType<typeof openDrizzle>;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'wbs-broadcast-durability-'));
    dirs.push(dir);
    const path = join(dir, 'test.db');
    runMigrations(path, FOLDER);
    db = openDrizzle(path);
  });

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function bootstrap(): {
    broadcaster: GatewayBroadcaster;
    eventLog: DrizzleEventLogRepo;
    lock: WriteCoordinator;
    buffer: ReplayBuffer;
  } {
    const buffer = new ReplayBuffer({ maxPerSubscription: 100, maxAgeMs: 60_000 });
    const lock = new WriteCoordinator();
    // Over the coordinator, which is where the durable record's turn is taken
    // now: the broadcaster used to wrap this call in `lock.run` itself, and the
    // store taking its own turn is the same exclusion said once.
    const eventLog = new DrizzleEventLogRepo(db, lock);
    return {
      eventLog,
      lock,
      buffer,
      broadcaster: new GatewayBroadcaster({
        eventLog,
        buffer,
        // A push that answers immediately, so what these two cases measure is
        // what survived in the log and never a delivery that timed out. The
        // real `PushClient` against an unroutable host would sit in its
        // 500ms→30s backoff for about a minute per event.
        push: { push: () => Promise.resolve({ delivered: 1 }) } as unknown as PushClient,
        onPushFailed: () => undefined,
      }),
    };
  }

  /**
   * A batch that takes the lock, opens the transaction, waits, and refuses.
   *
   * `PlanCommandRunner.execute` in miniature, and deliberately not the runner
   * itself: what has to be reproduced is the *window* — the transaction open
   * across an await — and driving the real runner to a refusal at a controlled
   * instant would need a fake command service whose only job is to hold this
   * same barrier.
   */
  function openBatch(
    lock: WriteCoordinator,
    outcome: 'commits' | 'refuses',
  ): { done: Promise<void>; open: Promise<void>; settle: () => void } {
    let letGo!: () => void;
    let announceOpen!: () => void;
    const held = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    // `WriteCoordinator.enter` schedules its callback on a microtask rather than running
    // it inline, so a caller that merely called `enter` has not opened anything
    // yet. Awaiting this is what puts the publish inside the window instead of
    // in front of it — without it the mutation below stays green, because
    // `DrizzleEventLogRepo.recordEvent` runs its statement synchronously and
    // wins the race.
    const open = new Promise<void>((resolve) => {
      announceOpen = resolve;
    });
    const transactions = drizzleOuterTransaction(db);
    const done = lock.enter(async () => {
      transactions.begin();
      announceOpen();
      await held;
      if (outcome === 'commits') transactions.commit();
      else transactions.rollback();
    });
    return { done, open, settle: letGo };
  }

  it('survives an unrelated batch refusing while the publish is in flight', async () => {
    const { broadcaster, eventLog, lock, buffer } = bootstrap();
    const projectId = 'p-1';
    const subscription = subscriptionFor(projectId);
    expect(await eventLog.latestSeq(subscription)).toBe(-1);

    const batch = openBatch(lock, 'refuses');
    await batch.open;
    // Issued while the batch's transaction is open — the window the defect
    // lived in. It queues behind the lock rather than recording into it.
    const published = broadcaster.publish(projectId, { type: 'saved_plans_changed' });
    batch.settle();
    await batch.done;
    await published;

    // The publish is the only writer here, so its event is seq 0 and the
    // rollback took nothing with it.
    const replayed = await eventLog.rangeSince(subscription, -1);
    expect(replayed.map((each) => each.message)).toEqual([{ type: 'saved_plans_changed' }]);
    expect(await eventLog.latestSeq(subscription)).toBe(0);
    // And the in-memory replay path agrees with the durable one, rather than
    // holding a sequence the log no longer knows about.
    expect(buffer.since(subscription, -1).map((each) => each.message)).toEqual([
      { type: 'saved_plans_changed' },
    ]);
  });

  it('records after the batch commits too, so the two orders agree', async () => {
    const { broadcaster, eventLog, lock } = bootstrap();
    const projectId = 'p-2';
    const subscription = subscriptionFor(projectId);

    const batch = openBatch(lock, 'commits');
    await batch.open;
    const published = broadcaster.publish(projectId, { type: 'saved_plans_changed' });

    // The assertion that gives this case teeth, and it has to come first.
    // Gemini's Important on this head: a commit keeps the savepoint, so the
    // *outcome* is `0` whether the publish waited or recorded inside the open
    // transaction, and the case passed with the lock deleted. What separates
    // the two is only observable while the batch is still open.
    expect(await eventLog.latestSeq(subscription)).toBe(-1);

    batch.settle();
    await batch.done;
    await published;

    expect(await eventLog.latestSeq(subscription)).toBe(0);
  });

  it('does not hold the write lock across the push', async () => {
    // The half of `PlanCommandRunner`'s rule this change could have broken:
    // under the lock the record, outside it the push. The fake push never
    // settles until this test lets it, standing in for the ~1 minute
    // `PushClient`'s six retries can take against a gateway that is down.
    let deliver!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    const lock = new WriteCoordinator();
    const eventLog = new DrizzleEventLogRepo(db, lock);
    const broadcaster = new GatewayBroadcaster({
      eventLog,
      buffer: new ReplayBuffer({ maxPerSubscription: 100, maxAgeMs: 60_000 }),
      push: {
        push: () => inFlight.then(() => ({ delivered: 1 })),
      } as unknown as PushClient,
    });

    const published = broadcaster.publish('p-3', { type: 'saved_plans_changed' });
    // A later holder starts while that push is still open. If the turn covered
    // the delivery this would deadlock and the test would time out rather than
    // fail.
    let ran = false;
    await lock.enter(() => {
      ran = true;
      return Promise.resolve();
    });
    expect(ran).toBe(true);
    // And the row was already durable before the push was let go, which is the
    // ordering the replay path depends on.
    expect(await eventLog.latestSeq(subscriptionFor('p-3'))).toBe(0);

    deliver();
    await published;
  });
  it('retains a durable edit and releases the lock when real push expires', async () => {
    const timers = new DeadlineClock();
    const lock = new WriteCoordinator();
    const eventLog = new DrizzleEventLogRepo(db, lock);
    const buffer = new ReplayBuffer({ maxPerSubscription: 100, maxAgeMs: 60000 });
    const failures: unknown[] = [];
    let aborted = false;
    const push = new PushClient({
      ...{ timers: systemTimers, fetchImpl: globalThis.fetch, attemptMs: 5000, overallMs: 15000 },
      gwUrl: 'http://gw',
      secret: 's',
      timers,
      attemptMs: 1000,
      overallMs: 250,
      maxRetries: 0,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('transport aborted'));
            },
            { once: true },
          );
        }),
    });
    const broadcaster = new GatewayBroadcaster({
      eventLog,
      buffer,
      push,
      onPushFailed: (error) => {
        failures.push(error);
      },
    });
    let settled = false;
    const published = broadcaster
      .publish('deadline-project', { type: 'saved_plans_changed' })
      .then(() => {
        settled = true;
      });
    await timers.flush();
    let entered = false;
    const second = lock.enter(() => {
      entered = true;
      return Promise.resolve();
    });
    await timers.flush();
    expect(entered).toBe(true);
    expect(settled).toBe(false);
    expect(await eventLog.latestSeq(subscriptionFor('deadline-project'))).toBe(0);
    await timers.advance(250);
    expect(aborted).toBe(true);
    expect(settled).toBe(true);
    await published;
    await second;
    expect(failures).toHaveLength(1);
    expect(
      (await eventLog.rangeSince(subscriptionFor('deadline-project'), -1)).map(
        (event) => event.message,
      ),
    ).toEqual([{ type: 'saved_plans_changed' }]);
    expect(buffer.since(subscriptionFor('deadline-project'), -1)).toHaveLength(1);
  });
});
