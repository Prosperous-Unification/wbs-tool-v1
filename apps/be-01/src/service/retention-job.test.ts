import { makeTestDb } from '@wbs/validation/fixtures';
import type { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import { DrizzleEventLogRepo } from '../repository/event-log';
import { OPEN } from '../repository/gate';
import { runRetention } from './retention-job';

const BOOT_SQL = `
  CREATE TABLE event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription TEXT NOT NULL,
    seq INTEGER NOT NULL,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

async function bootstrap() {
  const db = await makeTestDb({ migrationsFolder: null });
  const client = (db as unknown as { $client: Database }).$client;
  client.run(BOOT_SQL);
  return { db, client };
}

describe('runRetention', () => {
  it('prunes rows beyond maxPerSubscription (keeps newest by seq)', async () => {
    const { db, client } = await bootstrap();
    for (let i = 0; i < 15; i++) {
      client.run(
        `INSERT INTO event_log(subscription, seq, message, created_at) VALUES ('doc:a', ?, '{}', ?)`,
        [i, i],
      );
    }
    const repo = new DrizzleEventLogRepo(db, OPEN);
    const removed = await runRetention(repo, { maxPerSubscription: 10 });
    expect(removed).toBe(5);
    const rows = client
      .query('SELECT seq FROM event_log WHERE subscription = ? ORDER BY seq')
      .all('doc:a') as { seq: number }[];
    expect(rows.map((x) => x.seq)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    client.close();
  });

  it('prunes independently per subscription', async () => {
    const { db, client } = await bootstrap();
    for (let i = 0; i < 5; i++) {
      client.run(
        `INSERT INTO event_log(subscription, seq, message, created_at) VALUES ('doc:a', ?, '{}', ?)`,
        [i, i],
      );
      client.run(
        `INSERT INTO event_log(subscription, seq, message, created_at) VALUES ('doc:b', ?, '{}', ?)`,
        [i, i],
      );
    }
    const repo = new DrizzleEventLogRepo(db, OPEN);
    const removed = await runRetention(repo, { maxPerSubscription: 3 });
    expect(removed).toBe(4);
    const count = client.query('SELECT COUNT(*) as n FROM event_log').get() as { n: number };
    expect(count.n).toBe(6);
    client.close();
  });
});
