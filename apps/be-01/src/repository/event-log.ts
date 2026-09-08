import { sql } from 'drizzle-orm';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';

import { rowsChanged } from './changes';
import type { Gate } from './gate';

export interface RecordedEvent {
  subscription: string;
  seq: number;
  message: unknown;
  createdAt: number;
}

export type EventLogTransaction = Parameters<Parameters<SQLiteBunDatabase['transaction']>[0]>[0];

export interface EventLogRepo {
  recordEventIn(
    tx: EventLogTransaction,
    subscription: string,
    message: unknown,
    createdAt: number,
  ): RecordedEvent;
  recordEvent(subscription: string, message: unknown, createdAt: number): Promise<RecordedEvent>;
  rangeSince(subscription: string, sinceSeq: number): Promise<RecordedEvent[]>;
  oldestSeq(subscription: string): Promise<number | null>;
  /**
   * The sequence of the most recent event, or `-1` for a subscription that has
   * recorded none.
   *
   * Read from `event_sequencer` rather than from `MAX(seq)` on the log: retention
   * deletes log rows and the sequence must not move backwards when it does. A
   * client resuming from a stale `MAX(seq)` would be told it was up to date while
   * sitting behind every event that had been pruned.
   */
  latestSeq(subscription: string): Promise<number>;
  pruneBeyond(maxPerSubscription: number): Promise<number>;
}

export class DrizzleEventLogRepo implements EventLogRepo {
  constructor(
    private readonly db: SQLiteBunDatabase,
    private readonly gate: Gate,
  ) {}

  recordEventIn(
    tx: EventLogTransaction,
    subscription: string,
    message: unknown,
    createdAt: number,
  ): RecordedEvent {
    const payload = JSON.stringify(message);
    tx.run(sql`
        INSERT INTO event_sequencer (subscription, next_seq) VALUES (${subscription}, 0)
        ON CONFLICT(subscription) DO NOTHING
      `);
    const rows = tx.all<{ next_seq: number }>(
      sql`UPDATE event_sequencer
            SET next_seq = next_seq + 1
            WHERE subscription = ${subscription}
            RETURNING next_seq - 1 AS next_seq`,
    );
    const row = rows.at(0);
    if (row === undefined) throw new Error(`event sequencer did not return ${subscription}`);
    tx.run(sql`
        INSERT INTO event_log (subscription, seq, message, created_at)
        VALUES (${subscription}, ${row.next_seq}, ${payload}, ${createdAt})
      `);
    return { subscription, seq: row.next_seq, message, createdAt };
  }

  async recordEvent(
    subscription: string,
    message: unknown,
    createdAt: number,
  ): Promise<RecordedEvent> {
    return await this.gate.enter(() =>
      Promise.resolve(
        this.db.transaction((tx) => this.recordEventIn(tx, subscription, message, createdAt)),
      ),
    );
  }

  async rangeSince(subscription: string, sinceSeq: number): Promise<RecordedEvent[]> {
    await Promise.resolve();
    const rows = this.db.all<{
      subscription: string;
      seq: number;
      message: string;
      created_at: number;
    }>(
      sql`SELECT subscription, seq, message, created_at
          FROM event_log
          WHERE subscription = ${subscription} AND seq > ${sinceSeq}
          ORDER BY seq ASC`,
    );
    return rows.map((r) => ({
      subscription: r.subscription,
      seq: r.seq,
      message: JSON.parse(r.message) as unknown,
      createdAt: r.created_at,
    }));
  }

  async oldestSeq(subscription: string): Promise<number | null> {
    await Promise.resolve();
    const rows = this.db.all<{ seq: number }>(
      sql`SELECT seq FROM event_log WHERE subscription = ${subscription} ORDER BY seq ASC LIMIT 1`,
    );
    return rows[0]?.seq ?? null;
  }

  async latestSeq(subscription: string): Promise<number> {
    await Promise.resolve();
    const rows = this.db.all<{ next_seq: number }>(
      sql`SELECT next_seq FROM event_sequencer WHERE subscription = ${subscription}`,
    );
    const row = rows.at(0);
    return row === undefined ? -1 : row.next_seq - 1;
  }

  async pruneBeyond(maxPerSubscription: number): Promise<number> {
    return await this.gate.enter(async () => {
      await Promise.resolve();
      // One transaction over the delete and its count, for the reason
      // `PlanEventRepository.pruneOlderThan` states: `changes()` answers about
      // the last statement **this connection** ran; the sweep's turn at the
      // coordinator keeps a batch's statements out of that count.
      return this.db.transaction((tx) => {
        tx.run(
          sql`DELETE FROM event_log
          WHERE id IN (
            SELECT id FROM (
              SELECT id, ROW_NUMBER() OVER (PARTITION BY subscription ORDER BY seq DESC) AS rn
              FROM event_log
            )
            WHERE rn > ${maxPerSubscription}
          )`,
        );
        // The count is what the retention sweep reports, so no row back throws
        // rather than reading as zero: `?? 0` stood here until 2026-09-02, which
        // is a default for an unknown in the one place a caller acts on the
        // number. See {@link rowsChanged}.
        return rowsChanged(tx, 'pruning event_log');
      });
    });
  }
}
