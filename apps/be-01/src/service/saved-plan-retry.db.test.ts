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
import { savedPlan, savedPlanBody } from '../repository/schema';
import { UserRepository } from '../repository/user';
import { WorkItemRepository } from '../repository/work-item';
import { nodeDigest } from '../runtime/bun-runtime';
import { projectRow } from '../testing/project-fixture';
import { fastScheduler } from './optimizer-wiring';
import { SavedPlanService } from './saved-plan.service';
import { saveWithBoundedRetry } from './saved-plan-retry';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;
const HOLDER = new URL('../testing/saved-plan-lock-holder.ts', import.meta.url).pathname;

const wrote: WriteStamp = { at: 1, by: 'owner' };

const OPENED_AT = 1_756_000_123;
/** Distance between one attempt's stamp and the next. Any non-zero gap does. */
const STAMP_STEP = 7;

/**
 * Long enough that the first attempt is genuinely refused and the interleaved
 * edit lands while the rival still holds the lock; short enough that the whole
 * retry finishes inside the 5 s budget with room to spare.
 */
const HELD_FOR_MS = 1_200;

describe('a refused save retried inside its budget saves the project as it is then', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'wbs-saved-plan-retry-'));
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

  /**
   * A stamp per attempt, seven seconds apart.
   *
   * `save` reads `now()` once, at its own top, before the capture opens — so a
   * second reading is a second save and a repeated one would be the refused
   * attempt's value carried forward. Handing out a fresh number each call is
   * what lets the test say *which* attempt wrote the row rather than only that
   * two rows differ.
   */
  const steppingClock = () => {
    let calls = 0;
    return () => {
      const at = OPENED_AT + STAMP_STEP * calls;
      calls += 1;
      return at;
    };
  };

  const service = (now: () => number): SavedPlanService =>
    new SavedPlanService({
      scheduler: fastScheduler,
      digest: nodeDigest,
      capture: new SavedPlanCaptureRepository({ openConnection: () => openConnection(path) }),
      plans: new SavedPlanRepository({ openConnection: () => openConnection(path) }),
      newId: () => 'sp-mine',
      now,
    });

  const headerIds = async (): Promise<string[]> =>
    (await reader.db.select().from(savedPlan)).map((row) => row.id).sort();

  // Selected whole and narrowed in TypeScript rather than in SQL: `drizzle-orm`
  // is import-restricted outside `repository/`, and the fixture holds two rows,
  // so a `where` would buy nothing but the lint error.
  const createdAtOf = async (id: string): Promise<number> => {
    const rows = (await reader.db.select().from(savedPlan)).filter((row) => row.id === id);
    if (rows.length !== 1) throw new Error(`expected one ${id} header, got ${String(rows.length)}`);
    return rows[0].createdAt;
  };

  const inputBytesOf = async (id: string): Promise<string> => {
    const rows = (await reader.db.select().from(savedPlanBody)).filter(
      (row) => row.savedPlanId === id && row.kind === 'input',
    );
    if (rows.length !== 1) throw new Error(`expected one ${id} input body`);
    return rows[0].bytes;
  };

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
   * The whole of 4.5, in one interleaving.
   *
   * The rival holds the write lock from another process, so the first attempt
   * is refused rather than serialised — that much is 4.4. What this adds is
   * what happens *next*: the retry's wait is used to issue a live edit, the
   * rival then commits, and the retry acquires the lock and saves. The three
   * assertions are deliberately not interchangeable:
   *
   * - Two records with different `created_at` says the retry produced a second
   *   record rather than overwriting the rival's. It is necessary and **not
   *   sufficient**: a retry that re-submitted the refused attempt's already
   *   detached values would produce exactly this too.
   * - The saved header's stamp being the *second* one the clock handed out says
   *   `save` ran from its top again.
   * - The stored input containing `wi-3` is the one that cannot be faked: those
   *   bytes exist only if the second attempt opened its own read snapshot,
   *   after the edit. Without it the spec's "a fresh save over a new read
   *   snapshot" stays green while unimplemented, and a user's retry silently
   *   stores the plan as of the attempt that failed.
   */
  it('retries after the rival commits and stores an input captured after the interleaved edit', async () => {
    const { finished } = await otherProcessHoldsTheLock('sp-other');
    const now = steppingClock();
    const saver = service(now);

    let edits = 0;
    let retryMs = 0;
    const outcome = await saveWithBoundedRetry(
      saver,
      { projectId: 'p1', name: 'once more', createdBy: 'Ada Lovelace', createdById: null },
      {
        nowMs: () => retryMs,
        // The loop's wait is this test's interleaving point, chosen because it
        // is the only instant that is *provably* between the refusal and the
        // retry's acquisition. Issuing the edit from a timer beside the save
        // would be a race, and a race that usually lands is a test that
        // usually tests the right thing.
        sleep: async (ms: number) => {
          retryMs += ms;
          if (edits === 0) {
            edits += 1;
            // `reader` carries the ordinary 5 s `busy_timeout`, so this waits
            // behind the *other process* and returns once that has committed.
            // `bun:sqlite` is synchronous, so the wait is real and this line
            // is also what sequences the retry after the rival.
            await new WorkItemRepository(reader.db, OPEN).insert(item('wi-3', 30), [], wrote);
          }
          await Bun.sleep(ms);
        },
      },
    );

    expect(outcome.outcome).toBe('saved');
    expect(edits).toBe(1);
    expect(await finished).toBe(0);

    expect(await headerIds()).toEqual(['sp-mine', 'sp-other']);
    const mine = await createdAtOf('sp-mine');
    expect(mine).not.toBe(await createdAtOf('sp-other'));
    // The second stamp, not the first: the refused attempt's label was not
    // carried over.
    expect(mine).toBe(OPENED_AT + STAMP_STEP);

    // The assertion the other two cannot stand in for.
    expect(await inputBytesOf('sp-mine')).toContain('wi-3');
  });
});
