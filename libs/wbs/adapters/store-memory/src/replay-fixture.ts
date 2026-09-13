import type { EventLogStore, RecordedEvent } from '@wbs/core';

/**
 * The event log in a Map, for tests whose subject is not SQLite.
 *
 * It keeps the sequence in its own counter rather than deriving it from the
 * stored rows, because that is what the real one does — `pruneBeyond` must not
 * move the stream backwards, and a length-based sequence would.
 */
export interface MemoryEventLogTables {
  readonly rows: Map<string, RecordedEvent[]>;
  readonly nextSeq: Map<string, number>;
}
export function memoryEventLogTables(): MemoryEventLogTables {
  return { rows: new Map(), nextSeq: new Map() };
}

export function inMemoryEventLog(
  tables: MemoryEventLogTables = memoryEventLogTables(),
): EventLogStore & {
  record(subscription: string, message: unknown): Promise<RecordedEvent>;
} {
  const { rows, nextSeq } = tables;

  const record = (subscription: string, message: unknown, createdAt: number): RecordedEvent => {
    const seq = nextSeq.get(subscription) ?? 0;
    nextSeq.set(subscription, seq + 1);
    const event = { subscription, seq, message, createdAt };
    rows.set(subscription, [...(rows.get(subscription) ?? []), event]);
    return event;
  };

  const repo: EventLogStore = {
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
