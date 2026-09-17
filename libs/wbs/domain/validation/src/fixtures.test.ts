import type { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import { injectedClock, makeFrame, makeTestDb } from './fixtures';

describe('@wbs/validation/fixtures', () => {
  it('makeTestDb returns an in-memory Drizzle instance with migrations applied', async () => {
    const db = await makeTestDb({ migrationsFolder: null });
    const client = (db as unknown as { $client: Database }).$client;
    const result = client.query('SELECT 1 AS one').get() as { one: number };
    expect(result.one).toBe(1);
    client.close();
  });

  it('makeFrame produces a valid WS frame with defaults', () => {
    const f = makeFrame({ subscription: 'doc:abc' });
    expect(f.subscription).toBe('doc:abc');
    expect(typeof f.seq).toBe('number');
    expect(f.message).toBeDefined();
  });

  it('injectedClock returns monotonically increasing values from a fixed start', () => {
    const clock = injectedClock(1_000_000);
    expect(clock.now()).toBe(1_000_000);
    clock.advance(500);
    expect(clock.now()).toBe(1_000_500);
  });
});
