import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { personAdded } from '../testing/directory-fixture';
import { openDatabase, openDrizzle } from './db';
import { DependencyRepository } from './dependency';
import { DirectoryRepository } from './directory';
import { EstimateRepository } from './estimate';
import type { SubtreeCopy, WorkItem } from './index';
import { runMigrations } from './migrate';
import { ProjectRepository } from './project';
import { UserRepository } from './user';
import { SubtreeRepository, WorkItemRepository } from './work-item';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

let dir: string;
let dbPath: string;
let repo: WorkItemRepository;
let subtrees: SubtreeRepository;
let estimates: EstimateRepository;
let dependencies: DependencyRepository;
let directory: DirectoryRepository;
let projectId: string;
let roleId: string;
let personId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-work-item-'));
  dbPath = join(dir, 'test.db');
  runMigrations(dbPath, FOLDER);
  const db = openDrizzle(dbPath);
  repo = new WorkItemRepository(db);
  subtrees = new SubtreeRepository(db);
  estimates = new EstimateRepository(db);
  dependencies = new DependencyRepository(db);
  directory = new DirectoryRepository(db);

  const ownerId = crypto.randomUUID();
  await new UserRepository(db).create({
    id: ownerId,
    username: 'owner',
    passwordHash: 'x',
    createdAt: 1,
  });
  projectId = crypto.randomUUID();
  roleId = crypto.randomUUID();
  await new ProjectRepository(db).create(
    {
      id: projectId,
      name: 'Rewire the shed',
      ownerId,
      restricted: false,
      estimateMethod: 'pert',
      startDate: null,
      revision: 0,
      createdAt: 1,
    },
    [{ id: roleId, projectId, name: 'Dev', position: 10 }],
  );
  personId = (await personAdded(directory.addPerson({ id: crypto.randomUUID(), name: 'Ada' }, [])))
    .id;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function row(parentId: string | null, position: number, name: string): WorkItem {
  return {
    id: crypto.randomUUID(),
    projectId,
    parentId,
    position,
    name,
    notes: '',
    frozenNumber: null,
    priority: null,
    startNoEarlierThan: null,
    startNoEarlierThanReason: null,
    serviceTeamId: null,
    serviceId: null,
    maxParallel: 1,
    revision: 0,
  };
}

const byPosition = (items: WorkItem[]) =>
  [...items].sort((a, b) => a.position - b.position).map((w) => w.name);

/** A team in the global directory, since a join row has to point at a real one. */
async function team(name: string): Promise<string> {
  return (await directory.addTeam({ id: crypto.randomUUID(), name })).id;
}

/**
 * The join table as it stands, ordered, read on a connection of its own.
 *
 * Its own connection because the repository's writes are what is under test:
 * reading them back through the same drizzle client would prove the object in
 * front of the database and not the database.
 */
function joinedTeams(): { workItemId: string; teamId: string }[] {
  const db = openDatabase(dbPath);
  try {
    return db
      .query<
        { workItemId: string; teamId: string },
        []
      >('SELECT work_item_id AS workItemId, team_id AS teamId FROM work_item_team ORDER BY work_item_id, team_id')
      .all();
  } finally {
    db.close();
  }
}

/** A join row written directly, which is the only way to state two teams until R2-4. */
function joinTeam(workItemId: string, teamId: string): void {
  const db = openDatabase(dbPath);
  try {
    db.run('INSERT INTO work_item_team (work_item_id, team_id) VALUES (?, ?)', [
      workItemId,
      teamId,
    ]);
  } finally {
    db.close();
  }
}

/**
 * A service in the global directory, written directly because the directory's
 * own write path for services does not exist until section 4.
 *
 * Directly rather than through a repository for the same reason {@link joinTeam}
 * is: the read is what is under test here, and a write path that does not exist
 * yet cannot be the thing that sets it up.
 */
function service(name: string): string {
  const id = crypto.randomUUID();
  const db = openDatabase(dbPath);
  try {
    db.run('INSERT INTO service (id, name) VALUES (?, ?)', [id, name]);
  } finally {
    db.close();
  }
  return id;
}

/**
 * The services on a row, written directly into the join.
 *
 * The column is deliberately untouched by this helper since task 10.2 — a test
 * that seeded `work_item.service_id` would be seeding the outgoing release's
 * copy and then asserting this release reads it, which is the one thing D2 says
 * it must not do.
 */
