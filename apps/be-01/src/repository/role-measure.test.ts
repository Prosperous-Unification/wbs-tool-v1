import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { openDatabase, openDrizzle } from './db';
import type { Project, Role, WorkItem } from './index';
import { runMigrations } from './migrate';
import { ProjectRepository } from './project';
import { RoleMeasureRepository } from './role-measure';
import { UserRepository } from './user';
import { WorkItemRepository } from './work-item';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

let dir: string;
let path: string;
let repo: RoleMeasureRepository;
let workItems: WorkItemRepository;
let projectId: string;
let devId: string;
let qaId: string;
let stripId: string;
let sandId: string;

const insertItem = async (id: string, position: number, name: string): Promise<void> => {
  const item: WorkItem = {
    id,
    projectId,
    parentId: null,
    position,
    name,
    notes: '',
    frozenNumber: null,
    priority: null,
    startNoEarlierThan: null,
    serviceTeamId: null,
    serviceId: null,
    maxParallel: 1,
    revision: 0,
  };
  await workItems.insert(item, []);
};

const revisionOf = async (id: string): Promise<number> => {
  const rows = await workItems.listByProject(projectId);
  const found = rows.find((row) => row.id === id);
  if (found === undefined) throw new Error(`${id} is not in the project`);
  return found.revision;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-measure-'));
  path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  const db = openDrizzle(path);
  repo = new RoleMeasureRepository(db);
  workItems = new WorkItemRepository(db);

  const ownerId = crypto.randomUUID();
  await new UserRepository(db).create({
    id: ownerId,
    username: 'owner',
    passwordHash: 'x',
    createdAt: 1,
  });
  projectId = crypto.randomUUID();
  // Ids chosen so that sorting them disagrees with role order, exactly as
  // `actual.test.ts` does: `Dev` runs first and sorts last, so a read that fell
  // back to the primary key's own order hands back `QA` first.
  devId = `z-dev-${crypto.randomUUID()}`;
  qaId = `a-qa-${crypto.randomUUID()}`;
  const project: Project = {
    id: projectId,
    name: 'Rewire the shed',
    ownerId,
    restricted: false,
    estimateMethod: 'pert',
    startDate: null,
    revision: 0,
    createdAt: 1,
  };
  const roles: Role[] = [
    { id: devId, projectId, name: 'Dev', position: 10 },
    { id: qaId, projectId, name: 'QA', position: 20 },
  ];
  await new ProjectRepository(db).create(project, roles);

  stripId = crypto.randomUUID();
  sandId = crypto.randomUUID();
  await insertItem(stripId, 10, 'Strip');
  await insertItem(sandId, 20, 'Sand');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('RoleMeasureRepository', () => {
  it('replaces one pair’s figure in one metric and restamps it, rather than keeping two rows', async () => {
    // The composite primary key is the point: a second token count for the same
    // (work item, role, metric) is a correction, not a second fact. And the
    // stamp moves with it — the column says when *this* number was typed, so a
    // figure corrected today reading as recorded last week is the one thing it
    // must not do.
    await repo.set({
      workItemId: stripId,
      roleId: devId,
      metric: 'token_actual',
      value: 12_000,
      recordedAt: 1_000,
    });

    await repo.set({
      workItemId: stripId,
      roleId: devId,
      metric: 'token_actual',
      value: 48_500,
      recordedAt: 2_000,
    });

    expect(await repo.listByProject(projectId)).toEqual([
      {
        workItemId: stripId,
        roleId: devId,
        metric: 'token_actual',
        value: 48_500,
        recordedAt: 2_000,
      },
    ]);
  });

  it('keeps a pair’s three metrics independent of each other, so correcting the tokens leaves the hours', async () => {
    // D1's absence rule, at the storage layer. This is the case that would pass
    // under the two-column key `estimate` and `actual` use — and it is exactly
    // what a two-column key would destroy: an hours figure silently overwritten
    // by a token correction on the same pair.
    await repo.set({
      workItemId: stripId,
      roleId: devId,
      metric: 'token_estimate',
      value: 40_000,
      recordedAt: 1,
    });
    await repo.set({
      workItemId: stripId,
      roleId: devId,
      metric: 'hours_actual',
      value: 2.5,
      recordedAt: 2,
    });

    await repo.set({
      workItemId: stripId,
      roleId: devId,
      metric: 'token_estimate',
      value: 90_000,
      recordedAt: 3,
    });

    const held = await repo.listByProject(projectId);
    expect(held).toHaveLength(2);
    expect(held).toContainEqual({
      workItemId: stripId,
      roleId: devId,
      metric: 'hours_actual',
      value: 2.5,
      recordedAt: 2,
    });
    expect(held).toContainEqual({
      workItemId: stripId,
      roleId: devId,
      metric: 'token_estimate',
      value: 90_000,
      recordedAt: 3,
    });
  });

  it('removes one work item’s role in one metric, touching neither the other metric, the other role, nor the same pair elsewhere', async () => {
    // All three parts of the condition are load-bearing and each needs its own
    // survivor. With one work item a delete narrowed to the role alone passes;
    // with one metric a delete narrowed to the pair passes. The two-survivor
    // trap `actual.test.ts` records, plus the third the discriminator adds.
    await repo.set({
      workItemId: stripId,
      roleId: devId,
      metric: 'token_actual',
      value: 1,
      recordedAt: 1,
    });
    await repo.set({
      workItemId: stripId,
      roleId: devId,
      metric: 'hours_actual',
      value: 2,
      recordedAt: 2,
    });
    await repo.set({
      workItemId: stripId,
      roleId: qaId,
      metric: 'token_actual',
      value: 3,
      recordedAt: 3,
    });
    await repo.set({
      workItemId: sandId,
      roleId: devId,
      metric: 'token_actual',
      value: 4,
      recordedAt: 4,
    });

    await repo.remove(stripId, devId, 'token_actual');

    const left = await repo.listByProject(projectId);
    expect(left).toHaveLength(3);
    // The same pair in another metric survives — the metric half.
    expect(left).toContainEqual({
      workItemId: stripId,
      roleId: devId,
      metric: 'hours_actual',
      value: 2,
      recordedAt: 2,
    });
    // The other role on this work item — the role half.
    expect(left).toContainEqual({
      workItemId: stripId,
      roleId: qaId,
      metric: 'token_actual',
      value: 3,
      recordedAt: 3,
    });
    // The same role and metric on another work item — the work-item half.
    expect(left).toContainEqual({
      workItemId: sandId,
      roleId: devId,
      metric: 'token_actual',
      value: 4,
      recordedAt: 4,
    });
  });

  it('removing a figure nobody recorded takes nothing away and does not throw', async () => {
    await repo.set({
      workItemId: stripId,
      roleId: qaId,
      metric: 'hours_actual',
      value: 2,
      recordedAt: 2,
    });

    await repo.remove(stripId, devId, 'token_estimate');
    await repo.remove(stripId, devId, 'token_estimate');

    expect(await repo.listByProject(projectId)).toEqual([
      {
        workItemId: stripId,
        roleId: qaId,
        metric: 'hours_actual',
        value: 2,
        recordedAt: 2,
      },
    ]);
  });

  it('keeps zero as a recorded figure, because nobody typing is the absence of a row', async () => {
    // The rule the whole table rests on, asserted at the storage layer rather
    // than only argued in `schema.ts`: 0 is a person saying this cost nothing
    // and it is stored; "nobody has said" is no row at all. A repository that
    // treated 0 as nothing to write would make the two the same sentence.
    await repo.set({
      workItemId: stripId,
      roleId: devId,
      metric: 'hours_actual',
      value: 0,
      recordedAt: 5,
    });

    expect(await repo.listByProject(projectId)).toEqual([
      {
        workItemId: stripId,
        roleId: devId,
        metric: 'hours_actual',
        value: 0,
        recordedAt: 5,
      },
    ]);
  });

  it('reads in role order and then metric order, not in the order the row ids happen to sort', async () => {
    // Two claims, because this table is the first where roles alone are not a
    // total order. The role half is the roll-up's — floating-point addition is
    // not associative, so the order decides a parent's last bit — and the metric
    // half is what keeps two reads of an unchanged pair from disagreeing.
    await repo.set({
      workItemId: stripId,
      roleId: qaId,
      metric: 'token_actual',
      value: 4,
      recordedAt: 1,
    });
    await repo.set({
      workItemId: stripId,
      roleId: devId,
      metric: 'token_estimate',
      value: 1,
      recordedAt: 2,
    });
    await repo.set({
      workItemId: stripId,
      roleId: devId,
      metric: 'hours_actual',
      value: 3,
      recordedAt: 3,
    });

    const held = await repo.listByProject(projectId);

    expect(held.map((each) => [each.roleId, each.metric])).toEqual([
      [devId, 'hours_actual'],
      [devId, 'token_estimate'],
      [qaId, 'token_actual'],
    ]);
  });

  it('answers one project only, so another plan’s figures are never in the list', async () => {
    const otherProject = crypto.randomUUID();
    const otherRole = crypto.randomUUID();
    const otherItem = crypto.randomUUID();
    const db = openDrizzle(path);
    const owner = crypto.randomUUID();
    await new UserRepository(db).create({
      id: owner,
      username: 'other',
      passwordHash: 'x',
      createdAt: 1,
    });
    await new ProjectRepository(db).create(
      {
        id: otherProject,
        name: 'Another shed',
        ownerId: owner,
        restricted: false,
        estimateMethod: 'pert',
        startDate: null,
        revision: 0,
        createdAt: 1,
      },
      [{ id: otherRole, projectId: otherProject, name: 'Dev', position: 10 }],
    );
    await new WorkItemRepository(db).insert(
      {
        id: otherItem,
        projectId: otherProject,
        parentId: null,
        position: 10,
        name: 'Elsewhere',
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
    await repo.set({
      workItemId: otherItem,
      roleId: otherRole,
      metric: 'token_actual',
      value: 9,
      recordedAt: 1,
    });
    await repo.set({
      workItemId: stripId,
      roleId: devId,
      metric: 'token_actual',
      value: 1,
      recordedAt: 1,
    });

    expect(await repo.listByProject(projectId)).toEqual([
      {
        workItemId: stripId,
        roleId: devId,
        metric: 'token_actual',
        value: 1,
        recordedAt: 1,
      },
    ]);
  });

  it('moves the work item’s revision on a write and on a removal', async () => {
    // A measure is a satellite of the work item it is on: nobody holds an id for
    // it, and every reader sees it through that row. A write that left the
    // revision where it was would let a stale undo apply over a figure somebody
    // recorded in between.
    const before = await revisionOf(stripId);

    await repo.set({
      workItemId: stripId,
      roleId: devId,
      metric: 'token_estimate',
      value: 3,
      recordedAt: 1,
    });
    const written = await revisionOf(stripId);
    await repo.remove(stripId, devId, 'token_estimate');
    const removed = await revisionOf(stripId);

    expect(written).toBe(before + 1);
    expect(removed).toBe(before + 2);
  });

  it('moves every metric to another work item, and moves neither revision when there was nothing to move', async () => {
    // Three claims from two ends. The move is what a leaf gaining its first
    // child runs, beside the estimates' and actuals'; it takes *every* metric,
    // because a leaf that gained a child holds figures in no unit; and the
    // silence is what every other create runs, since almost no plan holds
    // measures at all.
    await repo.set({
      workItemId: stripId,
      roleId: devId,
      metric: 'token_actual',
      value: 2,
      recordedAt: 7,
    });
    await repo.set({
      workItemId: stripId,
      roleId: devId,
      metric: 'hours_actual',
      value: 8,
      recordedAt: 9,
    });
    const sandBefore = await revisionOf(sandId);

    await repo.moveAll(stripId, sandId);

    const moved = await repo.listByProject(projectId);
    expect(moved).toHaveLength(2);
    expect(moved.every((each) => each.workItemId === sandId)).toBe(true);
    expect(moved.map((each) => each.metric)).toEqual(['hours_actual', 'token_actual']);
    expect(await revisionOf(sandId)).toBe(sandBefore + 1);

    const quiet = await revisionOf(stripId);
    await repo.moveAll(stripId, sandId);
    expect(await revisionOf(stripId)).toBe(quiet);
  });

  it('goes with the work item it is on, so an old release can still delete one', async () => {
    // `role_measure.work_item_id` cascades, and it is the blue/green window this
    // is for: the outgoing release knows nothing about this table and its plain
    // `DELETE FROM work_item` must not hit a constraint it cannot see.
    await repo.set({
      workItemId: stripId,
      roleId: devId,
      metric: 'token_actual',
      value: 4,
      recordedAt: 1,
    });

    const db = openDatabase(path);
    try {
      db.run('PRAGMA foreign_keys = ON');
      db.run(`DELETE FROM work_item WHERE id = '${stripId}'`);
    } finally {
      db.close();
    }

    expect(await repo.listByProject(projectId)).toEqual([]);
  });

  it('refuses to leave a role that still holds a figure, rather than emptying it quietly', async () => {
    // `role_measure.role_id` deliberately carries **no** cascade, which is what
    // makes a role delete that forgot the measures fail loudly.
    // `RoleRepository.remove` is the caller that will say so explicitly (task
    // 6.3); this is the constraint underneath it, asserted so that a later
    // migration cannot add a cascade without a red test.
    await repo.set({
      workItemId: stripId,
      roleId: devId,
      metric: 'token_actual',
      value: 4,
      recordedAt: 1,
    });

    const db = openDatabase(path);
    try {
      db.run('PRAGMA foreign_keys = ON');
      expect(() => {
        db.run(`DELETE FROM role WHERE id = '${devId}'`);
      }).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      db.close();
    }

    expect(await repo.listByProject(projectId)).toHaveLength(1);
  });
});
