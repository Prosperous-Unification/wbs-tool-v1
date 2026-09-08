import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { effectiveTeamsOf, type Schedule, schedule } from '@wbs/domain';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { slicesOf } from '../service/work-item.service';
import { personAdded } from '../testing/directory-fixture';
import { projectRow } from '../testing/project-fixture';
import { openDatabase, openDrizzle } from './db';
import { DependencyRepository } from './dependency';
import { DirectoryRepository } from './directory';
import { EstimateRepository } from './estimate';
import { OPEN } from './gate';
import type { SubtreeCopy, WorkItem, WriteStamp } from './index';
import { runMigrations } from './migrate';
import { ProjectRepository } from './project';
import { StepMeasureRepository } from './step-measure';
import { UserRepository } from './user';
import { SubtreeRepository, WorkItemRepository } from './work-item';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

let dir: string;
let dbPath: string;
let ownerId: string;
let repo: WorkItemRepository;
let subtrees: SubtreeRepository;
let estimates: EstimateRepository;
let measures: StepMeasureRepository;
let dependencies: DependencyRepository;
let directory: DirectoryRepository;
let projectId: string;
let stepId: string;
let personId: string;

/**
 * The stamp every write here carries. The account is the project's owner, which
 * the `created_by` foreign key requires to exist; the owner's own signup carries
 * it too, because a new account authors its own row.
 */
const wrote = (): WriteStamp => ({ at: 1, by: ownerId });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-work-item-'));
  dbPath = join(dir, 'test.db');
  runMigrations(dbPath, FOLDER);
  const db = openDrizzle(dbPath);
  repo = new WorkItemRepository(db, OPEN);
  subtrees = new SubtreeRepository(db, OPEN);
  estimates = new EstimateRepository(db, OPEN);
  measures = new StepMeasureRepository(db, OPEN);
  dependencies = new DependencyRepository(db, OPEN);
  directory = new DirectoryRepository(db, OPEN);

  ownerId = crypto.randomUUID();
  await new UserRepository(db, OPEN).create(
    { id: ownerId, username: 'owner', passwordHash: 'x', createdAt: 1 },
    wrote(),
  );
  projectId = crypto.randomUUID();
  stepId = crypto.randomUUID();
  await new ProjectRepository(db, OPEN).create(
    projectRow({
      id: projectId,
      ownerId,
    }),
    [{ id: stepId, projectId, name: 'Dev', position: 10 }],
    wrote(),
  );
  personId = (
    await personAdded(directory.addPerson({ id: crypto.randomUUID(), name: 'Ada' }, [], wrote()))
  ).id;
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
    deadline: null,
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
  return (await directory.addTeam({ id: crypto.randomUUID(), name }, wrote())).id;
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
      .query<{ workItemId: string; teamId: string }, []>(
        'SELECT work_item_id AS workItemId, team_id AS teamId FROM work_item_team ORDER BY work_item_id, team_id',
      )
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
 * One work item's placed span, read off a schedule.
 *
 * `earliestStart`/`earliestFinish` rather than the latest pair: the assertion is
 * about where the plan **puts** the item, and the late pair is the float
 * calculation's other end, which moves for reasons that have nothing to do with
 * the read order under test.
 *
 * Throws on a missing row rather than answering `undefined` (R5). Every work
 * item the schedule was handed is in `workItems`, so an absent id is this
 * file's own fixture bug, and a nullish span would surface it as an
 * unintelligible `toEqual` diff several lines later.
 */
