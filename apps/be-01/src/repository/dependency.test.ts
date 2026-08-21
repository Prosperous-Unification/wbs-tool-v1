import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { Drizzle } from './db';
import { openDrizzle } from './db';
import { DependencyRepository } from './dependency';
import { runMigrations } from './migrate';
import { ProjectRepository } from './project';
import { UserRepository } from './user';
import { WorkItemRepository } from './work-item';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

let dir: string;
let db: Drizzle;
let repo: DependencyRepository;
let projectId: string;
let workItems: WorkItemRepository;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-dependency-'));
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  db = openDrizzle(path);
  repo = new DependencyRepository(db);
  workItems = new WorkItemRepository(db);

  const ownerId = crypto.randomUUID();
  await new UserRepository(db).create({
    id: ownerId,
    username: 'owner',
    passwordHash: 'x',
    createdAt: 1,
  });
  projectId = crypto.randomUUID();
  await new ProjectRepository(db).create(
    {
      id: projectId,
      name: 'Rewire the shed',
      ownerId,
      restricted: false,
      estimateMethod: 'pert',
      startDate: null,
      revision: 0,
      createdAt: 1,
    },
    [{ id: crypto.randomUUID(), projectId, name: 'Dev', position: 10 }],
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function addWorkItem(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await workItems.insert(
    {
      id,
      projectId,
      parentId: null,
      position: 10,
      name,
      notes: '',
      frozenNumber: null,
      priority: null,
      startNoEarlierThan: null,
      serviceTeamId: null,
      serviceId: null,
      maxParallel: 1,
      revision: 0,
    },
    [],
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

    await repo.add(edge(a, b));

    expect(await repo.listByProject(projectId)).toMatchObject([
      { predecessorId: a, successorId: b },
    ]);
  });

  it('adds the same edge twice without failing', async () => {
    // Two people drawing the same arrow at once both see "not there". A
    // read-then-write would make the second a 500 for an action that succeeded.
    const a = await addWorkItem('Strip');
    const b = await addWorkItem('Sand');

    await repo.add(edge(a, b));
    await repo.add(edge(a, b));

    expect(await repo.listByProject(projectId)).toHaveLength(1);
  });

  it('keeps the opposite direction as a different edge', async () => {
    // The unique index is on the ordered pair. `a → b` and `b → a` are both
    // storable; refusing the cycle is the service's job, not the index's.
    const a = await addWorkItem('Strip');
    const b = await addWorkItem('Sand');

    await repo.add(edge(a, b));
    await repo.add(edge(b, a));

    expect(await repo.listByProject(projectId)).toHaveLength(2);
  });

  it('removes one edge and leaves the rest', async () => {
    const a = await addWorkItem('Strip');
    const b = await addWorkItem('Sand');
    const c = await addWorkItem('Paint');
    await repo.add(edge(a, b));
    await repo.add(edge(b, c));

    await repo.remove(a, b);

    expect(await repo.listByProject(projectId)).toMatchObject([
      { predecessorId: b, successorId: c },
    ]);
  });

  it('removes every edge touching a work item, in both directions', async () => {
    const a = await addWorkItem('Strip');
    const b = await addWorkItem('Sand');
    const c = await addWorkItem('Paint');
    await repo.add(edge(a, b));
    await repo.add(edge(b, c));

    await repo.removeAllFor(b);

    expect(await repo.listByProject(projectId)).toEqual([]);
  });

  it('refuses an edge to a work item that does not exist', async () => {
    // The end-to-end proof that the foreign keys are enforced rather than
    // declared — `db.ts` asserts the pragma, and this is what that buys.
    const a = await addWorkItem('Strip');

    expect(repo.add(edge(a, crypto.randomUUID()))).rejects.toThrow(/FOREIGN KEY/i);
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
    await repo.add(edge(a, b));

    // Exactly what the old release runs: no edge cleanup first.
    await new WorkItemRepository(db).remove([a], []);

    expect(await repo.listByProject(projectId)).toEqual([]);
  });
});
