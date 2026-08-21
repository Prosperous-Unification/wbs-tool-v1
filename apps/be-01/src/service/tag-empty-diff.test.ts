import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { Role } from '../repository';
import { ActualRepository } from '../repository/actual';
import { CapacityRepository } from '../repository/capacity';
import { CommandJournalRepository } from '../repository/command-journal';
import { openDrizzle } from '../repository/db';
import { DependencyRepository } from '../repository/dependency';
import { DirectoryRepository } from '../repository/directory';
import { EstimateRepository } from '../repository/estimate';
import { runMigrations } from '../repository/migrate';
import { ProjectRepository } from '../repository/project';
import { RoleMeasureRepository } from '../repository/role-measure';
import { RoleProgressRepository } from '../repository/role-progress';
import { UserRepository } from '../repository/user';
import { SubtreeRepository, WorkItemRepository } from '../repository/work-item';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { inMemoryPriorityBands } from '../testing/priority-band-fixture';
import { ProjectService } from './project.service';
import { WorkItemService } from './work-item.service';

/**
 * **The central claim of `tags`, asserted on a plan where a label really does
 * decide dates.**
 *
 * A team says who does the work and the scheduler spends its capacity; a tag
 * says what kind of thing this is and the scheduler must never read it. The
 * first half is what makes this file's assertion non-vacuous: the plan below has
 * a **sized** team, so its two independent leaves are serialised by the pool
 * rather than running side by side. Take the label away and the dates move.
 *
 * That is the control. Against it, the claim: a plan with tags on it and the
 * same plan after every tag has been deleted — cascade and all — come out
 * identical in every schedule number and every date.
 *
 * **Real SQLite and a real `CapacityRepository`, both deliberately.** An earlier
 * version of this test used the in-memory capacity fixture with nothing seeded,
 * so no pool existed, so no label decided anything: the injected fault —
 * `effectiveTeamsOf` pointed at `tagIds` — passed green, and the test was
 * asserting that two identical reads are identical. Found by watching the fault
 * rather than by reading the test, 2026-08-20. The cascade needs real foreign
 * keys for the same class of reason.
 */
const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

let dir: string;
let workItems: WorkItemService;
let workItemStore: WorkItemRepository;
let directoryStore: DirectoryRepository;
let capacityStore: CapacityRepository;
let projects: ProjectService;
let projectId: string;
let ownerId: string;
let roles: Role[];

const DAYS = { optimistic: 2, realistic: 2, pessimistic: 2 };

const dev = (): string => {
  const found = roles.at(0);
  if (found === undefined) throw new Error('the project was created without its starting roles');
  return found.id;
};

async function root(name: string, afterId: string | null = null): Promise<string> {
  const outcome = await workItems.create(projectId, ownerId, { parentId: null, afterId, name });
  if (!outcome.ok) throw new Error(`create refused: ${outcome.reason}`);
  return outcome.result.id;
}