function spanOf(planned: Schedule, workItemId: string): { start: number; finish: number } {
  const placed = planned.workItems.get(workItemId);
  if (placed === undefined) throw new Error(`no scheduled span for work item ${workItemId}`);
  return { start: placed.earliestStart, finish: placed.earliestFinish };
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
    await repo.insert(strip, [], wrote());
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
    await repo.insert(row(null, 10, 'Strip'), [], wrote());

    expect((await repo.listByProject(projectId)).at(0)?.serviceIds).toEqual([]);
  });

  it('keeps the row when one of its services is removed, and loses only that member', async () => {
    // The cascade on `work_item_service.service_id`, seen from the read side
    // rather than from the migration: deleting a service must lose that label
    // and never the plan — and, since the row carries a set, never the other
    // services either. The second service is what makes this case say more than
    // the column's version of it could.
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, [], wrote());
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
    await repo.insert(strip, [], wrote());
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
    await repo.insert(row(null, 10, 'Strip'), [], wrote());

    expect((await repo.listByProject(projectId)).at(0)?.teamIds).toEqual([]);
  });

  it('labels the join as well as the column', async () => {
    // The dual write, forward. The column is what the outgoing release and the
    // journal read; the join is what everything in this release reads, and a
    // write that moved only one of them would put a label on screen that the
    // scheduler cannot see, or the reverse.
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, [], wrote());
    const backend = await team('Backend');

    const written = await repo.patch(strip.id, { serviceTeamId: backend }, wrote());

    expect(written.ok).toBe(true);
    expect(written.ok ? written.workItem.serviceTeamId : null).toBe(backend);
    expect(joinedTeams()).toEqual([{ workItemId: strip.id, teamId: backend }]);
    expect((await repo.listByProject(projectId)).at(0)?.teamIds).toEqual([backend]);
  });

  it('empties the join when the label is taken off', async () => {
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, [], wrote());
    const backend = await team('Backend');
    await repo.patch(strip.id, { serviceTeamId: backend }, wrote());

    await repo.patch(strip.id, { serviceTeamId: null }, wrote());

    expect(joinedTeams()).toEqual([]);
    const read = await repo.listByProject(projectId);
    expect(read.at(0)?.serviceTeamId).toBeNull();
    expect(read.at(0)?.teamIds).toEqual([]);
  });

  it('replaces the whole team set, deduplicates it, and projects its sorted first id', async () => {
    // Break caught: writing request order into the scalar projection makes two
    // equal sets expose different legacy ids, while omitting the second join
    // silently loses one scheduling pool.
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, [], wrote());
    const backend = await team('Backend');
    const design = await team('Design');
    const sorted = [backend, design].sort((a, b) => (a < b ? -1 : 1));

    const written = await repo.patch(
      strip.id,
      { teamIds: [sorted[1], sorted[0], sorted[1]] },
      wrote(),
    );

    expect(written.ok).toBe(true);
    expect(written.ok ? written.workItem.serviceTeamId : null).toBe(sorted[0]);
    expect(joinedTeams()).toEqual(sorted.map((teamId) => ({ workItemId: strip.id, teamId })));
    expect((await repo.listByProject(projectId)).at(0)?.teamIds).toEqual(sorted);
  });

  it('refuses one unknown team before changing the scalar row, joins, or revision', async () => {
    // Break caught: validation outside the transaction, or after the scalar
    // update, allows the rename/revision half of a mixed patch to land.
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, [], wrote());
    const backend = await team('Backend');
    await repo.patch(strip.id, { serviceTeamId: backend }, wrote());
    const before = await repo.findById(strip.id);

    const written = await repo.patch(
      strip.id,
      { name: 'Strip the walls', teamIds: [backend, crypto.randomUUID()] },
      wrote(),
    );

    expect(written.ok).toBe(false);
    expect(written.ok ? null : written.reason).toBe('unknown_team');
    expect(await repo.findById(strip.id)).toEqual(before);
    expect(joinedTeams()).toEqual([{ workItemId: strip.id, teamId: backend }]);
  });

  it('treats sequential team set patches as whole-set last-writer-wins replacements', async () => {
    // Break caught: merging the later request with stored memberships retains
    // a sibling the second client explicitly replaced.
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, [], wrote());
    const backend = await team('Backend');
    const design = await team('Design');

    await repo.patch(strip.id, { teamIds: [backend, design] }, wrote());
    await repo.patch(strip.id, { teamIds: [design] }, wrote());

    expect(joinedTeams()).toEqual([{ workItemId: strip.id, teamId: design }]);
    expect((await repo.listByProject(projectId)).at(0)?.teamIds).toEqual([design]);
  });

  it('writes a reason beside the date it explains', async () => {
    // The ordinary case, and the only pair this feature adds: a floor, and words
    // about it. One patch or two makes no difference — the rule is about the row
    // as it stands, not about how it got there.
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, [], wrote());
    await repo.patch(strip.id, { startNoEarlierThan: '2026-09-12' }, wrote());

    const written = await repo.patch(
      strip.id,
      { startNoEarlierThanReason: 'waiting on client sign-off' },
      wrote(),
    );

    expect(written.ok).toBe(true);
    expect(written.ok ? written.workItem.startNoEarlierThanReason : null).toBe(
      'waiting on client sign-off',
    );
    const read = await repo.listByProject(projectId);
    expect(read.at(0)?.startNoEarlierThan).toBe('2026-09-12');
    expect(read.at(0)?.startNoEarlierThanReason).toBe('waiting on client sign-off');
  });

  it('writes a deadline and reads it back, and clears it with a null', async () => {
    // The whole of the column's store-level contract, and deliberately shorter
    // than the floor's above it: there is no reason beside a deadline, so there
    // is no pair to be in and no refusal to meet here. A date goes in, comes
    // back off the read projection, and `null` takes it off again.
    //
    // Both faces are asserted — `patch`'s own `returning()` and a later
    // `listByProject` — because they are two different **reads**, not two
    // different column lists: both project `WORK_ITEM_COLUMNS`, which is why
    // adding the column there made both true at once, and the second assertion
    // is what says the value was stored rather than only echoed back off the
    // statement that wrote it.
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, [], wrote());

    const written = await repo.patch(strip.id, { deadline: '2026-03-31' }, wrote());

    expect(written.ok).toBe(true);
    expect(written.ok ? written.workItem.deadline : null).toBe('2026-03-31');
    expect((await repo.listByProject(projectId)).at(0)?.deadline).toBe('2026-03-31');

    const cleared = await repo.patch(strip.id, { deadline: null }, wrote());

    expect(cleared.ok).toBe(true);
    expect(cleared.ok ? cleared.workItem.deadline : 'unset').toBeNull();
    expect((await repo.listByProject(projectId)).at(0)?.deadline).toBeNull();
  });

  it('leaves a deadline alone when the patch does not name it', async () => {
    // The other half of "a patch names what it names": an edit to a different
    // column must not read as a deadline nobody typed, and must not clear one
    // somebody did. This is the case that fails if `deadline` is ever merged
    // with `??` rather than an `undefined` check.
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, [], wrote());
    await repo.patch(strip.id, { deadline: '2026-03-31' }, wrote());

    const renamed = await repo.patch(strip.id, { name: 'Strip the walls' }, wrote());

    expect(renamed.ok ? renamed.workItem.deadline : null).toBe('2026-03-31');
    expect((await repo.listByProject(projectId)).at(0)?.deadline).toBe('2026-03-31');
  });

  it('refuses a reason with no date to be about', async () => {
    // The pair rule, on the row that has never had a floor. Words about a floor
    // that is not there appear on no surface — the chart says them only where
    // the not-before is the *binding* floor — and nothing clears them, which is
    // the `blocked`-with-no-date shape this feature exists instead of.
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, [], wrote());

    const written = await repo.patch(
      strip.id,
      { startNoEarlierThanReason: 'waiting on client sign-off' },
      wrote(),
    );

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
    await repo.insert(strip, [], wrote());
    await repo.patch(
      strip.id,
      { startNoEarlierThan: '2026-09-12', startNoEarlierThanReason: 'waiting on client sign-off' },
      wrote(),
    );

    const written = await repo.patch(strip.id, { startNoEarlierThan: null }, wrote());

    expect(written.ok).toBe(false);
    expect(written.ok ? null : written.reason).toBe('not_before_reason_needs_a_date');
    const read = await repo.listByProject(projectId);
    expect(read.at(0)?.startNoEarlierThan).toBe('2026-09-12');
    expect(read.at(0)?.startNoEarlierThanReason).toBe('waiting on client sign-off');
  });

  it('takes the date and the words off together', async () => {
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, [], wrote());
    await repo.patch(
      strip.id,
      { startNoEarlierThan: '2026-09-12', startNoEarlierThanReason: 'waiting on client sign-off' },
      wrote(),
    );

    const written = await repo.patch(
      strip.id,
      { startNoEarlierThan: null, startNoEarlierThanReason: null },
      wrote(),
    );

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
    await repo.insert(strip, [], wrote());

    const written = await repo.patch(strip.id, { name: 'Strip the walls' }, wrote());

    expect(written.ok).toBe(true);
    expect(written.ok ? written.workItem.name : null).toBe('Strip the walls');
  });

  it('leaves the join alone when the patch does not name the label', async () => {
    // A rename must not empty the set. The join is replaced only where the
    // patch states it, exactly as the column is written only where it does.
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, [], wrote());
    const backend = await team('Backend');
    await repo.patch(strip.id, { serviceTeamId: backend }, wrote());

    await repo.patch(strip.id, { name: 'Strip the walls' }, wrote());

    expect(joinedTeams()).toEqual([{ workItemId: strip.id, teamId: backend }]);
  });

  it('joins a row that arrives already labelled', async () => {
    // `create` never labels, so this is the parity that keeps every other way a
    // whole row is written — a restore among them — from landing unpooled.
    const backend = await team('Backend');
    const strip = { ...row(null, 10, 'Strip'), serviceTeamId: backend };

    await repo.insert(strip, [], wrote());

    expect((await repo.listByProject(projectId)).at(0)?.teamIds).toEqual([backend]);
  });

  it('carries the teams of every row a copy writes', async () => {
    // A duplicated branch draws from the pools the original drew from, and a
    // restored one comes back on the pool it left: the join rows of a deleted
    // work item went with it through the cascade, so a restore writing only the
    // column would put the rows back unpooled and move dates nobody edited.
    const backend = await team('Backend');
    const strip = { ...row(null, 10, 'Strip'), serviceTeamId: backend };
    await repo.insert(strip, [], wrote());
    const copiedRoot = { ...row(null, 20, 'Strip (copy)'), serviceTeamId: backend };
    const copiedLeaf = { ...row(copiedRoot.id, 10, 'Sockets'), serviceTeamId: null };

    await subtrees.insertSubtree(
      {
        rows: [copiedRoot, copiedLeaf],
        respaced: [],
        reparented: [],
        estimates: [],
        actuals: [],
        progress: [],
        measures: [],
        assignments: [],
        dependencies: [],
        removedEstimates: [],
        removedActuals: [],
        removedProgress: [],
        removedMeasures: [],
      },
      wrote(),
    );

    expect(joinedTeams()).toEqual(
      [
        { workItemId: strip.id, teamId: backend },
        { workItemId: copiedRoot.id, teamId: backend },
      ].sort((a, b) => (a.workItemId < b.workItemId ? -1 : 1)),
    );
  });

  it('inserts every explicit team membership carried by a structural row', async () => {
    // Break caught: deriving restore/copy joins only from the legacy scalar
    // silently drops every structural membership after the sorted first one.
    const backend = await team('Backend');
    const design = await team('Design');
    const copiedRoot = {
      ...row(null, 20, 'Strip (copy)'),
      serviceTeamId: [backend, design].sort()[0] ?? null,
      teamIds: [design, backend],
    };

    await subtrees.insertSubtree(
      {
        rows: [copiedRoot],
        respaced: [],
        reparented: [],
        estimates: [],
        actuals: [],
        progress: [],
        measures: [],
        assignments: [],
        dependencies: [],
        removedEstimates: [],
        removedActuals: [],
        removedProgress: [],
        removedMeasures: [],
      },
      wrote(),
    );

    expect(joinedTeams()).toEqual(
      [backend, design].sort().map((teamId) => ({ workItemId: copiedRoot.id, teamId })),
    );
  });

  it('takes a work item’s join rows with it when the work item goes', async () => {
    // The cascade, on the other column. Nothing in be-01 deletes these rows,
    // and an undo of the deletion is what puts them back — through the copy
    // above, from the column the journal carries.
    const backend = await team('Backend');
    const strip = { ...row(null, 10, 'Strip'), serviceTeamId: backend };
    await repo.insert(strip, [], wrote());

    await repo.remove([strip.id], [], wrote());

    expect(joinedTeams()).toEqual([]);
  });
});

