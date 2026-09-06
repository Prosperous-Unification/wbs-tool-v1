import { type Schedule, schedule, sliceKey } from '@wbs/domain';
import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';
import { beforeEach, describe, expect, it } from 'bun:test';

import type { ProjectPatch, ProjectStore, WorkItemStore, WriteStamp } from '../repository';
import { inMemoryServices } from '../testing/harness';
import { projectRow } from '../testing/project-fixture';
import type { OptimizedScheduleAsk } from './optimized-schedule-reader';
import { WorkItemService, type WorkItemServiceOptions } from './work-item.service';

/**
 * tasks.md 4.11's seam, from the plan read's side.
 *
 * The cases below are about **which pass answers**, not about what either pass
 * computes: whether the optimized cache is consulted at all, what it is asked,
 * and whose dates reach the payload. 4.11's own six proofs — the annotation
 * fixtures — sit one layer above this and were unwritable until it existed:
 * before run 42 `work-item.service.ts` called `schedule()` with six arguments
 * and imported nothing from the cache, so no payload could carry an optimized
 * date to assert on (run 41 chunk 3 measured that and wrote it down).
 *
 * **The reader is a stub here, and deliberately not `readOptimizedPair`.** What
 * the cache decides — a miss, a `failed` row, a superseded generation, a
 * `corrupt` decode — is 4.1–4.8's, proved against real SQLite in
 * `optimized-schedule-cache.db.test.ts`. All four reach this layer as `null`,
 * so a suite that drove them through the database would re-prove the cache's
 * rules and prove nothing about the seam.
 */

const OWNER = 'owner-account';
const WROTE: WriteStamp = { at: 1, by: OWNER };

let projects: ProjectStore;
let workItems: WorkItemStore;
let serviceOptions: WorkItemServiceOptions;
let projectId: string;
let stepId: string;

beforeEach(async () => {
  const harness = inMemoryServices();
  ({ projects, workItems } = harness.stores);
  serviceOptions = { ...harness.stores, broadcast: harness.broadcast };
  const project = projectRow({ id: crypto.randomUUID(), ownerId: OWNER });
  stepId = crypto.randomUUID();
  await projects.create(
    project,
    [{ id: stepId, projectId: project.id, name: 'Dev', position: 10 }],
    WROTE,
  );
  projectId = project.id;
});

/**
 * Puts one leaf on the plan, straight through the store.
 *
 * One row is enough for every case here: the subject is which schedule the
 * payload reports, and a second row would only make the fixtures longer while
 * the assertion stayed on the first.
 */