function labelServices(workItemId: string, serviceIds: readonly string[]): void {
  const db = openDatabase(dbPath);
  try {
    db.run('DELETE FROM work_item_service WHERE work_item_id = ?', [workItemId]);
    for (const serviceId of serviceIds) {
      db.run('INSERT INTO work_item_service (work_item_id, service_id) VALUES (?, ?)', [
        workItemId,
        serviceId,
      ]);
    }
  } finally {
    db.close();
  }
}

describe('the services on the row', () => {
  it('reads every service on the row back, in one order', async () => {
    // Task 10.2: the dimension is `work_item_service` and `listByProject` reads
    // it as a fourth indexed query — the tag join's shape. Two services, because
    // one would pass just as well against a read that took the first row and
    // stopped, which is exactly what the column it replaced did.
    //
    // Ordered by service id and asserted sorted for `teamIds`' reason: two reads
    // of an unchanged plan must answer the same array (D6).
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, []);
    const payments = service('Payments');
    const billing = service('Billing');
    labelServices(strip.id, [payments, billing]);

    const read = await repo.listByProject(projectId);

    expect(read.at(0)?.serviceIds).toEqual([payments, billing].sort());
  });

  it('leaves a work item nobody labelled on an empty set, which is the state that inherits', async () => {
    // Empty is _unstated_, one spelling, exactly as the empty team set is. The
    // reading that turns it into an inherited service is `effectiveServicesOf`'s
    // and is deliberately not stored here.
    await repo.insert(row(null, 10, 'Strip'), []);

    expect((await repo.listByProject(projectId)).at(0)?.serviceIds).toEqual([]);
  });

  it('keeps the row when one of its services is removed, and loses only that member', async () => {
    // The cascade on `work_item_service.service_id`, seen from the read side
    // rather than from the migration: deleting a service must lose that label
    // and never the plan — and, since the row carries a set, never the other
    // services either. The second service is what makes this case say more than
    // the column's version of it could.
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, []);
    const payments = service('Payments');
    const billing = service('Billing');
    labelServices(strip.id, [payments, billing]);

    const db = openDatabase(dbPath);
    try {
      db.run('DELETE FROM service WHERE id = ?', [payments]);
    } finally {
      db.close();
    }

    const read = await repo.listByProject(projectId);
    expect(read.map((each) => each.name)).toEqual(['Strip']);
    expect(read.at(0)?.serviceIds).toEqual([billing]);
  });
});

