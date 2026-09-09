import { type Schedule, schedule, sliceKey } from '@wbs/domain';
import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';
import { beforeEach, describe, expect, it } from 'bun:test';

import type { ProjectPatch, ProjectStore, WorkItemStore, WriteStamp } from '../repository';
import type { SolverObjectiveName } from '../repository/schema';
import { inMemoryServices } from '../testing/harness';
import { projectRow } from '../testing/project-fixture';
import type { OptimizationVariantState, OptimizedScheduleAsk } from './optimized-schedule-reader';
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
function recordingReader(
  answer: Schedule | null | Readonly<Record<SolverObjectiveName, Schedule | null>>,
  /**
   * A variant's state, where it is not the one its schedule implies.
   *
   * The two are separate facts and slice 8b needs them apart for one case: a
   * reader that claims `ready` and hands back no schedule must not have a
   * finish invented for it. Everywhere else the state is derived, because a
   * fake free to disagree with itself is a fake that can pass a case the
   * production reader could never reach.
   */
  states: Readonly<Partial<Record<SolverObjectiveName, OptimizationVariantState>>> = {},
) {
  const asks: OptimizedScheduleAsk[] = [];
  // One schedule means "both variants answer this", which is what every case
  // written before slice 8b meant by it.
  const schedules: Record<SolverObjectiveName, Schedule | null> =
    answer === null || 'slices' in answer ? { pri: answer, time: answer } : answer;
  const stateOf = (objective: SolverObjectiveName): OptimizationVariantState =>
    states[objective] ??
    (schedules[objective] === null ? { state: 'idle' } : { state: 'ready', proof: 'proven' });
  return {
    asks,
    read: (ask: OptimizedScheduleAsk) => {
      asks.push(ask);
      return {
        inputHash: 'test-input-hash',
        generation: schedules.pri === null && schedules.time === null ? null : 1,
        contractVersion: '7+test',
        budgetMs: 60_000,
        variants: { pri: stateOf('pri'), time: stateOf('time') },
        schedules,
      };
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
    expect(tree.optimization).toEqual({
      enabled: true,
      engine: 'optimized',
      objective: 'pri',
      inputHash: 'test-input-hash',
      generation: 1,
      contractVersion: '7+test',
      budgetMs: 60_000,
      displayed: 'pri',
      variants: {
        pri: { state: 'ready', proof: 'proven' },
        time: { state: 'ready', proof: 'proven' },
      },
      // The unestimated leaf occupies `ASSUMED_SLICE_WORKDAYS`, so Fast
      // finishes on day 2 and a slice moved to day 3 finishes on day 5.
      finishDays: { fast: 2, pri: 5, time: 5 },
      sameOrderAsFast: { pri: true, time: true },
    });
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
    expect(tree.optimization).toMatchObject({
      displayed: 'fast',
      variants: { pri: { state: 'idle' }, time: { state: 'idle' } },
      // Fast's own finish is always there — it is the schedule this read had to
      // compute — and a variant that answered nothing contributes neither
      // figure rather than a zero, which would read as "finishes on day zero".
      finishDays: { fast: 2 },
      sameOrderAsFast: {},
    });
  });

  it('recovers a legacy out-of-range estimate when a later valid estimate replaces it', async () => {
    const id = await leaf('Rewire');
    await settings({
      startDate: '2026-09-09',
      optimizationEnabled: true,
      scheduleEngine: 'optimized',
    });
    await serviceOptions.estimates.set(
      {
        workItemId: id,
        stepId,
        optimistic: 4_000_000_000,
        realistic: 4_000_000_000,
        pessimistic: 4_000_000_000,
      },
      WROTE,
    );
    const service = new WorkItemService({
      ...serviceOptions,
      optimized: recordingReader(null).read,
    });

    // Legacy rows can still reach datesOf -> addWorkdays -> Date#toISOString,
    // which is the RangeError that made the whole plan read fail. The write
    // path must not need that broken read in order to replace the stored trio.
    expect(service.tree(projectId)).rejects.toBeInstanceOf(RangeError);
    expect(
      await service.setEstimate(id, OWNER, stepId, {
        optimistic: 1,
        realistic: 2,
        pessimistic: 3,
      }),
    ).toEqual({ ok: true, value: null });
    expect(await service.tree(projectId)).not.toBeNull();
  });

  it('reads disabled identity without serving a solver schedule', async () => {
    await leaf('Rewire');
    await settings({ optimizationEnabled: false, scheduleEngine: 'optimized' });
    const seen = recordingReader(null);
    const service = new WorkItemService({ ...serviceOptions, optimized: seen.read });
    const tree = await service.tree(projectId);
    if (tree === null) throw new Error('project vanished');
    expect(seen.asks).toHaveLength(1);
    expect(seen.asks[0]?.enabled).toBe(false);
    expect(tree.optimization).toMatchObject({ enabled: false, displayed: 'fast' });
  });

  it('warms absent variants while the enabled project keeps publishing Fast', async () => {
    // The optimizer toggle permits solver work; the engine chooses only what
    // this read publishes. Proof: restore the early `scheduleEngine !==
    // 'optimized'` return in `publishedOptimized` and the reader receives no
    // ask, leaving an enabled Fast project cold until somebody changes engines.
    await leaf('Rewire');
    await settings({ optimizationEnabled: true, scheduleEngine: 'fast' });
    const seen = recordingReader(null);
    const service = new WorkItemService({ ...serviceOptions, optimized: seen.read });
    const first = await service.tree(projectId);
    if (first === null) throw new Error('project vanished');
    expect(seen.asks).toHaveLength(1);
    expect(first.slices.map((each) => [each.earliestStart, each.boundBy])).toEqual([
      [0, 'projectStart'],
    ]);
  });

  /**
   * The plan read's own half of slice 8b, and the reason the cue can say
   * anything at all while the project is sitting on Fast.
   */
  it('compares both ready variants with Fast while Fast is the schedule on screen', async () => {
    await leaf('Rewire');
    await settings({ optimizationEnabled: true, scheduleEngine: 'fast' });
    const seen = recordingReader(null);
    await new WorkItemService({ ...serviceOptions, optimized: seen.read }).tree(projectId);
    if (seen.asks.length !== 1) throw new Error('the reader was not consulted exactly once');
    const asked = seen.asks[0];

    // Two different variants, because one figure standing for both would pass
    // against a read that computed either one of them twice.
    const served = recordingReader({
      pri: movedTo(asked.input, 3),
      time: movedTo(asked.input, 6),
    });
    const tree = await new WorkItemService({
      ...serviceOptions,
      optimized: served.read,
    }).tree(projectId);
    if (tree === null) throw new Error('project vanished');
    // Fast is still what the rows carry: the toggle permits the solver work and
    // the engine alone decides what is displayed.
    expect(tree.slices.map((each) => [each.earliestStart, each.boundBy])).toEqual([
      [0, 'projectStart'],
    ]);
    expect(tree.optimization).toMatchObject({ engine: 'fast', displayed: 'fast' });
    // Proof: with the `optimized === null ? … : comparedWithFast(…)` gate this
    // replaced put back — the shipped `comparison` was built only for a
    // displayed variant — this failed on `expect(received).toEqual(expected)`
    // dropping `- "pri": 5, - "time": 8` from the received object, and the case
    // below failed the same way on `pri`. That is the state a project is in for
    // the whole of its first solve and after any switch back to Fast: nothing
    // to compare, and so nothing for the cue to say. Watched 2026-09-08.
    expect(tree.optimization?.finishDays).toEqual({ fast: 2, pri: 5, time: 8 });
    expect(tree.optimization?.sameOrderAsFast).toEqual({ pri: true, time: true });
  });

  it('carries neither figure for a variant that has no schedule yet', async () => {
    await leaf('Rewire');
    await settings({ optimizationEnabled: true, scheduleEngine: 'fast' });
    const seen = recordingReader(null);
    await new WorkItemService({ ...serviceOptions, optimized: seen.read }).tree(projectId);
    if (seen.asks.length !== 1) throw new Error('the reader was not consulted exactly once');
    const asked = seen.asks[0];

    const served = recordingReader(
      { pri: movedTo(asked.input, 3), time: null },
      { time: { state: 'pending' } },
    );
    const tree = await new WorkItemService({
      ...serviceOptions,
      optimized: served.read,
    }).tree(projectId);
    if (tree === null) throw new Error('project vanished');
    // Absent rather than zero: a zero finish is a legal answer about a plan of
    // nothing, and a reader cannot tell the two apart.
    expect(tree.optimization?.finishDays).toEqual({ fast: 2, pri: 5 });
    expect(tree.optimization?.sameOrderAsFast).toEqual({ pri: true });
  });

  it('invents no figure for a variant that claims ready with nothing behind it', async () => {
    // The figures are measured off the schedules rather than read off the
    // states, and this is where the two can disagree. The engine stays Fast so
    // that the displayed-variant throw is not what is being observed.
    await leaf('Rewire');
    await settings({ optimizationEnabled: true, scheduleEngine: 'fast' });
    const served = recordingReader(
      { pri: null, time: null },
      { pri: { state: 'ready', proof: 'proven' }, time: { state: 'ready', proof: 'proven' } },
    );
    const tree = await new WorkItemService({
      ...serviceOptions,
      optimized: served.read,
    }).tree(projectId);
    if (tree === null) throw new Error('project vanished');
    expect(tree.optimization?.variants).toEqual({
      pri: { state: 'ready', proof: 'proven' },
      time: { state: 'ready', proof: 'proven' },
    });
    expect(tree.optimization?.finishDays).toEqual({ fast: 2 });
    expect(tree.optimization?.sameOrderAsFast).toEqual({});
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
    expect(await service.scheduleInput(projectId)).toEqual(asked.input);
    expect(asked.input.rows.map((row) => row.id)).toEqual([id]);
    expect(asked.input.slices.map((each) => sliceKey(each.workItemId, each.stepId))).toEqual([
      sliceKey(id, stepId),
    ]);
    // TASK-241's, not this task's: the column the map would be built from does
    // not exist yet, and an empty map is the true value for a plan with no
    // deadlines stated either side of that task.
    expect([...asked.input.deadlines]).toEqual([]);
    // Proof: rebuilding the queued input with a different reach or without the
    // start constraint makes the equality above fail before a stale solve can launch.
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