describe('WorkItemRepository', () => {
  it('inserts and reads back a project’s work items', async () => {
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, [], wrote());

    expect(byPosition(await repo.listByProject(projectId))).toEqual(['Strip']);
  });

  it('applies respacing in the same write as the insertion', async () => {
    const strip = row(null, 10, 'Strip');
    const cable = row(null, 11, 'Cable');
    await repo.insert(strip, [], wrote());
    await repo.insert(cable, [], wrote());

    const survey = row(null, 20, 'Survey');
    await repo.insert(
      survey,
      [
        { id: strip.id, position: 10 },
        { id: cable.id, position: 30 },
      ],
      wrote(),
    );

    expect(byPosition(await repo.listByProject(projectId))).toEqual(['Strip', 'Survey', 'Cable']);
  });

  it('re-parents on move', async () => {
    const strip = row(null, 10, 'Strip');
    const cable = row(null, 20, 'Cable');
    await repo.insert(strip, [], wrote());
    await repo.insert(cable, [], wrote());

    await repo.move(cable.id, strip.id, 10, [], wrote());

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
    for (const item of [strip, sockets, boxes]) await repo.insert(item, [], wrote());

    // Ancestors-first, as `subtreeOf` produces them.
    await repo.remove([strip.id, sockets.id, boxes.id], [], wrote());

    expect(await repo.listByProject(projectId)).toEqual([]);
  });

  it('places the copy after the original, respacing the group in the same write', async () => {
    const strip = row(null, 10, 'Strip');
    const cable = row(null, 11, 'Cable');
    await repo.insert(strip, [], wrote());
    await repo.insert(cable, [], wrote());

    const copy = row(null, 20, 'Strip (copy)');
    await subtrees.insertSubtree(
      {
        rows: [copy],
        respaced: [
          { id: strip.id, position: 10 },
          { id: cable.id, position: 30 },
        ],
        reparented: [],
        estimates: [],
        actuals: [],
        progress: [],
        measures: [],
        assignments: [],
        dependencies: [],
        removedEstimates: [],
        removedActuals: [],
        removedProgress: [],
        removedMeasures: [],
      },
      wrote(),
    );

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
    for (const item of [strip, sockets, switches]) await repo.insert(item, [], wrote());

    const copiedRoot = row(null, 20, 'Strip (copy)');
    const copiedFirst = { ...row(copiedRoot.id, 10, 'Sockets') };
    const copiedSecond = { ...row(copiedRoot.id, 20, 'Switches') };
    await subtrees.insertSubtree(
      {
        rows: [copiedRoot, copiedFirst, copiedSecond],
        respaced: [],
        reparented: [],
        estimates: [
          { workItemId: copiedFirst.id, stepId, optimistic: 1, realistic: 2, pessimistic: 3 },
        ],
        actuals: [],
        progress: [],
        measures: [],
        assignments: [{ workItemId: copiedSecond.id, stepId, personId }],
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
        removedMeasures: [],
      },
      wrote(),
    );

    expect(byPosition(await repo.listByProject(projectId))).toHaveLength(6);
    expect(await estimates.listByProject(projectId)).toContainEqual({
      workItemId: copiedFirst.id,
      stepId,
      optimistic: 1,
      realistic: 2,
      pessimistic: 3,
    });
    expect(await directory.assignmentsOf([copiedSecond.id])).toEqual([
      { workItemId: copiedSecond.id, stepId, personId },
    ]);
    expect(
      (await dependencies.listByProject(projectId)).map((edge) => [
        edge.predecessorId,
        edge.successorId,
      ]),
    ).toEqual([[copiedFirst.id, copiedSecond.id]]);
  });

  /**
   * `removedMeasures` is keyed by the **triple**, and this is the only seam it
   * can be proved at.
   *
   * A restore takes off the parent the figures the delete's hand-up put on it.
   * Keyed by the pair instead, the delete would take every metric that pair
   * holds — including one the parent has held since before the delete, which
   * the hand-up never touched and the restore has no business moving.
   *
   * **No path through `WorkItemService` can reach that state**, which is why
   * this case is here and not in `undo.test.ts`: a hand-down empties the parent
   * the moment it gains a child, `setMeasure` refuses a work item that has
   * children, and recording on the parent while it is briefly a leaf again
   * makes the undo refuse on the revision. So at restore time everything the
   * parent holds came from the hand-up, and the pair and the triple delete the
   * same set. The repository takes the command as given, so it can be handed
   * the state the service cannot produce — and the difference becomes visible.
   *
   * The command below is otherwise empty on purpose: nothing is restored, no
   * row is written. What is under test is the `where` on one `DELETE`.
   */
  it('takes off only the metric a restore names, and leaves the pair’s other figure', async () => {
    const strip = row(null, 10, 'Strip');
    await repo.insert(strip, [], wrote());
    await measures.set(
      {
        workItemId: strip.id,
        stepId,
        metric: 'token_estimate',
        value: 1000,
        recordedAt: 111,
      },
      wrote(),
    );
    await measures.set(
      {
        workItemId: strip.id,
        stepId,
        metric: 'hours_actual',
        value: 3,
        recordedAt: 222,
      },
      wrote(),
    );

    await subtrees.insertSubtree(
      {
        rows: [],
        respaced: [],
        reparented: [],
        estimates: [],
        actuals: [],
        progress: [],
        measures: [],
        assignments: [],
        dependencies: [],
        removedEstimates: [],
        removedActuals: [],
        removedProgress: [],
        removedMeasures: [{ workItemId: strip.id, stepId, metric: 'token_estimate' }],
      },
      wrote(),
    );

    // The hours survive with the stamp they were written under: a delete by the
    // pair leaves this list empty, and one that rewrote the survivor would be a
    // different fault wearing the same green.
    expect(await measures.listByProject(projectId)).toEqual([
      { workItemId: strip.id, stepId, metric: 'hours_actual', value: 3, recordedAt: 222 },
    ]);
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
    await repo.insert(strip, [], wrote());

    const copiedRoot = row(null, 20, 'Strip (copy)');
    const copiedChild = row(copiedRoot.id, 10, 'Sockets');
    const copy: SubtreeCopy = {
      rows: [copiedRoot, copiedChild],
      respaced: [],
      reparented: [],
      estimates: [
        { workItemId: copiedChild.id, stepId, optimistic: 1, realistic: 2, pessimistic: 3 },
      ],
      actuals: [],
      progress: [],
      measures: [],
      assignments: [{ workItemId: copiedChild.id, stepId, personId }],
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
      removedMeasures: [],
    };

    // Awaited through a catch rather than `.rejects`, so the assertions below
    // cannot run against a write that has not finished failing yet.
    let refused: unknown = null;
    try {
      await subtrees.insertSubtree(copy, wrote());
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
    await repo.insert(strip, [], wrote());
    await repo.insert(sockets, [], wrote());

    await repo.remove([strip.id], [{ id: sockets.id, parentId: null, position: 10 }], wrote());

    const remaining = await repo.listByProject(projectId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.parentId).toBeNull();
  });
});