describe('the team set beside the column', () => {
  it('reads back every team a work item is joined to, in one order', async () => {
    // The set, and the order that makes two reads of an unchanged plan the same
    // array — design.md D6. Written straight into the join because the write
    // path states one team until R2-4, and the read is the thing under test.
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, []);
    const backend = await team('Backend');
    const design = await team('Design');
    joinTeam(strip.id, design);
    joinTeam(strip.id, backend);

    const read = await repo.listByProject(projectId);

    expect(read.at(0)?.teamIds).toEqual([backend, design].sort((a, b) => (a < b ? -1 : 1)));
  });

  it('leaves a work item nobody labelled with an empty set rather than a null', async () => {
    // _Unstated_ has one spelling on this side too: the empty set inherits, and
    // there is no second state meaning "deliberately no team".
    await repo.insert(row(null, 10, 'Strip'), []);

    expect((await repo.listByProject(projectId)).at(0)?.teamIds).toEqual([]);
  });

  it('labels the join as well as the column', async () => {
    // The dual write, forward. The column is what the outgoing release and the
    // journal read; the join is what everything in this release reads, and a
    // write that moved only one of them would put a label on screen that the
    // scheduler cannot see, or the reverse.
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, []);
    const backend = await team('Backend');

    const written = await repo.patch(strip.id, { serviceTeamId: backend });

    expect(written.ok).toBe(true);
    expect(written.ok ? written.workItem.serviceTeamId : null).toBe(backend);
    expect(joinedTeams()).toEqual([{ workItemId: strip.id, teamId: backend }]);
    expect((await repo.listByProject(projectId)).at(0)?.teamIds).toEqual([backend]);
  });

  it('empties the join when the label is taken off', async () => {
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, []);
    const backend = await team('Backend');
    await repo.patch(strip.id, { serviceTeamId: backend });

    await repo.patch(strip.id, { serviceTeamId: null });

    expect(joinedTeams()).toEqual([]);
    const read = await repo.listByProject(projectId);
    expect(read.at(0)?.serviceTeamId).toBeNull();
    expect(read.at(0)?.teamIds).toEqual([]);
  });

  it('writes a reason beside the date it explains', async () => {
    // The ordinary case, and the only pair this feature adds: a floor, and words
    // about it. One patch or two makes no difference — the rule is about the row
    // as it stands, not about how it got there.
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, []);
    await repo.patch(strip.id, { startNoEarlierThan: '2026-09-12' });

    const written = await repo.patch(strip.id, {
      startNoEarlierThanReason: 'waiting on client sign-off',
    });

    expect(written.ok).toBe(true);
    expect(written.ok ? written.workItem.startNoEarlierThanReason : null).toBe(
      'waiting on client sign-off',
    );
    const read = await repo.listByProject(projectId);
    expect(read.at(0)?.startNoEarlierThan).toBe('2026-09-12');
    expect(read.at(0)?.startNoEarlierThanReason).toBe('waiting on client sign-off');
  });

  it('refuses a reason with no date to be about', async () => {
    // The pair rule, on the row that has never had a floor. Words about a floor
    // that is not there appear on no surface — the chart says them only where
    // the not-before is the *binding* floor — and nothing clears them, which is
    // the `blocked`-with-no-date shape this feature exists instead of.
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, []);

    const written = await repo.patch(strip.id, {
      startNoEarlierThanReason: 'waiting on client sign-off',
    });

    expect(written.ok).toBe(false);
    expect(written.ok ? null : written.reason).toBe('not_before_reason_needs_a_date');
    // Refused rather than half-applied: the transaction that would have written
    // it is where the check lives, so the row is untouched.
    expect((await repo.listByProject(projectId)).at(0)?.startNoEarlierThanReason).toBeNull();
  });

  it('refuses a date cleared out from under the words beside it', async () => {
    // The commoner half of the same rule, and the one a client meets by
    // accident: the reader takes the date off and the sentence explaining it is
    // still there. This is the request the Not before cell has to get right —
    // `{ startNoEarlierThan: null }` is refused and
    // `{ startNoEarlierThan: null, startNoEarlierThanReason: null }` is what it
    // means.
    //
    // Refused rather than cascaded: clearing the date does not delete somebody's
    // sentence on their behalf.
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, []);
    await repo.patch(strip.id, {
      startNoEarlierThan: '2026-09-12',
      startNoEarlierThanReason: 'waiting on client sign-off',
    });

    const written = await repo.patch(strip.id, { startNoEarlierThan: null });

    expect(written.ok).toBe(false);
    expect(written.ok ? null : written.reason).toBe('not_before_reason_needs_a_date');
    const read = await repo.listByProject(projectId);
    expect(read.at(0)?.startNoEarlierThan).toBe('2026-09-12');
    expect(read.at(0)?.startNoEarlierThanReason).toBe('waiting on client sign-off');
  });

  it('takes the date and the words off together', async () => {
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, []);
    await repo.patch(strip.id, {
      startNoEarlierThan: '2026-09-12',
      startNoEarlierThanReason: 'waiting on client sign-off',
    });

    const written = await repo.patch(strip.id, {
      startNoEarlierThan: null,
      startNoEarlierThanReason: null,
    });

    expect(written.ok).toBe(true);
    const read = await repo.listByProject(projectId);
    expect(read.at(0)?.startNoEarlierThan).toBeNull();
    expect(read.at(0)?.startNoEarlierThanReason).toBeNull();
  });

  it('lets a patch that names neither half of the pair through a dateless row', async () => {
    // Every write that existed before this column: a rename on a row with no
    // date and no reason. The rule is asked only where the patch names one of
    // the two, so nothing that used to be legal has become a 400 — which is the
    // whole of this change's compatibility claim, made against the store rather
    // than assumed from the shape of the `if`.
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, []);

    const written = await repo.patch(strip.id, { name: 'Strip the walls' });

    expect(written.ok).toBe(true);
    expect(written.ok ? written.workItem.name : null).toBe('Strip the walls');
  });

  it('leaves the join alone when the patch does not name the label', async () => {
    // A rename must not empty the set. The join is replaced only where the
    // patch states it, exactly as the column is written only where it does.
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, []);
    const backend = await team('Backend');
    await repo.patch(strip.id, { serviceTeamId: backend });

    await repo.patch(strip.id, { name: 'Strip the walls' });

    expect(joinedTeams()).toEqual([{ workItemId: strip.id, teamId: backend }]);
  });

  it('joins a row that arrives already labelled', async () => {
    // `create` never labels, so this is the parity that keeps every other way a
    // whole row is written — a restore among them — from landing unpooled.
    const backend = await team('Backend');
    const strip = { ...row(null, 10, 'Strip'), serviceTeamId: backend };

    await repo.insert(strip, []);

    expect((await repo.listByProject(projectId)).at(0)?.teamIds).toEqual([backend]);
  });

  it('carries the teams of every row a copy writes', async () => {
    // A duplicated branch draws from the pools the original drew from, and a
    // restored one comes back on the pool it left: the join rows of a deleted
    // work item went with it through the cascade, so a restore writing only the
    // column would put the rows back unpooled and move dates nobody edited.
    const backend = await team('Backend');
    const strip = { ...row(null, 10, 'Strip'), serviceTeamId: backend };
    await repo.insert(strip, []);
    const copiedRoot = { ...row(null, 20, 'Strip (copy)'), serviceTeamId: backend };
    const copiedLeaf = { ...row(copiedRoot.id, 10, 'Sockets'), serviceTeamId: null };

    await subtrees.insertSubtree({
      rows: [copiedRoot, copiedLeaf],
      respaced: [],
      reparented: [],
      estimates: [],
      actuals: [],
      progress: [],
      assignments: [],
      dependencies: [],
      removedEstimates: [],
      removedActuals: [],
      removedProgress: [],
    });

    expect(joinedTeams()).toEqual(
      [
        { workItemId: strip.id, teamId: backend },
        { workItemId: copiedRoot.id, teamId: backend },
      ].sort((a, b) => (a.workItemId < b.workItemId ? -1 : 1)),
    );
  });

  it('takes a work item’s join rows with it when the work item goes', async () => {
    // The cascade, on the other column. Nothing in be-01 deletes these rows,
    // and an undo of the deletion is what puts them back — through the copy
    // above, from the column the journal carries.
    const backend = await team('Backend');
    const strip = { ...row(null, 10, 'Strip'), serviceTeamId: backend };
    await repo.insert(strip, []);

    await repo.remove([strip.id], []);

    expect(joinedTeams()).toEqual([]);
  });
});

