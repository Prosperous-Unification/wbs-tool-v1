import type { EventLogRepo, RecordedEvent } from '../repository/event-log';
import { ReplayBuffer } from '../service/replay-buffer';
import { ReplayOrchestrator } from '../service/replay-orchestrator';

/**
 * The event log in a Map, for tests whose subject is not SQLite.
 *
 * It keeps the sequence in its own counter rather than deriving it from the
 * stored rows, because that is what the real one does — `pruneBeyond` must not
 * move the stream backwards, and a length-based sequence would.
 */
export function inMemoryEventLog(): EventLogRepo & {
  record(subscription: string, message: unknown): Promise<RecordedEvent>;
} {
  const rows = new Map<string, RecordedEvent[]>();
  const nextSeq = new Map<string, number>();

  const record = (subscription: string, message: unknown, createdAt: number): RecordedEvent => {
    const seq = nextSeq.get(subscription) ?? 0;
    nextSeq.set(subscription, seq + 1);
    const event = { subscription, seq, message, createdAt };
    rows.set(subscription, [...(rows.get(subscription) ?? []), event]);
    return event;
  };

  const repo: EventLogRepo = {
    recordEventIn(_tx, subscription, message, createdAt) {
      return record(subscription, message, createdAt);
    },
    recordEvent(subscription, message, createdAt) {
      return Promise.resolve(record(subscription, message, createdAt));
    },
    rangeSince(subscription, sinceSeq) {
      return Promise.resolve((rows.get(subscription) ?? []).filter((e) => e.seq > sinceSeq));
    },
    oldestSeq(subscription) {
      return Promise.resolve(rows.get(subscription)?.[0]?.seq ?? null);
    },
    latestSeq(subscription) {
      const next = nextSeq.get(subscription);
      return Promise.resolve(next === undefined ? -1 : next - 1);
    },
    pruneBeyond(maxPerSubscription) {
      let removed = 0;
      for (const [subscription, kept] of rows) {
        const excess = kept.length - maxPerSubscription;
        if (excess <= 0) continue;
        rows.set(subscription, kept.slice(excess));
        removed += excess;
      }
      return Promise.resolve(removed);
    },
  };

  return {
    ...repo,
    record: (subscription, message) => Promise.resolve(record(subscription, message, 1_000)),
  };
}

/** A replay orchestrator over an empty in-memory log, and the log behind it. */
export function testReplay(maxEvents?: number) {
  const log = inMemoryEventLog();
  const buffer = new ReplayBuffer({ maxPerSubscription: 100, maxAgeMs: 5 * 60_000 });
  return { log, buffer, replay: new ReplayOrchestrator({ log, buffer, maxEvents }) };
}
