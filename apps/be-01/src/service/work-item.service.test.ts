import { workdaysBetween } from '@wbs/domain';
import { beforeEach, describe, expect, it } from 'bun:test';

import type {
  CapacityStore,
  DependencyStore,
  DirectoryStore,
  Project,
  ProjectStore,
  WorkItemStore,
  WriteStamp,
} from '../repository';
import { type RecordingBroadcaster } from '../testing/broadcast-fixture';
import { personAdded } from '../testing/directory-fixture';
import { inMemoryServices } from '../testing/harness';
import { inMemoryPriorityBands } from '../testing/priority-band-fixture';
import { projectRow } from '../testing/project-fixture';
import { workItemRow } from '../testing/work-item-fixture';
import { poolsFor, WorkItemService, type WorkItemServiceOptions } from './work-item.service';

const OWNER = 'owner-account';
const STRANGER = 'stranger-account';

/**
 * The stamp the arrangements here write with. Every store below is an in-memory
 * one, so `created_by`'s foreign key is not in play; the owner is named because
 * these arrangements are the owner's, not because anything checks.
 */
const WROTE: WriteStamp = { at: 1, by: OWNER };

let projects: ProjectStore;
let workItems: WorkItemStore;
let service: WorkItemService;
let serviceOptions: WorkItemServiceOptions;
let projectId: string;
let stepId: string;
let dependencies: DependencyStore;
let directory: DirectoryStore;
/**
 * This project's capacity for each team, which is where a pool size is stated
 * since `capacity-per-project`. `directory.addTeam({ size })` no longer bounds
 * anything: the global number is read by nothing.
 */
let capacity: CapacityStore;
let broadcast: RecordingBroadcaster;

beforeEach(async () => {
  const harness = inMemoryServices();
  ({ projects, dependencies, directory, workItems, capacity } = harness.stores);
  broadcast = harness.broadcast;
  // Kept whole: three cases below build a second service from these options with
  // one store swapped for a broken one, which is how they drive a failure the
  // real stores cannot produce.
  serviceOptions = { ...harness.stores, broadcast };
  service = harness.service;
  const project: Project = projectRow({
    id: crypto.randomUUID(),
    ownerId: OWNER,
  });
  stepId = crypto.randomUUID();
  await projects.create(
    project,
    [{ id: stepId, projectId: project.id, name: 'Dev', position: 10 }],
    WROTE,
  );
  projectId = project.id;
  // The people these tests assign. They have to be in the directory because
  // production reads the person inside the assignment's own transaction and
  // refuses one it does not hold — a fixture that let an unknown id through
  // would be laxer than the schema it stands for.
  for (const name of ['ada', 'grace', 'kat', 'ada-of-platform']) {
    await personAdded(directory.addPerson({ id: name, name }, [], WROTE));
  }
  // The same for the teams these tests label with: `patch` reads the team
  // inside the update's own transaction, because `work_item.service_team_id`
  // has no foreign key to do it.
  for (const name of ['team-billing', 'team-sparks']) {
    await directory.addTeam({ id: name, name }, WROTE);
  }
});

/** Creates under `parentId`, after `afterId`, returning the new id. */
async function add(name: string, parentId: string | null = null, afterId: string | null = null) {
  const outcome = await service.create(projectId, OWNER, { parentId, afterId, name });
  if (!outcome.ok) throw new Error(`create failed: ${outcome.reason}`);
  return outcome.value.id;
}

/**
 * The same, created with **no** priority — the explicit-null create.
 *
 * {@link add} carries the project's middle rung since `priority-default-medium`;
 * this is the create for a test whose subject is a row nobody has ranked, which
 * is what every row written before that change still is.
 */
async function unranked(name: string, parentId: string | null = null) {
  const outcome = await service.create(projectId, OWNER, {
    parentId,
    afterId: null,
    name,
    priority: null,
  });
  if (!outcome.ok) throw new Error(`create failed: ${outcome.reason}`);
  return outcome.value.id;
}

/**
 * Puts `count` children under `parentId`, straight through the store.
 *
 * Not through `create`: five hundred creates are five hundred whole-tree
 * announces, and the only thing under test here is how many rows there are.
 */
async function fill(parentId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await workItems.insert(
      {
        id: crypto.randomUUID(),
        projectId,
        parentId,
        position: (i + 1) * 10,
        name: `Back box ${String(i)}`,
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
      },
      [],
      WROTE,
    );
  }
}

/** The project's work items as `number → name`, which is what a reader actually sees. */
async function numbered(): Promise<Record<string, string>> {
  const tree = await service.tree(projectId);
  if (tree === null) throw new Error('project vanished');
  return Object.fromEntries(tree.workItems.map((w) => [w.number, w.name]));
}

describe('the pools a row spends slots in', () => {
  it('spends nothing where the set is empty', () => {
    // _Unstated_ constrains nothing, which is the state most rows are in.
    expect(poolsFor([], new Map([['backend', 2]]))).toEqual({ poolIds: [], slots: undefined });
  });

  it('spends nothing in a team this project has stated no capacity for', () => {
    // An unsized team labels the work and constrains nothing — the empty pool
    // set is what keeps the engine's `no size for pool` throw a caller-fault
    // assertion rather than ordinary control flow.
    expect(poolsFor(['design'], new Map([['backend', 2]]))).toEqual({
      poolIds: [],
      slots: undefined,
    });
  });

  it('spends in the one sized team the row names, at its stated size', () => {
    expect(poolsFor(['backend'], new Map([['backend', 2]]))).toEqual({
      poolIds: ['backend'],
      slots: 2,
    });
  });

  it('spends in every sized team the row names', () => {
    // R2-2's arity: each named team spends its own days, so each of them is a
    // pool the block draws a slot from. The order is the set's, which is the
    // store's — the joint search's answer does not depend on it.
    expect(
      poolsFor(
        ['backend', 'design'],
        new Map([
          ['backend', 2],
          ['design', 3],
        ]),
      ),
    ).toEqual({ poolIds: ['backend', 'design'], slots: 2 });
  });

  it('takes the narrowest stated size, whichever team states it', () => {
    // The clamp is a correctness bound, not a policy: a block wider than the
    // narrowest of its pools can never be placed there, and without the min
    // `CapacityTooNarrowError` becomes reachable from ordinary data. Asserted
    // both ways round so a `Math.max` cannot pass by accident of ordering, and
    // an unsized third team is in the set to show it contributes no clamp —
    // unstated is not a capacity of zero.
    const sizes = new Map([
      ['backend', 4],
      ['design', 1],
    ]);
    expect(poolsFor(['backend', 'design', 'unsized'], sizes)).toEqual({
      poolIds: ['backend', 'design'],
      slots: 1,
    });
    expect(poolsFor(['design', 'backend'], sizes)).toEqual({
      poolIds: ['design', 'backend'],
      slots: 1,
    });
  });
});

describe('creating work items', () => {
  it('numbers roots in the order they are added', async () => {
    const first = await add('Strip the old wiring');
    await add('Run the new cable', null, first);

    expect(await numbered()).toEqual({
      '010': 'Strip the old wiring',
      '020': 'Run the new cable',
    });
  });

  it('inserts between two siblings without writing either', async () => {
    const first = await add('Strip');
    await add('Cable', null, first);

    await add('Survey', null, first);

    expect(await numbered()).toEqual({ '010': 'Strip', '020': 'Survey', '030': 'Cable' });
  });

  it('nests children under their parent', async () => {
    const strip = await add('Strip');
    const socket = await add('Sockets', strip);
    await add('Back boxes', socket);

    expect(await numbered()).toEqual({
      '010': 'Strip',
      '010.1': 'Sockets',
      '010.1.1': 'Back boxes',
    });
  });

  it('accepts an empty name', async () => {
    await add('');
    expect(await numbered()).toEqual({ '010': '' });
  });

  it('refuses a stranger on a restricted project', async () => {
    await projects.update(projectId, { restricted: true }, WROTE);

    const outcome = await service.create(projectId, STRANGER, {
      parentId: null,
      afterId: null,
      name: 'Sneaky',
    });

    expect(outcome).toEqual({ ok: false, reason: 'forbidden' });
    expect(await numbered()).toEqual({});
  });
});

describe('moving work items', () => {
  it('renumbers everything the move displaced', async () => {
    const strip = await add('Strip');
    const cable = await add('Cable', null, strip);

    const outcome = await service.move(cable, OWNER, { parentId: null, afterId: null });

    expect(outcome.ok).toBe(true);
    expect(await numbered()).toEqual({ '010': 'Cable', '020': 'Strip' });
  });

  it('re-parents into another branch', async () => {
    const strip = await add('Strip');
    const cable = await add('Cable', null, strip);

    await service.move(cable, OWNER, { parentId: strip, afterId: null });

    expect(await numbered()).toEqual({ '010': 'Strip', '010.1': 'Cable' });
  });

  it('refuses to move a work item beneath itself', async () => {
    // Left unchecked this detaches the subtree from every root: the rows still
    // exist, no number can be derived for them, and the project reads as if the
    // work simply vanished.
    const strip = await add('Strip');
    const sockets = await add('Sockets', strip);

    const outcome = await service.move(strip, OWNER, { parentId: sockets, afterId: null });

    expect(outcome).toEqual({ ok: false, reason: 'cycle' });
    expect(await numbered()).toEqual({ '010': 'Strip', '010.1': 'Sockets' });
  });
});

describe('deleting work items', () => {
  it('removes a leaf and closes the gap', async () => {
    const strip = await add('Strip');
    const cable = await add('Cable', null, strip);
    await add('Test', null, cable);

    await service.remove(cable, OWNER, null);

    expect(await numbered()).toEqual({ '010': 'Strip', '020': 'Test' });
  });

  it('refuses a parent with no strategy, writing nothing', async () => {
    const strip = await add('Strip');
    await add('Sockets', strip);

    const outcome = await service.remove(strip, OWNER, null);

    expect(outcome).toEqual({ ok: false, reason: 'strategy_required' });
    expect(await numbered()).toEqual({ '010': 'Strip', '010.1': 'Sockets' });
  });

  it('cascade takes the whole subtree', async () => {
    const strip = await add('Strip');
    const sockets = await add('Sockets', strip);
    await add('Back boxes', sockets);
    await add('Cable', null, strip);

    await service.remove(strip, OWNER, 'cascade');

    expect(await numbered()).toEqual({ '010': 'Cable' });
  });

  it('promote lifts children into their parent’s place, in order', async () => {
    const strip = await add('Strip');
    const sockets = await add('Sockets', strip);
    await add('Switches', strip, sockets);
    await add('Cable', null, strip);

    await service.remove(strip, OWNER, 'promote');

    expect(await numbered()).toEqual({
      '010': 'Sockets',
      '020': 'Switches',
      '030': 'Cable',
    });
  });
});

