import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WriteStamp } from '@wbs/core';
import { workItemRow } from '@wbs/core/testing/work-item-fixture';
import { projectRow } from '@wbs/store-memory/project-fixture';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { messagesOf } from './constraint';
import type { Drizzle } from './db';
import { openDrizzle } from './db';
import { DependencyRepository } from './dependency';
import { OPEN } from './gate';
import { runMigrations } from './migrate';
import { ProjectRepository } from './project';
import { UserRepository } from './user';
import { WorkItemRepository } from './work-item';

const FOLDER = new URL('../../../apps/be-01/drizzle', import.meta.url).pathname;

let dir: string;
let dbPath: string;
let db: Drizzle;
let repo: DependencyRepository;
let ownerId: string;
let projectId: string;
let workItems: WorkItemRepository;

/**
 * The stamp every write here carries. The account is the project's owner, which
 * the `created_by` foreign key requires to exist; the owner's own signup carries
 * it too, because a new account authors its own row.
 */
const wrote = (): WriteStamp => ({ at: 1, by: ownerId });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-dependency-'));
  dbPath = join(dir, 'test.db');
  runMigrations(dbPath, FOLDER);
  db = openDrizzle(dbPath);
  repo = new DependencyRepository(db, OPEN);
  workItems = new WorkItemRepository(db, OPEN);

  ownerId = crypto.randomUUID();
  await new UserRepository(db, OPEN).create(
    { id: ownerId, username: 'owner', passwordHash: 'x', createdAt: 1 },
    wrote(),
  );
  projectId = crypto.randomUUID();
  await new ProjectRepository(db, OPEN).create(
    projectRow({
      id: projectId,
      ownerId,
    }),
    [{ id: crypto.randomUUID(), projectId, name: 'Dev', position: 10 }],
    wrote(),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function addWorkItem(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await workItems.insert(
    workItemRow({
      id,
      projectId,
      position: 10,
      name,
    }),
    [],
    wrote(),
  );
  return id;
}

const edge = (predecessorId: string, successorId: string) => ({
  id: crypto.randomUUID(),
  projectId,
  predecessorId,
  successorId,
});

describe('DependencyRepository', () => {
  it('stores an edge and reads it back for the project', async () => {
    const a = await addWorkItem('Strip');
    const b = await addWorkItem('Sand');

    await repo.add(edge(a, b), wrote());

    expect(await repo.listByProject(projectId)).toMatchObject([
      { predecessorId: a, successorId: b },
    ]);
  });

  it('adds the same edge twice without failing', async () => {
    // Two people drawing the same arrow at once both see "not there". A
    // read-then-write would make the second a 500 for an action that succeeded.
    const a = await addWorkItem('Strip');
    const b = await addWorkItem('Sand');

    await repo.add(edge(a, b), wrote());
    await repo.add(edge(a, b), wrote());

    expect(await repo.listByProject(projectId)).toHaveLength(1);
  });

  it('keeps the opposite direction as a different edge', async () => {
    // The unique index is on the ordered pair. `a → b` and `b → a` are both
    // storable; refusing the cycle is the service's job, not the index's.
    const a = await addWorkItem('Strip');
    const b = await addWorkItem('Sand');

    await repo.add(edge(a, b), wrote());
    await repo.add(edge(b, a), wrote());

    expect(await repo.listByProject(projectId)).toHaveLength(2);
  });

  it('removes one edge and leaves the rest', async () => {
    const a = await addWorkItem('Strip');
    const b = await addWorkItem('Sand');
    const c = await addWorkItem('Paint');
    await repo.add(edge(a, b), wrote());
    await repo.add(edge(b, c), wrote());

    await repo.remove(a, b, wrote());

    expect(await repo.listByProject(projectId)).toMatchObject([
      { predecessorId: b, successorId: c },
    ]);
  });

  it('removes every edge touching a work item, in both directions', async () => {
    const a = await addWorkItem('Strip');
    const b = await addWorkItem('Sand');
    const c = await addWorkItem('Paint');
    await repo.add(edge(a, b), wrote());
    await repo.add(edge(b, c), wrote());

    await repo.removeAllFor([b], wrote());

    expect(await repo.listByProject(projectId)).toEqual([]);
  });

  /**
   * A subtree delete knows every row it is about to remove, and the edges have
   * to go first or the foreign keys refuse the delete. Doing that one row at a
   * time cost a transaction, a read and a write **each**, inside the outer
   * transaction and therefore inside the process-wide write lock (ADR 0007).
   *
   * Two claims, and the second is why this is not only a speed change. From
   * inside a single-id call a **doomed sibling looks like a survivor**, so an
   * edge between two rows on their way out bumped the far end — a counter moved
   * onto a row about to stop existing, which is the exact thing this method's
   * own contract says it will not do. Reading the whole set is what makes it
   * answerable.
   *
   * Four rows, not two: `a` and `b` are doomed and joined to each other, so a
   * per-row loop bumps `b` while removing `a`'s edges. `c` survives and must be
   * bumped. `d` is untouched and must not be.
   *
   * Proof, both halves watched 2026-09-02 with the per-row loop restored
   * (`for (const only of workItemIds) await this.removeAllForOne(only, stamp)`):
   * the statement count failed on `expect(received).toHaveLength(expected)` ·
   * `Expected length: 3` · `Received length: 6`, and with that assertion
   * silenced the revision half failed on `expect(received).toBe(expected)` ·
   * `Expected: 0` · `Received: 1` at `moved(b)` — `b` bumped on its way out.
   */
  it('takes a subtree’s edges in one transaction and bumps only the survivors', async () => {
    const a = await addWorkItem('Strip');
    const b = await addWorkItem('Sand');
    const c = await addWorkItem('Paint');
    const d = await addWorkItem('Sweep');
    await repo.add(edge(a, b), wrote());
    await repo.add(edge(b, c), wrote());

    // Deltas, not absolutes: adding an edge already bumps both of its ends, so
    // `b` and `c` do not start at zero and what this test is about is what the
    // *removal* moves.
    const revisionsNow = async (): Promise<Map<string, number>> =>
      new Map((await workItems.listByProject(projectId)).map((row) => [row.id, row.revision]));
    const before = await revisionsNow();

    const statements: string[] = [];
    const counted = new DependencyRepository(
      openDrizzle(dbPath, {
        logQuery(query) {
          statements.push(query);
        },
      }),
      OPEN,
    );

    await counted.removeAllFor([a, b], wrote());

    // One read of the losing ends, one delete, one bump — three whatever the
    // subtree's size. A loop pays all three per row. (`begin`/`commit` are not
    // logged by drizzle's hook, so every entry here is a statement of ours.)
    expect(statements).toHaveLength(3);
    expect(await repo.listByProject(projectId)).toEqual([]);

    const after = await revisionsNow();
    const moved = (id: string): number => {
      const was = before.get(id);
      const now = after.get(id);
      if (was === undefined || now === undefined) throw new Error(`no revision for ${id}`);
      return now - was;
    };
    // `c` lost an edge and is still there, so somebody holding its revision has
    // stale information.
    expect(moved(c)).toBe(1);
    // `b` is on its way out. A per-row loop bumps it while clearing `a`'s edges,
    // because from inside that call `b` is just the far end of an edge.
    expect(moved(b)).toBe(0);
    expect(moved(a)).toBe(0);
    // The precondition: a bump that touched every row would satisfy `c` above.
    expect(moved(d)).toBe(0);
  });

  it('refuses an edge to a work item that does not exist', async () => {
    // The end-to-end proof that the foreign keys are enforced rather than
    // declared — `db.ts` asserts the pragma, and this is what that buys.
    const a = await addWorkItem('Strip');

    // Read down the `cause` chain: drizzle 1.0.0-rc.4 wraps SQLite's refusal
    // in a `DrizzleQueryError` whose own message names the statement, not the
    // constraint — a `rejects.toThrow(/FOREIGN KEY/)` on the outer error was
    // watched failing on `Received message: "Failed query: insert into
    // \"dependency\" …"` (2026-09-06).
    const refusal = await repo
      .add(edge(a, crypto.randomUUID()), wrote())
      .catch((err: unknown) => err);
    expect(messagesOf(refusal).join('\n')).toMatch(/FOREIGN KEY/i);
  });
});

describe('a work item deleted by a release that knows nothing about edges', () => {
  it('takes its dependencies with it rather than refusing the delete', async () => {
    // agy, high. Blue and green share one SQLite file during a swap. The
    // outgoing release has never heard of this table, so its plain
    // `DELETE FROM work_item` would hit a foreign key it cannot see and answer
    // 500 for an ordinary deletion. The cascade is what makes the migration
    // safe to apply while the old release is still serving.
    const a = await addWorkItem('Strip');
    const b = await addWorkItem('Sand');
    await repo.add(edge(a, b), wrote());

    // Exactly what the old release runs: no edge cleanup first.
    await new WorkItemRepository(db, OPEN).remove([a], [], wrote());

    expect(await repo.listByProject(projectId)).toEqual([]);
  });
});
