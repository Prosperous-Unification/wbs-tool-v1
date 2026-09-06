import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { CapacityRepository } from '../repository/capacity';
import type { Connection } from '../repository/db';
import { openConnection } from '../repository/db';
import { DirectoryRepository } from '../repository/directory';
import type { WriteStamp } from '../repository/index';
import { runMigrations } from '../repository/migrate';
import { ProjectRepository } from '../repository/project';
import type { PlanInputReads } from '../repository/saved-plan-capture';
import { SavedPlanCaptureRepository } from '../repository/saved-plan-capture';
import { UserRepository } from '../repository/user';
import { WorkItemRepository } from '../repository/work-item';
import { projectRow } from '../testing/project-fixture';
import { captureAndSchedulePlan, schedulePlanInput } from './saved-plan-schedule';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

const wrote: WriteStamp = { at: 1, by: 'owner' };

/**
 * The scheduling pass runs with no handle of the capture's still open.
 *
 * The whole claim is about an *instant*, so the count is sampled from inside
 * the scheduling call rather than around it: a check taken before and after
 * would stay green with the pass moved inside the read transaction, which is
 * the one arrangement this row exists to forbid. `captureAndSchedulePlan` takes
 * the scheduler injected for exactly this, the way the capture takes
 * `openConnection` injected so a test can watch it open and close.
 */
describe('scheduling a captured plan', () => {
  let dir: string;
  let path: string;
  /** How many connections this factory has opened and not yet closed. */
  let live: number;
  let opened: number;

  const counting = (): Connection => {
    const real = openConnection(path);
    opened += 1;
    live += 1;
    return {
      db: real.db,
      close: () => {
        live -= 1;
        real.close();
      },
    };
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wbs-saved-plan-schedule-'));
    path = join(dir, 'test.db');
    runMigrations(path, FOLDER);
    live = 0;
    opened = 0;
    const seed = openConnection(path);
    const db = seed.db;
    await new UserRepository(db).create(
      { id: 'owner', username: 'owner', passwordHash: 'x', createdAt: 1 },
      wrote,
    );
    await new ProjectRepository(db).create(
      projectRow({ id: 'p1', name: 'plan', ownerId: 'owner', estimateMethod: 'realistic' }),
      [{ id: 'st-1', projectId: 'p1', name: 'Dev', position: 10 }],
      wrote,
    );
    const directory = new DirectoryRepository(db);
    await directory.addTeam({ id: 't-platform', name: 'Platform' }, wrote);
    await directory.addPerson({ id: 'pp-ada', name: 'Ada' }, ['t-platform'], wrote);
    await new CapacityRepository(db).set('p1', 't-platform', 4, wrote);
    const items = new WorkItemRepository(db);
    for (const [id, position] of [
      ['wi-1', 10],
      ['wi-2', 20],
    ] as const) {
      await items.insert(
        {
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
        },
        [],
        wrote,
      );
    }
    seed.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const capture = (): SavedPlanCaptureRepository =>
    new SavedPlanCaptureRepository({ openConnection: counting });

  it('holds no connection open while the plan is scheduled', async () => {
    // Pushed rather than assigned to a `number | null`: the assignment happens
    // inside a callback, and the reading has to distinguish "sampled 0" from
    // "never sampled", which an initial value cannot.
    const sampled: number[] = [];
    const result = await captureAndSchedulePlan(capture(), 'p1', (reads: PlanInputReads) => {
      sampled.push(live);
      return schedulePlanInput(reads);
    });

    expect(result).not.toBeNull();
    // One sample, and it is zero. An empty array would mean the scheduler never
    // ran and the count below was nobody's observation.
    expect(sampled).toEqual([0]);
    // The capture did open one, so the zero above is a release rather than a
    // capture that never happened.
    expect(opened).toBe(1);
    expect(live).toBe(0);
  });

  /**
   * The instrument reads non-zero while a handle is open.
   *
   * Without this, the `[0]` sample above would also pass against a
   * counter that never increments — a liveness assertion that cannot fail,
   * which is what task 3.3 names as the failure mode. The other half of the
   * proof is the watched red recorded in `verify.md`: the scheduling call moved
   * inside `readPlanInput`'s transaction, where the same probe reads 1.
   */
  it('counts a live handle as live', () => {
    const held = counting();
    expect(live).toBe(1);
    held.close();
    expect(live).toBe(0);
  });

  it('schedules every leaf from the captured values alone', async () => {
    const result = await captureAndSchedulePlan(capture(), 'p1');
    expect(result).not.toBeNull();
    const { reads, planned } = result!;
    expect([...planned.workItems.keys()].sort()).toEqual(['wi-1', 'wi-2']);
    // Recomputed from the same detached values, on no connection at all: the
    // schedule is a function of the capture and of nothing else, so a second
    // pass over the same reads is byte-for-byte the same answer.
    expect(live).toBe(0);
    const again = schedulePlanInput(reads);
    expect(again.workItems).toEqual(planned.workItems);
    expect(again.slices).toEqual(planned.slices);
    expect(again.waitingForPerson).toBe(planned.waitingForPerson);
    expect(again.waitingForCapacity).toBe(planned.waitingForCapacity);
  });

  it('returns null for a project that is not there, and schedules nothing', async () => {
    let scheduled = 0;
    const result = await captureAndSchedulePlan(capture(), 'missing', (reads) => {
      scheduled += 1;
      return schedulePlanInput(reads);
    });
    expect(result).toBeNull();
    expect(scheduled).toBe(0);
    expect(live).toBe(0);
  });
});
