import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  diffPlans,
  planDiffIsEmpty,
  type Schedule,
  SCHEDULE_ALGORITHM_ID,
  serialiseCanonicalPlanInput,
} from '@wbs/domain';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { CapacityRepository } from '../repository/capacity';
import type { Connection } from '../repository/db';
import { openConnection } from '../repository/db';
import { DependencyRepository } from '../repository/dependency';
import { DirectoryRepository } from '../repository/directory';
import type { WriteStamp } from '../repository/index';
import { runMigrations } from '../repository/migrate';
import { ProjectRepository } from '../repository/project';
import { SavedPlanRepository } from '../repository/saved-plan';
import type { PlanInputReads } from '../repository/saved-plan-capture';
import { SavedPlanCaptureRepository } from '../repository/saved-plan-capture';
import { savedPlan } from '../repository/schema';
import { UserRepository } from '../repository/user';
import { WorkItemRepository } from '../repository/work-item';
import { projectRow } from '../testing/project-fixture';
import { SavedPlanService } from './saved-plan.service';
import { schedulePlanInput } from './saved-plan-schedule';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

const wrote: WriteStamp = { at: 1, by: 'owner' };
const OPENED_AT = 1_756_000_123;

/**
 * Tasks 7.3 and 7.3a — `current` as a comparison side.
 *
 * The two defects this file exists to catch are both invisible to the domain
 * diff's own completeness properties, because those mutate `CanonicalPlanInput`
 * values directly and never run this path:
 *
 * 1. A `current` built from the projection's twelve awaited reads instead of
 *    the capture's read set lacks the registry and junction rows by value, so
 *    every saved-vs-current comparison reports the saved side's tags, types and
 *    external systems as removed.
 * 2. A `current` whose schedule is the absent reason `unavailable` — which
 *    spec's stored-schedule bound lawfully permits until 7.3a exists — answers
 *    "no schedule was saved" about the live side of this feature's primary
 *    direction, while every input-side assertion stays green.
 */
