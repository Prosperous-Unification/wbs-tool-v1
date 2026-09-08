import type { EventLogStore, RecordedEvent } from '../repository/event-log';
import { type Broadcaster, type ProjectEvent, subscriptionFor } from './broadcast';
import { type Clock, clockOf } from './clock';
import type { PushClient } from './push-client';
import type { ReplayBuffer } from './replay-buffer';

export interface GatewayBroadcasterOptions {
  /**
   * The durable log, written straight rather than through a wrapper.
   *
   * `EventSequencer` stood here until 2026-09-02 and did nothing but pass the
   * two calls through, reading a clock on the way — which is what a
   * {@link Clock} is for. The sequence numbers were always the log's own, out of
   * `event_sequencer` in one statement (see `DrizzleEventLogStore.recordEvent`);
   * nothing about them was ever this layer's.
   */
  eventLog: EventLogStore;
  /** The instant each event is recorded at — see {@link Clock}. */
  clock?: Clock;
  push: PushClient;
  /**
   * The same buffer the replay orchestrator reads. Required: a broadcaster that
   * did not fill it would leave every resume falling through to a database
   * query, and the buffer would look healthy while being permanently empty.
   */
  buffer: ReplayBuffer;
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

  latestSeq(projectId: string): Promise<number> {
    return this.opts.eventLog.latestSeq(subscriptionFor(projectId));
  }

  /**
   * Record durably and buffer, then push — the durable half inside the event
   * log's own turn at the write coordinator, the push outside it.
   *
   * The split is the whole point and the two halves are not interchangeable.
   * **Inside** a turn, because the log shares its connection with a batch's
   * outer transaction and a record made inside one is a savepoint the batch's
   * rollback takes with it. **Outside** it, because a push is a network call
   * that PushClient bounds with attempt and overall deadlines, and a turn held
   * across even that bounded delivery stalls every write in the process.
   * `PlanCommandRunner` states the second half of that rule for itself and
   * `plan-commands.db.test.ts` › `lets go of the write lock before the broadcast
   * leaves` holds it; this method is where the first half lives.
   *
   * The turn is taken by `EventLogStore.recordEvent` itself rather than here.
   * This method used to wrap that call in `lock.run`, which was the same
   * exclusion said twice — and, once every store takes its own turn, a caller
   * holding a turn while its callee waits for one, which is a deadlock rather
   * than a slow write. A batch's own announcements never reach here while it is
   * open: they are collected by that batch's `AnnouncementCollector` and
   * drained by its `send` after
   * `execute` has let go.
   */
  async publish(projectId: string, event: ProjectEvent): Promise<void> {
    const subscription = subscriptionFor(projectId);
    const recorded = await this.opts.eventLog.recordEvent(subscription, event, this.clock.now());
    // Proof: moving push inside the durable half made the real-client
    // durability case observe entered=false for its second writer while
    // transport was pending.
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
