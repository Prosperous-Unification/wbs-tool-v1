import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Project, Step, WorkItem, WriteStamp } from '@wbs/core';
import { workItemRow } from '@wbs/core/testing/work-item-fixture';
import { projectRow } from '@wbs/store-memory/project-fixture';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { openDatabase, openDrizzle } from './db';
import { OPEN } from './gate';
import { runMigrations } from './migrate';
import { ProjectRepository } from './project';
import { StepProgressRepository } from './step-progress';
import { UserRepository } from './user';
import { WorkItemRepository } from './work-item';

const FOLDER = new URL('../../../apps/be-01/drizzle', import.meta.url).pathname;

let dir: string;
let path: string;
let ownerId: string;
let repo: StepProgressRepository;
let workItems: WorkItemRepository;
let projectId: string;
let devId: string;
let qaId: string;
let stripId: string;
let sandId: string;

/**
 * The stamp every write here carries. The account is the project's owner, which
 * the `created_by` foreign key requires to exist; the owner's own signup carries
 * it too, because a new account authors its own row. Not to be read as a
 * statement's `statedAt` — that is when somebody says a step stood where it
 * does, and this is when the row was written.
 */
const wrote = (): WriteStamp => ({ at: 1, by: ownerId });

const insertItem = async (id: string, position: number, name: string): Promise<void> => {
  const item: WorkItem = workItemRow({
    id,
    projectId,
    position,
    name,
  });
  await workItems.insert(item, [], wrote());
};

