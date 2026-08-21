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
import { RoleProgressRepository } from '../repository/role-progress';
import { UserRepository } from '../repository/user';
import { SubtreeRepository, WorkItemRepository } from '../repository/work-item';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { inMemoryPriorityBands } from '../testing/priority-band-fixture';
import { ProjectService } from './project.service';
import { WorkItemService } from './work-item.service';

/**
 * **Task 4.5, asserted on a plan where a label really does decide dates.**
 *
 * Two claims, one file. A team says who does the work and the scheduler spends
 * its capacity. The **service** says what the work is part of, and the
 * **ownership map** says which team is accountable for it — and the scheduler
 * must read neither. So:
 *
 * - deleting a service moves no date, and
 * - editing the ownership map moves no date.
 *
 * `tag-empty-diff.test.ts` is this file's template and the resemblance is the
 * point: the third dimension earns its own file rather than a case in that one,
 * because the map is a *fourth* thing — not a label on any work item at all —
 * and a reader looking for "does the map touch the schedule" should find the
 * question asked in a file named after it.
 *
 * **Non-vacuity is the whole discipline here.** The plan below has a *sized*
 * team, so its two independent leaves are serialised by the pool rather than
 * running side by side; take the team label off and the dates move. Without
 * that control every assertion in this file would be "two identical reads are
 * identical", which is true of a build where the scheduler reads services.
 * Real SQLite and a real `CapacityRepository` for the same reason the tag file
 * uses them — the in-memory capacity fixture seeds no pool, so nothing decides
 * anything and every fault passes green.
 *
 * **Re-aimed in chunk 22, and the reason is the sharpest finding in this
 * change.** Written at task 4.5 this file labelled its rows with `serviceId`,
 * because that is what a row carried then. Chunk 12 widened the dimension to a
 * set and chunk 10.2 moved the fact onto `work_item_service`, leaving
 * `work_item.service_id` standing for the release that is still running (design
 * D2) — read by nothing. The file kept passing anyway: `serviceId` is not in
 * `WorkItemPatch`, so it fell through the patch's rest-spread straight onto the
 * dead column, and the FK's `on delete set null` nulled it again on removal.
 * Green, and measuring the one field in the schema that no scheduler could read
 * even if it wanted to. Every case below now labels through `serviceIds` and
 * asserts the label's presence **in the shape `listByProject` delivers**, so the
 * plan under test is one the engine can actually see.
 *
 * **Why the gate could not catch it:** `nx typecheck` builds
 * `tsconfig.lib.json`, which excludes every `.test.ts` under `src`. Test files
 * in this repo are never typechecked — a stale field name is invisible to lint,
 * typecheck and a green suite alike. The only defence is asserting the fact is
 * present rather than trusting the write, which is what the guards below do.
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
  dir = mkdtempSync(join(tmpdir(), 'wbs-service-empty-diff-'));
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

describe('a service and the ownership map decide no date, on a plan where a label does', () => {
  /**
   * Two independent leaves, both on one team of one, both labelled with the
   * same service, and the team owns it.
   *
   * Independent — no dependency between them — so the **only** thing that can
   * put one after the other is the pool. Two days each, so a serialised plan
   * finishes on day four and a parallel one on day two: a difference no rounding
   * can hide.
   */
  async function pooledPlan(): Promise<{
    strip: string;
    cable: string;
    teamId: string;
    serviceId: string;
    otherServiceId: string;
  }> {
    const platform = await directoryStore.addTeam({ id: crypto.randomUUID(), name: 'Platform' });
    const payments = await directoryStore.addService({
      id: crypto.randomUUID(),
      name: 'Payments',
    });
    const auth = await directoryStore.addService({ id: crypto.randomUUID(), name: 'Auth' });
    // The team owns what it is building, so the plan starts in the state the
    // signal calls *matched*. Every edit below moves it out of that state and
    // back, which is the map being exercised rather than merely present.
    await directoryStore.patchTeam(platform.id, { serviceIds: [payments.id] });
    const strip = await root('Strip the roof');
    const cable = await root('Cable it', strip);
    await workItems.setEstimate(strip, ownerId, dev(), DAYS);
    await workItems.setEstimate(cable, ownerId, dev(), DAYS);
    // One at a time, which is what makes the team label decide a date.
    await capacityStore.set(projectId, platform.id, 1);
    await workItems.patch(strip, ownerId, {
      serviceTeamId: platform.id,
      serviceIds: [payments.id],
    });
    await workItems.patch(cable, ownerId, {
      serviceTeamId: platform.id,
      serviceIds: [payments.id],
    });
    // The plan is only a service plan if the service came back on the read the
    // engine uses. Asserted here, once, rather than trusted in four cases: this
    // is the guard that would have failed the file the moment `serviceId` went
    // stale, and it is cheaper than typechecking specs.
    expect(
      (await workItemStore.listByProject(projectId)).filter((row) => row.serviceIds.length > 0)
        .length,
    ).toBe(2);
    return {
      strip,
      cable,
      teamId: platform.id,
      serviceId: payments.id,
      otherServiceId: auth.id,
    };
  }

  it('serialises the two leaves while the team is sized — the control', async () => {
    // **Non-vacuity, and it is the whole reason this file exists.** Without this
    // every assertion below is "two identical reads are identical", which is
    // true of any build, including one where the scheduler reads services.
    const { strip } = await pooledPlan();

    const pooled = await datesNow();

    // Take the *team* off one of them: it leaves the pool, the two run side by
    // side, and the plan gets shorter. If this does not move, nothing in this
    // file is measuring anything.
    await workItems.patch(strip, ownerId, { serviceTeamId: null });

    expect(await datesNow()).not.toEqual(pooled);
  });

  it('moves not one date when the service is deleted, cascade and all', async () => {
    // The first claim, and the watched red for it.
    //
    // Proof: `const teamOf = effectiveTeamsOf(rows)` at `work-item.service.ts`
    // :1097 replaced by `effectiveTeamsOf(rows.map((r) => (r.serviceIds.length >
    // 0 ? { ...r, teamIds: r.serviceIds } : r)))` — the scheduler reading a
    // row's service set as if it were its team set — and **1 pass, 3 fail**,
    // watched on h2puni 2026-08-21 (chunk 22). The recorded red before it aimed
    // at `r.serviceId !== null`, the dead column, and is exactly what the
    // re-aim above was for.
    //
    // Three different shapes of failure, which is why the count went up: this
    // case and the ownership-map case fail on the dates, and `put on, taken off
    // and replaced` fails *harder* — `poolFor` throws outright, because a row
    // carrying two services now claims two teams and a slice can only spend one
    // pool. A set-valued dimension read as a pool key is not merely a wrong
    // date; it is a plan that cannot be scheduled at all. The control passes
    // here only because that row keeps one service.
    //
    // The labelling really goes — asserted on both sides, so
    // this is a comparison of two plans that differ rather than two reads of one
    // that does not — and every schedule number and every date is where it was.
    const { serviceId } = await pooledPlan();

    const before = await datesNow();

    const removed = await directoryStore.removeService(serviceId, true);
    expect(removed.ok).toBe(true);

    // The cascade really emptied the rows — off the join table, which is where
    // `removeService` deletes and where the read looks. Asserting this over
    // `work_item.service_id` instead is what made the case vacuous until
    // chunk 22: that column is nulled by the FK whether or not the removal
    // understood the join at all.
    expect(
      (await workItemStore.listByProject(projectId)).every((row) => row.serviceIds.length === 0),
    ).toBe(true);
    expect(await datesNow()).toEqual(before);
  });

  it('moves not one date when the ownership map is edited', async () => {
    // **The map half has no fault to inject, and that is the finding rather
    // than a gap.** The red above leaves this case green, because it breaks the
    // reading of the *item's* service and the map is not on the item at all.
    // Nothing under the scheduling surface reads the map to break: `grep -rn
    // serviceIds apps/be-01/src libs/domain/src`, minus its own tests and the
    // five directory files that own it, returns **nothing** — watched
    // 2026-08-21. So this case is a regression guard rather than a proof: the
    // day somebody wires the map into a pool key, it goes red here. What proves
    // the claim today is the grep and `DirectoryService.patchTeam`'s own red,
    // where announcing a map edit like a rename fails `editing the ownership map
    // announces nothing`.
    //
    // The second claim, and the one the spec states in as many words: "editing
    // it SHALL move no date in any plan". Every reachable state of the map for
    // this team, in order — owning what it builds, owning something else
    // entirely, owning both, owning nothing — because a map read by the
    // scheduler would most plausibly be read as a *pool key*, and that fault
    // shows up on the transitions rather than on any single state.
    const { teamId, serviceId, otherServiceId } = await pooledPlan();

    const before = await datesNow();

    await directoryStore.patchTeam(teamId, { serviceIds: [otherServiceId] });
    expect(await datesNow()).toEqual(before);

    await directoryStore.patchTeam(teamId, { serviceIds: [serviceId, otherServiceId] });
    expect(await datesNow()).toEqual(before);

    await directoryStore.patchTeam(teamId, { serviceIds: [] });
    expect(await datesNow()).toEqual(before);
  });

  it('moves not one date when a service is put on, taken off and replaced', async () => {
    // The write path's half of the same claim: labelling and unlabelling are
    // writes, and a write that touched anything the engine reads would show up
    // here rather than in the delete.
    const { strip, cable, serviceId, otherServiceId } = await pooledPlan();

    const before = await datesNow();

    // Emptied, replaced, and widened to two — the set's reachable states, which
    // is more than the single column could express and the reason this case is
    // worth more after the widening than before it.
    await workItems.patch(strip, ownerId, { serviceIds: [] });
    await workItems.patch(cable, ownerId, { serviceIds: [otherServiceId] });
    await workItems.patch(strip, ownerId, { serviceIds: [serviceId, otherServiceId] });

    expect(
      (await workItemStore.listByProject(projectId)).map((row) => row.serviceIds.length).sort(),
    ).toEqual([1, 2]);
    expect(await datesNow()).toEqual(before);
  });
});