/** Every row's name beside its dates — what "no date moved" is asserted over. */
async function datesNow(): Promise<unknown> {
  const tree = await workItems.tree(projectId);
  return {
    workItems: tree?.workItems.map((row) => ({
      name: row.name,
      schedule: row.schedule,
      dates: row.dates,
    })),
    slices: tree?.slices,
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-tag-empty-diff-'));
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  const db = openDrizzle(path);

  const projectStore = new ProjectRepository(db);
  workItemStore = new WorkItemRepository(db);
  directoryStore = new DirectoryRepository(db);
  capacityStore = new CapacityRepository(db);

  ownerId = crypto.randomUUID();
  await new UserRepository(db).create({
    id: ownerId,
    username: 'owner',
    passwordHash: 'x',
    createdAt: 1,
  });

  projects = new ProjectService({ projects: projectStore });
  workItems = new WorkItemService({
    workItems: workItemStore,
    projects: projectStore,
    estimates: new EstimateRepository(db),
    actuals: new ActualRepository(db),
    measures: new RoleMeasureRepository(db),
    progress: new RoleProgressRepository(db),
    directory: directoryStore,
    capacity: capacityStore,
    priorityBands: inMemoryPriorityBands(),
    dependencies: new DependencyRepository(db),
    subtrees: new SubtreeRepository(db),
    journal: new CommandJournalRepository(db),
    broadcast: recordingBroadcaster(),
  });

  const created = await projects.create('Rewire the shed', ownerId);
  projectId = created.project.id;
  roles = created.roles;
  await projects.update(projectId, ownerId, { startDate: '2026-09-01' });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a tag decides no date, on a plan where a label does', () => {
  /**
   * Two independent leaves, both on one team of one, both tagged.
   *
   * Independent — no dependency between them — so the **only** thing that can
   * put one after the other is the pool. Two days each, so a serialised plan
   * finishes on day four and a parallel one on day two: a difference no rounding
   * can hide.
   */
  async function pooledPlan(): Promise<{ strip: string; cable: string; tagId: string }> {
    const platform = await directoryStore.addTeam({ id: crypto.randomUUID(), name: 'Platform' });
    const regulatory = await directoryStore.addTag({
      id: crypto.randomUUID(),
      name: 'regulatory',
    });
    const strip = await root('Strip the roof');
    const cable = await root('Cable it', strip);
    await workItems.setEstimate(strip, ownerId, dev(), DAYS);
    await workItems.setEstimate(cable, ownerId, dev(), DAYS);
    // One at a time, which is what makes the label decide a date.
    await capacityStore.set(projectId, platform.id, 1);
    await workItems.patch(strip, ownerId, { serviceTeamId: platform.id, tagIds: [regulatory.id] });
    await workItems.patch(cable, ownerId, { serviceTeamId: platform.id, tagIds: [regulatory.id] });
    return { strip, cable, tagId: regulatory.id };
  }

  it('serialises the two leaves while the team is sized — the control', async () => {
    // **Non-vacuity, and it is the whole reason this file exists.** Without this
    // the assertion below is "two identical reads are identical", which is true
    // of any build, including one where the scheduler reads tags.
    const { strip } = await pooledPlan();

    const pooled = await datesNow();

    // Take the label off one of them: it leaves the pool, the two run side by
    // side, and the plan gets shorter. If this does not move, nothing in this
    // file is measuring anything.
    await workItems.patch(strip, ownerId, { serviceTeamId: null });

    expect(await datesNow()).not.toEqual(pooled);
  });

  it('moves not one date when every tag is deleted, cascade and all', async () => {
    // The claim. The labelling really goes — asserted first, so this is a
    // comparison of two plans that differ rather than two reads of one that
    // does not — and every schedule number and every date is where it was.
    //
    // Proof: `effectiveTeamsOf(rows)` in `work-item.service.ts` replaced by
    // `effectiveTeamsOf(rows.map((r) => (r.tagIds.length > 0 ? { ...r, teamIds:
    // r.tagIds } : r)))` — the scheduler reading a tag as if it were a team —
    // and **1 pass, 2 fail**: this one on the dates, because the two rows then
    // sit in a pool keyed on a tag id nothing has stated a capacity for, so they
    // stop being serialised — and `serialises the two leaves while the team is
    // sized` beside it, because taking the *team* label off a row the scheduler
    // is reading tags from moves nothing. That the control fails too is the
    // clearest statement of the fault: the plan's dates stop answering to the
    // team at all. Watched 2026-08-20, see verify.md.
    const { tagId } = await pooledPlan();

    const before = await datesNow();
    expect(
      (await workItemStore.listByProject(projectId)).some((row) => row.tagIds.length > 0),
    ).toBe(true);

    const removed = await directoryStore.removeTag(tagId, true);
    expect(removed.ok).toBe(true);

    expect(
      (await workItemStore.listByProject(projectId)).every((row) => row.tagIds.length === 0),
    ).toBe(true);
    expect(await datesNow()).toEqual(before);
  });

  it('moves not one date when a tag is put on, taken off and replaced', async () => {
    // The write path's half of the same claim: labelling and unlabelling are
    // writes, and a write that touched anything the engine reads would show up
    // here rather than in the delete.
    const { strip, cable } = await pooledPlan();
    const techDebt = await directoryStore.addTag({ id: crypto.randomUUID(), name: 'tech-debt' });

    const before = await datesNow();

    await workItems.patch(strip, ownerId, { tagIds: [] });
    await workItems.patch(cable, ownerId, { tagIds: [techDebt.id] });
    await workItems.patch(strip, ownerId, { tagIds: [techDebt.id] });

    expect(await datesNow()).toEqual(before);
  });
});
