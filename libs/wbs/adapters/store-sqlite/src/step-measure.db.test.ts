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
import { StepMeasureRepository } from './step-measure';
import { UserRepository } from './user';
import { WorkItemRepository } from './work-item';

const FOLDER = new URL('../../../apps/be-01/drizzle', import.meta.url).pathname;

let dir: string;
let path: string;
let ownerId: string;
let repo: StepMeasureRepository;
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
 * measure's `recordedAt` — that is the moment the figure is about, and this is
 * when the row was written.
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
  dir = mkdtempSync(join(tmpdir(), 'wbs-measure-'));
  path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  const db = openDrizzle(path);
  repo = new StepMeasureRepository(db, OPEN);
  workItems = new WorkItemRepository(db, OPEN);

  ownerId = crypto.randomUUID();
  await new UserRepository(db, OPEN).create(
    { id: ownerId, username: 'owner', passwordHash: 'x', createdAt: 1 },
    wrote(),
  );
  projectId = crypto.randomUUID();
  // Ids chosen so that sorting them disagrees with step order, exactly as
  // `actual.test.ts` does: `Dev` runs first and sorts last, so a read that fell
  // back to the primary key's own order hands back `QA` first.
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

describe('StepMeasureRepository', () => {
  it('replaces one pair’s figure in one metric and restamps it, rather than keeping two rows', async () => {
    // The composite primary key is the point: a second token count for the same
    // (work item, step, metric) is a correction, not a second fact. And the
    // stamp moves with it — the column says when *this* number was typed, so a
    // figure corrected today reading as recorded last week is the one thing it
    // must not do.
    await repo.set(
      {
        workItemId: stripId,
        stepId: devId,
        metric: 'token_actual',
        value: 12_000,
        recordedAt: 1_000,
      },
      wrote(),
    );

    await repo.set(
      {
        workItemId: stripId,
        stepId: devId,
        metric: 'token_actual',
        value: 48_500,
        recordedAt: 2_000,
      },
      wrote(),
    );

    expect(await repo.listByProject(projectId)).toEqual([
      {
        workItemId: stripId,
        stepId: devId,
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
    await repo.set(
      {
        workItemId: stripId,
        stepId: devId,
        metric: 'token_estimate',
        value: 40_000,
        recordedAt: 1,
      },
      wrote(),
    );
    await repo.set(
      {
        workItemId: stripId,
        stepId: devId,
        metric: 'hours_actual',
        value: 2.5,
        recordedAt: 2,
      },
      wrote(),
    );

    await repo.set(
      {
        workItemId: stripId,
        stepId: devId,
        metric: 'token_estimate',
        value: 90_000,
        recordedAt: 3,
      },
      wrote(),
    );

    const held = await repo.listByProject(projectId);
    expect(held).toHaveLength(2);
    expect(held).toContainEqual({
      workItemId: stripId,
      stepId: devId,
      metric: 'hours_actual',
      value: 2.5,
      recordedAt: 2,
    });
    expect(held).toContainEqual({
      workItemId: stripId,
      stepId: devId,
      metric: 'token_estimate',
      value: 90_000,
      recordedAt: 3,
    });
  });

  it('removes one work item’s step in one metric, touching neither the other metric, the other step, nor the same pair elsewhere', async () => {
    // All three parts of the condition are load-bearing and each needs its own
    // survivor. With one work item a delete narrowed to the step alone passes;
    // with one metric a delete narrowed to the pair passes. The two-survivor
    // trap `actual.test.ts` records, plus the third the discriminator adds.
    await repo.set(
      {
        workItemId: stripId,
        stepId: devId,
        metric: 'token_actual',
        value: 1,
        recordedAt: 1,
      },
      wrote(),
    );
    await repo.set(
      {
        workItemId: stripId,
        stepId: devId,
        metric: 'hours_actual',
        value: 2,
        recordedAt: 2,
      },
      wrote(),
    );
    await repo.set(
      {
        workItemId: stripId,
        stepId: qaId,
        metric: 'token_actual',
        value: 3,
        recordedAt: 3,
      },
      wrote(),
    );
    await repo.set(
      {
        workItemId: sandId,
        stepId: devId,
        metric: 'token_actual',
        value: 4,
        recordedAt: 4,
      },
      wrote(),
    );

    await repo.remove(stripId, devId, 'token_actual', wrote());

    const left = await repo.listByProject(projectId);
    expect(left).toHaveLength(3);
    // The same pair in another metric survives — the metric half.
    expect(left).toContainEqual({
      workItemId: stripId,
      stepId: devId,
      metric: 'hours_actual',
      value: 2,
      recordedAt: 2,
    });
    // The other step on this work item — the step half.
    expect(left).toContainEqual({
      workItemId: stripId,
      stepId: qaId,
      metric: 'token_actual',
      value: 3,
      recordedAt: 3,
    });
    // The same step and metric on another work item — the work-item half.
    expect(left).toContainEqual({
      workItemId: sandId,
      stepId: devId,
      metric: 'token_actual',
      value: 4,
      recordedAt: 4,
    });
  });

  it('removing a figure nobody recorded takes nothing away and does not throw', async () => {
    await repo.set(
      {
        workItemId: stripId,
        stepId: qaId,
        metric: 'hours_actual',
        value: 2,
        recordedAt: 2,
      },
      wrote(),
    );

    await repo.remove(stripId, devId, 'token_estimate', wrote());
    await repo.remove(stripId, devId, 'token_estimate', wrote());

    expect(await repo.listByProject(projectId)).toEqual([
      {
        workItemId: stripId,
        stepId: qaId,
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
    await repo.set(
      {
        workItemId: stripId,
        stepId: devId,
        metric: 'hours_actual',
        value: 0,
        recordedAt: 5,
      },
      wrote(),
    );

    expect(await repo.listByProject(projectId)).toEqual([
      {
        workItemId: stripId,
        stepId: devId,
        metric: 'hours_actual',
        value: 0,
        recordedAt: 5,
      },
    ]);
  });

  it('reads in step order and then metric order, not in the order the row ids happen to sort', async () => {
    // Two claims, because this table is the first where steps alone are not a
    // total order. The step half is the roll-up's — floating-point addition is
    // not associative, so the order decides a parent's last bit — and the metric
    // half is what keeps two reads of an unchanged pair from disagreeing.
    await repo.set(
      {
        workItemId: stripId,
        stepId: qaId,
        metric: 'token_actual',
        value: 4,
        recordedAt: 1,
      },
      wrote(),
    );
    await repo.set(
      {
        workItemId: stripId,
        stepId: devId,
        metric: 'token_estimate',
        value: 1,
        recordedAt: 2,
      },
      wrote(),
    );
    await repo.set(
      {
        workItemId: stripId,
        stepId: devId,
        metric: 'hours_actual',
        value: 3,
        recordedAt: 3,
      },
      wrote(),
    );

    const held = await repo.listByProject(projectId);

    expect(held.map((each) => [each.stepId, each.metric])).toEqual([
      [devId, 'hours_actual'],
      [devId, 'token_estimate'],
      [qaId, 'token_actual'],
    ]);
  });

  it('answers one project only, so another plan’s figures are never in the list', async () => {
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
      {
        workItemId: otherItem,
        stepId: otherStep,
        metric: 'token_actual',
        value: 9,
        recordedAt: 1,
      },
      wroteElsewhere,
    );
    await repo.set(
      {
        workItemId: stripId,
        stepId: devId,
        metric: 'token_actual',
        value: 1,
        recordedAt: 1,
      },
      wrote(),
    );

    expect(await repo.listByProject(projectId)).toEqual([
      {
        workItemId: stripId,
        stepId: devId,
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

    await repo.set(
      {
        workItemId: stripId,
        stepId: devId,
        metric: 'token_estimate',
        value: 3,
        recordedAt: 1,
      },
      wrote(),
    );
    const written = await revisionOf(stripId);
    await repo.remove(stripId, devId, 'token_estimate', wrote());
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
    await repo.set(
      {
        workItemId: stripId,
        stepId: devId,
        metric: 'token_actual',
        value: 2,
        recordedAt: 7,
      },
      wrote(),
    );
    await repo.set(
      {
        workItemId: stripId,
        stepId: devId,
        metric: 'hours_actual',
        value: 8,
        recordedAt: 9,
      },
      wrote(),
    );
    const sandBefore = await revisionOf(sandId);

    await repo.moveAll(stripId, sandId, wrote());

    const moved = await repo.listByProject(projectId);
    expect(moved).toHaveLength(2);
    expect(moved.every((each) => each.workItemId === sandId)).toBe(true);
    expect(moved.map((each) => each.metric)).toEqual(['hours_actual', 'token_actual']);
    expect(await revisionOf(sandId)).toBe(sandBefore + 1);

    const quiet = await revisionOf(stripId);
    await repo.moveAll(stripId, sandId, wrote());
    expect(await revisionOf(stripId)).toBe(quiet);
  });

  it('goes with the work item it is on, so an old release can still delete one', async () => {
    // `step_measure.work_item_id` cascades, and it is the blue/green window this
    // is for: the outgoing release knows nothing about this table and its plain
    // `DELETE FROM work_item` must not hit a constraint it cannot see.
    await repo.set(
      {
        workItemId: stripId,
        stepId: devId,
        metric: 'token_actual',
        value: 4,
        recordedAt: 1,
      },
      wrote(),
    );

    const db = openDatabase(path);
    try {
      db.run('PRAGMA foreign_keys = ON');
      db.run(`DELETE FROM work_item WHERE id = '${stripId}'`);
    } finally {
      db.close();
    }

    expect(await repo.listByProject(projectId)).toEqual([]);
  });

  it('refuses to leave a step that still holds a figure, rather than emptying it quietly', async () => {
    // `step_measure.step_id` deliberately carries **no** cascade, which is what
    // makes a step delete that forgot the measures fail loudly.
    // `StepRepository.remove` is the caller that will say so explicitly (task
    // 6.3); this is the constraint underneath it, asserted so that a later
    // migration cannot add a cascade without a red test.
    await repo.set(
      {
        workItemId: stripId,
        stepId: devId,
        metric: 'token_actual',
        value: 4,
        recordedAt: 1,
      },
      wrote(),
    );

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
