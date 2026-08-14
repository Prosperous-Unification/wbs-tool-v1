import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { CapacityRepository } from '../repository/capacity';
import { openDrizzle } from '../repository/db';
import { DependencyRepository } from '../repository/dependency';
import { DirectoryRepository } from '../repository/directory';
import { EstimateRepository } from '../repository/estimate';
import type { WorkItem } from '../repository/index';
import { runMigrations } from '../repository/migrate';
import { ProjectRepository } from '../repository/project';
import { service, workItemService } from '../repository/schema';
import { UserRepository } from '../repository/user';
import { SubtreeRepository, WorkItemRepository } from '../repository/work-item';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { inMemoryCommandJournal } from '../testing/command-journal-fixture';
import { WorkItemService } from './work-item.service';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

/**
 * **The service no-op differential.** A service is a label: it has no size, no
 * pool, and no effect on any date (Dany, 2026-08-13 23:41).
 *
 * That is the whole claim of the second dimension, and it is the one claim a
 * later change can take away by accident — nothing in a schema stops a
 * migration adding `service.size`, and nothing in a type stops an adapter
 * putting a service id into `Slice.poolId`. The structural half of the
 * guarantee is that `slicesOf` is never handed the service sets at all. This is
 * the differential half: the same plan, read twice, the second time with every
 * row labelled with services, compared field by field.
 *
 * Against **real** SQLite and the real repositories, unlike the capacity
 * oracle's in-memory replay, for one reason: nothing in this release writes a
 * service, so the only way to have any is to write the rows the way R2-5's
 * routes will. An in-memory store told to answer with services would be a
 * fixture asserting its own arrangement.
 *
 * The plan is deliberately one a pool actually binds — a sized team, three
 * leaves competing for two slots — because a differential over a plan with no
 * contention would be green against an engine that had lost the pool entirely.
 */
describe('services label work and move nothing', () => {
  let dir: string;
  let path: string;
  let projectId: string;
  let roleId: string;
  let teamId: string;
  let rows: WorkItem[];

  function serviceOf(): WorkItemService {
    const db = openDrizzle(path);
    const workItems = new WorkItemRepository(db);
    const estimates = new EstimateRepository(db);
    const dependencies = new DependencyRepository(db);
    const directory = new DirectoryRepository(db);
    return new WorkItemService({
      workItems,
      projects: new ProjectRepository(db),
      estimates,
      dependencies,
      directory,
      capacity: new CapacityRepository(db),
      subtrees: new SubtreeRepository(db),
      journal: inMemoryCommandJournal(),
      broadcast: recordingBroadcaster(),
    });
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wbs-service-noop-'));
    path = join(dir, 'test.db');
    runMigrations(path, FOLDER);
    const db = openDrizzle(path);

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
        startDate: '2026-09-01',
        revision: 0,
        createdAt: 1,
      },
      [{ id: roleId, projectId, name: 'Dev', position: 10 }],
    );
    const directory = new DirectoryRepository(db);
    teamId = (await directory.addTeam({ id: crypto.randomUUID(), name: 'Platform' })).id;
    // Two slots and three leaves, so the third waits: the plan has a capacity
    // floor in it and this differential is measuring something.
    await new CapacityRepository(db).set(projectId, teamId, 2);

    const workItems = new WorkItemRepository(db);
    const estimates = new EstimateRepository(db);
    rows = [];
    // Three rows on the team, and a fourth on none. The fourth is what makes
    // the differential able to see a service reaching the engine: a row that
    // already has a team never falls through to whatever comes after it, so a
    // plan where every row is labelled is green against a build that reads
    // `teams ?? services`.
    for (const [at, name] of ['Strip', 'Rewire', 'Make good', 'Snagging'].entries()) {
      const row: WorkItem = {
        id: crypto.randomUUID(),
        projectId,
        parentId: null,
        position: (at + 1) * 10,
        name,
        notes: '',
        frozenNumber: null,
        priority: null,
        startNoEarlierThan: null,
        serviceTeamId: name === 'Snagging' ? null : teamId,
        maxParallel: 1,
        revision: 0,
      };
      rows.push(row);
      await workItems.insert(row, []);
      await estimates.set({
        workItemId: row.id,
        roleId,
        optimistic: 2,
        realistic: 2,
        pessimistic: 2,
      });
    }
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is measuring a plan a pool actually binds', async () => {
    // The coverage assertion `schedule-identity.test.ts` insists on: a
    // differential over a plan nothing contends in is green against an engine
    // that lost the pool, and would say nothing about services either way.
    const tree = await serviceOf().tree(projectId);
    if (tree === null) throw new Error('the plan vanished');
    expect(tree.slices.some((slice) => slice.boundBy === 'capacity')).toBe(true);
    expect(tree.waitingForCapacity).toBeGreaterThan(0);
  });

  it('schedules a plan identically with every row labelled with two services', async () => {
    // Proof: `slicesOf` given the service sets as a second argument and a pool
    // of `teams ?? services` — the one-line mistake a second dimension invites,
    // and exactly the model this change reversed at 23:41 — and this failed on
    //
    //   PluralMembershipError: work item <id> names 2 resources (<payments>,
    //   <auth>), and this release reads one
    //     at soleMemberOf … at slicesOf … at tree
    //
    // thrown for `Snagging`, the row with no team: its two services fell through
    // into the pool the teams should have filled. 1 pass / 1 fail, the coverage
    // case beside it still green. Watched 2026-08-14.
    const before = await serviceOf().tree(projectId);
    if (before === null) throw new Error('the plan vanished');

    const db = openDrizzle(path);
    const payments = { id: crypto.randomUUID(), name: 'Payments' };
    const auth = { id: crypto.randomUUID(), name: 'Auth' };
    await db.insert(service).values([payments, auth]);
    await db.insert(workItemService).values(
      rows.flatMap((row) => [
        { workItemId: row.id, serviceId: payments.id },
        { workItemId: row.id, serviceId: auth.id },
      ]),
    );

    const after = await serviceOf().tree(projectId);
    if (after === null) throw new Error('the plan vanished');

    // Field by field, and the added field asserted rather than skipped: a
    // comparison that dropped `serviceIds` would pass against a build that had
    // stopped reading the table at all, which is the same test with none of the
    // premise.
    expect(after.slices).toEqual(before.slices);
    expect(after.waitingForCapacity).toBe(before.waitingForCapacity);
    expect(after.workItems).toHaveLength(before.workItems.length);
    for (const [at, was] of before.workItems.entries()) {
      // `.at`, so a shorter answer throws here rather than spreading
      // `undefined` into the comparison and passing against nothing.
      const now = after.workItems.at(at);
      if (now === undefined) throw new Error(`row ${was.number} vanished`);
      expect({ number: now.number, schedule: now.schedule, dates: now.dates }).toEqual({
        number: was.number,
        schedule: was.schedule,
        dates: was.dates,
      });
      expect(now.teamIds).toEqual(now.name === 'Snagging' ? [] : [teamId]);
      // Sorted by id in SQL, so the payload cannot reshuffle between two reads
      // of an unchanged plan.
      expect([...now.serviceIds].sort()).toEqual([payments.id, auth.id].sort());
      expect(was.serviceIds).toEqual([]);
    }
  });
});