describe('projecting the live plan as a comparison side', () => {
  let dir: string;
  let path: string;
  /** How many connections the capture has opened and not yet closed. */
  let live: number;

  const counting = (): Connection => {
    const real = openConnection(path);
    live += 1;
    return {
      db: real.db,
      close: () => {
        live -= 1;
        real.close();
      },
    };
  };

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
    revision: 0,
  });

  beforeEach(async () => {
    live = 0;
    dir = mkdtempSync(join(tmpdir(), 'wbs-saved-plan-current-'));
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
        name: 'Rewire the shed',
        ownerId: 'owner',
        estimateMethod: 'realistic',
        startDate: '2026-03-02',
      }),
      [{ id: 'st-1', projectId: 'p1', name: 'Dev', position: 10 }],
      wrote,
    );
    const directory = new DirectoryRepository(db);
    await directory.addTeam({ id: 't-platform', name: 'Platform' }, wrote);
    await directory.addPerson({ id: 'pp-ada', name: 'Ada' }, ['t-platform'], wrote);
    await new CapacityRepository(db).set('p1', 't-platform', 4, wrote);
    const items = new WorkItemRepository(db);
    await items.insert(item('wi-1', 10), [], wrote);
    await items.insert(item('wi-2', 20), [], wrote);
    seed.close();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** How many rows the saved-plan table holds right now. */
  const savedPlanCount = (): number => {
    const conn = openConnection(path);
    try {
      return conn.db.select().from(savedPlan).all().length;
    } finally {
      conn.close();
    }
  };

  const service = (
    id = 'sp-1',
    schedule: (reads: PlanInputReads) => Schedule = schedulePlanInput,
  ): SavedPlanService =>
    new SavedPlanService({
      capture: new SavedPlanCaptureRepository({ openConnection: counting }),
      plans: new SavedPlanRepository({ openConnection: () => openConnection(path) }),
      newId: () => id,
      now: () => OPENED_AT,
      schedule,
    });

  it('returns null for a project that is not there', async () => {
    expect(await service().projectCurrentPlan('missing')).toBeNull();
  });

  it('writes no row and consumes no quota', async () => {
    expect(savedPlanCount()).toBe(0);

    const side = await service().projectCurrentPlan('p1');

    expect(side).not.toBeNull();
    expect(savedPlanCount()).toBe(0);
  });

  /**
   * The strongest available statement of "the same canonical function the save
   * uses": save the project, then project it, and require the two input bodies
   * to be **byte-identical**. A `current` assembled from the live projection
   * instead of the capture's read set fails here on the registry and junction
   * rows, which is defect (1) above, and it fails on the bytes rather than on a
   * field list nobody has to remember to extend.
   */
  it('produces the same input bytes the save path stores', async () => {
    const saved = await service().save({
      projectId: 'p1',
      name: 'before',
      createdBy: 'owner',
      createdById: 'owner',
    });
    expect(saved.outcome).toBe('saved');

    const side = await service('sp-2').projectCurrentPlan('p1');

    expect(serialiseCanonicalPlanInput(side!.input)).toBe(
      saved.outcome === 'saved' ? saved.record.input.bytes : '',
    );
  });

  /** 7.3a: the live side has a schedule, and it is labelled with today's identity. */
  it('carries a schedule under the algorithm identity currently in force', async () => {
    const side = await service().projectCurrentPlan('p1');

    expect(side!.schedule.present).toBe(true);
    expect(side!.schedule.present && side!.schedule.algorithmId).toBe(SCHEDULE_ALGORITHM_ID);
  });

  /**
   * 3.3's handle-liveness assertion, on **this** scheduling call.
   *
   * 3.3's own spy covers the save path only. Without this an implementer who
   * scheduled inside the held `BEGIN DEFERRED` ships green and every
   * saved-vs-current comparison — this feature's hot path — holds the read
   * snapshot open for the length of a levelling run.
   *
   * Sampled from **inside** the scheduling call, because the claim is about an
   * instant; a reading taken before and after would stay green under exactly
   * the arrangement it forbids. The array distinguishes "sampled zero" from
   * "never sampled".
   */
  it('holds no capture connection open while the live plan is scheduled', async () => {
    const sampled: number[] = [];
    const side = await service('sp-1', (reads) => {
      sampled.push(live);
      return schedulePlanInput(reads);
    }).projectCurrentPlan('p1');

    expect(side).not.toBeNull();
    expect(sampled).toEqual([0]);
    expect(live).toBe(0);
  });

  it('counts a live handle as live, so the zero above is a release', () => {
    const held = counting();
    expect(live).toBe(1);
    held.close();
    expect(live).toBe(0);
  });

  /**
   * A cyclic live plan cannot be scheduled, and that is `current`'s own
   * `infeasible` — not "no schedule was saved", because nothing about `current`
   * was ever saved. The input side is unaffected and still compares.
   */
  it('maps a dependency cycle to infeasible and still carries the input', async () => {
    const conn = openConnection(path);
    const deps = new DependencyRepository(conn.db);
    await deps.add(
      { id: 'dep-1', projectId: 'p1', predecessorId: 'wi-1', successorId: 'wi-2' },
      wrote,
    );
    await deps.add(
      { id: 'dep-2', projectId: 'p1', predecessorId: 'wi-2', successorId: 'wi-1' },
      wrote,
    );
    conn.close();

    const side = await service().projectCurrentPlan('p1');

    expect(side!.schedule).toEqual({ present: false, absentReason: 'infeasible' });
    expect(side!.input.workItems.map((row) => row.id)).toEqual(['wi-1', 'wi-2']);
  });

  /** The two sides meet: an unchanged plan compares clean against itself. */
  it('compares clean against a plan saved from the same rows', async () => {
    const left = await service().projectCurrentPlan('p1');
    const right = await service('sp-2').projectCurrentPlan('p1');

    expect(planDiffIsEmpty(diffPlans(left!, right!))).toBe(true);
  });

  /** And a live edit shows up, on the input side and on the dates. */
  it('reports a live edit against a side captured before it', async () => {
    const before = await service().projectCurrentPlan('p1');

    const conn = openConnection(path);
    await new WorkItemRepository(conn.db).insert(item('wi-3', 30), [], wrote);
    conn.close();

    const after = await service('sp-2').projectCurrentPlan('p1');
    const diff = diffPlans(before!, after!);

    expect(diff.input.some((d) => d.path === 'workItems[wi-3]' && d.category === 'added')).toBe(
      true,
    );
  });
});