describe('deleting a subtree', () => {
  /**
   * A subtree delete used to cost one `DELETE` per row, deepest first, because
   * `work_item.parent_id` references `work_item.id` and a parent cannot outlive
   * its child. That constraint is real statement by statement and absent inside
   * one: SQLite checks an immediate foreign key at the **end of the statement**,
   * so a parent and its child may go in the same `IN` list. A 2,000-row plan
   * costs one statement rather than 2,000, inside the process-wide write lock
   * (ADR 0007).
   *
   * Three generations, so "one statement" and "one per row" differ by more than
   * the setup — and the deepest-first order is genuinely reversed here, which is
   * the arrangement the old loop existed for.
   *
   * Proof: with the per-row loop restored, watched failing on
   * `expect(received).toHaveLength(expected)` · `Expected length: 2` ·
   * `Received length: 4` (2026-09-02).
   */
  it('deletes a whole subtree in one statement', async () => {
    const parent = row(null, 10, 'Shed');
    await repo.insert(parent, [], wrote());
    const child = row(parent.id, 10, 'Wall');
    await repo.insert(child, [], wrote());
    const grandchild = row(child.id, 10, 'Stud');
    await repo.insert(grandchild, [], wrote());

    const statements: string[] = [];
    const counted = new WorkItemRepository(
      openDrizzle(dbPath, {
        logQuery(query) {
          statements.push(query);
        },
      }),
      OPEN,
    );

    // Ancestors first, exactly as `subtreeOf` hands them over — the order the
    // old loop reversed before it could delete anything.
    await counted.remove([parent.id, child.id, grandchild.id], [], wrote());

    // One delete of the estimates, one of the rows. A loop is one per row on
    // top of the estimates.
    expect(statements).toHaveLength(2);
    expect(await repo.listByProject(projectId)).toEqual([]);
  });
});

