import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Schedule } from '@wbs/domain';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { ActualRepository } from '../repository/actual';
import { CapacityRepository } from '../repository/capacity';
import { CommandJournalRepository } from '../repository/command-journal';
import { type Connection, openConnection } from '../repository/db';
import { DependencyRepository } from '../repository/dependency';
import { DirectoryRepository } from '../repository/directory';
import { EstimateRepository } from '../repository/estimate';
import { OPEN } from '../repository/gate';
import type { WriteStamp } from '../repository/index';
import { runMigrations } from '../repository/migrate';
import { PriorityBandRepository } from '../repository/priority-band';
import { ProjectRepository } from '../repository/project';
import type { PlanInputReads } from '../repository/saved-plan-capture';
import { SavedPlanCaptureRepository } from '../repository/saved-plan-capture';
import { StepMeasureRepository } from '../repository/step-measure';
import { StepProgressRepository } from '../repository/step-progress';
import { UserRepository } from '../repository/user';
import { SubtreeRepository, WorkItemRepository } from '../repository/work-item';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { projectRow } from '../testing/project-fixture';
import { captureAndSchedulePlan, schedulePlanInput } from './saved-plan-schedule';
import { WorkItemService } from './work-item.service';

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
 *
 * **The third case turns the doc's claim into an assertion.** The same project
 * is read twice — once through `WorkItemService.tree`, which is the live
 * projection the doc says this derivation mirrors, and once through the
 * capture — and the two are compared placement by placement. Argued equality
 * is what let this defect live in a file whose own comment described the
 * property it broke.
 */
describe('a captured plan and its deadlines', () => {
  let dir: string;
  let path: string;
  /**
   * Every connection a case opened beyond the seed's, closed together.
   *
   * The live projection needs one of its own — `WorkItemService` takes stores,
   * and a store takes a `Drizzle` — and a file left with an open WAL is a
   * `rmSync` that removes the database out from under a reader.
   */
  const opened: Connection[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wbs-saved-plan-deadlines-'));
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
        name: 'plan',
        ownerId: 'owner',
        estimateMethod: 'realistic',
        startDate: START,
      }),
      [{ id: 'st-1', projectId: 'p1', name: 'Dev', position: 10 }],
      wrote,
    );
    const directory = new DirectoryRepository(db, OPEN);
    await directory.addTeam({ id: 't-platform', name: 'Platform' }, wrote);
    await directory.addPerson({ id: 'pp-ada', name: 'Ada' }, ['t-platform'], wrote);
    await new CapacityRepository(db, OPEN).set('p1', 't-platform', 4, wrote);
    const items = new WorkItemRepository(db, OPEN);
    const estimates = new EstimateRepository(db, OPEN);
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
    for (const each of opened.splice(0)) each.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const capture = (): SavedPlanCaptureRepository =>
    new SavedPlanCaptureRepository({ openConnection: () => openConnection(path) });

  /**
   * The **live** plan of the same project, read the way the app reads it.
   *
   * Not a second call to `schedulePlanInput` with different inputs: this is
   * `WorkItemService.tree`, whose `schedule()` call at `work-item.service.ts`
   * `:1718` is the one `saved-plan-schedule.ts:24-27` claims to mirror. Real
   * repositories over the same file, so the two paths differ in **how they
   * reach the values** and in nothing else — which is the only arrangement in
   * which an equality between them says anything.
   *
   * `optimized` is left off deliberately: with no reader the projection takes
   * its `fast` branch, and `fast` is the engine the capture runs. Wiring a
   * solver cache in would compare a captured Fast plan against a published
   * optimized one and the disagreement would be about the engine.
   */
  const liveProjection = async () => {
    const live = openConnection(path);
    opened.push(live);
    const { db } = live;
    return new WorkItemService({
      workItems: new WorkItemRepository(db, OPEN),
      projects: new ProjectRepository(db, OPEN),
      estimates: new EstimateRepository(db, OPEN),
      actuals: new ActualRepository(db, OPEN),
      measures: new StepMeasureRepository(db, OPEN),
      progress: new StepProgressRepository(db, OPEN),
      dependencies: new DependencyRepository(db, OPEN),
      directory: new DirectoryRepository(db, OPEN),
      capacity: new CapacityRepository(db, OPEN),
      priorityBands: new PriorityBandRepository(db, OPEN),
      subtrees: new SubtreeRepository(db, OPEN),
      journal: new CommandJournalRepository(db, OPEN),
      broadcast: recordingBroadcaster(),
    }).tree('p1');
  };

  /** What "the same placements" means: the key, whose work it is, and when. */
  const placementsOf = (
    slices: Iterable<{
      id: string;
      workItemId: string;
      earliestStart: number;
      earliestFinish: number;
      lateBy: number | null;
    }>,
  ) =>
    [...slices]
      .map(({ id, workItemId, earliestStart, earliestFinish, lateBy }) => ({
        id,
        workItemId,
        earliestStart,
        earliestFinish,
        lateBy,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));

  /** The slice a work item holds, found by field rather than by key format. */
  const sliceOf = (plan: Schedule, workItemId: string) => {
    const found = [...plan.slices.values()].filter((each) => each.workItemId === workItemId);
    expect(found).toHaveLength(1);
    return found[0];
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

  it('schedules the same project to the same placements as the live projection', async () => {
    // `tree` answers `null` for a project that is not there, exactly as the
    // capture does, so both are narrowed the same way and a fixture that failed
    // to seed reads as "the project is missing" rather than as a placement
    // disagreement.
    const read = await liveProjection();
    expect(read).not.toBeNull();
    const live = read!;
    const result = await captureAndSchedulePlan(capture(), 'p1');
    expect(result).not.toBeNull();
    const { planned } = result!;

    // Neither side is empty and neither is a degraded plan, so the equality
    // below cannot pass by comparing nothing to nothing — the failure R5 calls
    // a check that cannot fail.
    expect(live.scheduleError).toBeNull();
    expect(live.slices).toHaveLength(2);
    expect(planned.slices.size).toBe(2);

    // And the two leaves are in **deadline** order on the live side, which is
    // what makes this an assertion about the seventh argument rather than about
    // any two schedules of an unconstrained fixture agreeing. A capture that
    // dropped the argument would sit in position order here and this equality
    // is what would report it.
    const liveOf = (workItemId: string) => {
      const found = live.slices.filter((each) => each.workItemId === workItemId);
      expect(found).toHaveLength(1);
      return found[0];
    };
    expect(liveOf('wi-2').earliestStart).toBeLessThan(liveOf('wi-1').earliestStart);

    // The claim `saved-plan-schedule.ts:24-27` makes in prose — "a saved plan
    // and the live plan schedule the same numbers the same way" — as one
    // comparison, so a disagreement prints both plans rather than the first
    // field to differ.
    const saved = [...planned.slices.entries()].map(([id, slice]) => ({ ...slice, id }));
    expect(placementsOf(saved)).toEqual(placementsOf(live.slices));
  });
});
