import { mkdtempSync, rmSync } from 'node:fs';
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
import { projectRow } from '../testing/project-fixture';
import { SavedPlanService } from './saved-plan.service';
import type { SavedPlanQuota } from './saved-plan-quota';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

const wrote: WriteStamp = { at: 1, by: 'owner' };

const OPENED_AT = 1_756_000_123;

/** Room enough that only the one limit under test can be the reason. */
const ROOMY: SavedPlanQuota = {
  mostBytesPerBody: 8 * 1024 * 1024,
  mostPlansPerProject: 100,
  mostBytesPerProject: 64 * 1024 * 1024,
};

describe('SavedPlanService.save refuses each limit before writing anything', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'wbs-saved-plan-quota-'));
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

  let issued = 0;

  /**
   * A service under `quota`, with a fresh id per save.
   *
   * Distinct ids matter: two records is the state several of these cases have to
   * reach, and a reused id would refuse on the primary key rather than on the
   * limit under test — a green assertion for the wrong reason.
   */
  const service = (quota: SavedPlanQuota): SavedPlanService => {
    issued += 1;
    const n = issued;
    return new SavedPlanService({
      capture: new SavedPlanCaptureRepository({ openConnection: () => openConnection(path) }),
      plans: new SavedPlanRepository({ openConnection: () => openConnection(path) }),
      newId: () => 'sp-' + String(n),
      now: () => OPENED_AT,
      quota,
    });
  };

  const save = (quota: SavedPlanQuota) =>
    service(quota).save({
      projectId: 'p1',
      name: 'once more',
      createdBy: 'Ada Lovelace',
      createdById: null,
    });

  const headers = () => reader.db.select().from(savedPlan);
  const bodies = () => reader.db.select().from(savedPlanBody);

  it('refuses a body over the byte limit, naming it, with nothing written at all', async () => {
    const result = await save({ ...ROOMY, mostBytesPerBody: 8 });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.refusal.limit).toBe('body_bytes');
    expect(result.refusal.allowed).toBe(8);
    // Asked is the input body's real size, so the message a caller renders is
    // about their plan and not about a constant.
    expect(result.refusal.asked).toBeGreaterThan(8);
    // Nothing at all: this limit is checked before `BEGIN IMMEDIATE`, so the
    // write transaction never opens, and the two tables are as the migration
    // left them.
    expect(await headers()).toEqual([]);
    expect(await bodies()).toEqual([]);
  });

  it('refuses the plan over the count limit, naming it, leaving the held record alone', async () => {
    const quota = { ...ROOMY, mostPlansPerProject: 1 };
    expect((await save(quota)).outcome).toBe('saved');
    const held = await bodies();

    const refused = await save(quota);

    expect(refused.outcome).toBe('refused');
    if (refused.outcome !== 'refused') return;
    expect(refused.refusal.limit).toBe('plan_count');
    // Against the state **after** the save it asked for: one held, this would
    // be the second, and the limit is one.
    expect(refused.refusal.asked).toBe(2);
    expect(refused.refusal.allowed).toBe(1);
    // The no-partial-record assertion, and the one the negative below breaks:
    // the refusal happens inside an open write transaction, so a header written
    // before the check would survive here.
    expect((await headers()).length).toBe(1);
    expect(await bodies()).toEqual(held);
  });

  it('refuses the plan over the project byte total, naming it, leaving the held record alone', async () => {
    // The limit is set from what one save of *this* plan actually costs, so the
    // second save is over it by exactly its own size and the arithmetic below is
    // checkable rather than approximate. Both saves capture the same unchanged
    // plan, so the incoming bytes equal the held bytes.
    const first = await save(ROOMY);
    if (first.outcome !== 'saved') throw new Error('expected the first save to land');
    const rows = await headers();
    expect(rows.length).toBe(1);
    const oneSave = rows[0].inputBytes + (rows[0].scheduleBytes ?? 0);
    const held = await bodies();

    const refused = await save({ ...ROOMY, mostBytesPerProject: oneSave });

    expect(refused.outcome).toBe('refused');
    if (refused.outcome !== 'refused') return;
    expect(refused.refusal.limit).toBe('project_bytes');
    expect(refused.refusal.allowed).toBe(oneSave);
    // Held plus incoming, not incoming alone: a check against the current total
    // by itself admits one body of any size onto a project one byte under.
    expect(refused.refusal.asked).toBe(oneSave * 2);
    expect((await headers()).length).toBe(1);
    expect(await bodies()).toEqual(held);
  });

  it('names the count when a project is over both the count and the byte total', async () => {
    // Both bounds reached at once is still one refusal, and the one worth
    // naming is the count: it is the one the project is still over after
    // deleting a single plan. Without this the order of the two checks is
    // unasserted and either order passes.
    const first = await save(ROOMY);
    if (first.outcome !== 'saved') throw new Error('expected the first save to land');
    const rows = await headers();
    const oneSave = rows[0].inputBytes + (rows[0].scheduleBytes ?? 0);

    const refused = await save({
      ...ROOMY,
      mostPlansPerProject: 1,
      mostBytesPerProject: oneSave,
    });

    expect(refused.outcome).toBe('refused');
    if (refused.outcome !== 'refused') return;
    expect(refused.refusal.limit).toBe('plan_count');
  });
});
