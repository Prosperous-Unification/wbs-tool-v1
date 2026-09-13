import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Project, Step, WorkItem, WriteStamp } from '@wbs/core';
import { workItemRow } from '@wbs/core/testing/work-item-fixture';
import { projectRow } from '@wbs/store-memory/project-fixture';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { openDrizzle } from './db';
import { EstimateRepository } from './estimate';
import { OPEN } from './gate';
import { runMigrations } from './migrate';
import { ProjectRepository } from './project';
import { UserRepository } from './user';
import { WorkItemRepository } from './work-item';

const FOLDER = new URL('../../../apps/be-01/drizzle', import.meta.url).pathname;

let dir: string;
let repo: EstimateRepository;
let ownerId: string;
let projectId: string;
let devId: string;
let qaId: string;
let stripId: string;
let sandId: string;

/**
 * The stamp every write here carries. The account is the project's owner, which
 * the `created_by` foreign key requires to exist; the owner's own signup carries
 * it too, because a new account authors its own row.
 */
const wrote = (): WriteStamp => ({ at: 1, by: ownerId });

/** A plausible trio; the figures are not the subject of the reference cases. */
const DAYS = { optimistic: 1, realistic: 2, pessimistic: 3 };

const insertItem = async (
  workItems: WorkItemRepository,
  id: string,
  position: number,
  name: string,
): Promise<void> => {
  const item: WorkItem = workItemRow({
    id,
    projectId,
    position,
    name,
  });
  await workItems.insert(item, [], wrote());
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-estimate-'));
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  const db = openDrizzle(path);
  repo = new EstimateRepository(db, OPEN);
  const workItems = new WorkItemRepository(db, OPEN);

  ownerId = crypto.randomUUID();
  await new UserRepository(db, OPEN).create(
    { id: ownerId, username: 'owner', passwordHash: 'x', createdAt: 1 },
    wrote(),
  );
  projectId = crypto.randomUUID();
  // Ids chosen so that sorting them disagrees with step order: `Dev` runs first
  // and sorts last. Random UUIDs would agree by luck about half the time, and a
  // read that fell back to the primary key's own order would pass on those runs.
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
  await insertItem(workItems, stripId, 10, 'Strip');
  await insertItem(workItems, sandId, 20, 'Sand');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('EstimateRepository', () => {
  it('removes one work item’s step without touching the other step or the same step elsewhere', async () => {
    // Both halves of the condition are load-bearing and each needs its own
    // survivor. With one work item, a delete narrowed to the step alone —
    // which would clear that step on every work item in the database — passes.
    // The same trap `directory.test.ts` records for `assign(…, null)`.
    await repo.set(
      {
        workItemId: stripId,
        stepId: devId,
        optimistic: 1,
        realistic: 2,
        pessimistic: 3,
      },
      wrote(),
    );
    await repo.set(
      {
        workItemId: stripId,
        stepId: qaId,
        optimistic: 4,
        realistic: 5,
        pessimistic: 6,
      },
      wrote(),
    );
    await repo.set(
      {
        workItemId: sandId,
        stepId: devId,
        optimistic: 7,
        realistic: 8,
        pessimistic: 9,
      },
      wrote(),
    );

    await repo.remove(stripId, devId, wrote());

    const left = await repo.listByProject(projectId);
    expect(left).toHaveLength(2);
    // The same step on another work item survives — the work-item half.
    expect(left).toContainEqual({
      workItemId: sandId,
      stepId: devId,
      optimistic: 7,
      realistic: 8,
      pessimistic: 9,
    });
    // The other step on this one — the step half.
    expect(left).toContainEqual({
      workItemId: stripId,
      stepId: qaId,
      optimistic: 4,
      realistic: 5,
      pessimistic: 6,
    });
  });

  it('removing an estimate that was never stored takes nothing away and does not throw', async () => {
    // Clearing twice is the ordinary path: a person empties three boxes, the
    // tree refreshes, and they empty them again. The state asked for is the
    // state left, so the second call is a success rather than a 404.
    await repo.set(
      {
        workItemId: stripId,
        stepId: qaId,
        optimistic: 4,
        realistic: 5,
        pessimistic: 6,
      },
      wrote(),
    );

    await repo.remove(stripId, devId, wrote());
    await repo.remove(stripId, devId, wrote());

    expect(await repo.listByProject(projectId)).toEqual([
      { workItemId: stripId, stepId: qaId, optimistic: 4, realistic: 5, pessimistic: 6 },
    ]);
  });

  it('reads a work item’s estimates in step order, not in the order the row ids happen to sort', async () => {
    // The order is a contract because the schedule's adapter adds these up per
    // work item, and floating-point addition is not associative: three steps
    // summed in two orders can differ in the last bit, and a finish is read
    // through `Math.ceil`, so that bit is a day on the screen. `Dev` runs first
    // here and its id sorts last, so a read falling back to the primary key
    // would hand back `QA` first.
    await repo.set(
      {
        workItemId: stripId,
        stepId: qaId,
        optimistic: 4,
        realistic: 5,
        pessimistic: 6,
      },
      wrote(),
    );
    await repo.set(
      {
        workItemId: stripId,
        stepId: devId,
        optimistic: 1,
        realistic: 2,
        pessimistic: 3,
      },
      wrote(),
    );

    const held = await repo.listByProject(projectId);

    expect(held.map((each) => each.stepId)).toEqual([devId, qaId]);
  });

  it('reads a project’s estimates in one statement, with no parameter per row', async () => {
    // The four satellite reads were two statements each until 2026-09-02: every
    // work item id, then `IN (…)` over the lot. Twenty work items rather than
    // two, because the fault is a bound parameter per row and at two rows "one
    // parameter" and "one per row" differ by one.
    //
    // Both halves matter. The count rules out the second query coming back, and
    // the SQL check rules out an `IN` list wearing a join's clothes: a plan of
    // 33,000 rows would exceed SQLite's parameter ceiling and refuse the read
    // outright, and the ceiling is not something a test on this machine can
    // reach.
    //
    // Proof: the join replaced by the two-query shape it had before, watched
    // failing on `expect(received).toHaveLength(expected) · Expected length: 1
    // · Received length: 2`; and with the project's own `where` written as
    // `inArray(workItem.projectId, [projectId])` — one statement, an `IN` list
    // of one — on `Expected to not contain: "in ("`. Observed 2026-09-02.
    const workItems = new WorkItemRepository(openDrizzle(join(dir, 'test.db')), OPEN);
    for (let made = 0; made < 20; made += 1) {
      const id = `row-${String(made)}`;
      await insertItem(workItems, id, 100 + made, `Row ${String(made)}`);
      await repo.set(
        { workItemId: id, stepId: devId, optimistic: 1, realistic: 2, pessimistic: 3 },
        wrote(),
      );
    }
    const statements: string[] = [];
    const counted = new EstimateRepository(
      openDrizzle(join(dir, 'test.db'), {
        logQuery(query) {
          statements.push(query);
        },
      }),
      OPEN,
    );

    const held = await counted.listByProject(projectId);

    // The precondition: a read that answered nothing would also cost one
    // statement, and the count would prove nothing about the join.
    expect(held).toHaveLength(20);
    expect(statements).toHaveLength(1);
    expect(statements[0]).not.toContain('in (');
  });
});

/**
 * D6: a reference-specific outcome, said by the method it happened in.
 *
 * SQLite answers `FOREIGN KEY constraint failed` and names no column, so a
 * caller cannot tell a step that has gone from a work item that has. The store
 * can: it re-reads the step it just named, and only when that row is missing is
 * the refusal the step's. Anything else is an invariant nothing should have
 * been able to break, and is thrown.
 */
describe('what a broken reference means', () => {
  it('answers unknown_step for a step that has gone, and throws for anything else', async () => {
    // The step is gone, the work item is there: the modeled outcome.
    expect(await repo.set({ workItemId: stripId, stepId: 'no-such-step', ...DAYS }, wrote())).toBe(
      'unknown_step',
    );

    // The work item is gone, the step is there: an unknown, and thrown.
    // Proof: the step re-read in `writingStep` bypassed (`rows.length > 0 &&
    // false`), so every foreign key reads as the step's — this case failed on
    // `Expected promise that rejects · Received promise that resolved` — an
    // absent **work item** reported to the caller as an absent step, and
    // nothing thrown at all. Watched 2026-09-08. The message asserted on is
    // drizzle's wrapper rather than SQLite's own `FOREIGN KEY constraint
    // failed`, which it carries as the cause; what the case is about is that
    // this reaches the caller as a fault rather than as a refusal.
    const orphaned = repo.set({ workItemId: 'no-such-work-item', stepId: devId, ...DAYS }, wrote());
    expect(orphaned).rejects.toThrow(/insert into "estimate"/);
    await orphaned.catch(() => undefined);
  });
});