const revisionOf = async (id: string): Promise<number> => {
  const rows = await workItems.listByProject(projectId);
  const found = rows.find((row) => row.id === id);
  if (found === undefined) throw new Error(`${id} is not in the project`);
  return found.revision;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-step-progress-'));
  path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  const db = openDrizzle(path);
  repo = new StepProgressRepository(db, OPEN);
  workItems = new WorkItemRepository(db, OPEN);

  ownerId = crypto.randomUUID();
  await new UserRepository(db, OPEN).create(
    { id: ownerId, username: 'owner', passwordHash: 'x', createdAt: 1 },
    wrote(),
  );
  projectId = crypto.randomUUID();
  // Ids chosen so that sorting them disagrees with step order, exactly as
  // `estimate.test.ts` and `actual.test.ts` do: `Dev` runs first and sorts last,
  // so a read that fell back to the primary key's own order hands back `QA`
  // first.
  devId = `z-dev-${crypto.randomUUID()}`;
  qaId = `a-qa-${crypto.randomUUID()}`;
  const project: Project = projectRow({
    id: projectId,
    ownerId,
  });
  const steps: Step[] = [
    { id: devId, projectId, name: 'Dev', position: 10 },
    { id: qaId, projectId, name: 'QA', position: 20 },
  ];
  await new ProjectRepository(db, OPEN).create(project, steps, wrote());

  stripId = crypto.randomUUID();
  sandId = crypto.randomUUID();
  await insertItem(stripId, 10, 'Strip');
  await insertItem(sandId, 20, 'Sand');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('StepProgressRepository', () => {
  it('replaces one pair’s state and restamps it, rather than keeping two rows', async () => {
    // The composite primary key is the point: a step going from in progress to
    // done is the same statement corrected, not a second one. And the stamp
    // moves with it — a step said to be done today reading as stated last week
    // is the one thing this column must not do.
    await repo.set(
      { workItemId: stripId, stepId: devId, state: 'in_progress', statedAt: 1_000 },
      wrote(),
    );

    await repo.set({ workItemId: stripId, stepId: devId, state: 'done', statedAt: 2_000 }, wrote());

    expect(await repo.listByProject(projectId)).toEqual([
      { workItemId: stripId, stepId: devId, state: 'done', statedAt: 2_000 },
    ]);
  });

  it('removes one work item’s step without touching the other step or the same step elsewhere', async () => {
    // Both halves of the condition are load-bearing and each needs its own
    // survivor. With one work item, a delete narrowed to the step alone — which
    // would clear that step's state on every work item in the database — passes.
    // The same trap `estimate.test.ts` and `actual.test.ts` record.
    await repo.set({ workItemId: stripId, stepId: devId, state: 'done', statedAt: 1 }, wrote());
    await repo.set(
      { workItemId: stripId, stepId: qaId, state: 'in_progress', statedAt: 2 },
      wrote(),
    );
    await repo.set({ workItemId: sandId, stepId: devId, state: 'done', statedAt: 3 }, wrote());

    await repo.remove(stripId, devId, wrote());

    const left = await repo.listByProject(projectId);
    expect(left).toHaveLength(2);
    // The same step on another work item survives — the work-item half.
    expect(left).toContainEqual({
      workItemId: sandId,
      stepId: devId,
      state: 'done',
      statedAt: 3,
    });
    // The other step on this one — the step half.
    expect(left).toContainEqual({
      workItemId: stripId,
      stepId: qaId,
      state: 'in_progress',
      statedAt: 2,
    });
  });

  it('removing a statement nobody made takes nothing away and does not throw', async () => {
    await repo.set({ workItemId: stripId, stepId: qaId, state: 'done', statedAt: 2 }, wrote());

    await repo.remove(stripId, devId, wrote());
    await repo.remove(stripId, devId, wrote());

    expect(await repo.listByProject(projectId)).toEqual([
      { workItemId: stripId, stepId: qaId, state: 'done', statedAt: 2 },
    ]);
  });

  it('refuses a state outside the two a step may be stored in', async () => {
    // The `CHECK` is the closed set the whole design rests on, and it is here
    // rather than only in the type because a hand-edit, a stale release or a
    // future mistake would otherwise write a value every reader dispatches on
    // and nothing folds. `not_started` is refused with the rest: it is the
    // absence of a row, and a row saying it would be a second spelling.
    const db = openDatabase(path);
    try {
      db.run('PRAGMA foreign_keys = ON');
      for (const state of ['not_started', 'blocked', 'cancelled', '']) {
        expect(() => {
          db.run(
            `INSERT INTO step_progress (work_item_id, step_id, state, stated_at) VALUES ('${stripId}', '${devId}', '${state}', 1)`,
          );
        }).toThrow(/CHECK constraint failed/);
      }
    } finally {
      db.close();
    }

    expect(await repo.listByProject(projectId)).toEqual([]);
  });

  it('reads a work item’s states in step order, not in the order the row ids happen to sort', async () => {
    // The order is not a contract about the fold — `agree` is commutative, so
    // unlike a sum of reals it cannot change the answer — it is a contract about
    // the screen: these have to line up with the estimates and the actuals
    // beside them, which come back in this same order.
    await repo.set({ workItemId: stripId, stepId: qaId, state: 'done', statedAt: 1 }, wrote());
    await repo.set(
      { workItemId: stripId, stepId: devId, state: 'in_progress', statedAt: 2 },
      wrote(),
    );

    const held = await repo.listByProject(projectId);

    expect(held.map((each) => each.stepId)).toEqual([devId, qaId]);
  });

  it('answers one project only, so another plan’s statements are never in the list', async () => {
    const otherProject = crypto.randomUUID();
    const otherStep = crypto.randomUUID();
    const otherItem = crypto.randomUUID();
    const db = openDrizzle(path);
    const owner = crypto.randomUUID();
    // The other plan is the other owner's, so its rows are attributed to them.
    const wroteElsewhere: WriteStamp = { at: 1, by: owner };
    await new UserRepository(db, OPEN).create(
      { id: owner, username: 'other', passwordHash: 'x', createdAt: 1 },
      wroteElsewhere,
    );
    await new ProjectRepository(db, OPEN).create(
      projectRow({
        id: otherProject,
        name: 'Another shed',
        ownerId: owner,
      }),
      [{ id: otherStep, projectId: otherProject, name: 'Dev', position: 10 }],
      wroteElsewhere,
    );
    await new WorkItemRepository(db, OPEN).insert(
      workItemRow({
        id: otherItem,
        projectId: otherProject,
        position: 10,
        name: 'Elsewhere',
      }),
      [],
      wroteElsewhere,
    );
    await repo.set(
      { workItemId: otherItem, stepId: otherStep, state: 'done', statedAt: 1 },
      wroteElsewhere,
    );
    await repo.set({ workItemId: stripId, stepId: devId, state: 'done', statedAt: 1 }, wrote());

    expect(await repo.listByProject(projectId)).toEqual([
      { workItemId: stripId, stepId: devId, state: 'done', statedAt: 1 },
    ]);
  });

  it('moves the work item’s revision on a write and on a removal', async () => {
    // A statement is a satellite of the work item it is on: nobody holds an id
    // for it, and every reader sees it through that row. A write that left the
    // revision where it was would let a stale undo apply over a statement
    // somebody made in between.
    const before = await revisionOf(stripId);

    await repo.set(
      { workItemId: stripId, stepId: devId, state: 'in_progress', statedAt: 1 },
      wrote(),
    );
    const written = await revisionOf(stripId);
    await repo.remove(stripId, devId, wrote());
    const removed = await revisionOf(stripId);

    expect(written).toBe(before + 1);
    expect(removed).toBe(before + 2);
  });

  it('moves every statement to another work item, and moves neither revision when there was nothing to move', async () => {
    // Two claims in one case because they are the same statement from both
    // ends. The move is what a leaf gaining its first child runs, beside the
    // estimates' and the actuals'; the silence is what every other create runs,
    // and almost every plan has nothing stated at all.
    await repo.set({ workItemId: stripId, stepId: devId, state: 'done', statedAt: 7 }, wrote());
    const sandBefore = await revisionOf(sandId);

    await repo.moveAll(stripId, sandId, wrote());

    expect(await repo.listByProject(projectId)).toEqual([
      { workItemId: sandId, stepId: devId, state: 'done', statedAt: 7 },
    ]);
    expect(await revisionOf(sandId)).toBe(sandBefore + 1);

    const quiet = await revisionOf(stripId);
    await repo.moveAll(stripId, sandId, wrote());
    expect(await revisionOf(stripId)).toBe(quiet);
  });

  it('goes with the work item it is on, so an old release can still delete one', async () => {
    // `step_progress.work_item_id` cascades, and it is the blue/green window
    // this is for: the outgoing release knows nothing about this table and its
    // plain `DELETE FROM work_item` must not hit a constraint it cannot see.
    await repo.set({ workItemId: stripId, stepId: devId, state: 'done', statedAt: 1 }, wrote());

    const db = openDatabase(path);
    try {
      db.run('PRAGMA foreign_keys = ON');
      db.run(`DELETE FROM work_item WHERE id = '${stripId}'`);
    } finally {
      db.close();
    }

    expect(await repo.listByProject(projectId)).toEqual([]);
  });

  it('refuses to leave a step that has been said to be done, rather than emptying it quietly', async () => {
    // `step_progress.step_id` deliberately carries **no** cascade, which is what
    // makes a step delete that forgot the statements fail loudly.
    // `StepRepository.remove` is the caller that says so explicitly; this is the
    // constraint underneath it, asserted so that a later migration cannot add a
    // cascade without a red test.
    await repo.set({ workItemId: stripId, stepId: devId, state: 'done', statedAt: 1 }, wrote());

    const db = openDatabase(path);
    try {
      db.run('PRAGMA foreign_keys = ON');
      expect(() => {
        db.run(`DELETE FROM step WHERE id = '${devId}'`);
      }).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      db.close();
    }

    expect(await repo.listByProject(projectId)).toHaveLength(1);
  });
});