describe('dependencies', () => {
  it('records an edge and reports it against the dependent work item', async () => {
    const a = await add('Strip');
    const b = await add('Sand');

    expect(await service.addDependency(b, OWNER, a)).toEqual({ ok: true, value: null });

    const tree = await service.tree(projectId);
    expect(tree?.workItems.find((w) => w.id === b)?.dependsOn).toEqual([a]);
    expect(tree?.workItems.find((w) => w.id === a)?.dependsOn).toEqual([]);
  });

  it('refuses an edge that closes a cycle and writes nothing', async () => {
    const a = await add('Strip');
    const b = await add('Sand');
    await service.addDependency(b, OWNER, a);

    expect(await service.addDependency(a, OWNER, b)).toEqual({ ok: false, reason: 'cycle' });

    const tree = await service.tree(projectId);
    expect(tree?.workItems.find((w) => w.id === a)?.dependsOn).toEqual([]);
  });

  it('refuses an edge onto its own parent', async () => {
    const parent = await add('Step');
    const child = await add('Task', parent);

    expect(await service.addDependency(child, OWNER, parent)).toEqual({
      ok: false,
      reason: 'ancestor',
    });
  });

  it('refuses a predecessor that is not in the project', async () => {
    const a = await add('Strip');

    expect(await service.addDependency(a, OWNER, crypto.randomUUID())).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('removes an edge, and removing one that is not there is not an error', async () => {
    const a = await add('Strip');
    const b = await add('Sand');
    await service.addDependency(b, OWNER, a);

    expect(await service.removeDependency(b, OWNER, a)).toEqual({ ok: true, value: null });
    expect(await service.removeDependency(b, OWNER, a)).toEqual({ ok: true, value: null });

    const tree = await service.tree(projectId);
    expect(tree?.workItems.find((w) => w.id === b)?.dependsOn).toEqual([]);
  });

  it("takes a work item's edges with it when it is deleted", async () => {
    // The foreign keys refuse a delete that would orphan an edge, so this is not
    // tidiness — without it, deleting a row that anything depends on fails.
    const a = await add('Strip');
    const b = await add('Sand');
    await service.addDependency(b, OWNER, a);

    expect(await service.remove(a, OWNER, null)).toEqual({ ok: true, value: null });

    const tree = await service.tree(projectId);
    expect(tree?.workItems.find((w) => w.id === b)?.dependsOn).toEqual([]);
  });

  it('takes the edges when a parent is deleted and its children are promoted', async () => {
    // The other delete path. It removes one row rather than a subtree, and it
    // had no edge cleanup at all — found by asking whether the first fix covered
    // both branches rather than assuming the tests would have said.
    const parent = await add('Step');
    await add('Task', parent);
    const other = await add('Sand');
    await service.addDependency(other, OWNER, parent);

    expect(await service.remove(parent, OWNER, 'promote')).toEqual({ ok: true, value: null });

    const tree = await service.tree(projectId);
    expect(tree?.workItems.find((w) => w.id === other)?.dependsOn).toEqual([]);
  });

  it('still reads a project whose dependencies contain a cycle', async () => {
    // The write path refuses a cycle, but two clients drawing conflicting edges
    // at the same instant are each checked against the graph as they read it.
    // If that ever lands, every read of the project must not throw — the rows
    // are still there and a plan nobody can open is worse than one with no
    // dates in it.
    const a = await add('Strip');
    const b = await add('Sand');
    await dependencies.add({ id: 'x', projectId, predecessorId: a, successorId: b }, WROTE);
    await dependencies.add({ id: 'y', projectId, predecessorId: b, successorId: a }, WROTE);

    const tree = await service.tree(projectId);

    expect(tree?.workItems).toHaveLength(2);
    expect(tree?.scheduleError).toBe('cycle');
    expect(tree?.workItems[0]?.schedule).toMatchObject({ earliestStart: 0, estimated: false });
  });

  it('lets a failure that is not a cycle out rather than calling it one', async () => {
    // codex, high. An unqualified catch turned every exception in that block
    // into "your dependencies run in a circle" — a stack overflow on a deep
    // tree, a future mistake in the duration sum, anything. R5: unknown is not
    // OK, and a confident wrong answer is the worst kind.
    const a = await add('Strip');
    const broken = {
      ...dependencies,
      listByProject: () => Promise.reject(new Error('the dependency table is on fire')),
    };
    const service2 = new WorkItemService({ ...serviceOptions, dependencies: broken });

    expect(service2.tree(projectId)).rejects.toThrow(/on fire/);
    expect(a).toBeDefined();
  });

  it('does not report a predecessor that is not in the project', async () => {
    const a = await add('Strip');
    await dependencies.add(
      {
        id: 'stray',
        projectId,
        predecessorId: crypto.randomUUID(),
        successorId: a,
      },
      WROTE,
    );

    const tree = await service.tree(projectId);

    expect(tree?.workItems.find((w) => w.id === a)?.dependsOn).toEqual([]);
  });

  it('reports no schedule error for a project that schedules', async () => {
    await add('Strip');

    expect((await service.tree(projectId))?.scheduleError).toBeNull();
  });

  it('schedules a dependent work item after the one it waits for', async () => {
    const a = await add('Strip');
    const b = await add('Sand');
    await service.setEstimate(a, OWNER, stepId, { optimistic: 2, realistic: 2, pessimistic: 2 });
    await service.setEstimate(b, OWNER, stepId, { optimistic: 3, realistic: 3, pessimistic: 3 });
    await service.addDependency(b, OWNER, a);

    const tree = await service.tree(projectId);
    const sand = tree?.workItems.find((w) => w.id === b)?.schedule;

    expect(sand).toMatchObject({ earliestStart: 2, earliestFinish: 5, critical: true });
  });
});

describe('the plan waits for the people in it', () => {
  /** A whole-day estimate, so the numbers in these tests are the numbers. */
  const flat = (days: number) => ({ optimistic: days, realistic: days, pessimistic: days });

  /** A second project, holding `Dev` and `QA` in that order. */
  async function twoStepProject() {
    const project: Project = projectRow({
      id: crypto.randomUUID(),
      name: 'Two steps',
      ownerId: OWNER,
    });
    const dev = crypto.randomUUID();
    const qa = crypto.randomUUID();
    await projects.create(
      project,
      [
        { id: dev, projectId: project.id, name: 'Dev', position: 10 },
        { id: qa, projectId: project.id, name: 'QA', position: 20 },
      ],
      WROTE,
    );
    return { projectId: project.id, dev, qa };
  }

  it('runs two work items one person is doing one after the other', async () => {
    const first = await add('Strip');
    const second = await add('Sand');
    await service.setEstimate(first, OWNER, stepId, flat(3));
    await service.setEstimate(second, OWNER, stepId, flat(2));
    await directory.assign(first, stepId, 'ada', WROTE);
    await directory.assign(second, stepId, 'ada', WROTE);

    const tree = await service.tree(projectId);

    expect(tree?.workItems.find((w) => w.id === first)?.schedule).toMatchObject({
      earliestStart: 0,
      earliestFinish: 3,
    });
    expect(tree?.workItems.find((w) => w.id === second)?.schedule).toMatchObject({
      earliestStart: 3,
      earliestFinish: 5,
    });
    expect(tree?.waitingForPerson).toBe(1);
  });

  it('starts the work somebody said matters most, end to end', async () => {
    // The whole path: a PATCH writes the priority, `tree` reads the rows, the
    // engine priorities its queue by them and the dates come back the other way
    // round. Without the priority `first` reads first and takes `ada`.
    const first = await add('Strip');
    const second = await add('Sand');
    await service.setEstimate(first, OWNER, stepId, flat(3));
    await service.setEstimate(second, OWNER, stepId, flat(2));
    await directory.assign(first, stepId, 'ada', WROTE);
    await directory.assign(second, stepId, 'ada', WROTE);

    const before = await service.tree(projectId);
    expect(before?.workItems.find((w) => w.id === first)?.schedule.earliestStart).toBe(0);

    await service.patch(second, OWNER, { priority: 1 });
    const after = await service.tree(projectId);

    expect(after?.workItems.find((w) => w.id === second)?.schedule).toMatchObject({
      earliestStart: 0,
      earliestFinish: 2,
    });
    expect(after?.workItems.find((w) => w.id === first)?.schedule).toMatchObject({
      earliestStart: 2,
      earliestFinish: 5,
    });
    // The priority is on the row that comes back, so the table has something to
    // render without a second read.
    expect(after?.workItems.find((w) => w.id === second)?.priority).toBe(1);
  });

  it('reaches every leaf beneath a parent somebody gave a priority', async () => {
    // The mirror of the parent floor: a priority written on a step means its work
    // is what matters, and the leaves beneath it are the only things a queue
    // can be made of.
    //
    // `Wire` is created **unprioritised** on purpose. Since
    // `priority-default-medium` a create carries the project's middle rung, and
    // `priorityByLeaf` resolves by the most specific statement — so a leaf with
    // one of its own is a leaf a step's priority no longer reaches, which is
    // the rule working rather than failing. The state under test here is a leaf
    // nobody has ranked, and only an explicit null still puts a row in it.
    const step = await add('Step');
    const inside = await unranked('Wire', step);
    const other = await add('Sand');
    await service.setEstimate(inside, OWNER, stepId, flat(3));
    await service.setEstimate(other, OWNER, stepId, flat(2));
    await directory.assign(inside, stepId, 'ada', WROTE);
    await directory.assign(other, stepId, 'ada', WROTE);

    // `Step` reads first, so `Wire` already takes `ada` — a priority on `other`
    // is what makes the second half of this say anything at all.
    await service.patch(other, OWNER, { priority: 2 });
    const after = await service.tree(projectId);
    expect(after?.workItems.find((w) => w.id === other)?.schedule.earliestStart).toBe(0);

    // And now the step outranks it — 1 against 2 — through its leaf, which is
    // the only thing in the queue.
    await service.patch(step, OWNER, { priority: 1 });
    const ranked = await service.tree(projectId);

    expect(ranked?.workItems.find((w) => w.id === inside)?.schedule).toMatchObject({
      earliestStart: 0,
      earliestFinish: 3,
    });
    expect(ranked?.workItems.find((w) => w.id === other)?.schedule.earliestStart).toBe(3);
  });

  it('leaves them where they were when the two are different people', async () => {
    const first = await add('Strip');
    const second = await add('Sand');
    await service.setEstimate(first, OWNER, stepId, flat(2));
    await service.setEstimate(second, OWNER, stepId, flat(3));
    await directory.assign(first, stepId, 'ada', WROTE);
    await directory.assign(second, stepId, 'grace', WROTE);

    const tree = await service.tree(projectId);

    expect(tree?.workItems.find((w) => w.id === second)?.schedule.earliestStart).toBe(0);
    expect(tree?.waitingForPerson).toBe(0);
  });

  it('queues every step of a work item its one assignee is assumed to be doing', async () => {
    // The assumed assignee, as time: one named person on a two-step work item
    // is doing both of its slices, so nothing else of theirs can run alongside
    // either. Only `Dev` is assigned here — the `QA` queue is the assumption.
    const two = await twoStepProject();
    const covered = (await service.create(two.projectId, OWNER, {
      parentId: null,
      afterId: null,
      name: 'Rewire',
    })) as { ok: true; value: { id: string } };
    const next = (await service.create(two.projectId, OWNER, {
      parentId: null,
      afterId: covered.value.id,
      name: 'Test the rewire',
    })) as { ok: true; value: { id: string } };
    await service.setEstimate(covered.value.id, OWNER, two.dev, flat(2));
    await service.setEstimate(covered.value.id, OWNER, two.qa, flat(1));
    await service.setEstimate(next.value.id, OWNER, two.dev, flat(1));
    await directory.assign(covered.value.id, two.dev, 'ada', WROTE);
    await directory.assign(next.value.id, two.dev, 'ada', WROTE);

    const tree = await service.tree(two.projectId);

    // `ada` works through every slice of both work items: the first's `Dev`,
    // then the second's, then the two `QA`s nobody named her for. The first
    // work item is therefore 0→4 with a gap in the middle of it, rather than
    // 0→3.
    //
    // Re-derived at `assumed-duration-schedules` (2026-08-29): the second work
    // item's `QA` is unestimated, so it is two workdays wide and queues behind
    // `ada`'s other work rather than taking no time at the row's own start.
    // `ada`'s day, in order: `Rewire` Dev 0→2, `Test the rewire` Dev 2→3, that
    // row's assumed QA 3→5, and `Rewire`'s own QA 5→6. Both rows are still
    // pulled apart by the one person on them, which is what this test is about.
    expect(tree?.workItems.find((w) => w.id === next.value.id)?.schedule).toMatchObject({
      earliestStart: 2,
      earliestFinish: 5,
    });
    expect(tree?.workItems.find((w) => w.id === covered.value.id)?.schedule).toMatchObject({
      earliestStart: 0,
      earliestFinish: 6,
    });
    expect(tree?.waitingForPerson).toBe(2);
  });

  it('stops assuming at two, and lets the second person work alongside the first', async () => {
    // The same plan with `QA` named as well: `grace` does the QA, so `ada` is
    // free the moment her own `Dev` is done and the next work item follows it —
    // `Test the rewire`'s `Dev` still starts on day 2, which is the claim.
    //
    // Re-derived at `assumed-duration-schedules` (2026-08-29): that row's own
    // `QA` is unestimated, so it takes two workdays behind its `Dev` and the
    // row ends on day 5 rather than day 3. `ada` is who it waits for, and only
    // because it is `ada`'s next piece of work — `grace` is unaffected.
    const two = await twoStepProject();
    const covered = (await service.create(two.projectId, OWNER, {
      parentId: null,
      afterId: null,
      name: 'Rewire',
    })) as { ok: true; value: { id: string } };
    const next = (await service.create(two.projectId, OWNER, {
      parentId: null,
      afterId: covered.value.id,
      name: 'Test the rewire',
    })) as { ok: true; value: { id: string } };
    await service.setEstimate(covered.value.id, OWNER, two.dev, flat(2));
    await service.setEstimate(covered.value.id, OWNER, two.qa, flat(1));
    await service.setEstimate(next.value.id, OWNER, two.dev, flat(1));
    await directory.assign(covered.value.id, two.dev, 'ada', WROTE);
    await directory.assign(covered.value.id, two.qa, 'grace', WROTE);
    await directory.assign(next.value.id, two.dev, 'ada', WROTE);

    const tree = await service.tree(two.projectId);

    expect(tree?.workItems.find((w) => w.id === next.value.id)?.schedule).toMatchObject({
      earliestStart: 2,
      earliestFinish: 5,
    });
  });

  it('reports nobody waiting on a plan nobody is assigned to', async () => {
    const first = await add('Strip');
    await service.setEstimate(first, OWNER, stepId, flat(2));

    expect((await service.tree(projectId))?.waitingForPerson).toBe(0);
  });

  it('reports nobody waiting on a plan that could not be scheduled at all', async () => {
    // A cycle leaves the rows on screen and takes the dates away. There is no
    // queue to report, and a number left over from a plan that does not exist
    // would be one more confident lie beside the banner saying so.
    const a = await add('Strip');
    const b = await add('Sand');
    await directory.assign(a, stepId, 'ada', WROTE);
    await directory.assign(b, stepId, 'ada', WROTE);
    await dependencies.add({ id: 'x', projectId, predecessorId: a, successorId: b }, WROTE);
    await dependencies.add({ id: 'y', projectId, predecessorId: b, successorId: a }, WROTE);

    const tree = await service.tree(projectId);

    expect(tree?.scheduleError).toBe('cycle');
    expect(tree?.waitingForPerson).toBe(0);
  });
});

describe('who is doing the work', () => {
  it('reports nobody when nobody is assigned', async () => {
    const id = await add('Strip');

    const row = (await service.tree(projectId))?.workItems.find((w) => w.id === id);

    expect(row?.assignees).toEqual({});
    expect(row?.doesEveryStep).toBeNull();
  });

  it('assumes one assignee does every step, and stops assuming at two', async () => {
    // Dany, 2026-08-06: "when just one is assigned it is assumed they do both
    // dev and QA". Read from the assignments rather than written as a second
    // row, so nobody is recorded against work they were never given.
    const id = await add('Strip');
    const qaStepId = crypto.randomUUID();
    await directory.assign(id, stepId, 'ada', WROTE);
    let row = (await service.tree(projectId))?.workItems.find((w) => w.id === id);
    expect(row?.doesEveryStep).toBe('ada');

    await directory.assign(id, qaStepId, 'grace', WROTE);

    row = (await service.tree(projectId))?.workItems.find((w) => w.id === id);
    expect(row?.assignees).toEqual({ [stepId]: 'ada', [qaStepId]: 'grace' });
    expect(row?.doesEveryStep).toBeNull();
  });

  it('assigns somebody who is not in the work item’s team', async () => {
    // Dany's call: keep people and service/team decoupled for the work item. A
    // platform engineer picking up billing work is an ordinary Tuesday.
    const id = await add('Strip');
    await service.patch(id, OWNER, { serviceTeamId: 'team-billing' });

    const outcome = await service.assign(id, OWNER, stepId, 'ada-of-platform');

    expect(outcome.ok).toBe(true);
    const row = (await service.tree(projectId))?.workItems.find((w) => w.id === id);
    expect(row?.assignees[stepId]).toBe('ada-of-platform');
    expect(row?.serviceTeamId).toBe('team-billing');
  });

  it('refuses an assignment naming a person the directory has lost', async () => {
    // A picker rendered before somebody was removed. Out of date, not broken:
    // a typed 4xx rather than the foreign key the write used to reach.
    const id = await add('Strip');
    await directory.removePerson('ada', true, WROTE);

    const outcome = await service.assign(id, OWNER, stepId, 'ada');

    expect(outcome).toEqual({ ok: false, reason: 'unknown_person' });
    expect(await directory.assignmentsOf([id])).toEqual([]);
  });

  it('refuses a label naming a team the directory has lost, leaving the old one', async () => {
    const id = await add('Strip');
    await service.patch(id, OWNER, { serviceTeamId: 'team-sparks' });
    await directory.removeTeam('team-billing', true, WROTE);

    const outcome = await service.patch(id, OWNER, { serviceTeamId: 'team-billing' });

    expect(outcome).toEqual({ ok: false, reason: 'unknown_team' });
    // The label it already had, not a null and not the dead id: a refused
    // write leaves the row exactly where it was.
    const row = (await service.tree(projectId))?.workItems.find((w) => w.id === id);
    expect(row?.serviceTeamId).toBe('team-sparks');
  });

  it('clears an assignment', async () => {
    const id = await add('Strip');
    await service.assign(id, OWNER, stepId, 'ada');

    await service.assign(id, OWNER, stepId, null);

    expect((await service.tree(projectId))?.workItems.find((w) => w.id === id)?.assignees).toEqual(
      {},
    );
  });
});

describe('duplicating a subtree', () => {
  /** Duplicates, or fails the test with the refusal rather than an undefined id. */
  async function duplicate(id: string, actorId = OWNER): Promise<string> {
    const outcome = await service.duplicate(id, actorId);
    if (!outcome.ok) throw new Error(`duplicate failed: ${outcome.reason}`);
    return outcome.value.id;
  }

  /** The project's rows, by id, as a reader sees them. */
  async function readTree() {
    const tree = await service.tree(projectId);
    if (tree === null) throw new Error('project vanished');
    return tree.workItems;
  }

  it('lands the copy next to the original, with the numbers derived afresh', async () => {
    const strip = await add('Strip');
    const sockets = await add('Sockets', strip);
    await add('Switches', strip, sockets);
    // A later sibling, so "next sibling" is distinguishable from "appended".
    await add('Test', null, strip);

    await duplicate(strip);

    expect(await numbered()).toEqual({
      '010': 'Strip',
      '010.1': 'Sockets',
      '010.2': 'Switches',
      '020': 'Strip (copy)',
      '020.1': 'Sockets',
      '020.2': 'Switches',
      '030': 'Test',
    });
  });

  it('copies notes, estimates, assignees, the team label and the date', async () => {
    const strip = await add('Strip');
    const socket = await add('Sockets', strip);
    await service.patch(socket, OWNER, {
      notes: 'Two gang, chased in',
      serviceTeamId: 'team-sparks',
      startNoEarlierThan: '2026-09-01',
      startNoEarlierThanReason: 'waiting on client sign-off',
    });
    await service.setEstimate(socket, OWNER, stepId, {
      optimistic: 1,
      realistic: 2,
      pessimistic: 6,
    });
    await service.assign(socket, OWNER, stepId, 'ada');

    const copyId = await duplicate(strip);

    const copied = (await readTree()).find((w) => w.parentId === copyId);
    expect(copied?.name).toBe('Sockets');
    expect(copied?.notes).toBe('Two gang, chased in');
    expect(copied?.serviceTeamId).toBe('team-sparks');
    expect(copied?.startNoEarlierThan).toBe('2026-09-01');
    // The pair travels together, which is what stops a duplicate from being the
    // one way to make the row the pair rule refuses. The date is a constraint on
    // work the copy also has, so the words about it are still true of the copy —
    // unlike a recorded actual or a stated progress, which are claims about work
    // that was done on the original alone.
    expect(copied?.startNoEarlierThanReason).toBe('waiting on client sign-off');
    expect(copied?.estimates[stepId]).toEqual({ optimistic: 1, realistic: 2, pessimistic: 6 });
    expect(copied?.assignees[stepId]).toBe('ada');
  });

  /**
   * The one that decides whether this feature is worth having. A copied step
   * whose edges still point at the original schedules the copy against work it
   * has nothing to do with, and nothing on screen says so.
   *
   * Proof: with the remap dropped — the copied edges keeping their originals'
   * ids — this failed on `dependsOn`, the copy waiting for the original's
   * predecessor. Watched 2026-08-07.
   */
  it('remaps a dependency inside the subtree onto the copies', async () => {
    const strip = await add('Strip');
    const boxes = await add('Back boxes', strip);
    const sockets = await add('Sockets', strip);
    await service.addDependency(sockets, OWNER, boxes);

    const copyId = await duplicate(strip);

    const under = (await readTree()).filter((w) => w.parentId === copyId);
    const copiedBoxes = under.find((w) => w.name === 'Back boxes');
    const copiedSockets = under.find((w) => w.name === 'Sockets');
    if (copiedBoxes === undefined) throw new Error('the duplicate has no Back boxes');
    expect(copiedSockets?.dependsOn).toEqual([copiedBoxes.id]);
    expect(copiedSockets?.dependsOn).not.toContain(boxes);
  });

  it('leaves behind a dependency with one end outside the subtree', async () => {
    const strip = await add('Strip');
    const sockets = await add('Sockets', strip);
    const survey = await add('Survey');
    await service.addDependency(sockets, OWNER, survey);

    const copyId = await duplicate(strip);

    const rows = await readTree();
    // A template starts unwired: the copy inherits nothing it did not contain.
    expect(rows.find((w) => w.parentId === copyId)?.dependsOn).toEqual([]);
    expect(rows.find((w) => w.id === sockets)?.dependsOn).toEqual([survey]);
  });

  /**
   * Proof: with `frozenNumber` carried over from the source row, this failed —
   * two rows claiming `010`, which is the exact thing freezing exists to stop.
   * Watched 2026-08-07.
   */
  it('gives no copy a frozen number, and leaves every original with its own', async () => {
    const strip = await add('Strip');
    const sockets = await add('Sockets', strip);
    await service.freeze(projectId, OWNER);

    const copyId = await duplicate(strip);

    const rows = await readTree();
    const copies = rows.filter((w) => w.id === copyId || w.parentId === copyId);
    expect(copies).toHaveLength(2);
    expect(copies.every((w) => w.frozenNumber === null)).toBe(true);
    expect(rows.find((w) => w.id === strip)?.frozenNumber).toBe('010');
    expect(rows.find((w) => w.id === sockets)?.frozenNumber).toBe('010.1');
  });

  it('copies a leaf on its own', async () => {
    const strip = await add('Strip');

    const copyId = await duplicate(strip);

    expect(copyId).not.toBe(strip);
    expect(await numbered()).toEqual({ '010': 'Strip', '020': 'Strip (copy)' });
  });

  it('tells the project once, with the whole tree', async () => {
    const strip = await add('Strip');
    await add('Sockets', strip);
    const before = broadcast.published.length;

    await duplicate(strip);

    const since = broadcast.published.slice(before);
    expect(since).toHaveLength(1);
    expect(since[0]?.event.type).toBe('tree_replaced');
  });

  it('refuses a subtree of more than 500 work items, changing nothing', async () => {
    const root = await add('Strip');
    await fill(root, 500);

    const outcome = await service.duplicate(root, OWNER);

    expect(outcome).toEqual({ ok: false, reason: 'too_large' });
    expect(await readTree()).toHaveLength(501);
  });

  // The boundary itself, so the guard cannot quietly become `>=`: 500 rows is
  // the largest copy there is, not the first one refused.
  it('copies a subtree of exactly 500 work items', async () => {
    const root = await add('Strip');
    await fill(root, 499);

    await duplicate(root);

    expect(await readTree()).toHaveLength(1000);
  });
});

describe('the calendar', () => {
  // 2026-08-06 is a Thursday, so a two-day task spans Thursday and Friday and
  // a three-day one runs into the Monday.
  const THURSDAY = '2026-08-06';

  const twoDaysOf = async (id: string) => {
    await service.setEstimate(id, OWNER, stepId, { optimistic: 2, realistic: 2, pessimistic: 2 });
  };

  it('reports no dates while the project has no start date', async () => {
    const id = await add('Strip');
    await twoDaysOf(id);

    const row = (await service.tree(projectId))?.workItems.find((w) => w.id === id);

    // The ordinary state of an estimate nobody has committed to a date.
    expect(row?.dates).toBeNull();
    expect((await service.tree(projectId))?.startDate).toBeNull();
  });

  it('places the plan on working days, skipping the weekend', async () => {
    const first = await add('Strip');
    const second = await add('Sand');
    await twoDaysOf(first);
    await twoDaysOf(second);
    await service.addDependency(second, OWNER, first);
    await projects.update(projectId, { startDate: THURSDAY }, WROTE);

    const tree = await service.tree(projectId);
    const strip = tree?.workItems.find((w) => w.id === first);
    const sand = tree?.workItems.find((w) => w.id === second);

    // Thursday and Friday, then the next two working days — Monday and
    // Tuesday. Saturday and Sunday are not days anyone works.
    expect(strip?.dates).toEqual({ startsOn: '2026-08-06', endsOn: '2026-08-07' });
    expect(sand?.dates).toEqual({ startsOn: '2026-08-10', endsOn: '2026-08-11' });
  });

  it('pushes an item later when it may not start before a date', async () => {
    const id = await add('Strip');
    await twoDaysOf(id);
    await projects.update(projectId, { startDate: THURSDAY }, WROTE);
    await service.patch(id, OWNER, { startNoEarlierThan: '2026-08-12' });

    const row = (await service.tree(projectId))?.workItems.find((w) => w.id === id);

    expect(row?.dates?.startsOn).toBe('2026-08-12');
  });

  it('lets a dependency push past the constraint, never the other way', async () => {
    // The constraint is a floor, not a pin — Dany's call, so the calendar and
    // the dependency tree cannot contradict each other. A predecessor that
    // finishes later still wins.
    const first = await add('Strip');
    const second = await add('Sand');
    await service.setEstimate(first, OWNER, stepId, {
      optimistic: 6,
      realistic: 6,
      pessimistic: 6,
    });
    await twoDaysOf(second);
    await service.addDependency(second, OWNER, first);
    await projects.update(projectId, { startDate: THURSDAY }, WROTE);
    // Day 1 is the Friday: earlier than where the predecessor leaves it.
    await service.patch(second, OWNER, { startNoEarlierThan: '2026-08-07' });

    const sand = (await service.tree(projectId))?.workItems.find((w) => w.id === second);

    // Six working days from Thursday lands on the Friday after next.
    expect(sand?.dates?.startsOn).toBe('2026-08-14');
  });

  it('reports no dates when the schedule itself failed', async () => {
    const first = await add('Strip');
    const second = await add('Sand');
    await projects.update(projectId, { startDate: THURSDAY }, WROTE);
    await dependencies.add(
      {
        id: 'a',
        projectId,
        predecessorId: first,
        successorId: second,
      },
      WROTE,
    );
    await dependencies.add(
      {
        id: 'b',
        projectId,
        predecessorId: second,
        successorId: first,
      },
      WROTE,
    );

    const tree = await service.tree(projectId);

    // A date read off a schedule that could not be computed is the same
    // confident lie as a page of zeroes.
    expect(tree?.scheduleError).toBe('cycle');
    expect(tree?.workItems.every((w) => w.dates === null)).toBe(true);
  });
});

describe('the calendar — weekend edges and fractions of a day', () => {
  const THURSDAY = '2026-08-06';
  const SATURDAY = '2026-08-08';

  // Half a day only reaches the calendar under `exact`. Every other rounding
  // charges a step whole days, so the boundary arithmetic these tests are about
  // — a finish at midday, a chain that drifts a bit below a whole day, the snap
  // that must not eat 14.9 — is unreachable on a project that rounds. The
  // guards are `snapWorkdays`' and they are still live; this is the arm that
  // reaches them (`estimate-weights-and-rounding`).
  beforeEach(async () => {
    await projects.update(projectId, { estimateRounding: 'exact' }, WROTE);
  });

  /** A flat trio, so the duration in these tests is the number written. */
  const flatDaysOf = async (id: string, days: number) => {
    await service.setEstimate(id, OWNER, stepId, {
      optimistic: days,
      realistic: days,
      pessimistic: days,
    });
  };

  const datesFor = async (id: string) =>
    (await service.tree(projectId))?.workItems.find((w) => w.id === id)?.dates;

  it('starts a plan whose start date is a Saturday on the Monday', async () => {
    const id = await add('Pour');
    await flatDaysOf(id, 1);
    await projects.update(projectId, { startDate: SATURDAY }, WROTE);

    expect(await datesFor(id)).toEqual({ startsOn: '2026-08-10', endsOn: '2026-08-10' });
  });

  it('carries a span across two weekends without counting them', async () => {
    const id = await add('Rewire');
    await flatDaysOf(id, 12);
    await projects.update(projectId, { startDate: THURSDAY }, WROTE);

    // Twelve working days from the Thursday: two of week one, five each of the
    // next two weeks — landing on that third Friday, fifteen calendar days on.
    expect(await datesFor(id)).toEqual({ startsOn: '2026-08-06', endsOn: '2026-08-21' });
  });

  it('keeps a half-day task inside its single day', async () => {
    const id = await add('Chase');
    await flatDaysOf(id, 0.5);
    await projects.update(projectId, { startDate: THURSDAY }, WROTE);

    expect(await datesFor(id)).toEqual({ startsOn: '2026-08-06', endsOn: '2026-08-06' });
  });

  it('hands a fractional finish and its successor the same calendar day', async () => {
    // 2.5 days each. The first is still on the Monday when it finishes at
    // midday, and the second starts on that same Monday — a day two rows
    // share, which whole days never do.
    const first = await add('Strip');
    const second = await add('Sand');
    await flatDaysOf(first, 2.5);
    await flatDaysOf(second, 2.5);
    await service.addDependency(second, OWNER, first);
    await projects.update(projectId, { startDate: THURSDAY }, WROTE);

    expect(await datesFor(first)).toEqual({ startsOn: '2026-08-06', endsOn: '2026-08-10' });
    // The pair finish at exactly 5.0, so the fraction never reaches the dates.
    expect(await datesFor(second)).toEqual({ startsOn: '2026-08-10', endsOn: '2026-08-12' });
  });

  it('keeps a zero-length row on its own start day, whole or fractional', async () => {
    // Two sign-offs with nothing to do, each waiting on work that finishes
    // where it stands: one at a whole workday, one at 3.4. `datesOf` reads
    // each row's two ends through two different helpers, and this is where
    // they have to meet — a zero-length span's last day is its first.
    //
    // Proof, twice, both watched 2026-08-11:
    //
    // - the clamp dropped at this call site (`lastWorkdayOf(0,
    //   timing.earliestFinish)`): the whole-day gate's `endsOn` came back
    //   `"2026-08-10"` where `"2026-08-11"` was owed — a row ending the day
    //   before it starts. **Nothing else in the file saw it**: with the clamp
    //   gone the other 71 cases passed, which is why this test exists.
    // - the clamp reading the start a day up (`lastWorkdayOf(Math.ceil(
    //   timing.earliestStart), …)`): the fractional gate failed on `expected
    //   "2026-08-12" to be "2026-08-11"`, the whole-day pair untouched — the
    //   half of this test the whole days cannot stand in for.
    const wholeRunner = await add('Prime');
    const wholeGate = await add('Sign off');
    const partRunner = await add('Sand');
    const partGate = await add('Approve');
    await flatDaysOf(wholeRunner, 3);
    await flatDaysOf(wholeGate, 0);
    await flatDaysOf(partRunner, 3.4);
    await flatDaysOf(partGate, 0);
    await service.addDependency(wholeGate, OWNER, wholeRunner);
    await service.addDependency(partGate, OWNER, partRunner);
    await projects.update(projectId, { startDate: THURSDAY }, WROTE);

    // Three whole days from the Thursday end on the Monday; the gate stands on
    // the Tuesday after them, both ends.
    expect(await datesFor(wholeRunner)).toEqual({ startsOn: '2026-08-06', endsOn: '2026-08-10' });
    expect(await datesFor(wholeGate)).toEqual({ startsOn: '2026-08-11', endsOn: '2026-08-11' });
    // 3.4 days end inside the Tuesday, and the gate shares that same Tuesday.
    expect(await datesFor(partRunner)).toEqual({ startsOn: '2026-08-06', endsOn: '2026-08-11' });
    expect(await datesFor(partGate)).toEqual({ startsOn: '2026-08-11', endsOn: '2026-08-11' });
  });

  it('moves the dates and the printed figure together when the method changes', async () => {
    const id = await add('Strip');
    await service.setEstimate(id, OWNER, stepId, { optimistic: 2, realistic: 3, pessimistic: 10 });
    await projects.update(projectId, { startDate: THURSDAY }, WROTE);

    await projects.update(projectId, { estimateMethod: 'optimistic' }, WROTE);
    const hopeful = (await service.tree(projectId))?.workItems.find((w) => w.id === id);
    expect(hopeful?.finalTotal).toBe(2);
    expect(hopeful?.dates).toEqual({ startsOn: '2026-08-06', endsOn: '2026-08-07' });

    await projects.update(projectId, { estimateMethod: 'pessimistic' }, WROTE);
    const braced = (await service.tree(projectId))?.workItems.find((w) => w.id === id);
    expect(braced?.finalTotal).toBe(10);
    expect(braced?.dates).toEqual({ startsOn: '2026-08-06', endsOn: '2026-08-19' });
  });

  // A `startNoEarlierThan` set on a parent reaches every leaf beneath it,
  // exactly as a dependency declared on a parent does: the engine expands the
  // floors down the tree (`schedule.ts`, `leafFloors`). Until 2026-08-10 it
  // read the map for leaves alone, so a parent's floor was accepted, stored,
  // echoed back — and constrained nothing: this test was watched failing on
  // the leaf starting `2026-08-06` where the parent's floor says `2026-08-12`.
  // The composition cases — a grandparent's floor, a child's stricter own
  // floor surviving, a later dependency still named — are engine-level, in
  // `schedule-shapes.test.ts` ('a manual floor beside a dependency').
  it('floors every leaf beneath a parent told not to start before a day', async () => {
    const parent = await add('Step');
    const kid = await add('Wire', parent);
    await flatDaysOf(kid, 2);
    await projects.update(projectId, { startDate: THURSDAY }, WROTE);
    await service.patch(parent, OWNER, { startNoEarlierThan: '2026-08-12' });

    expect((await datesFor(kid))?.startsOn).toBe('2026-08-12');
  });

  // The chain below is exactly 15 working days of PERT estimates —
  // 45/6 + 25/6 + 20/6 — so it ends on the fifteenth working day, the third
  // Friday, 2026-08-28. The finishes accumulate as doubles across work items
  // and the sum arrives as 15.000000000000002; until 2026-08-10 `datesOf` read
  // that through a bare `Math.ceil` into a sixteenth day — a Monday, three
  // calendar days late — and this test was watched failing on `2026-08-31`.
  // `snapWorkdays` at the calendar boundary is what absorbs the bit; the
  // engine's span anchoring stops the same fault *within* one work item (see
  // `schedule.ts`), and `schedule-shapes.test.ts` ('accumulates PERT sixths…')
  // bounds the drift the snap window has to cover.
  it('ends a chain of PERT estimates on the day the estimates add up to', async () => {
    const trios: [number, number, number][] = [
      [0, 8, 13],
      [3, 4, 6],
      [0, 3, 8],
    ];
    let previous: string | null = null;
    let last = '';
    for (const [at, [optimistic, realistic, pessimistic]] of trios.entries()) {
      const id = await add(`Link ${String(at)}`);
      await service.setEstimate(id, OWNER, stepId, { optimistic, realistic, pessimistic });
      if (previous !== null) await service.addDependency(id, OWNER, previous);
      previous = id;
      last = id;
    }
    await projects.update(projectId, { startDate: '2026-08-10' }, WROTE);

    expect((await datesFor(last))?.endsOn).toBe('2026-08-28');
  });

  it('holds the calendar steady when a chained finish drifts above the whole day', async () => {
    // The same 15-working-day chain, with a one-day successor. The chain's
    // last row finishes at 15.000000000000002, and a bare ceil read that
    // drifted bit as a sixteenth day — `endsOn` three calendar days late over
    // the weekend. The successor's own `startsOn` goes through `addWorkdays`'
    // floor, which upward drift cannot fool (floor of 15+ε is 15); it is
    // asserted so the boundary cannot regress. Its `endsOn` is clean by
    // arithmetic — 15.000000000000002 + 1 rounds to exactly 16 in doubles —
    // which is why the drifted `endsOn` is asserted on the chain end, where
    // the drift actually survives.
    const trios: [number, number, number][] = [
      [0, 8, 13],
      [3, 4, 6],
      [0, 3, 8],
    ];
    let previous: string | null = null;
    let last = '';
    for (const [at, [optimistic, realistic, pessimistic]] of trios.entries()) {
      const id = await add(`Link ${String(at)}`);
      await service.setEstimate(id, OWNER, stepId, { optimistic, realistic, pessimistic });
      if (previous !== null) await service.addDependency(id, OWNER, previous);
      previous = id;
      last = id;
    }
    const after = await add('Snag');
    await flatDaysOf(after, 1);
    await service.addDependency(after, OWNER, last);
    await projects.update(projectId, { startDate: '2026-08-10' }, WROTE);

    // The chain end starts within working day 11 and finishes on day 15 —
    // Tuesday the 25th to Friday the 28th, not Monday the 31st.
    expect(await datesFor(last)).toEqual({ startsOn: '2026-08-25', endsOn: '2026-08-28' });
    // Working day 15 from Monday 2026-08-10 is Monday 2026-08-31 — one day.
    expect(await datesFor(after)).toEqual({ startsOn: '2026-08-31', endsOn: '2026-08-31' });
  });

  it('holds the calendar steady when a chained finish drifts below the whole day', async () => {
    // 1/6 + 49/6 + 4/6 is exactly 9 working days; the doubles accumulate to
    // 8.999999999999998. A bare floor in `addWorkdays` read that as day 8 and
    // started the successor a whole day early, on top of its predecessor. The
    // `endsOn` fields cannot be bitten by this sign — `ceil - 1` lands on day
    // 8 whether the finish reads 8.999999999999998 or exactly 9 — and are
    // asserted to pin that down.
    const trios: [number, number, number][] = [
      [0, 0, 1],
      [0, 9, 13],
      [0, 0, 4],
    ];
    let previous: string | null = null;
    let last = '';
    for (const [at, [optimistic, realistic, pessimistic]] of trios.entries()) {
      const id = await add(`Step ${String(at)}`);
      await service.setEstimate(id, OWNER, stepId, { optimistic, realistic, pessimistic });
      if (previous !== null) await service.addDependency(id, OWNER, previous);
      previous = id;
      last = id;
    }
    const after = await add('Snag');
    await flatDaysOf(after, 1);
    await service.addDependency(after, OWNER, last);
    await projects.update(projectId, { startDate: '2026-08-10' }, WROTE);

    // The chain end runs inside working day 8 — Thursday the 20th, both ends.
    expect(await datesFor(last)).toEqual({ startsOn: '2026-08-20', endsOn: '2026-08-20' });
    // Working day 9 from Monday 2026-08-10 is Friday 2026-08-21 — the tenth
    // working day, not a second bite of Thursday the 20th.
    expect(await datesFor(after)).toEqual({ startsOn: '2026-08-21', endsOn: '2026-08-21' });
  });

  it('keeps a genuine fraction just shy of a boundary as real work', async () => {
    // 14.9 is a tenth of a day short of 15 — an estimate, nine orders of
    // magnitude outside the snap window. The row still finishes within its
    // fifteenth day and its successor starts on that same shared day, which is
    // exactly what a snap window wide enough to swallow real work would break.
    const first = await add('Grind');
    const second = await add('Snag');
    await flatDaysOf(first, 14.9);
    await flatDaysOf(second, 1);
    await service.addDependency(second, OWNER, first);
    await projects.update(projectId, { startDate: '2026-08-10' }, WROTE);

    expect(await datesFor(first)).toEqual({ startsOn: '2026-08-10', endsOn: '2026-08-28' });
    expect(await datesFor(second)).toEqual({ startsOn: '2026-08-28', endsOn: '2026-08-31' });
  });
});

describe('the project’s dependency reach', () => {
  const flat = (days: number) => ({ optimistic: days, realistic: days, pessimistic: days });

  /**
   * A project of its own on `reach`, holding `Dev` then `QA`, with `A` (Dev 3,
   * QA 2) and `B` (Dev 1) and `B` depending on `A`.
   *
   * Its own project rather than the fixture's, because the fixture has one role
   * and a reach decides nothing on a plan with one step.
   */
  async function chainOn(reach: 'whole-item' | 'anchor-slice') {
    const id = crypto.randomUUID();
    const dev = crypto.randomUUID();
    const qa = crypto.randomUUID();
    await projects.create(
      projectRow({
        id,
        name: `Chain on ${reach}`,
        ownerId: OWNER,
        depReach: reach,
      }),
      [
        { id: dev, projectId: id, name: 'Dev', position: 10 },
        { id: qa, projectId: id, name: 'QA', position: 20 },
      ],
      WROTE,
    );
    const made = async (name: string) => {
      const outcome = await service.create(id, OWNER, { parentId: null, afterId: null, name });
      if (!outcome.ok) throw new Error(`create failed: ${outcome.reason}`);
      return outcome.value.id;
    };
    const a = await made('A');
    const b = await made('B');
    await service.setEstimate(a, OWNER, dev, flat(3));
    await service.setEstimate(a, OWNER, qa, flat(2));
    await service.setEstimate(b, OWNER, dev, flat(1));
    await dependencies.add(
      { id: crypto.randomUUID(), projectId: id, predecessorId: a, successorId: b },
      WROTE,
    );
    return { id, a, b };
  }

  /** One work item's earliest start out of the payload, or a throw. */
  async function startOf(projectId: string, workItemId: string): Promise<number> {
    const tree = await service.tree(projectId);
    const row = tree?.workItems.find((each) => each.id === workItemId);
    if (row === undefined) throw new Error(`${workItemId} is not in the payload`);
    return row.schedule.earliestStart;
  }

  it('each project is scheduled by its own reach', async () => {
    // The reach is read from the project being scheduled, so two projects in
    // one process must not share one answer. Both orders, so a hoisted read is
    // visible whichever plan happened to be read first.
    //
    // Proof: `project.depReach` in `work-item.service.ts` replaced by a
    // module-level `heldReach ??= project.depReach` and this failed on
    // `expect(received).toBe(expected) / Expected: 5 / Received: 3` for the
    // whole-item plan's `B`; watched 2026-08-29.
    const anchored = await chainOn('anchor-slice');
    const whole = await chainOn('whole-item');

    // `A`'s Dev finishes on day 3 and its QA on day 5.
    expect(await startOf(anchored.id, anchored.b)).toBe(3);
    expect(await startOf(whole.id, whole.b)).toBe(5);
    // Read again in the other order: the second read of each must answer what
    // the first did.
    expect(await startOf(whole.id, whole.b)).toBe(5);
    expect(await startOf(anchored.id, anchored.b)).toBe(3);
  });

  it('reports the project’s reach on the wire beside the dates it produced', async () => {
    // The chart draws a dependency arrow out of the slice the reach names, so
    // the value that decided the dates has to travel with them.
    const anchored = await chainOn('anchor-slice');

    expect((await service.tree(anchored.id))?.depReach).toBe('anchor-slice');
  });
});

describe('the project’s estimate method', () => {
  /** A leaf with one three-point estimate, and the tree read back. */
  async function estimated(method: 'pert' | 'optimistic' | 'realistic' | 'pessimistic') {
    const id = await add('Strip');
    await service.setEstimate(id, OWNER, stepId, {
      optimistic: 2,
      realistic: 3,
      pessimistic: 10,
    });
    await projects.update(projectId, { estimateMethod: method }, WROTE);
    const tree = await service.tree(projectId);
    const row = tree?.workItems.find((w) => w.id === id);
    return { tree, row };
  }

  it('reports the final figure per step and their sum, under PERT', async () => {
    const { tree, row } = await estimated('pert');

    expect(row?.finalDays[stepId]).toBe(4);
    expect(row?.finalTotal).toBe(4);
    expect(tree?.estimateMethod).toBe('pert');
  });

  it('reports the chosen point instead when the project chose one', async () => {
    expect((await estimated('pessimistic')).row?.finalTotal).toBe(10);
    expect((await estimated('optimistic')).row?.finalTotal).toBe(2);
    expect((await estimated('realistic')).row?.finalTotal).toBe(3);
  });

  it('plans the dates with the same figure it prints', async () => {
    // The schedule's durations and the number in the column beside them come
    // from one call to `finalDays`. Two implementations is how a table comes to
    // disagree with the dates printed next to it.
    const { row } = await estimated('pessimistic');

    expect(row?.schedule.earliestFinish).toBe(10);
    expect(row?.schedule.duration).toBe(10);
  });

  it('leaves a step nobody estimated absent rather than zero', async () => {
    const id = await add('Strip');

    const row = (await service.tree(projectId))?.workItems.find((w) => w.id === id);

    expect(row?.finalDays).toEqual({});
    expect(row?.finalTotal).toBe(0);
  });
});

describe('the project’s estimate arithmetic — weights, and the rounding per step', () => {
  /**
   * A project of its own with two steps, because the order the rounding and the
   * sum happen in is only visible across **two** steps and the fixture's project
   * has one.
   */
  async function twoStepProject(over: {
    pertWeights?: { optimistic: number; realistic: number; pessimistic: number };
    estimateRounding?: 'exact' | 'floor' | 'round' | 'ceil';
  }): Promise<{ id: string; devId: string; qaId: string }> {
    const id = crypto.randomUUID();
    const devId = crypto.randomUUID();
    const qaId = crypto.randomUUID();
    await projects.create(
      {
        id,
        name: 'Refit',
        ownerId: OWNER,
        restricted: false,
        estimateMethod: 'pert',
        pertWeights: over.pertWeights ?? { optimistic: 1, realistic: 4, pessimistic: 1 },
        estimateRounding: over.estimateRounding ?? 'ceil',
        depReach: 'whole-item',
        startDate: null,
        solutionRef: null,
        revision: 0,
        createdAt: 1,
      },
      [
        { id: devId, projectId: id, name: 'Dev', position: 10 },
        { id: qaId, projectId: id, name: 'QA', position: 20 },
      ],
      WROTE,
    );
    return { id, devId, qaId };
  }

  const half = { optimistic: 0.5, realistic: 0.5, pessimistic: 0.5 };

  /** One row of a project's tree, or a throw — a missing row is a broken fixture. */
  async function rowOf(projectOfIt: string, workItemId: string) {
    const found = (await service.tree(projectOfIt))?.workItems.find((w) => w.id === workItemId);
    if (found === undefined) throw new Error(`no row for ${workItemId}`);
    return found;
  }

  /**
   * The order Dany asked for, and the one thing this change is: each step is
   * charged on its own, and the steps are summed afterwards. Two half-day steps
   * are two days under `ceil`; summing them first and rounding once is one.
   *
   * Proof: with the other order in place — `rollUpFinals` charging
   * `combinedDays` and `finalsOf` rounding the **sum** with a `Math.ceil` — this
   * failed on `Expected: 1 / Received: 0.5` at the Dev step, which is the
   * fraction a plan that rounds its total still carries per step. Watched
   * 2026-08-30.
   *
   * Note what this test does **not** prove, because it cannot: a leaf's steps
   * were already charged one at a time before this change (`finalsOf` summed
   * `finalDays` per step). The order only becomes visible across **children**,
   * and that half is `rollUpFinals`' own proof and the parent test below.
   */
  it('rounds each step before summing them', async () => {
    const { id, devId, qaId } = await twoStepProject({ estimateRounding: 'ceil' });
    const outcome = await service.create(id, OWNER, {
      parentId: null,
      afterId: null,
      name: 'Sand',
    });
    if (!outcome.ok) throw new Error(`create failed: ${outcome.reason}`);
    await service.setEstimate(outcome.value.id, OWNER, devId, half);
    await service.setEstimate(outcome.value.id, OWNER, qaId, half);

    const row = await rowOf(id, outcome.value.id);

    expect(row.finalDays[devId]).toBe(1);
    expect(row.finalDays[qaId]).toBe(1);
    expect(row.finalTotal).toBe(2);
    // What the two steps said, unrounded and unchanged: the trio is still the
    // estimate somebody typed.
    expect(row.estimates[devId]).toEqual(half);
  });

  it('floors, rounds and keeps the fraction when the project says so', async () => {
    for (const [rounding, owed] of [
      ['floor', 0],
      ['round', 1],
      ['ceil', 1],
      ['exact', 0.5],
    ] as const) {
      const { id, devId } = await twoStepProject({ estimateRounding: rounding });
      const outcome = await service.create(id, OWNER, {
        parentId: null,
        afterId: null,
        name: 'Sand',
      });
      if (!outcome.ok) throw new Error(`create failed: ${outcome.reason}`);
      await service.setEstimate(outcome.value.id, OWNER, devId, half);

      expect((await rowOf(id, outcome.value.id)).finalDays[devId]).toBe(owed);
    }
  });

  it('weighs the three points by the coefficients the project set', async () => {
    // 2/3/10 is 4 days under 1/4/1 and 5 under a plain average — the divisor is
    // the sum of the weights, not a fixed six.
    const { id, devId } = await twoStepProject({
      pertWeights: { optimistic: 1, realistic: 1, pessimistic: 1 },
      estimateRounding: 'exact',
    });
    const outcome = await service.create(id, OWNER, {
      parentId: null,
      afterId: null,
      name: 'Sand',
    });
    if (!outcome.ok) throw new Error(`create failed: ${outcome.reason}`);
    await service.setEstimate(outcome.value.id, OWNER, devId, {
      optimistic: 2,
      realistic: 3,
      pessimistic: 10,
    });

    const row = await rowOf(id, outcome.value.id);

    expect(row.finalDays[devId]).toBe(5);
    const tree = await service.tree(id);
    expect(tree?.pertWeights).toEqual({ optimistic: 1, realistic: 1, pessimistic: 1 });
    expect(tree?.estimateRounding).toBe('exact');
  });

  /**
   * The parent half of the same order, and the half that is genuinely new: a
   * parent used to be its rolled-up triple combined once, which for two
   * half-day children is one day against the two days their own rows show and
   * the two the chart draws.
   *
   * Proof: with `rollUpFinals` taken back to "roll the triples up, charge the
   * parent's once" — the arithmetic that shipped until 2026-08-30 — this failed
   * on `Expected: 2 / Received: 1` at the parent's Dev figure. Watched
   * 2026-08-30.
   */
  it('gives a parent the days its children were charged, and the chart the same', async () => {
    const { id, devId } = await twoStepProject({ estimateRounding: 'ceil' });
    const parent = await service.create(id, OWNER, {
      parentId: null,
      afterId: null,
      name: 'Refit the shed',
    });
    if (!parent.ok) throw new Error(`create failed: ${parent.reason}`);
    const children: string[] = [];
    for (const name of ['Strip', 'Sand']) {
      const child = await service.create(id, OWNER, {
        parentId: parent.value.id,
        afterId: null,
        name,
      });
      if (!child.ok) throw new Error(`create failed: ${child.reason}`);
      await service.setEstimate(child.value.id, OWNER, devId, half);
      children.push(child.value.id);
    }

    const tree = await service.tree(id);
    const parentRow = await rowOf(id, parent.value.id);

    expect(parentRow.rolledUp).toBe(true);
    expect(parentRow.finalDays[devId]).toBe(2);
    expect(parentRow.finalTotal).toBe(2);
    // What the two children said between them — one day — which is no longer
    // the same question as what the plan charges for them.
    expect(parentRow.estimates[devId]).toEqual({
      optimistic: 1,
      realistic: 1,
      pessimistic: 1,
    });
    for (const child of children) {
      const slice = tree?.slices.find((one) => one.workItemId === child);
      expect(slice?.duration).toBe(1);
      expect((await rowOf(id, child)).finalDays[devId]).toBe(1);
    }
  });

  it('plans the dates with the rounded figures it prints', async () => {
    // The whole point of one `finalDays`: two half-day steps charged as a whole
    // day each occupy two whole days of the calendar, and the row's own figures
    // say so. Both steps are estimated, so nothing here is an assumed duration.
    const { id, devId, qaId } = await twoStepProject({ estimateRounding: 'ceil' });
    const outcome = await service.create(id, OWNER, {
      parentId: null,
      afterId: null,
      name: 'Sand',
    });
    if (!outcome.ok) throw new Error(`create failed: ${outcome.reason}`);
    await service.setEstimate(outcome.value.id, OWNER, devId, half);
    await service.setEstimate(outcome.value.id, OWNER, qaId, half);
    await projects.update(id, { startDate: '2026-08-06' }, WROTE);

    const row = await rowOf(id, outcome.value.id);

    expect(row.finalTotal).toBe(2);
    expect(row.schedule.duration).toBe(2);
    expect(row.schedule.earliestFinish).toBe(2);
    // The Thursday and the Friday: one day for Dev, one for QA, where the
    // fractional arithmetic would have put both inside the Thursday.
    expect(row.dates).toEqual({ startsOn: '2026-08-06', endsOn: '2026-08-07' });
  });
});

describe('capacity, as the adapter resolves it', () => {
  /** A whole-day estimate, so the numbers in these tests are the numbers. */
  const flat = (days: number) => ({ optimistic: days, realistic: days, pessimistic: days });

  /** One work item's slice in the payload, or a throw. */
  function slicedFor(
    tree: Awaited<ReturnType<WorkItemService['tree']>>,
    workItemId: string,
  ): NonNullable<typeof tree>['slices'][number] {
    const found = tree?.slices.find((one) => one.workItemId === workItemId);
    if (found === undefined) throw new Error(`no slice for ${workItemId}`);
    return found;
  }

  /** A leaf written straight through the store, so `maxParallel` can be set before C2's write path exists. */
  async function leaf(
    name: string,
    maxParallel: number,
    serviceTeamId: string | null = null,
    parentId: string | null = null,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await workItems.insert(
      workItemRow({
        id,
        projectId,
        parentId,
        position: (position += 10),
        name,
        serviceTeamId,
        maxParallel,
      }),
      [],
      WROTE,
    );
    return id;
  }
  let position = 1000;

  it('compresses a work item across the people its parallelism allows', async () => {
    const strip = await leaf('Strip', 3);
    await service.setEstimate(strip, OWNER, stepId, flat(6));

    const tree = await service.tree(projectId);

    expect(slicedFor(tree, strip)).toMatchObject({
      effort: 6,
      width: 3,
      duration: 2,
      earliestStart: 0,
      earliestFinish: 2,
    });
  });

  it('clamps a work item’s parallelism down to the size of its team', async () => {
    // Nobody may claim more people than the team has. `maxParallel: 4` on a
    // team of 2 runs at 2, and the block waits for both.
    //
    // Proof: the `Math.min` against `slots` dropped from `widthFor` and this
    // failed with `width: 4` and `duration: 1` — a plan claiming four of a
    // team of two; watched 2026-08-12.
    //
    // The two is stated **for this project** since `capacity-per-project`. The
    // team is added unsized on purpose: a global size is read by nothing, and
    // seeding one here would let this pass against a build that still read it.
    await directory.addTeam({ id: 'team-small', name: 'Small' }, WROTE);
    await capacity.set(projectId, 'team-small', 2, WROTE);
    const strip = await leaf('Strip', 4, 'team-small');
    await service.setEstimate(strip, OWNER, stepId, flat(4));

    const tree = await service.tree(projectId);

    expect(slicedFor(tree, strip)).toMatchObject({ effort: 4, width: 2, duration: 2 });
  });

  it('reports the non-first team that bound a joint-capacity slice', async () => {
    await directory.addTeam({ id: 'team-alpha', name: 'Alpha' }, WROTE);
    await directory.addTeam({ id: 'team-beta', name: 'Beta' }, WROTE);
    await capacity.set(projectId, 'team-alpha', 1, WROTE);
    await capacity.set(projectId, 'team-beta', 1, WROTE);
    const betaBlocker = await leaf('Beta blocker', 1, 'team-beta');
    const jointlyBound = await leaf('Jointly bound', 1, 'team-alpha');

    // Task 2 widens the writer. Until then, present the reader with the exact
    // canonical set that the repository already returns from work_item_team.
    const listByProject = workItems.listByProject.bind(workItems);
    workItems.listByProject = async (wantedProjectId) =>
      (await listByProject(wantedProjectId)).map((row) =>
        row.id === jointlyBound ? { ...row, teamIds: ['team-alpha', 'team-beta'] } : row,
      );
    await service.setEstimate(betaBlocker, OWNER, stepId, flat(2));
    await service.setEstimate(jointlyBound, OWNER, stepId, flat(2));

    const tree = await service.tree(projectId);

    // Proof: replacing the engine's capacityTeamId in the payload with
    // `teamOf.get(placed.workItemId)?.teamIds.at(0)` failed here on
    // `team-alpha` versus `team-beta`; the first label did not bind this bar.
    expect(slicedFor(tree, jointlyBound)).toMatchObject({
      earliestStart: 2,
      boundBy: 'capacity',
      capacityTeamId: 'team-beta',
    });
  });

  it('runs a named person’s work one at a time however parallel the item is', async () => {
    // D3. One human cannot work beside themselves, and `assumedAssignee` means
    // one named assignment covers every step — so naming somebody collapses
    // the whole item to width 1.
    //
    // Proof: the named-person arm dropped from `widthFor` and this failed with
    // `width: 3` and `duration: 2` on work one person is doing; watched
    // 2026-08-12.
    const strip = await leaf('Strip', 3);
    await service.setEstimate(strip, OWNER, stepId, flat(6));
    await directory.assign(strip, stepId, 'kat', WROTE);

    const tree = await service.tree(projectId);

    expect(slicedFor(tree, strip)).toMatchObject({
      effort: 6,
      width: 1,
      duration: 6,
      personId: 'kat',
    });
  });

  it('draws a leaf’s pool from the team its parent labels', async () => {
    // D5, through the adapter: a label on a parent reaches the leaves beneath
    // it, and the pool those leaves spend is that team's. Nothing is copied
    // down — the rows are read back to prove the label is still only on the
    // parent.
    await directory.addTeam({ id: 'team-one', name: 'One' }, WROTE);
    await capacity.set(projectId, 'team-one', 1, WROTE);
    const step = await leaf('Step', 1, 'team-one');
    const first = await leaf('First', 1, null, step);
    const second = await leaf('Second', 1, null, step);
    await service.setEstimate(first, OWNER, stepId, flat(2));
    await service.setEstimate(second, OWNER, stepId, flat(2));

    const tree = await service.tree(projectId);

    // A pool of one, so the two children queue behind each other even though
    // neither of them carries the label.
    expect(slicedFor(tree, first)).toMatchObject({ earliestStart: 0, earliestFinish: 2 });
    expect(slicedFor(tree, second)).toMatchObject({
      earliestStart: 2,
      earliestFinish: 4,
      boundBy: 'capacity',
    });
    expect(tree?.waitingForCapacity).toBe(1);
    // Inheritance is a reading, never a stored second copy.
    const stored = tree?.workItems.filter((row) => [first, second].includes(row.id));
    for (const row of stored ?? []) expect(row.serviceTeamId).toBeNull();
  });

  it('leaves an unsized team labelling the work and constraining nothing', async () => {
    // The identity claim through the adapter: `team-billing` has no size, so
    // its work draws from no pool and the plan is the one this engine answered
    // before capacity existed.
    const strip = await leaf('Strip', 1, 'team-billing');
    const sand = await leaf('Sand', 1, 'team-billing');
    await service.setEstimate(strip, OWNER, stepId, flat(2));
    await service.setEstimate(sand, OWNER, stepId, flat(2));

    const tree = await service.tree(projectId);

    expect(slicedFor(tree, strip)).toMatchObject({ earliestStart: 0, earliestFinish: 2 });
    expect(slicedFor(tree, sand)).toMatchObject({
      earliestStart: 0,
      earliestFinish: 2,
      boundBy: 'projectStart',
      capacityPredecessorIds: [],
    });
    expect(tree?.waitingForCapacity).toBe(0);
  });
});

describe('the slices the schedule placed, on the wire', () => {
  /** A whole-day estimate, so the numbers in these tests are the numbers. */
  const flat = (days: number) => ({ optimistic: days, realistic: days, pessimistic: days });

  /**
   * One work item's slice in the payload, or a throw — a missing one is a
   * broken fixture, not a null.
   */
  function slicedFor(
    tree: Awaited<ReturnType<WorkItemService['tree']>>,
    workItemId: string,
  ): NonNullable<typeof tree>['slices'][number] {
    const found = tree?.slices.find((one) => one.workItemId === workItemId);
    if (found === undefined) throw new Error(`no slice for ${workItemId}`);
    return found;
  }

  it('names the slice the person was finishing, under the engine’s own id', async () => {
    const strip = await add('Strip');
    const sand = await add('Sand');
    await service.setEstimate(strip, OWNER, stepId, flat(3));
    await service.setEstimate(sand, OWNER, stepId, flat(2));
    await directory.assign(strip, stepId, 'kat', WROTE);
    await directory.assign(sand, stepId, 'kat', WROTE);

    const tree = await service.tree(projectId);

    expect(tree?.slices).toHaveLength(2);
    expect(slicedFor(tree, strip)).toMatchObject({
      workItemId: strip,
      stepId,
      personId: 'kat',
      duration: 3,
      estimated: true,
      earliestStart: 0,
      earliestFinish: 3,
      critical: true,
      boundBy: 'projectStart',
      resourcePredecessorId: null,
    });
    expect(slicedFor(tree, sand)).toMatchObject({
      earliestStart: 3,
      earliestFinish: 5,
      boundBy: 'person',
      // The engine's key, looked up rather than taken apart — the whole point
      // of carrying the ids is that the Gantt's person link is this lookup.
      resourcePredecessorId: slicedFor(tree, strip).id,
    });
  });

  it('reports the engine’s fractional numbers verbatim', async () => {
    // A PERT trio that does not land on a whole day: 22/6, which is
    // 3.6666666666666665 and not 3.67, not 4. The next slice of the same
    // person starts exactly there, and a payload that rounded either would put
    // the bar a whole day from where the Start column says it is.
    //
    // Under `exact`, because that is the only arm a fraction survives now
    // (`estimate-weights-and-rounding`): the claim is about the **payload**
    // never rounding the engine's own numbers, which is exactly as load-bearing
    // for a project that plans in fractions as it was for every project before.
    await projects.update(projectId, { estimateRounding: 'exact' }, WROTE);
    const strip = await add('Strip');
    const sand = await add('Sand');
    await service.setEstimate(strip, OWNER, stepId, {
      optimistic: 3,
      realistic: 3.5,
      pessimistic: 5,
    });
    await service.setEstimate(sand, OWNER, stepId, flat(2));
    await directory.assign(strip, stepId, 'kat', WROTE);
    await directory.assign(sand, stepId, 'kat', WROTE);

    const tree = await service.tree(projectId);

    const expected = (3 + 4 * 3.5 + 5) / 6;
    expect(slicedFor(tree, strip).duration).toBe(expected);
    expect(slicedFor(tree, strip).earliestFinish).toBe(expected);
    expect(slicedFor(tree, sand).earliestStart).toBe(expected);
    expect(slicedFor(tree, sand).earliestFinish).toBe(expected + 2);
  });

  it('carries no slices at all when the plan could not be scheduled', async () => {
    const strip = await add('Strip');
    const sand = await add('Sand');
    await dependencies.add({ id: 'x', projectId, predecessorId: strip, successorId: sand }, WROTE);
    await dependencies.add({ id: 'y', projectId, predecessorId: sand, successorId: strip }, WROTE);

    const tree = await service.tree(projectId);

    expect(tree?.scheduleError).toBe('cycle');
    expect(tree?.slices).toEqual([]);
  });

  /**
   * A project with two steps, its own rows, and somebody on each step.
   *
   * Its own project rather than the fixture's, because the order of the steps
   * is the point and the fixture has one.
   */
  async function twoStepPlan(): Promise<{ id: string; devId: string; qaId: string }> {
    const id = crypto.randomUUID();
    const devId = crypto.randomUUID();
    const qaId = crypto.randomUUID();
    await projects.create(
      projectRow({
        id,
        name: 'Refit',
        ownerId: OWNER,
      }),
      [
        { id: devId, projectId: id, name: 'Dev', position: 10 },
        { id: qaId, projectId: id, name: 'QA', position: 20 },
      ],
      WROTE,
    );
    const created = await service.create(id, OWNER, {
      parentId: null,
      afterId: null,
      name: 'Hull',
    });
    if (!created.ok) throw new Error(`create failed: ${created.reason}`);
    const hull = created.value.id;
    await service.setEstimate(hull, OWNER, devId, flat(3));
    await service.setEstimate(hull, OWNER, qaId, flat(2));
    const kat = await personAdded(
      directory.addPerson({ id: crypto.randomUUID(), name: 'Kat' }, [], WROTE),
    );
    const ada = await personAdded(
      directory.addPerson({ id: crypto.randomUUID(), name: 'Ada' }, [], WROTE),
    );
    // Somebody in the directory that nobody on this plan is: the payload names
    // who is on the plan, not who could be.
    await personAdded(
      directory.addPerson({ id: crypto.randomUUID(), name: 'Unbooked' }, [], WROTE),
    );
    await directory.assign(hull, devId, kat.id, WROTE);
    await directory.assign(hull, qaId, ada.id, WROTE);
    return { id, devId, qaId };
  }

  it('carries the steps its slices were placed under, in the engine’s order', async () => {
    const plan = await twoStepPlan();

    const tree = await service.tree(plan.id);

    // The order is the schedule's own: `slicesOf` is handed
    // `steps.map((each) => each.id)`, and a bar's place in its row is that
    // list's order. A payload carrying the steps in any other order would put
    // QA's bar before Dev's on a chart that had no way to know.
    //
    // Proof: `steps: [...steps].reverse()` on the way out. This failed on
    // `expect(received).toEqual(expected)` printing `- "Dev"` before `"QA"`;
    // watched 2026-08-09.
    expect(tree?.steps.map((step) => step.name)).toEqual(['Dev', 'QA']);
    // And the invariant a chart is drawn on: every slice is under a step this
    // payload lists. `layOutGantt` throws on the alternative.
    const listed = new Set(tree?.steps.map((step) => step.id));
    expect(tree?.slices.map((slice) => slice.stepId).filter((id) => id !== null)).toHaveLength(2);
    for (const slice of tree?.slices ?? []) {
      expect(listed.has(slice.stepId ?? '')).toBe(true);
    }
  });

  it('names everybody its slices are assigned to, and nobody else', async () => {
    const plan = await twoStepPlan();

    const tree = await service.tree(plan.id);

    // Proof: the filter inverted (`!assignedIds.has`), so the payload named
    // everybody nobody is. This failed on `expect(received).toEqual(expected)`
    // with `- "Ada"`, `- "Kat"` and `+ "Unbooked"`; watched 2026-08-09.
    expect(tree?.assignedPeople.map((person) => person.name).sort()).toEqual(['Ada', 'Kat']);
    // Every assigned id has a name here — the fact a bar's colour and its
    // on-bar label are both read from.
    const named = new Set(tree?.assignedPeople.map((person) => person.id));
    const assignedTo = (tree?.slices ?? [])
      .map((slice) => slice.personId)
      .filter((id): id is string => id !== null);
    expect(assignedTo).toHaveLength(2);
    for (const personId of assignedTo) expect(named.has(personId)).toBe(true);
  });

  it('answers from one read of the steps, whatever a later read would say', async () => {
    const plan = await twoStepPlan();
    // A peer removes QA in the moment between this client's tree read and the
    // separate step read it used to pair with it. `stepsOf` answers the first
    // caller with both steps and everybody after with one — which is exactly
    // what the two requests saw, and why the chart used to be handed a slice
    // under a step its step list no longer had.
    let reads = 0;
    const shifting: ProjectStore = {
      ...projects,
      async stepsOf(projectId) {
        reads += 1;
        const all = await projects.stepsOf(projectId);
        return reads === 1 ? all : all.filter((step) => step.name !== 'QA');
      },
    };
    const readingOnce = new WorkItemService({ ...serviceOptions, projects: shifting });

    const tree = await readingOnce.tree(plan.id);

    // The payload is whole: the steps in it are the steps its slices are
    // under, on one read.
    //
    // Proof: `steps` in the returned object replaced by a second
    // `await this.opts.projects.stepsOf(projectId)` — the second request, which
    // is what the client used to make. This failed on
    // `expect(received).toEqual(expected)` with `- "QA"` — the payload one
    // step short of the slices in it, which is the skew itself. Watched
    // 2026-08-09.
    expect(tree?.steps.map((step) => step.name)).toEqual(['Dev', 'QA']);
    const listed = new Set(tree?.steps.map((step) => step.id));
    for (const slice of tree?.slices ?? []) expect(listed.has(slice.stepId ?? '')).toBe(true);
    // And the separate read really does disagree, so the assertion above is
    // about carrying the list rather than about a store that never moved.
    expect((await shifting.stepsOf(plan.id)).map((step) => step.name)).toEqual(['Dev']);
  });

  it('adds slices and moves nothing else in the payload', async () => {
    // `exact` for the reason above: the row's `finalDays` in this test is the
    // fraction the engine ran the slice for, and the claim is that the two are
    // one number.
    await projects.update(projectId, { estimateRounding: 'exact' }, WROTE);
    const strip = await add('Strip');
    await service.setEstimate(strip, OWNER, stepId, flat(3));

    const tree = await service.tree(projectId);

    // Additive, asserted rather than asserted about: every name the payload
    // carried before is still there, and the new ones are named. `slices` was
    // this test's own; `waitingForCapacity` is `capacity-engine`'s, and it sits
    // beside `waitingForPerson` rather than inside it because a queue and a
    // headcount are different sentences. `teamCapacities` is
    // `capacity-per-project`'s, and it rides here rather than on a route of its
    // own because the dates in this payload were computed from it. `priorityBands`
    // is `priority-bands`', and it rides here for a different reason: no date
    // here came from it, and every face draws every priority through it.
    // `depReach` is `dep-reach-whole-item`'s, and it rides here for a third
    // reason: every date here was computed from it *and* the chart has to draw
    // its arrows out of the slice it names, so a client without it would draw a
    // chart that disagrees with the dates beside it. `pertWeights` and
    // `estimateRounding` are `estimate-weights-and-rounding`'s, and they ride
    // here for `estimateMethod`'s reason: they are the arithmetic every figure
    // in this payload came out of, and a client that guessed would describe the
    // numbers in front of it with a formula they did not come from.
    expect(Object.keys(tree ?? {}).sort()).toEqual([
      'assignedPeople',
      'depReach',
      'estimateMethod',
      'estimateRounding',
      'pertWeights',
      'priorityBands',
      'projectRevision',
      'scheduleError',
      'seq',
      'slices',
      'startDate',
      'steps',
      'teamCapacities',
      'waitingForCapacity',
      'waitingForPerson',
      'workItems',
    ]);
    expect(tree?.workItems).toHaveLength(1);
    expect(tree?.workItems[0]).toMatchObject({
      number: '010',
      name: 'Strip',
      finalTotal: 3,
      schedule: { duration: 3, earliestStart: 0, earliestFinish: 3, estimated: true },
    });
    expect(tree?.waitingForPerson).toBe(0);
    expect(tree?.depReach).toBe('whole-item');
    expect(tree?.pertWeights).toEqual({ optimistic: 1, realistic: 4, pessimistic: 1 });
    expect(tree?.estimateRounding).toBe('exact');
    expect(tree?.scheduleError).toBeNull();
  });
});

describe('what a not-before reason does not do', () => {
  it('moves no date: the plan schedules identically with and without a reason', async () => {
    // This change's whole product decision as an assertion. The engine reads
    // `start_no_earlier_than` and builds a floor from it (`work-item.service.ts`,
    // `notBefore.set(row.id, workdaysBetween(…))`); the column beside it is in
    // no map the engine is handed, so writing words on a floor moves nothing at
    // all — not the row they are written on, and not the successor waiting for
    // it.
    //
    // That is what makes this a substitute for a `blocked` state rather than a
    // small version of one: a state that moved dates would need a rule for what
    // a blocked predecessor does to its successors, and this deliberately has
    // none, because the date already has one.
    //
    // Proof: the engine wired to read the reason — `notBefore` set from
    // `row.startNoEarlierThanReason !== null ? …` so an explained row is pushed
    // a day — and this fails with every date downstream moved; watched
    // 2026-08-18. `libs/domain/src/schedule.ts` has an empty diff on this branch and
    // this is the behavioural half of that claim.
    // **The project needs a start date and the floor has to bind.** Without a
    // start date the engine never builds the not-before map at all — the
    // `if (project.startDate !== null)` in `tree` — so a plan with no calendar
    // would schedule identically whatever this column said, and the assertion
    // below would hold for a reason that has nothing to do with this change.
    // That vacuity was real: the first version of this case ran on the default
    // project (`startDate: null`) and passed under its own injected fault.
    await projects.update(projectId, { startDate: '2026-08-06' }, WROTE);
    const strip = await add('Strip');
    const sand = await add('Sand');
    await service.setEstimate(strip, OWNER, stepId, {
      optimistic: 4,
      realistic: 5,
      pessimistic: 6,
    });
    await service.setEstimate(sand, OWNER, stepId, {
      optimistic: 1,
      realistic: 2,
      pessimistic: 3,
    });
    await service.addDependency(sand, OWNER, strip);
    await service.patch(strip, OWNER, { startNoEarlierThan: '2026-09-01' });
    const before = await service.tree(projectId);
    // The floor is the thing being held still, so it has to be holding
    // something first: `010` starts on its date rather than on day zero.
    expect(before?.workItems.find((row) => row.name === 'Strip')?.schedule.earliestStart).toBe(
      workdaysBetween('2026-08-06', '2026-09-01'),
    );

    await service.patch(strip, OWNER, {
      startNoEarlierThanReason: 'waiting on client sign-off',
    });

    const after = await service.tree(projectId);
    const schedules = (tree: Awaited<ReturnType<WorkItemService['tree']>>) =>
      (tree?.workItems ?? []).map((row) => ({
        name: row.name,
        schedule: row.schedule,
        dates: row.dates,
      }));
    expect(schedules(after)).toEqual(schedules(before));
    // And the slices the chart is drawn from, which is where a floor is
    // actually spelled: same count, same `boundBy`, same offsets.
    expect(after?.slices).toEqual(before?.slices ?? []);
  });

  it('refuses words on a row with no date, through the service', async () => {
    // The refusal as the service hands it up, which is what the controller turns
    // into a 400. Asserted here as well as against the real store because this
    // suite runs on `inMemoryWorkItems`, and a fixture laxer than the store it
    // stands for is how a test passes here and fails against SQLite.
    //
    // Proof: the pair rule deleted from `inMemoryWorkItems.patch`, and this
    // failed on `Expected: false, Received: true` — the fixture accepting a row
    // the database refuses, which is the whole class of fault that mirror
    // exists to prevent. Watched 2026-08-18.
    const strip = await add('Strip');

    const outcome = await service.patch(strip, OWNER, {
      startNoEarlierThanReason: 'waiting on client sign-off',
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.reason).toBe('not_before_reason_needs_a_date');
  });

  it('carries the words to every reader of the tree, beside the date', async () => {
    // The wire. Nothing derives it, nothing folds it and no parent rolls it up —
    // it rides the row it was written on, which is the whole of its plumbing.
    const strip = await add('Strip');
    await service.patch(strip, OWNER, {
      startNoEarlierThan: '2026-09-12',
      startNoEarlierThanReason: 'waiting on client sign-off',
    });

    const tree = await service.tree(projectId);

    expect(tree?.workItems.find((row) => row.id === strip)).toMatchObject({
      startNoEarlierThan: '2026-09-12',
      startNoEarlierThanReason: 'waiting on client sign-off',
    });
  });
});

/**
 * The rung a create stamps, and what happens when the ladder has not got one.
 *
 * The happy paths live in `plan-commands.test.ts`, against real SQLite and the
 * project's own ladder. This is the one case a real ladder cannot be put into:
 * `priorityLadderProblem` refuses a write of any count but five, so a store
 * answering fewer is a store that has stopped keeping its contract.
 */
describe('the priority a create stamps', () => {
  it('refuses to create against a ladder with no middle rung', async () => {
    // Proof: the throw in `ordinaryPriorityOf` replaced by
    // `?? DEFAULT_PRIORITY_BANDS[ORDINARY_BAND_RANK]`, and this failed on
    // `expected "(resolved without throwing)" to match /no rank 2 rung/` — the
    // create returned `ok` having stored 50, a number from a ladder this project
    // does not use. Watched 2026-08-29.
    const short = new WorkItemService({
      ...serviceOptions,
      priorityBands: inMemoryPriorityBands({
        [projectId]: [
          { startsAt: 1, label: 'Now', defaultValue: 1 },
          { startsAt: 2, label: 'Later', defaultValue: 2 },
        ],
      }),
    });
    // Awaited rather than `.rejects.toThrow`, which returns void in `bun:test`
    // and so cannot be awaited — an assertion nothing awaits passes whatever
    // happens, which is `project.test.ts`' own note and exactly the failure mode
    // R5 is about.
    const refusal = await short
      .create(projectId, OWNER, { parentId: null, afterId: null, name: 'Rewire' })
      .then(
        () => '(resolved without throwing)',
        (err: unknown) => String(err),
      );
    expect(refusal).toMatch(/no rank 2 rung/);
    // And nothing was written on the way to the throw.
    expect(await workItems.listByProject(projectId)).toHaveLength(0);
  });

  it('writes the explicit priority a caller names, and null for an unprioritised row', async () => {
    const stamped = await service.create(projectId, OWNER, {
      parentId: null,
      afterId: null,
      name: 'Rewire',
      priority: 7,
    });
    const blank = await service.create(projectId, OWNER, {
      parentId: null,
      afterId: null,
      name: 'Sand',
      priority: null,
    });
    if (!stamped.ok || !blank.ok) throw new Error('a create was refused');
    expect([stamped.value.priority, blank.value.priority]).toEqual([7, null]);
  });
});