describe('freezing every number', () => {
  /**
   * A freeze names **every** work item in the project, so a loop of `UPDATE`s
   * costs one statement per row — inside the outer transaction, and therefore
   * inside the process-wide write lock (ADR 0007). Three rows here rather than
   * two, so "one statement" and "one per row" differ by more than the setup.
   *
   * Proof: with the per-row loop restored, watched failing on
   * `expect(received).toHaveLength(expected)` at this assertion — three
   * statements where one is owed (2026-09-02).
   */
  it('freezes every number in a single statement', async () => {
    const rows = [row(null, 10, 'Strip'), row(null, 20, 'Sockets'), row(null, 30, 'Boxes')];
    for (const each of rows) await repo.insert(each, [], wrote());

    const statements: string[] = [];
    const counted = new WorkItemRepository(
      openDrizzle(dbPath, {
        logQuery(query) {
          statements.push(query);
        },
      }),
      OPEN,
    );

    await counted.setFrozenNumbers(
      // Strings, because a frozen number is one: `frozen_number` is a text
      // column and `FrozenNumber.frozenNumber` says `string | null`. The first
      // draft passed numbers, which the spec project does not typecheck and
      // SQLite stored as text anyway — the read is what said so.
      rows.map((each, at) => ({ id: each.id, frozenNumber: String((at + 1) * 10) })),
      wrote(),
    );

    expect(statements).toHaveLength(1);
    // The precondition: one statement that wrote nothing would also count one,
    // and each row must get **its own** number rather than all of them one.
    const frozen = await repo.listByProject(projectId);
    expect(frozen.map((each) => each.frozenNumber).sort()).toEqual(['10', '20', '30']);
  });
});

