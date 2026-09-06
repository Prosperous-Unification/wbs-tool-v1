import type { EventLogRepo, RecordedEvent } from '../repository/event-log';
import { type Broadcaster, type ProjectEvent, subscriptionFor } from './broadcast';
import { type Clock, clockOf } from './clock';
import type { PushClient } from './push-client';
import type { ReplayBuffer } from './replay-buffer';
import type { WriteLock } from './write-lock';

export interface GatewayBroadcasterOptions {
  /**
   * The durable log, written straight rather than through a wrapper.
   *
   * `EventSequencer` stood here until 2026-09-02 and did nothing but pass the
   * two calls through, reading a clock on the way — which is what a
   * {@link Clock} is for. The sequence numbers were always the log's own, out of
   * `event_sequencer` in one statement (see `DrizzleEventLogRepo.recordEvent`);
   * nothing about them was ever this layer's.
   */
  eventLog: EventLogRepo;
  /** The instant each event is recorded at — see {@link Clock}. */
  clock?: Clock;
  push: PushClient;
  /**
   * The same buffer the replay orchestrator reads. Required: a broadcaster that
   * did not fill it would leave every resume falling through to a database
   * query, and the buffer would look healthy while being permanently empty.
   */
  buffer: ReplayBuffer;
  /**
   * The process's one {@link WriteLock} — **the same object** `buildApp` gets as
   * `writes.lock`, not a second one.
   *
   * It is here for durability, not for mutual exclusion of the log. `eventLog`
   * is built on the one shared `Drizzle` handle, which is also the handle a
   * command batch holds its outer transaction open on (ADR 0007), so a
   * `recordEvent` issued while that transaction is open becomes a savepoint
   * inside it and the batch's rollback erases it — after the live push has
   * already left the process. A connected collaborator then sees a change that a
   * reconnecting one is never replayed, and the sequencer can reissue the number.
   *
   * `PlanCommandRunner` opens and closes that transaction strictly inside
   * `lock.run` (`execute` and `walk` are its only two openers), so taking a turn
   * on the lock is exactly "no outer transaction is open". Nothing else in the
   * tree takes it.
   *
   * Only the durable half runs under it — see {@link GatewayBroadcaster.publish}.
   */
  lock: WriteLock;
  /** Called when the gateway could not be reached; the write itself already committed. */
  onPushFailed?: (err: unknown, subscription: string) => void;
}

/**
 * Records each project event in the durable log, then pushes it to gw-01.
 *
 * The order matters and is not interchangeable. Recording first means a client
 * that reconnects can replay what it missed even if the push never landed; the
 * log is the record and the push is only the fast path. So a failed push is
 * logged and swallowed rather than thrown: the mutation it describes is already
 * committed, and turning a delivery problem into a failed API call would tell
 * the caller their edit did not happen when it did.
 */
export class GatewayBroadcaster implements Broadcaster {
  private readonly clock: Clock;

  constructor(private readonly opts: GatewayBroadcasterOptions) {
    this.clock = opts.clock ?? clockOf();
  }

  /**
   * The lock this broadcaster records under, read back off the constructed
   * object.
   *
   * It exists so the *composition* can be asserted rather than the intention:
   * {@link GatewayBroadcasterOptions.lock} says "the same object `buildApp` gets
   * as `writes.lock`", and until this getter existed nothing could observe
   * whether `boot.ts` had actually passed one object to both. A second lock
   * excludes nothing and every existing test stayed green through it, because
   * each one builds its own pair — the gap Sol's Important named on PR 204.
   * `boot.db.test.ts` › `holds a command batch out while the broadcaster lock
   * is taken` takes a turn on this lock and watches a real HTTP batch wait for
   * it.
   */
  get lock(): WriteLock {
    return this.opts.lock;
  }

  latestSeq(projectId: string): Promise<number> {
    return this.opts.eventLog.latestSeq(subscriptionFor(projectId));
  }

  /**
   * Record durably and buffer, then push — the durable half under the
   * {@link GatewayBroadcasterOptions.lock write lock}, the push outside it.
   *
   * The split is the whole point and the two halves are not interchangeable.
   * **Under** the lock, because the log shares its connection with a batch's
   * outer transaction and a record made inside one is a savepoint the batch's
   * rollback takes with it. **Outside** it, because a push is a network call
   * that PushClient bounds with attempt and overall deadlines. A lock held
   * across even that bounded delivery stalls every write in
   * the process. `PlanCommandRunner` states the second half of that rule for
   * itself and `plan-commands.db.test.ts` › `lets go of the write lock before the
   * broadcast leaves` holds it; this method is where the first half lives.
   *
   * It cannot deadlock, and that is checked rather than assumed: no publisher
   * reaches here with the lock already held. A batch's announcements are queued
   * by `DeferringBroadcaster` and drained by `send` after `execute` has let go;
   * `WorkItemService.announceTree` diverts into its collector while collecting
   * and `announceTreeNow` runs after `walk` returns; every other publisher is an
   * HTTP route that never takes the lock at all.
   */
  async publish(projectId: string, event: ProjectEvent): Promise<void> {
    const subscription = subscriptionFor(projectId);
    const recorded = await this.opts.lock.run(async () => {
      const recorded = await this.opts.eventLog.recordEvent(subscription, event, this.clock.now());
      return recorded;
    });
    // Proof: moving push into the lock made the real-client durability case
    // observe entered=false for its second writer while transport was pending.
    await this.pushRecorded(subscription, recorded, event);
  }

  /** Buffer and push an event whose durable row already committed. */
  async pushRecorded(
    subscription: string,
    recorded: RecordedEvent,
    event: ProjectEvent,
  ): Promise<void> {
    if (recorded.subscription !== subscription) {
      throw new Error(
        `recorded subscription ${recorded.subscription} does not match push ${subscription}`,
      );
    }
    this.opts.buffer.record(subscription, recorded.seq, event);
    try {
      await this.opts.push.push({ subscription, seq: recorded.seq, message: event });
    } catch (err) {
      // Proof: rethrowing here made the same deadline durability test observe
      // settled=false instead of successful publication after the event committed.
      this.opts.onPushFailed?.(err, subscription);
    }
  }
}