async function leaf(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await workItems.insert(
    {
      id,
      projectId,
      parentId: null,
      position: 10,
      name,
      notes: '',
      frozenNumber: null,
      priority: 50,
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
  return id;
}

/** Moves the three settings 3b.1 added, through the repository patch 3b.2 built. */
async function settings(patch: ProjectPatch): Promise<void> {
  const moved = await projects.update(projectId, patch, WROTE);
  if (moved === null) throw new Error('project vanished');
}

/**
 * A reader that answers `answer` and records what it was asked.
 *
 * The asks are recorded rather than counted so a case can assert **that it was
 * never consulted** — the difference between "the flag was read" and "the flag
 * happened not to change the answer", which is the whole of what 3b.1's two
 * separate settings buy.
 */
function recordingReader(answer: Schedule | null) {
  const asks: OptimizedScheduleAsk[] = [];
  return {
    asks,
    read: (ask: OptimizedScheduleAsk) => {
      asks.push(ask);
      return answer;
    },
  };
}

/**
 * A schedule no Fast pass over this plan could produce, built by running the
 * real one and moving its single slice.
 *
 * Fabricated from `schedule()`'s own output rather than written out by hand:
 * `Schedule` carries eleven fields per slice and the assertion is about *whose*
 * numbers arrive, so a hand-built one would be eleven chances to write a shape
 * the domain never emits and still pass.
 */
function movedTo(input: ScheduleInput, start: number): Schedule {
  const fast = schedule(
    input.rows,
    input.edges,
    input.slices,
    input.notBefore,
    input.poolSizes,
    input.reach,
  );
  const slices = new Map(fast.slices);
  const workItems = new Map(fast.workItems);
  for (const [key, placed] of slices) {
    const width = placed.earliestFinish - placed.earliestStart;
    slices.set(key, {
      ...placed,
      earliestStart: start,
      earliestFinish: start + width,
      latestStart: start,
      latestFinish: start + width,
      boundBy: 'optimizer',
    });
    const item = workItems.get(placed.workItemId);
    if (item === undefined) continue;
    workItems.set(placed.workItemId, {
      ...item,
      earliestStart: start,
      earliestFinish: start + width,
      latestStart: start,
      latestFinish: start + width,
    });
  }
  return { ...fast, slices, workItems };
}

describe('the plan read and the optimized cache', () => {
  it('reports the published solver schedule when the project is on the optimized engine', async () => {
    // Proof: `optimized ?? schedule(...)` reduced to `schedule(...)` and this
    // failed on the start — the payload carried Fast's day 0 and `projectStart`
    // while a published solver row said day 3. Watched 2026-09-04.
    await leaf('Rewire');
    await settings({ optimizationEnabled: true, scheduleEngine: 'optimized' });
    const seen = recordingReader(null);
    const probe = new WorkItemService({ ...serviceOptions, optimized: seen.read });
    await probe.tree(projectId);
    if (seen.asks.length !== 1) throw new Error('the reader was not consulted exactly once');
    const asked = seen.asks[0];

    const served = recordingReader(movedTo(asked.input, 3));
    const service = new WorkItemService({ ...serviceOptions, optimized: served.read });
    const tree = await service.tree(projectId);
    if (tree === null) throw new Error('project vanished');
    expect(tree.slices.map((each) => [each.earliestStart, each.boundBy])).toEqual([
      [3, 'optimizer'],
    ]);
  });

  it('falls back to Fast when the cache has nothing to serve', async () => {
    // The one answer four different cache outcomes arrive as. Fast's own start
    // is day 0 for a plan with one unconstrained leaf, and `projectStart` is
    // what put it there — a floor the optimizer never names.
    await leaf('Rewire');
    await settings({ optimizationEnabled: true, scheduleEngine: 'optimized' });
    const seen = recordingReader(null);
    const service = new WorkItemService({ ...serviceOptions, optimized: seen.read });
    const tree = await service.tree(projectId);
    if (tree === null) throw new Error('project vanished');
    expect(tree.slices.map((each) => [each.earliestStart, each.boundBy])).toEqual([
      [0, 'projectStart'],
    ]);
    expect(seen.asks).toHaveLength(1);
  });

  it('never consults the cache for a project that has optimization switched off', async () => {
    // Proof: the `optimizationEnabled` refusal deleted and this failed on
    // `[]` receiving one ask — a project an administrator had just switched off
    // went on being served solver schedules, which is the state 3b.1's flag
    // exists to make immediate. Watched 2026-09-04.
    await leaf('Rewire');
    await settings({ optimizationEnabled: false, scheduleEngine: 'optimized' });
    const seen = recordingReader(null);
    const service = new WorkItemService({ ...serviceOptions, optimized: seen.read });
    await service.tree(projectId);
    expect(seen.asks).toEqual([]);
  });

  it('never consults the cache for a project that asked for the fast engine', async () => {
    // Proof: the `scheduleEngine` refusal deleted and this failed the same way.
    // The two settings are separate facts — a project may be permitted to spend
    // solver time and still be reading Fast — so one check cannot stand for both.
    await leaf('Rewire');
    await settings({ optimizationEnabled: true, scheduleEngine: 'fast' });
    const seen = recordingReader(null);
    const service = new WorkItemService({ ...serviceOptions, optimized: seen.read });
    await service.tree(projectId);
    expect(seen.asks).toEqual([]);
  });

  it('asks for the objective the project publishes, under the plan the pass is about to run', async () => {
    // The ask is the cache key's whole input: a `ScheduleInput` that named a
    // different plan than the one `schedule()` is handed one line below would
    // serve another plan's schedule under this plan's hash.
    const id = await leaf('Rewire');
    await settings({
      optimizationEnabled: true,
      scheduleEngine: 'optimized',
      scheduleObjective: 'time',
    });
    const seen = recordingReader(null);
    const service = new WorkItemService({ ...serviceOptions, optimized: seen.read });
    await service.tree(projectId);
    if (seen.asks.length !== 1) throw new Error('the reader was not consulted exactly once');
    const asked = seen.asks[0];
    expect([asked.projectId, asked.objective]).toEqual([projectId, 'time']);
    expect(asked.input.rows.map((row) => row.id)).toEqual([id]);
    expect(asked.input.slices.map((each) => sliceKey(each.workItemId, each.stepId))).toEqual([
      sliceKey(id, stepId),
    ]);
    // TASK-241's, not this task's: the column the map would be built from does
    // not exist yet, and an empty map is the true value for a plan with no
    // deadlines stated either side of that task.
    expect([...asked.input.deadlines]).toEqual([]);
  });

  it('runs Fast for a deployment with no cache wired in', async () => {
    // The optional collaborator's own case. A service built without a reader
    // must schedule, not refuse and not throw — which is every construction
    // site in this app on the day this lands.
    await leaf('Rewire');
    await settings({ optimizationEnabled: true, scheduleEngine: 'optimized' });
    const service = new WorkItemService(serviceOptions);
    const tree = await service.tree(projectId);
    if (tree === null) throw new Error('project vanished');
    expect(tree.slices.map((each) => [each.earliestStart, each.boundBy])).toEqual([
      [0, 'projectStart'],
    ]);
  });
});
