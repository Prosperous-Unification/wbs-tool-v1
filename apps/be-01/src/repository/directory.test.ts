import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { personAdded } from '../testing/directory-fixture';
import { openDrizzle } from './db';
import { DirectoryRepository } from './directory';
import type { Project, Role, WorkItem } from './index';
import { runMigrations } from './migrate';
import { ProjectRepository } from './project';
import { UserRepository } from './user';
import { WorkItemRepository } from './work-item';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

let dir: string;
let repo: DirectoryRepository;
let workItems: WorkItemRepository;
let projectId: string;
let roleId: string;
let otherRoleId: string;
let itemId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-directory-'));
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  const db = openDrizzle(path);
  repo = new DirectoryRepository(db);
  workItems = new WorkItemRepository(db);

  const ownerId = crypto.randomUUID();
  await new UserRepository(db).create({
    id: ownerId,
    username: 'owner',
    passwordHash: 'x',
    createdAt: 1,
  });
  projectId = crypto.randomUUID();
  roleId = crypto.randomUUID();
  otherRoleId = crypto.randomUUID();
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
    { id: roleId, projectId, name: 'Dev', position: 10 },
    { id: otherRoleId, projectId, name: 'QA', position: 20 },
  ];
  await new ProjectRepository(db).create(project, roles);
  itemId = crypto.randomUUID();
  const item: WorkItem = {
    id: itemId,
    projectId,
    parentId: null,
    position: 10,
    name: 'Strip',
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
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('DirectoryRepository', () => {
  it('adds a team, and adding the same name again gives back the same row', async () => {
    // The picker types a name when the list does not have it, so this is the
    // ordinary path rather than a race nobody hits.
    const first = await repo.addTeam({ id: crypto.randomUUID(), name: 'Platform' });
    const again = await repo.addTeam({ id: crypto.randomUUID(), name: 'Platform' });

    expect(again.id).toBe(first.id);
    expect((await repo.listTeams()).map((t) => t.name)).toEqual(['Platform']);
  });

  it('takes a team\u2019s ownership rows with the service, and moves no work item', async () => {
    // The cascade the schema declares, read from the map's own side. Chunk 5
    // proved `ON DELETE SET NULL` on the work item's column; this is the other
    // half of the same removal, and the two are deliberately separate claims:
    // an ownership row about a service that no longer exists is not an effect
    // on any plan (spec), so it goes silently, while the work item stays.
    const platform = await repo.addTeam({ id: crypto.randomUUID(), name: 'Platform' });
    const payments = await repo.addService({ id: crypto.randomUUID(), name: 'Payments' });
    const auth = await repo.addService({ id: crypto.randomUUID(), name: 'Auth' });
    await repo.patchTeam(platform.id, { serviceIds: [payments.id, auth.id] });

    const removed = await repo.removeService(payments.id, true);
    expect(removed.ok).toBe(true);

    // `Auth` survives on the same team: the cascade takes the rows naming the
    // removed service, not the team's whole map.
    expect(await repo.listTeams()).toEqual([
      { id: platform.id, name: 'Platform', serviceIds: [auth.id] },
    ]);
  });

  it('deduplicates the owned set rather than letting the primary key throw', async () => {
    const platform = await repo.addTeam({ id: crypto.randomUUID(), name: 'Platform' });
    const payments = await repo.addService({ id: crypto.randomUUID(), name: 'Payments' });

    // A client naming the same service twice means exactly what it says. Left
    // to the pair primary key it would be a 500 for a well-formed request —
    // `patchPerson`'s reasoning, one dimension over.
    const written = await repo.patchTeam(platform.id, {
      serviceIds: [payments.id, payments.id],
    });

    expect(written).toEqual({
      ok: true,
      team: { id: platform.id, name: 'Platform', serviceIds: [payments.id] },
      projectIds: [],
    });
  });

  it('keeps a person in several teams at once', async () => {
    const platform = await repo.addTeam({ id: crypto.randomUUID(), name: 'Platform' });
    const billing = await repo.addTeam({ id: crypto.randomUUID(), name: 'Billing' });
    const ada = await personAdded(
      repo.addPerson({ id: crypto.randomUUID(), name: 'Ada' }, [platform.id]),
    );
    await personAdded(repo.addPerson({ id: crypto.randomUUID(), name: 'Ada' }, [billing.id]));

    const people = await repo.listPeople();

    expect(people).toHaveLength(1);
    expect(people[0]?.id).toBe(ada.id);
    expect([...(people[0]?.teamIds ?? [])].sort()).toEqual([platform.id, billing.id].sort());
  });

  it('leaves a person with no team a free agent, not a member of anything', async () => {
    await personAdded(repo.addPerson({ id: crypto.randomUUID(), name: 'Grace' }, []));

    // The empty array, not a magic team id: a real "Free agents" row could be
    // renamed, deleted or given work of its own.
    expect((await repo.listPeople())[0]?.teamIds).toEqual([]);
  });

  it('holds one assignee per role, replacing rather than adding', async () => {
    const ada = await personAdded(repo.addPerson({ id: crypto.randomUUID(), name: 'Ada' }, []));
    const grace = await personAdded(repo.addPerson({ id: crypto.randomUUID(), name: 'Grace' }, []));

    await repo.assign(itemId, roleId, ada.id);
    await repo.assign(itemId, roleId, grace.id);

    expect(await repo.assignmentsOf([itemId])).toEqual([
      { workItemId: itemId, roleId, personId: grace.id },
    ]);
  });

  it('clears one work item’s role without touching the other role or anyone else’s', async () => {
    // Both halves of the condition are load-bearing, and each needs its own
    // survivor to prove it. The first attempt at this test had one work item,
    // so narrowing the delete to the role alone — which would clear that role
    // on every work item in the database — passed it.
    const ada = await personAdded(repo.addPerson({ id: crypto.randomUUID(), name: 'Ada' }, []));
    const otherItemId = crypto.randomUUID();
    await workItems.insert(
      {
        id: otherItemId,
        projectId,
        parentId: null,
        position: 20,
        name: 'Sand',
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
    await repo.assign(itemId, roleId, ada.id);
    await repo.assign(itemId, otherRoleId, ada.id);
    await repo.assign(otherItemId, roleId, ada.id);

    await repo.assign(itemId, roleId, null);

    const left = await repo.assignmentsOf([itemId, otherItemId]);
    expect(left).toHaveLength(2);
    // The same role on another work item survives — that is the work-item half.
    expect(left).toContainEqual({ workItemId: otherItemId, roleId, personId: ada.id });
    // And the other role on this one — that is the role half.
    expect(left).toContainEqual({ workItemId: itemId, roleId: otherRoleId, personId: ada.id });
  });

  it('refuses an assignment naming a person who has been removed', async () => {
    // The person is read inside the write's own transaction, so this is a
    // typed refusal rather than the foreign key it used to be — a client
    // holding a picker rendered a moment too early is out of date, not broken.
    const gone = crypto.randomUUID();

    expect(await repo.assign(itemId, roleId, gone)).toEqual({
      ok: false,
      reason: 'unknown_person',
    });
    expect(await repo.assignmentsOf([itemId])).toEqual([]);
  });

  it('refuses a label naming a team that has been removed', async () => {
    const platform = await repo.addTeam({ id: crypto.randomUUID(), name: 'Platform' });
    await workItems.patch(itemId, { serviceTeamId: platform.id });
    await repo.removeTeam(platform.id, true);

    // `work_item.service_team_id` has no foreign key, so nothing under this
    // would refuse the write: without the read in the update's own transaction
    // the row simply carries an id the directory does not hold.
    expect(await workItems.patch(itemId, { serviceTeamId: platform.id })).toEqual({
      ok: false,
      reason: 'unknown_team',
    });
    expect((await workItems.findById(itemId))?.serviceTeamId).toBeNull();
  });
});