describe('WorkItemRepository', () => {
  it('inserts and reads back a project’s work items', async () => {
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, []);

    expect(byPosition(await repo.listByProject(projectId))).toEqual(['Strip']);
  });

  it('applies respacing in the same write as the insertion', async () => {
    const strip = row(null, 10, 'Strip');
    const cable = row(null, 11, 'Cable');
    await repo.insert(strip, []);
    await repo.insert(cable, []);

    const survey = row(null, 20, 'Survey');
    await repo.insert(survey, [
      { id: strip.id, position: 10 },
      { id: cable.id, position: 30 },
    ]);

    expect(byPosition(await repo.listByProject(projectId))).toEqual(['Strip', 'Survey', 'Cable']);
  });

  it('re-parents on move', async () => {
    const strip = row(null, 10, 'Strip');
    const cable = row(null, 20, 'Cable');
    await repo.insert(strip, []);
    await repo.insert(cable, []);

    await repo.move(cable.id, strip.id, 10, []);

    const moved = await repo.findById(cable.id);
    expect(moved?.parentId).toBe(strip.id);
  });

  // The ordering claim in `remove`, against the constraints that force it. With
  // the parent deleted first SQLite rejects the whole transaction, so this
  // passing is what proves the reversal is real rather than intended.
  it('deletes a subtree leaves-first, which the foreign keys require', async () => {
    const strip = row(null, 10, 'Strip');
    const sockets = row(strip.id, 10, 'Sockets');
    const boxes = row(sockets.id, 10, 'Back boxes');
    for (const item of [strip, sockets, boxes]) await repo.insert(item, []);

    // Ancestors-first, as `subtreeOf` produces them.
    await repo.remove([strip.id, sockets.id, boxes.id], []);

    expect(await repo.listByProject(projectId)).toEqual([]);
  });

  it('places the copy after the original, respacing the group in the same write', async () => {
    const strip = row(null, 10, 'Strip');
    const cable = row(null, 11, 'Cable');
    await repo.insert(strip, []);
    await repo.insert(cable, []);

    const copy = row(null, 20, 'Strip (copy)');
    await subtrees.insertSubtree({
      rows: [copy],
      respaced: [
        { id: strip.id, position: 10 },
        { id: cable.id, position: 30 },
      ],
      reparented: [],
      estimates: [],
      actuals: [],
      progress: [],
      assignments: [],
      dependencies: [],
      removedEstimates: [],
      removedActuals: [],
      removedProgress: [],
    });

    expect(byPosition(await repo.listByProject(projectId))).toEqual([
      'Strip',
      'Strip (copy)',
      'Cable',
    ]);
  });

  it('writes rows, estimates, assignments and edges as one copy', async () => {
    const strip = row(null, 10, 'Strip');
    const sockets = row(strip.id, 10, 'Sockets');
    const switches = row(strip.id, 20, 'Switches');
    for (const item of [strip, sockets, switches]) await repo.insert(item, []);

    const copiedRoot = row(null, 20, 'Strip (copy)');
    const copiedFirst = { ...row(copiedRoot.id, 10, 'Sockets') };
    const copiedSecond = { ...row(copiedRoot.id, 20, 'Switches') };
    await subtrees.insertSubtree({
      rows: [copiedRoot, copiedFirst, copiedSecond],
      respaced: [],
      reparented: [],
      estimates: [
        { workItemId: copiedFirst.id, roleId, optimistic: 1, realistic: 2, pessimistic: 3 },
      ],
      actuals: [],
      progress: [],
      assignments: [{ workItemId: copiedSecond.id, roleId, personId }],
      dependencies: [
        {
          id: crypto.randomUUID(),
          projectId,
          predecessorId: copiedFirst.id,
          successorId: copiedSecond.id,
        },
      ],
      removedEstimates: [],
      removedActuals: [],
      removedProgress: [],
    });

    expect(byPosition(await repo.listByProject(projectId))).toHaveLength(6);
    expect(await estimates.listByProject(projectId)).toContainEqual({
      workItemId: copiedFirst.id,
      roleId,
      optimistic: 1,
      realistic: 2,
      pessimistic: 3,
    });
    expect(await directory.assignmentsOf([copiedSecond.id])).toEqual([
      { workItemId: copiedSecond.id, roleId, personId },
    ]);
    expect(
      (await dependencies.listByProject(projectId)).map((edge) => [
        edge.predecessorId,
        edge.successorId,
      ]),
    ).toEqual([[copiedFirst.id, copiedSecond.id]]);
  });

  /**
   * The transaction in `insertSubtree`, against the constraint that can break
   * it. The dependency is written last and names a work item that does not
   * exist, so SQLite rejects it — and the rows, the estimate and the
   * assignment written before it must go with it.
   *
   * Proof: with the transaction replaced by the same statements run one after
   * another, this test failed on the first assertion — three copied rows, one
   * estimate and one assignment survived a copy that did not happen. Watched
   * 2026-08-07.
   */
  it('inserts nothing when the last write in the copy violates a foreign key', async () => {
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, []);

    const copiedRoot = row(null, 20, 'Strip (copy)');
    const copiedChild = row(copiedRoot.id, 10, 'Sockets');
    const copy: SubtreeCopy = {
      rows: [copiedRoot, copiedChild],
      respaced: [],
      reparented: [],
      estimates: [
        { workItemId: copiedChild.id, roleId, optimistic: 1, realistic: 2, pessimistic: 3 },
      ],
      actuals: [],
      progress: [],
      assignments: [{ workItemId: copiedChild.id, roleId, personId }],
      dependencies: [
        {
          id: crypto.randomUUID(),
          projectId,
          // No such work item, so the foreign key refuses the last statement.
          predecessorId: crypto.randomUUID(),
          successorId: copiedChild.id,
        },
      ],
      removedEstimates: [],
      removedActuals: [],
      removedProgress: [],
    };

    // Awaited through a catch rather than `.rejects`, so the assertions below
    // cannot run against a write that has not finished failing yet.
    let refused: unknown = null;
    try {
      await subtrees.insertSubtree(copy);
    } catch (thrown) {
      refused = thrown;
    }
    expect(refused).toBeInstanceOf(Error);

    expect(byPosition(await repo.listByProject(projectId))).toEqual(['Strip']);
    expect(await estimates.listByProject(projectId)).toEqual([]);
    expect(await directory.assignmentsOf([copiedChild.id])).toEqual([]);
    expect(await dependencies.listByProject(projectId)).toEqual([]);
  });

  it('promotes children before deleting the parent they point at', async () => {
    const strip = row(null, 10, 'Strip');
    const sockets = row(strip.id, 10, 'Sockets');
    await repo.insert(strip, []);
    await repo.insert(sockets, []);

    await repo.remove([strip.id], [{ id: sockets.id, parentId: null, position: 10 }]);

    const remaining = await repo.listByProject(projectId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.parentId).toBeNull();
  });
});