describe('the order the work-item select answers in', () => {
  /**
   * Task 1.7 of `dual-optimized-scheduler`. The select had no `ORDER BY`, so the
   * row order was whatever SQLite chose to return — in practice the insert
   * order, which is not a fact about the plan.
   *
   * This array is not merely displayed. `slicesOf` walks it in order and emits
   * the `slices` argument in that order, and the intra-item step order is real
   * precedence, so two reads of an unchanged project could hand Fast two
   * different argument tuples. That is a scheduling defect before it is a cache
   * one.
   *
   * The ids are written rather than generated because the whole assertion is
   * about their order: with `crypto.randomUUID` the insert order agrees with id
   * order often enough that the watched red would be a coin toss. Written in
   * the opposite order to their ids for the same reason.
   */
  it('answers in work_item.id order, whatever order the rows were written in', async () => {
    const later = {
      ...row(null, 10, 'Written first'),
      id: 'ffffffff-0000-4000-8000-000000000001',
    };
    const earlier = {
      ...row(null, 20, 'Written second'),
      id: '00000000-0000-4000-8000-000000000002',
    };
    await repo.insert(later, [], wrote());
    await repo.insert(earlier, [], wrote());

    const first = await repo.listByProject(projectId);
    const second = await repo.listByProject(projectId);

    expect(first.map((each) => each.id)).toEqual([earlier.id, later.id]);
    expect(second.map((each) => each.id)).toEqual(first.map((each) => each.id));
  });

  /**
   * Task 1.8, and it asserts the **raw argument tuple** rather than its hash.
   * The earlier plan compared two `scheduleInputHash` values across a reversed
   * driver; 1.1(c) groups slices by work item and sorts rows by id, and the spec
   * separately *requires* the hash to be equal when only the underlying row
   * order differs — so that assertion could never fail, which is the
   * check-that-cannot-fail R5 names.
   *
   * What Fast actually receives is this: `listByProject` → `slicesOf` → the
   * `rows` and `slices` arguments. `slicesOf` walks the rows in order, so the
   * slice order is the row order, and the intra-item order is real step
   * precedence. Both arrays are asserted here in `work_item.id` order, and both
   * go red when the `ORDER BY` is removed.
   *
   * No estimate is written, deliberately: `slicesOf` emits one slice per leaf
   * per project step whether or not anybody has estimated it, so an estimate
   * would be a second moving part in an assertion about order.
   */
  it('hands Fast rows and slices in id order, not in the order they were written', async () => {
    const later = { ...row(null, 10, 'Written first'), id: 'ffffffff-0000-4000-8000-000000000003' };
    const earlier = {
      ...row(null, 20, 'Written second'),
      id: '00000000-0000-4000-8000-000000000004',
    };
    await repo.insert(later, [], wrote());
    await repo.insert(earlier, [], wrote());
    const project = projectRow({ id: projectId, ownerId });

    const rows = await repo.listByProject(projectId);
    const slices = slicesOf(
      rows,
      await estimates.listByProject(projectId),
      new Set(rows.map((each) => each.parentId).filter((id): id is string => id !== null)),
      [stepId],
      {
        method: project.estimateMethod,
        pertWeights: project.pertWeights,
        rounding: project.estimateRounding,
      },
      new Map(),
      effectiveTeamsOf(rows),
      new Map(),
    );

    expect(rows.map((each) => each.id)).toEqual([earlier.id, later.id]);
    expect(slices.map((each) => each.workItemId)).toEqual([earlier.id, later.id]);
  });

  /**
   * Task 1.8's second assertion: Fast's **own output** for this read, not only
   * the tuple that reaches it. The tuple assertion above proves the arrays
   * arrive in one order; this proves that order is a scheduling fact, so an
   * unordered select is a plan that schedules two ways rather than a tidiness
   * complaint.
   *
   * **The two siblings share a position, and that is the whole fixture.**
   * `deriveNumbers` sorts each sibling group by `position` and `Array#sort` is
   * stable, so tied positions leave the labels decided by the array order — and
   * the number is the third of `goesFirst`'s four tie-breaks
   * (`schedule.ts:2283`). Measured at `705f1bc5`, two unestimated leaves on a
   * one-slot pool: id order gives `00000000…` `010` and `ffffffff…` `020`, so
   * `00000000…` takes the slot at 0 → 2 and `ffffffff…` waits at 2 → 4; the
   * insert order gives `ffffffff…` `010` and the two placements exchange.
   * With the positions **distinct** — which is what the two tests above use —
   * the labels come off `position` alone and both orders produce a
   * byte-identical schedule, which is precisely why a Fast assertion could not
   * be added to them and this fixture exists.
   *
   * A tied sibling position is a legal database state and a reachable one:
   * `work_item_siblings` (`schema.ts:475`) is a plain index, and `placeAfter`
   * appends at `last + POSITION_STEP` with no re-read under a lock
   * (`place-sibling.ts:53`), so two appends that read the same group both
   * compute the same number.
   *
   * The pool is what turns the order into dates. Two leaves with no edge and no
   * queue both start at day 0 whatever order they arrive in; one slot is what
   * makes one of them wait, and the tie-break is what decides which.
   *
   * Proof: with the `ORDER BY` deleted from 1.7's production path, this
   * assertion fails with the two spans exchanged, alongside 1.7's and 1.8's.
   */
  it('schedules the same project two ways when the rows arrive in two orders', async () => {
    const shared = await team('Platform');
    const tied = 10;
    const later = {
      ...row(null, tied, 'Written first'),
      id: 'ffffffff-0000-4000-8000-000000000005',
    };
    const earlier = {
      ...row(null, tied, 'Written second'),
      id: '00000000-0000-4000-8000-000000000006',
    };
    await repo.insert(later, [], wrote());
    await repo.insert(earlier, [], wrote());
    joinTeam(later.id, shared);
    joinTeam(earlier.id, shared);
    const project = projectRow({ id: projectId, ownerId });
    /** One slot, which is what makes the two leaves queue rather than run together. */
    const slotsOf = new Map([[shared, 1]]);

    const rows = await repo.listByProject(projectId);
    const slices = slicesOf(
      rows,
      await estimates.listByProject(projectId),
      new Set(rows.map((each) => each.parentId).filter((id): id is string => id !== null)),
      [stepId],
      {
        method: project.estimateMethod,
        pertWeights: project.pertWeights,
        rounding: project.estimateRounding,
      },
      new Map(),
      effectiveTeamsOf(rows),
      slotsOf,
    );
    const planned = schedule(rows, [], slices, new Map(), slotsOf, project.depReach);

    expect(planned.waitingForCapacity).toBe(1);
    expect(spanOf(planned, earlier.id)).toEqual({ start: 0, finish: 2 });
    expect(spanOf(planned, later.id)).toEqual({ start: 2, finish: 4 });
  });

  /**
   * The three cases above watch the *returned* order, and that is no longer
   * enough to hold the contract down at the final schema. `beforeEach` builds
   * each database through the whole migration set, which now includes
   * `work_item_project_id_id` on `(project_id, id)` — so with the `ORDER BY`
   * deleted SQLite may satisfy `where project_id = ?` by walking that very
   * index and hand back ascending id order anyway. Those assertions would pass
   * over a query that promises nothing, and a later planner or statistics
   * change picking `work_item_siblings` instead would restore the
   * nondeterministic schedule with no test going red.
   *
   * That is exactly the gap in `verify.md` §1: the 31/3 negative was watched at
   * `84716c40`, *before* §2 added the index, so it does not cover the schema
   * this ships.
   *
   * The contract is a property of the statement, so this reads the statement.
   * `logQuery` is drizzle's own hook and is already how this file proves round
   * trips (`deletes a whole subtree in one statement`). Quotes and case are
   * flattened first because the rendering is drizzle's to change and the
   * contract is not.
   *
   * Peer review finding, TASK-260 round 1, Important (openai/gpt-5.6-sol):
   * `queue/reviews/t260-r1-sol.txt`.
   */
  it('asks for the order in the statement rather than inheriting it from an index', async () => {
    const statements: string[] = [];
    const logged = new WorkItemRepository(
      openDrizzle(dbPath, {
        logQuery(query) {
          statements.push(query);
        },
      }),
      OPEN,
    );

    await logged.listByProject(projectId);

    // The work-item select itself. The two membership reads beside it also name
    // `work_item`, but they reach it through a join and order by their own
    // column, so neither of them is the statement under test.
    const select = statements.find(
      (query) => query.includes('from "work_item"') && !query.includes('join'),
    );
    expect(select).toBeDefined();

    const flattened = (select ?? '').replaceAll('"', '').replace(/\s+/g, ' ').toLowerCase();
    expect(flattened).toContain('order by work_item.id');
    // Ascending, and stated as such: descending is a different tie-break and
    // would answer the two reads consistently while contradicting ADR 0016.
    expect(flattened).not.toContain('order by work_item.id desc');
  });
});
