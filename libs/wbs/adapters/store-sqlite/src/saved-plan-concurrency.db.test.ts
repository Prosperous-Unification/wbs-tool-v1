import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WriteStamp } from '@wbs/core';
import { projectRow } from '@wbs/store-memory/project-fixture';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { Connection } from './db';
import { openConnection } from './db';
import { OPEN } from './gate';
import { runMigrations } from './migrate';
import { ProjectRepository } from './project';
import type { SavedPlanWrite } from './saved-plan';
import { SavedPlanRepository } from './saved-plan';
import { savedPlan } from './schema';
import { UserRepository } from './user';

const FOLDER = new URL('../../../apps/be-01/drizzle', import.meta.url).pathname;
const HOLDER = new URL('../../../apps/be-01/src/testing/saved-plan-lock-holder.ts', import.meta.url)
  .pathname;

const wrote: WriteStamp = { at: 1, by: 'owner' };

/**
 * How long the other process keeps the lock, and the bound the refusal must
 * come in under.
 *
 * The two numbers are what makes the test discriminating rather than merely
 * green. The hold is comfortably longer than the bound, so a save that *waited*
 * could not answer inside it; the bound is comfortably longer than the
 * measured refusal (about a millisecond) and shorter than the 5 s the
 * connection's default `busy_timeout` would spend, so neither a slow machine
 * nor a fast one can move the answer from one side of it to the other.
 */
const HELD_FOR_MS = 1_500;
const REFUSAL_BOUND_MS = 400;

/** A plausible header and one small body. The bytes are not the subject here. */
const record = (id: string): SavedPlanWrite => ({
  id,
  projectId: 'p1',
  name: id,
  createdBy: 'Ada Lovelace',
  createdById: null,
  createdAt: 1_756_000_123,
  input: { schemaVersion: 1, bytes: '{"schemaVersion":1}', sha256: 'a'.repeat(64) },
  schedule: { present: false, absentReason: 'pending' },
});

describe('a save that meets a held write lock is refused, not queued behind it', () => {
  let dir: string;
  let path: string;
  let reader: Connection;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wbs-saved-plan-busy-'));
    path = join(dir, 'test.db');
    runMigrations(path, FOLDER);
    const seed = openConnection(path);
    await new UserRepository(seed.db, OPEN).create(
      { id: 'owner', username: 'owner', passwordHash: 'x', createdAt: 1 },
      wrote,
    );
    await new ProjectRepository(seed.db, OPEN).create(
      projectRow({ id: 'p1', name: 'Rewire the shed', ownerId: 'owner' }),
      [{ id: 'st-1', projectId: 'p1', name: 'Dev', position: 10 }],
      wrote,
    );
    seed.close();
    reader = openConnection(path);
  });

  afterEach(() => {
    reader.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const plans = (): SavedPlanRepository =>
    new SavedPlanRepository({ openConnection: () => openConnection(path) });

  const headerIds = async (): Promise<string[]> =>
    (await reader.db.select().from(savedPlan)).map((row) => row.id).sort();

  /**
   * Starts the other process's save and returns once it holds the write lock.
   *
   * Waited on by watching for the file the holder writes from *inside* its
   * transaction, not by sleeping for a plausible interval: a fixed delay that
   * turns out to be too short measures an uncontended save, which passes.
   */
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
      // A ceiling on the wait, so a holder that died on startup fails as itself
      // rather than as a test that hung until the runner killed it.
      if (Date.now() - startedWaiting > 10_000) {
        throw new Error(
          `the holder never took the lock: ${await new Response(holder.stderr).text()}`,
        );
      }
      await Bun.sleep(5);
    }
    return { finished };
  };

  it('refuses at once while the other process is still writing, and only that process commits', async () => {
    const { finished } = await otherProcessHoldsTheLock('sp-other');

    // Nothing is visible yet: the holder is inside its transaction. This is
    // what "before the first has finished writing" means, and it is asserted
    // rather than assumed, because a refusal that arrived after the rival had
    // committed would be a different (and permitted) event.
    expect(await headerIds()).toEqual([]);

    const startedAttempt = Date.now();
    const attempt = await plans().write<'over'>(record('sp-mine'), () => Promise.resolve(null));
    const tookMs = Date.now() - startedAttempt;

    expect(attempt).toEqual({ outcome: 'snapshot_busy' });
    // The whole point of `busy_timeout = 0`. At the connection default this
    // same call answers with the same error five seconds later, having held
    // every live edit in the project behind it for the duration.
    expect(tookMs).toBeLessThan(REFUSAL_BOUND_MS);
    // And the rival was genuinely still holding when the refusal arrived, so
    // the bound above measured contention rather than an empty file.
    expect(await headerIds()).toEqual([]);

    expect(await finished).toBe(0);
    // One record, not two: the save was refused rather than serialised behind
    // the other process. A marker in this process's memory would not have been
    // able to see that writer at all, and both would be here.
    expect(await headerIds()).toEqual(['sp-other']);
  });

  // Case budget stated, not defaulted (TASK-415). Two observations, not a
  // floor: 1647ms on h2puni at load 7-9, and 1658ms in the sweep recorded in
  // notes/t415-per-case-duration-sweep.txt. Both give a 3.0x margin on the
  // 5000ms default, and 5x either, rounded up to the next second, is 9000ms. A
  // real second process must commit before this one is allowed to proceed.
  // Re-derive with notes/t415-sweep.sh rather than trusting either number.
  it('writes normally once the other process has committed, on a fresh attempt', async () => {
    const { finished } = await otherProcessHoldsTheLock('sp-other');
    expect(await finished).toBe(0);

    // The refusal is about *this instant* and nothing else: with the lock
    // released the very same call succeeds, which is why the outcome is
    // separate from a quota refusal that would still be true a second later.
    expect(await plans().write<'over'>(record('sp-mine'), () => Promise.resolve(null))).toEqual({
      outcome: 'written',
    });
    expect(await headerIds()).toEqual(['sp-mine', 'sp-other']);
  }, 9000);
});
