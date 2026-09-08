import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { CapacityRepository } from '../repository/capacity';
import type { Connection } from '../repository/db';
import { openConnection } from '../repository/db';
import { DirectoryRepository } from '../repository/directory';
import { OPEN } from '../repository/gate';
import type { WriteStamp } from '../repository/index';
import { runMigrations } from '../repository/migrate';
import { ProjectRepository } from '../repository/project';
import { SavedPlanRepository } from '../repository/saved-plan';
import { SavedPlanCaptureRepository } from '../repository/saved-plan-capture';
import { savedPlan, workItem } from '../repository/schema';
import { UserRepository } from '../repository/user';
import { WorkItemRepository } from '../repository/work-item';
import { nodeDigest } from '../runtime/bun-runtime';
import { projectRow } from '../testing/project-fixture';
import { SavedPlanService } from './saved-plan.service';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;
const HOLDER = new URL('../testing/saved-plan-lock-holder.ts', import.meta.url).pathname;

const wrote: WriteStamp = { at: 1, by: 'owner' };

const OPENED_AT = 1_756_000_123;

/**
 * Long enough that the save's answer and the live edit both land inside it, and
 * short enough to stay well under bun's per-test budget. The live edit's own
 * connection carries the 5 s default `busy_timeout`, so it can outwait this
 * hold — which is the point: the save refuses at once, the edit waits its turn
 * behind the *other process*, and neither waits behind the other.
 */
const HELD_FOR_MS = 1_200;
const REFUSAL_BOUND_MS = 400;

describe('SavedPlanService.save answers snapshot_busy without holding up an edit', () => {
  let dir: string;
  let path: string;
  let reader: Connection;

  const item = (id: string, position: number) => ({
    id,
    projectId: 'p1',
    parentId: null,
    position,
    name: id,
    notes: '',
    frozenNumber: null,
    priority: null,
    startNoEarlierThan: null,
    serviceTeamId: null,
    serviceId: null,
    maxParallel: 1,
    startNoEarlierThanReason: null,
    deadline: null,
    revision: 0,
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wbs-saved-plan-busy-svc-'));
    path = join(dir, 'test.db');
    runMigrations(path, FOLDER);
    const seed = openConnection(path);
    const db = seed.db;
    await new UserRepository(db, OPEN).create(
      { id: 'owner', username: 'owner', passwordHash: 'x', createdAt: 1 },
      wrote,
    );
    await new ProjectRepository(db, OPEN).create(
      projectRow({
        id: 'p1',
        name: 'Rewire the shed',
        ownerId: 'owner',
        estimateMethod: 'realistic',
        startDate: '2026-03-02',
      }),
      [{ id: 'st-1', projectId: 'p1', name: 'Dev', position: 10 }],
      wrote,
    );
    const directory = new DirectoryRepository(db, OPEN);
    await directory.addTeam({ id: 't-platform', name: 'Platform' }, wrote);
    await directory.addPerson({ id: 'pp-ada', name: 'Ada' }, ['t-platform'], wrote);
    await new CapacityRepository(db, OPEN).set('p1', 't-platform', 4, wrote);
    const items = new WorkItemRepository(db, OPEN);
    await items.insert(item('wi-1', 10), [], wrote);
    await items.insert(item('wi-2', 20), [], wrote);
    seed.close();
    reader = openConnection(path);
  });

  afterEach(() => {
    reader.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const service = (): SavedPlanService =>
    new SavedPlanService({
      digest: nodeDigest,
      capture: new SavedPlanCaptureRepository({ openConnection: () => openConnection(path) }),
      plans: new SavedPlanRepository({ openConnection: () => openConnection(path) }),
      newId: () => 'sp-mine',
      now: () => OPENED_AT,
    });

  const headerIds = async (): Promise<string[]> =>
    (await reader.db.select().from(savedPlan)).map((row) => row.id).sort();

  const itemIds = async (): Promise<string[]> =>
    (await reader.db.select().from(workItem)).map((row) => row.id).sort();

  /** Starts the other process's save and returns once it holds the write lock. */
  const otherProcessHoldsTheLock = async (
    planId: string,
  ): Promise<{ readonly finished: Promise<number> }> => {
    const readyPath = join(dir, `${planId}.held`);
    const holder = Bun.spawn({
      cmd: [process.execPath, HOLDER, path, 'p1', planId, String(HELD_FOR_MS), readyPath],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const finished = holder.exited;
    const startedWaiting = Date.now();
    while (!existsSync(readyPath)) {
      if (Date.now() - startedWaiting > 10_000) {
        throw new Error(
          `the holder never took the lock: ${await new Response(holder.stderr).text()}`,
        );
      }
      await Bun.sleep(5);
    }
    return { finished };
  };

  /**
   * The whole refusal, end to end, and the promise that comes with it.
   *
   * The repository-level test proves the mechanism; this one proves the service
   * reports it as itself rather than as a save, and — the half that only exists
   * at this level — that the refusal costs a concurrent editor nothing. The
   * edit waits behind the **other process**, which is where the write lock
   * actually is; it never waits behind this save, because this save is not
   * holding anything to wait for.
   */
  it('refuses at once and lets a live edit issued in the same window complete', async () => {
    const { finished } = await otherProcessHoldsTheLock('sp-other');

    const startedAttempt = Date.now();
    const attempt = await service().save({
      projectId: 'p1',
      name: 'once more',
      createdBy: 'Ada Lovelace',
      createdById: null,
    });
    const tookMs = Date.now() - startedAttempt;

    expect(attempt).toEqual({ outcome: 'snapshot_busy' });
    expect(tookMs).toBeLessThan(REFUSAL_BOUND_MS);
    // The other process was still inside its transaction when that answer
    // arrived, so it was contention that produced it.
    expect(await headerIds()).toEqual([]);

    // Issued now, while the lock is still held elsewhere, on a connection
    // carrying the ordinary 5 s `busy_timeout`. It waits for the holder and
    // then lands — which is the spec's "a live edit issued during that window
    // still completes".
    await new WorkItemRepository(reader.db, OPEN).insert(item('wi-3', 30), [], wrote);
    expect(await itemIds()).toEqual(['wi-1', 'wi-2', 'wi-3']);

    expect(await finished).toBe(0);
    // And the refused save wrote nothing: the only record is the other
    // process's.
    expect(await headerIds()).toEqual(['sp-other']);
  });
});
