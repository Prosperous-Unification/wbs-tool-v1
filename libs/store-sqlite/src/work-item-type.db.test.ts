import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Project, Step, WorkItem, WriteStamp } from '@wbs/core';
import { projectRow } from '@wbs/store-memory/project-fixture';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { openDrizzle } from './db';
import { DirectoryRepository } from './directory';
import { OPEN } from './gate';
import { runMigrations } from './migrate';
import { ProjectRepository } from './project';
import { UserRepository } from './user';
import { WorkItemRepository } from './work-item';

const FOLDER = new URL('../../../apps/be-01/drizzle', import.meta.url).pathname;

let dir: string;
let ownerId: string;
let repo: DirectoryRepository;
let workItems: WorkItemRepository;
let projectId: string;
let itemId: string;
let childId: string;

/**
 * The stamp every write here carries. The account is the project's owner, which
 * the `created_by` foreign key requires to exist; the owner's own signup carries
 * it too, because a new account authors its own row.
 */
const wrote = (): WriteStamp => ({ at: 1, by: ownerId });

const newItem = (
  id: string,
  position: number,
  name: string,
  parentId: string | null,
): WorkItem => ({
  id,
  projectId,
  parentId,
  position,
  name,
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

const typed = (name: string) => repo.addWorkItemType({ id: crypto.randomUUID(), name }, wrote());

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-work-item-type-'));
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  const db = openDrizzle(path);
  repo = new DirectoryRepository(db, OPEN);
  workItems = new WorkItemRepository(db, OPEN);

  ownerId = crypto.randomUUID();
  await new UserRepository(db, OPEN).create(
    { id: ownerId, username: 'owner', passwordHash: 'x', createdAt: 1 },
    wrote(),
  );
  projectId = crypto.randomUUID();
  const project: Project = projectRow({
    id: projectId,
    ownerId,
  });
  const steps: Step[] = [{ id: crypto.randomUUID(), projectId, name: 'Dev', position: 10 }];
  await new ProjectRepository(db, OPEN).create(project, steps, wrote());

  itemId = crypto.randomUUID();
  childId = crypto.randomUUID();
  await workItems.insert(newItem(itemId, 10, 'Strip', null), [], wrote());
  await workItems.insert(newItem(childId, 10, 'Cladding', itemId), [], wrote());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the work item type vocabulary', () => {
  it('a type name is unique in the directory', async () => {
    // The picker types a name when the list does not have it, so two people
    // adding `Bug` at once is the ordinary path rather than a race nobody hits.
    // Only the unique index stops the second, and what comes back is the row the
    // table holds — returning the caller's own id would hand back an id nothing
    // has.
    //
    // Proof: `CREATE UNIQUE INDEX work_item_type_name` weakened to a plain
    // `CREATE INDEX`. Watched 2026-08-30 failing on the list coming back with two
    // `Bug` rows under two ids, taking `refuses a rename onto a name another type
    // holds` red with it.
    const first = await typed('Bug');
    const again = await typed('Bug');

    expect(again.id).toBe(first.id);
    expect((await repo.listWorkItemTypes()).map((each) => each.name)).toEqual(['Bug']);
  });

  it('a work item carries several types', async () => {
    // Set-valued on Dany's call (2026-08-29), which is the whole reason this is
    // a join table with a composite key rather than a `type_id` column.
    const bug = await typed('Bug');
    const spike = await typed('Spike');

    await workItems.patch(itemId, { typeIds: [bug.id, spike.id] }, wrote());

    const row = (await workItems.listByProject(projectId)).find((each) => each.id === itemId);
    expect([...(row?.typeIds ?? [])].sort()).toEqual([bug.id, spike.id].sort());
  });

  it('the type set is replaced whole, never merged', async () => {
    // The undo journal has to carry a before-value that restores what was there,
    // and a patch of "add Bug" has no inverse a second patch can express. The
    // compensating command for a set is the prior set.
    //
    // Proof: the `tx.delete(workItemWorkItemType)` in the write path removed, so
    // the write becomes additive. Watched 2026-08-30 failing with
    // `SQLiteError: UNIQUE constraint failed:
    // work_item_work_item_type.work_item_id, work_item_work_item_type.type_id`
    // — the join's own primary key refusing the re-insert, which is the additive
    // write meeting the constraint that makes the pair a fact. `an empty set
    // takes every type off` went red beside it.
    const bug = await typed('Bug');
    const spike = await typed('Spike');
    await workItems.patch(itemId, { typeIds: [bug.id, spike.id] }, wrote());

    await workItems.patch(itemId, { typeIds: [spike.id] }, wrote());

    const row = (await workItems.listByProject(projectId)).find((each) => each.id === itemId);
    expect(row?.typeIds).toEqual([spike.id]);
  });

  it('an empty set takes every type off, and is the only spelling of it', async () => {
    const bug = await typed('Bug');
    await workItems.patch(itemId, { typeIds: [bug.id] }, wrote());

    await workItems.patch(itemId, { typeIds: [] }, wrote());

    const row = (await workItems.listByProject(projectId)).find((each) => each.id === itemId);
    expect(row?.typeIds).toEqual([]);
  });

  it('a patch that does not name the dimension leaves the types alone', async () => {
    // The no-field guard's other half: an edit to the name must not empty the
    // types, exactly as it must not empty the tags.
    const bug = await typed('Bug');
    await workItems.patch(itemId, { typeIds: [bug.id] }, wrote());

    await workItems.patch(itemId, { name: 'Strip the walls' }, wrote());

    const row = (await workItems.listByProject(projectId)).find((each) => each.id === itemId);
    expect(row?.typeIds).toEqual([bug.id]);
  });

  it('a patch naming only the types is written, not swallowed by the no-field branch', async () => {
    // Proof: `patch.typeIds === undefined` removed from the no-field condition,
    // so a patch naming only the types takes the early branch, writes nothing,
    // and answers `ok` with the row it found — every face reporting a write that
    // never happened. Watched 2026-08-30 taking this case and two others red
    // (`a work item carries several types`, `the type set is replaced whole`),
    // each on the written set coming back empty. The tag line's own red, one
    // dimension over, and the third time this omission has been made here.
    const bug = await typed('Bug');

    const outcome = await workItems.patch(itemId, { typeIds: [bug.id] }, wrote());

    expect(outcome.ok).toBe(true);
    const row = (await workItems.listByProject(projectId)).find((each) => each.id === itemId);
    expect(row?.typeIds).toEqual([bug.id]);
  });

  it('a type the directory no longer holds refuses the whole patch, naming the type', async () => {
    // Decided inside the transaction that performs the update:
    // `work_item_work_item_type.type_id` cascades, so a type removed between a
    // precheck and this write leaves nothing for a foreign key to catch, and the
    // refusal a reader gets must name the type rather than be a 500.
    const bug = await typed('Bug');
    await repo.removeWorkItemType(bug.id, true, wrote());

    const outcome = await workItems.patch(itemId, { name: 'Renamed', typeIds: [bug.id] }, wrote());

    expect(outcome).toEqual({ ok: false, reason: 'unknown_type' });
    // The **whole** patch, which is the half a reader loses if the refusal comes
    // after the other fields are written.
    const row = (await workItems.listByProject(projectId)).find((each) => each.id === itemId);
    expect(row?.name).toBe('Strip');
  });

  it('a payload naming one type twice is one type, not a refusal', async () => {
    // Counted against the distinct ids asked for: a client being untidy is not a
    // request that means anything else, and the raw length would refuse it.
    const bug = await typed('Bug');

    const outcome = await workItems.patch(itemId, { typeIds: [bug.id, bug.id] }, wrote());

    expect(outcome.ok).toBe(true);
    const row = (await workItems.listByProject(projectId)).find((each) => each.id === itemId);
    expect(row?.typeIds).toEqual([bug.id]);
  });

  it('a row states its own types and inherits none from its parent', async () => {
    // The dimension's defining rule, and the one place it differs from every
    // other reference dimension in this model. A child of an `Epic` is
    // emphatically not an `Epic` —
    // `docs/adr/0009-a-work-item-type-does-not-inherit-at-all.md`.
    //
    // This is a *negative about an absence*, so it cannot be proved by deleting
    // a line: there is no `effectiveTypesOf` to remove. What it guards against is
    // the walk being **added** — copying `effectiveTagsOf` onto this dimension
    // out of symmetry, which is the change a future reader is most likely to
    // make. Proof: an `inheritedTypes` walk added to `listByProject` — climbing
    // to the nearest ancestor stating a type, which is `effectiveTagsOf`'s own
    // shape — watched 2026-08-30 failing on the child coming back carrying the
    // parent's `Epic`. The absence is the behaviour, so the fault to inject is
    // the line's arrival rather than its removal.
    const epic = await typed('Epic');
    await workItems.patch(itemId, { typeIds: [epic.id] }, wrote());

    const rows = await workItems.listByProject(projectId);
    expect(rows.find((each) => each.id === itemId)?.typeIds).toEqual([epic.id]);
    expect(rows.find((each) => each.id === childId)?.typeIds).toEqual([]);
  });

  it('removing a type from the directory takes it off every row', async () => {
    // The cascade does the deleting — `type_id` carries it — but a cascade moves
    // no revision, so the removal bumps the rows itself.
    //
    // Proof: `bumpWorkItems` removed from `removeWorkItemType`. Watched
    // 2026-08-30 failing on `Expected: > 1 / Received: 1` — the row coming back
    // at the revision it had, which is a journal entry undoing against a plan
    // whose labelling moved under it. The stale-undo failure this repo has
    // already shipped once, for people.
    const bug = await typed('Bug');
    await workItems.patch(itemId, { typeIds: [bug.id] }, wrote());
    const before = (await workItems.listByProject(projectId)).find((each) => each.id === itemId);

    expect(await repo.removeWorkItemType(bug.id, true, wrote())).toEqual({
      ok: true,
      removal: { workItemIds: [itemId], projectIds: [projectId] },
    });

    const after = (await workItems.listByProject(projectId)).find((each) => each.id === itemId);
    expect(after?.typeIds).toEqual([]);
    expect(after?.revision).toBeGreaterThan(before?.revision ?? 0);
    expect(await repo.listWorkItemTypes()).toEqual([]);
  });

  it('refuses an unconfirmed removal that would unlabel a row, and writes nothing', async () => {
    const bug = await typed('Bug');
    await workItems.patch(itemId, { typeIds: [bug.id] }, wrote());

    const outcome = await repo.removeWorkItemType(bug.id, false, wrote());

    if (outcome.ok || outcome.reason !== 'in_use') throw new Error('the removal was not refused');
    // `DirectoryUsageRows` is the flat repository shape — the service is what
    // folds it into a per-project tree — so the row is read off `workItems`.
    //
    // **Ascending `work_item.id`, not insertion order.** This line asserted the
    // order the rows happened to be inserted in, which was never what
    // `usageRowsIn` promised: the select carried no `ORDER BY` at all, so what
    // it returned was whatever plan SQLite chose. CI run 34020910596 at
    // `44463938` chose the index and the two ids came back swapped —
    // `0588a41f…` before `d705447e…`, ascending — on bytes whose only change
    // was merging `work_item_project_id_id` in. The read now states its order
    // and this states the same one; the ids are UUIDv4, so the expectation is
    // sorted rather than written out.
    expect(outcome.usage.workItems.map((each) => each.id)).toEqual([itemId, childId].sort());
    expect(outcome.usage.projects.map((each) => each.id)).toEqual([projectId]);
    expect(await repo.listWorkItemTypes()).toEqual([{ id: bug.id, name: 'Bug' }]);
  });

  it('removes an unused type without a confirmation', async () => {
    const bug = await typed('Bug');

    expect(await repo.removeWorkItemType(bug.id, false, wrote())).toEqual({
      ok: true,
      removal: { workItemIds: [], projectIds: [] },
    });
    expect(await repo.listWorkItemTypes()).toEqual([]);
  });

  it('refuses a rename onto a name another type holds, and writes nothing', async () => {
    // Proof: `isDuplicateWorkItemTypeName` made to answer `false`. Watched
    // 2026-08-30 failing with `SQLiteError: UNIQUE constraint failed:
    // work_item_type.name` thrown out of the rename instead of the `taken`
    // answer — a 500 for a reader who typed a name already in the list.
    //
    // This test earned its keep before either fault was injected: the detector
    // was first written matching `tag.name`, copied from `isDuplicateTagName`,
    // and this case caught it on the first run.
    await typed('Bug');
    const spike = await typed('Spike');

    expect(await repo.renameWorkItemType(spike.id, 'Bug', wrote())).toEqual({
      ok: false,
      reason: 'taken',
    });
    expect((await repo.listWorkItemTypes()).map((each) => each.name)).toEqual(['Bug', 'Spike']);
  });

  it('renames a type and names the projects that carry it', async () => {
    const bug = await typed('Bug');
    await workItems.patch(itemId, { typeIds: [bug.id] }, wrote());

    expect(await repo.renameWorkItemType(bug.id, 'Defect', wrote())).toEqual({
      ok: true,
      workItemType: { id: bug.id, name: 'Defect' },
      projectIds: [projectId],
    });
  });

  it('answers not_found for a rename or a removal of a type nobody holds', async () => {
    const absent = crypto.randomUUID();

    expect(await repo.renameWorkItemType(absent, 'Defect', wrote())).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await repo.removeWorkItemType(absent, true, wrote())).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('lets the outgoing release keep deleting work items against the migrated schema', async () => {
    // Blue and green share one SQLite file while green migrates, and the
    // outgoing release knows nothing about `work_item_work_item_type`. Its plain
    // `DELETE FROM work_item` must not hit a constraint it cannot see.
    //
    // Proof: `ON DELETE CASCADE` struck from `work_item_id` in the migration.
    // Watched 2026-08-30 failing with `SQLiteError: FOREIGN KEY constraint
    // failed` — a 500 on every work item delete for the length of the swap.
    const bug = await typed('Bug');
    await workItems.patch(childId, { typeIds: [bug.id] }, wrote());

    await workItems.remove([childId], [], wrote());

    expect((await workItems.listByProject(projectId)).map((each) => each.id)).toEqual([itemId]);
  });
});
