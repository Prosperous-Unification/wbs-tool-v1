import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Schedule } from '@wbs/domain';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { CapacityRepository } from '../repository/capacity';
import { openConnection } from '../repository/db';
import { DirectoryRepository } from '../repository/directory';
import { EstimateRepository } from '../repository/estimate';
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
 * A Monday, so `nextWorkday` leaves it alone and the project's day zero is the
 * start itself. A weekend start would put day zero on the following Monday and
 * every offset below would be an assertion about `nextWorkday` rather than
 * about this seam.
 */
const START = '2026-03-02';

/**
 * A captured plan is scheduled with the deadlines it captured — TASK-301.
 *
 * `schedulePlanInput` passes `schedule()` six of its seven arguments and builds
 * no deadline map, so a saved plan is scheduled as if no work item had a
 * deadline. Since `work-item-deadline` slice 5 a deadline reorders Fast's ready
 * set by minimum slack, so this is not a missing reported field: **a saved plan
 * and the live plan of the same project place their slices on different days.**
 * The file's own doc claims the opposite — "a saved plan and the live plan
 * schedule the same numbers the same way" — which is what makes this a defect
 * rather than an omission.
 *
 * **The fixture is built so the deadline is the only thing that can decide the
 * order.** Two leaves, one person, equal two-day estimates, no dependency
 * between them, and `wi-1` earlier in `position` than `wi-2`. Position order is
 * therefore what a scheduler that never sees a deadline produces, and it is
 * what this file asserts against.
 */
describe('a captured plan and its deadlines', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wbs-saved-plan-deadlines-'));
    path = join(dir, 'test.db');
    runMigrations(path, FOLDER);
    const seed = openConnection(path);
    const db = seed.db;
    await new UserRepository(db).create(
      { id: 'owner', username: 'owner', passwordHash: 'x', createdAt: 1 },
      wrote,
    );
    await new ProjectRepository(db).create(
      projectRow({
        id: 'p1',
        name: 'plan',
        ownerId: 'owner',
        estimateMethod: 'realistic',
        startDate: START,
      }),
      [{ id: 'st-1', projectId: 'p1', name: 'Dev', position: 10 }],
      wrote,
    );
    const directory = new DirectoryRepository(db);
    await directory.addTeam({ id: 't-platform', name: 'Platform' }, wrote);
    await directory.addPerson({ id: 'pp-ada', name: 'Ada' }, ['t-platform'], wrote);
    await new CapacityRepository(db).set('p1', 't-platform', 4, wrote);
    const items = new WorkItemRepository(db);
    const estimates = new EstimateRepository(db);
    // `wi-1` is earlier in position and carries no deadline; `wi-2` is later and
    // owes day zero. Nothing else separates them.
    for (const [id, position, deadline] of [
      ['wi-1', 10, null],
      ['wi-2', 20, START],
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
          deadline,
          revision: 0,
        },
        [],
        wrote,
      );
      await estimates.set(
        { workItemId: id, stepId: 'st-1', optimistic: 2, realistic: 2, pessimistic: 2 },
        wrote,
      );
      // One person for both, so the two cannot run at the same time and the
      // engine has to choose which goes first.
      await directory.assign(id, 'st-1', 'pp-ada', wrote);
    }
    seed.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const capture = (): SavedPlanCaptureRepository =>
    new SavedPlanCaptureRepository({ openConnection: () => openConnection(path) });

  /** The slice a work item holds, found by field rather than by key format. */
  const sliceOf = (plan: Schedule, workItemId: string) => {
    const found = [...plan.slices.values()].filter((each) => each.workItemId === workItemId);
    expect(found).toHaveLength(1);
    return found[0]!;
  };

  it('lets a captured deadline decide which of two contending leaves goes first', async () => {
    const result = await captureAndSchedulePlan(capture(), 'p1');
    expect(result).not.toBeNull();
    const { reads, planned } = result!;

    // The capture itself is not the defect and is asserted first, so a red here
    // reads as "the date never reached the capture" rather than as the
    // scheduling claim below.
    expect(reads.workItems.find((each) => each.id === 'wi-2')?.deadline).toBe(START);
    expect(reads.project.startDate).toBe(START);

    // The claim: the deadlined leaf is placed first, ahead of the leaf that
    // sorts before it on position and is otherwise identical.
    expect(sliceOf(planned, 'wi-2').earliestStart).toBeLessThan(
      sliceOf(planned, 'wi-1').earliestStart,
    );

    // And the number the plan reports for it. `wi-2` owes day zero, occupies
    // days 0 and 1 once it is placed first, so its last workday is 1 and it is
    // late by 1 — not `null`, which is what a schedule computed without
    // deadlines reports for every row whether it met one or not.
    expect(sliceOf(planned, 'wi-2').lateBy).toBe(1);
    expect(sliceOf(planned, 'wi-1').lateBy).toBeNull();
  });

  it('puts the same two leaves back in position order once the deadline is gone', async () => {
    const result = await captureAndSchedulePlan(capture(), 'p1');
    expect(result).not.toBeNull();
    const { reads } = result!;

    // The negative control, and the reason the case above means anything: the
    // same reads with every deadline cleared, scheduled by the same function on
    // no connection at all. If this also placed `wi-2` first, the assertion
    // above would be about position or about the fixture rather than about the
    // date.
    const undated: PlanInputReads = {
      ...reads,
      workItems: reads.workItems.map((each) => ({ ...each, deadline: null })),
    };
    const without = schedulePlanInput(undated);

    expect(sliceOf(without, 'wi-1').earliestStart).toBeLessThan(
      sliceOf(without, 'wi-2').earliestStart,
    );
    expect(sliceOf(without, 'wi-2').lateBy).toBeNull();
  });
});
