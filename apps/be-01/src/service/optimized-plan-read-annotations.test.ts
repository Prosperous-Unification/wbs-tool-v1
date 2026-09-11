import { materialiseOptimized } from '@wbs/contracts/solver/materialise-optimized';
import { quantisedFastBaseline } from '@wbs/contracts/solver/quantised-baseline';
import { sliceKey, SOLVER_QUANTUM } from '@wbs/domain';
import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';
import { beforeEach, describe, expect, it } from 'bun:test';

import type {
  CapacityStore,
  DirectoryStore,
  EstimateStore,
  ProjectStore,
  WorkItemStore,
  WriteStamp,
} from '../repository';
import { AvailableWorkItemService as WorkItemService } from '../testing/available-work-item-service';
import { testClock } from '../testing/clock-fixture';
import { inMemoryServices } from '../testing/harness';
import { projectRow } from '../testing/project-fixture';
import type { OptimizedScheduleAsk } from './optimized-schedule-reader';
import { optimizerWiring } from './optimizer-wiring';
import type { WorkItemServiceOptions } from './work-item.service';

/**
 * tasks.md 4.11 (a)–(c): the materialiser's annotations, asserted **through the
 * real plan-read payload** rather than against the domain type.
 *
 * The distinction is the whole item. `schedule-annotate.test.ts` already proves
 * what `pinFloor` and `annotateCapacity` decide, and 4.9 is closed on exactly
 * those assertions — so an assertion written one layer down here would be 4.9's
 * proof again under a new name. What is unproved until this file exists is that
 * a *served* optimized schedule reaches `tree()`'s payload with its own
 * annotations intact: the floats, the `boundBy` labels and the capacity fields
 * that a Gantt bar and a critical-path badge are drawn from.
 *
 * **The materialiser is the real one, not a moved schedule.**
 * `optimized-plan-read.test.ts` fabricates a `Schedule` by running Fast and
 * shifting a slice, which is right for its subject (*which pass answers*) and
 * wrong for this one: a hand-moved slice carries Fast's annotations by
 * construction, so a case built on one could not tell an optimized annotation
 * from a Fast annotation with a later date. Every schedule below comes out of
 * `materialiseOptimized` over the plan read's own `ScheduleInput`, driven by
 * unit offsets exactly as a parsed solver response would drive it.
 */

const OWNER = 'owner-account';
const WROTE: WriteStamp = { at: 1, by: OWNER };
/** The one team a single-pool case here draws from. */
const PLATFORM = 'team-platform';
/**
 * The two pools 4.11 (d)'s contended slice spends a slot in at once.
 *
 * Named so the two orders a reader might confuse stay visibly apart, which is
 * `schedule-joint-capacity.test.ts`'s own convention: `team-alpha` sorts first
 * and the case below puts the right answer on `team-beta` on purpose, so a
 * first-sorted reading of `capacityTeamId` and a latest-finisher reading give
 * different answers.
 */
const ALPHA = 'team-alpha';
const BETA = 'team-beta';

let projects: ProjectStore;
let workItems: WorkItemStore;
let estimates: EstimateStore;
let capacity: CapacityStore;
let directory: DirectoryStore;
let serviceOptions: WorkItemServiceOptions;
let projectId: string;
let stepId: string;
/**
 * The project's second step, so a slice can have a floor that is neither the
 * project start nor a pool.
 *
 * Step order is an edge in this engine (`slicesOf`), so a work item's QA slice
 * sits on a `stepOrder` floor at its Dev slice's finish — the cheapest real
 * floor a payload fixture can build, needing no dependency rows and no
 * project start date.
 */
let laterStepId: string;

beforeEach(async () => {
  const harness = inMemoryServices();
  ({ projects, workItems, estimates, capacity, directory } = harness.stores);
  serviceOptions = {
    clock: testClock,
    ...harness.stores,
    broadcast: harness.broadcast,
    scheduler: harness.scheduler,
  };
  const project = projectRow({ id: crypto.randomUUID(), ownerId: OWNER });
  stepId = crypto.randomUUID();
  laterStepId = crypto.randomUUID();
  await projects.create(
    project,
    [
      { id: stepId, projectId: project.id, name: 'Dev', position: 10 },
      { id: laterStepId, projectId: project.id, name: 'QA', position: 20 },
    ],
    WROTE,
  );
  projectId = project.id;
  const moved = await projects.update(
    projectId,
    { optimizationEnabled: true, scheduleEngine: 'optimized' },
    WROTE,
  );
  if (moved === null) throw new Error('project vanished');
});

/**
 * One leaf with a flat whole-day estimate, and optionally a team.
 *
 * Whole days on purpose: every number these cases assert is a workday offset,
 * and a three-point estimate that averaged to a fraction would make the
 * expected values arithmetic the reader has to redo.
 *
 * `priority` is the leveller's first tie-break and every leaf here shares a
 * position, so a case whose answer depends on which of two same-day slices
 * takes a scarce slot first must say so rather than inherit the float ordering
 * underneath. 4.11 (d) is the one that does; everything else leaves it alone.
 */
async function leaf(
  name: string,
  days: number,
  serviceTeamId: string | null = null,
  priority = 50,
) {
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
      priority,
      startNoEarlierThan: null,
      startNoEarlierThanReason: null,
      deadline: null,
      serviceTeamId,
      serviceId: null,
      maxParallel: 1,
      revision: 0,
    },
    [],
    WROTE,
  );
  await estimates.set(
    { workItemId: id, stepId, optimistic: days, realistic: days, pessimistic: days },
    WROTE,
  );
  return id;
}

/**
 * A leaf that spends a slot in SEVERAL pools at once.
 *
 * Written as an insert plus a `patch`, which reads like ceremony and is not:
 * `WorkItemStore.insert` takes a `WorkItem`, and a `WorkItem` carries the
 * singular `serviceTeamId` and no set at all. The SQLite repository's private
 * `joinRowsFor` will read a `teamIds` property off the row it is handed, but
 * that shape is not on the port, the in-memory twin's `joinFor` does not read
 * it, and a fixture that passed one got a slice with **no pools** and a case
 * that measured the wrong thing without failing (watched 2026-09-04, run 43:
 * the resulting `poolIds: []` was misread as the joint search taking the
 * minimum of its pools). The set's supported write path is the patch, which
 * both the store and its twin implement — and which validates the teams
 * against the directory, so they have to exist first.
 */
async function multiPoolLeaf(
  name: string,
  days: number,
  teamIds: readonly string[],
  priority = 50,
) {
  const id = await leaf(name, days, null, priority);
  const labelled = await workItems.patch(id, { teamIds }, WROTE);
  if (!labelled.ok) throw new Error(`could not label ${name}: ${labelled.reason}`);
  return id;
}

/** The same leaf, estimated on both steps, so it carries a `stepOrder` floor. */
async function twoStepLeaf(name: string, days: number, serviceTeamId: string | null = null) {
  const id = await leaf(name, days, serviceTeamId);
  await estimates.set(
    { workItemId: id, stepId: laterStepId, optimistic: days, realistic: days, pessimistic: days },
    WROTE,
  );
  return id;
}

/**
 * The `ScheduleInput` the plan read will hand its reader for this project.
 *
 * Taken from a throwaway pass with a reader that answers `null` rather than
 * rebuilt here: the input is the service's own canonicalisation of the stored
 * rows, and a copy assembled in the test would be a second implementation of it
 * — one that could drift from the real one without either side failing, which
 * is the exact defect the port's doc comment refuses for `inputHash`.
 */
async function askedInput(): Promise<ScheduleInput> {
  const asks: OptimizedScheduleAsk[] = [];
  const read = (ask: OptimizedScheduleAsk) => {
    asks.push(ask);
    return {
      inputHash: 'probe-input-hash',
      generation: null,
      contractVersion: '7+test',
      budgetMs: 60_000,
      variants: { pri: { state: 'idle' as const }, time: { state: 'idle' as const } },
      schedules: { pri: null, time: null },
    };
  };
  const probe = new WorkItemService({
    ...serviceOptions,
    scheduler: optimizerWiring({ readLive: read, readCaptured: read }).scheduler,
  });
  await probe.tree(projectId);
  // A length check rather than an `=== undefined` guard on the indexed read:
  // `noUncheckedIndexedAccess` is off in this repo, so the read is not optional
  // and eslint refuses the guard as `no-unnecessary-condition`.
  if (asks.length !== 1) {
    throw new Error(`the reader was consulted ${String(asks.length)} times, not once`);
  }
  return asks[0].input;
}

/**
 * The payload of a plan read served by the real materialiser over `offsets`.
 *
 * `moved` is keyed by `sliceKey` and measured in solver units, which is the
 * wire's own shape — `materialiseOptimized` divides by {@link SOLVER_QUANTUM}
 * and hands the result to `schedule()` as pinned starts.
 *
 * **Every slice the plan has must carry an offset**, because a solver answers
 * for all of them and `materialiseOptimized` refuses a map that misses one.
 * The unmoved ones therefore come from `quantisedFastBaseline` — the plan's own
 * hint, and the one offset set that is legal by construction — and `moved`
 * overrides only the slices a case is about. Spelling every offset in the case
 * instead made the fixtures depend on how many steps the project happens to
 * have: a second step added for 4.11 (f) silently gave every other leaf a
 * second slice, and three cases that had spelled one offset each began throwing
 * `this plan has no such slice`'s converse. Measured 2026-09-04.
 */
async function servedBy(moved: Readonly<Record<string, number>>) {
  const input = await askedInput();
  const materialised = materialiseOptimized(
    input.rows,
    input.edges,
    input.slices,
    input.notBefore,
    input.poolSizes,
    input.reach,
    {
      ...quantisedFastBaseline(
        input.rows,
        input.edges,
        input.slices,
        input.notBefore,
        input.poolSizes,
        input.reach,
      ),
      ...moved,
    },
  );
  const read = () => ({
    inputHash: 'served-input-hash',
    generation: 1,
    contractVersion: '7+test',
    budgetMs: 60_000,
    variants: {
      pri: { state: 'ready' as const, proof: 'proven' as const },
      time: { state: 'ready' as const, proof: 'proven' as const },
    },
    schedules: { pri: materialised, time: materialised },
  });
  const service = new WorkItemService({
    ...serviceOptions,
    scheduler: optimizerWiring({ readLive: read, readCaptured: read }).scheduler,
  });
  const tree = await service.tree(projectId);
  if (tree === null) throw new Error('project vanished');
  return tree;
}

/** Solver units for a whole number of workdays. */
const units = (days: number) => days * SOLVER_QUANTUM;

/** One work item's slice in the payload, or a throw — a missing one is a broken fixture. */
function slicedFor(
  tree: Awaited<ReturnType<WorkItemService['tree']>>,
  workItemId: string,
): NonNullable<typeof tree>['slices'][number] {
  const found = tree?.slices.find((one) => one.workItemId === workItemId);
  if (found === undefined) throw new Error(`no slice for ${workItemId}`);
  return found;
}

/**
 * One work item's slice on a named step, or a throw.
 *
 * {@link slicedFor} answers the first slice a row has, which is its Dev one.
 * Every leaf here also carries an unestimated QA slice, and in a pooled case
 * that slice takes a slot from the same pools — so the reservation a contended
 * block actually waits for is often the QA one, and a fixture that named the
 * Dev slice would assert against a reservation that released two days earlier.
 */
function slicedForStep(
  tree: Awaited<ReturnType<WorkItemService['tree']>>,
  workItemId: string,
  step: string,
): NonNullable<typeof tree>['slices'][number] {
  const found = tree?.slices.find((one) => one.workItemId === workItemId && one.stepId === step);
  if (found === undefined) throw new Error(`no slice for ${workItemId} on ${step}`);
  return found;
}

/** One work item's row in the payload, or a throw. */
function rowFor(
  tree: Awaited<ReturnType<WorkItemService['tree']>>,
  workItemId: string,
): NonNullable<typeof tree>['workItems'][number] {
  const found = tree?.workItems.find((one) => one.id === workItemId);
  if (found === undefined) throw new Error(`no row for ${workItemId}`);
  return found;
}

describe("the materialiser's annotations, through the plan read", () => {
  it('reports the optimized float and the optimized floor, not Fast’s against optimized dates', async () => {
    // tasks.md 4.11 (a). Two independent two-day leaves. Fast puts both on day
    // 0, so the plan is two days long and BOTH are critical with no float. The
    // solver idles `sand` to day 3, which makes the plan five days long and
    // hands `strip` three days of float it did not have — and `sand` a floor
    // Fast has no name for.
    //
    // Watched red: `timing = planned.workItems` replaced by
    // `timing = schedule(rows, edges, slices, notBefore, slotsOf,
    // project.depReach).workItems` — Fast's own annotations under the
    // optimizer's dates. `strip` came back `float: 0, critical: true` and this
    // failed on both. Watched 2026-09-04.
    const strip = await leaf('Strip', 2);
    const sand = await leaf('Sand', 2);
    // The QA slice moves with its Dev slice: `sand`'s zero-duration second
    // slice sits on a `stepOrder` floor at its Dev finish, so a baseline offset
    // for day 2 is below the floor day 3 creates and the materialiser refuses
    // it — correctly. A solver moves a slice's own successors too.
    const tree = await servedBy({
      [sliceKey(strip, stepId)]: units(0),
      [sliceKey(sand, stepId)]: units(3),
      [sliceKey(sand, laterStepId)]: units(5),
    });

    expect(slicedFor(tree, sand)).toMatchObject({
      earliestStart: 3,
      earliestFinish: 5,
      boundBy: 'optimizer',
      critical: true,
    });
    expect(rowFor(tree, strip).schedule).toMatchObject({ float: 3, critical: false });
    expect(rowFor(tree, sand).schedule).toMatchObject({ float: 0, critical: true });
  });

  it('labels a deliberately idled slice `optimizer` and not by the floor it cleared', async () => {
    // tasks.md 4.11 (b). One leaf, nothing holding it up, pinned three days
    // above the only floor it has. `projectStart` is a true statement about
    // where it *could* have gone and a false one about why it is where it is —
    // the difference a Gantt bar's reason text is drawn from.
    //
    // Watched red: `pinFloor`'s last line returned
    // `{ start: window.start, boundBy: resolved.boundBy }` — the optimizer's
    // date under the floor's own label. This failed on
    // `'projectStart'` where `'optimizer'` was expected, and it is the only
    // case in the repository that fails on it: the date is unchanged, so every
    // placement assertion elsewhere stays green. Watched 2026-09-04.
    const rewire = await leaf('Rewire', 2);
    const tree = await servedBy({
      [sliceKey(rewire, stepId)]: units(3),
      [sliceKey(rewire, laterStepId)]: units(5),
    });

    expect(slicedFor(tree, rewire)).toMatchObject({
      earliestStart: 3,
      earliestFinish: 5,
      boundBy: 'optimizer',
    });
  });

  it('leaves an optimizer slice naming no team and no capacity predecessor', async () => {
    // tasks.md 4.11 (c), the render invariant on the production path: the
    // capacity fields are set exactly when `boundBy` is `capacity`, and an
    // `'optimizer'` slice is the case where a pool exists, the slice draws from
    // it, and it still held nothing up. A team named here would draw an arrow
    // from a bar that waited for nobody.
    //
    // The pool has room — size 2 with one other tenant — so the pin is legal
    // and the re-ask inside `pinFloor` returns its own instant with an empty
    // binding, which is what makes the invariant true rather than lucky.
    //
    // **THIS CASE STATES THE INVARIANT AND DELIBERATELY DOES NOT PIN IT.
    // Measured, not assumed.** Two facts, both established on 2026-09-04:
    //
    // 1. The pin must be strictly above the slice's own capacity floor, or
    //    `pinFloor` hands `resolved` back untouched and the slice is
    //    `'capacity'` — correctly. Written first on the tighter fixture this
    //    item implies (pool size 1, the other tenant releasing at exactly the
    //    pinned instant), it came back `boundBy: 'capacity'` with the team
    //    named. `named only the pool tenants that had actually finished by the
    //    pinned start` below is that state, kept as its own case.
    // 2. Above the floor, `pinFloor` re-asks the window from its own answer, so
    //    the accepted window has an empty binding BY CONSTRUCTION. There is
    //    then nothing for `annotateCapacity`'s `boundBy === 'capacity'` gate to
    //    gate: deleting it leaves this green, because `window.blocking` is
    //    already empty. The gate's own watched red therefore lives where it
    //    bites — `libs/domain/src/schedule-annotate.test.ts`, and (e) below for
    //    the filter inside it.
    //
    // What this case is for is the projection: an `'optimizer'` slice arrives
    // in the payload with `capacityTeamId: null` and no predecessors, so the
    // render invariant a Gantt arrow depends on survives the DTO. A mutation
    // that reddens it would have to be in the payload build, not the engine.
    await capacity.set(projectId, PLATFORM, 2, WROTE);
    const hold = await leaf('Hold', 6, PLATFORM);
    const rewire = await leaf('Rewire', 2, PLATFORM);
    const tree = await servedBy({
      [sliceKey(hold, stepId)]: units(0),
      [sliceKey(rewire, stepId)]: units(3),
      [sliceKey(rewire, laterStepId)]: units(5),
    });

    expect(slicedFor(tree, rewire)).toMatchObject({
      earliestStart: 3,
      boundBy: 'optimizer',
      capacityTeamId: null,
      capacityPredecessorIds: [],
    });
    // The other tenant is where Fast put it, and its own floor is unchanged —
    // so the assertion above is about the pinned slice and not about a plan
    // that lost its capacity annotations wholesale.
    expect(slicedFor(tree, hold)).toMatchObject({ earliestStart: 0, capacityTeamId: null });
  });

  it('leaves a slice pinned on its own floor labelled by that floor, not by the optimizer', async () => {
    // tasks.md 4.11 (f), the converse of (b) and the case the three-way split
    // in `pinFloor` exists for: an offset that agrees with where the plan was
    // going to put the slice anyway. The solver returns a start for EVERY
    // slice, so this is not a corner — it is what most of a solver answer looks
    // like, and calling all of it `'optimizer'` would make the label mean
    // "was in the answer" rather than "the optimizer chose this".
    //
    // The floor is `stepOrder`: the QA slice cannot begin before the same work
    // item's Dev slice finishes, and the pool has room (size 2, one tenant), so
    // capacity is not what is holding it.
    //
    // Watched red: `pinFloor`'s early return reduced from
    // `pinned === undefined || withinDrift(pinned, resolved.start)` to
    // `pinned === undefined`, so a pin equal to its own floor falls through to
    // the window and comes back `'optimizer'`.
    await capacity.set(projectId, PLATFORM, 2, WROTE);
    const rewire = await twoStepLeaf('Rewire', 2, PLATFORM);
    const tree = await servedBy({
      [sliceKey(rewire, stepId)]: units(0),
      [sliceKey(rewire, laterStepId)]: units(2),
    });

    const later = tree.slices.find(
      (each) => each.workItemId === rewire && each.stepId === laterStepId,
    );
    expect(later).toMatchObject({
      earliestStart: 2,
      earliestFinish: 4,
      boundBy: 'stepOrder',
      capacityTeamId: null,
      capacityPredecessorIds: [],
    });
  });

  it('names only the pool tenants that had actually finished by the pinned start', async () => {
    // tasks.md 4.11 (e), the long-plus-short capacity-2 case, on the production
    // path. Pool size 2. `long` runs 0–10 and `short` runs 0–5, so the pool is
    // full for the first five days and `pinned` — which nothing else holds up —
    // has a capacity floor at 5. The optimizer's offset agrees with it, so this
    // slice stays `'capacity'` and its predecessor set is a real one.
    //
    // The set is `short` and NOT `long`: a conservative scan records every
    // reservation live at a violated instant, but a reservation that is still
    // running alongside this slice did not release the slot it took. Promoting
    // it into the backward graph draws a `long` → `pinned` edge, which gives
    // `long` a late finish earlier than its own early finish and puts negative
    // float on the plan — a bar the UI would draw as overdue against nothing.
    //
    // Watched red: `annotateCapacity`'s
    // `window.blocking.filter(finishesByStart)` reduced to `window.blocking`.
    await capacity.set(projectId, PLATFORM, 2, WROTE);
    const long = await leaf('Long', 10, PLATFORM);
    const short = await leaf('Short', 5, PLATFORM);
    const pinned = await leaf('Pinned', 2, PLATFORM);
    const tree = await servedBy({ [sliceKey(pinned, stepId)]: units(5) });

    const shortSlice = slicedFor(tree, short);
    expect(slicedFor(tree, pinned)).toMatchObject({
      earliestStart: 5,
      boundBy: 'capacity',
      capacityTeamId: PLATFORM,
      capacityPredecessorIds: [shortSlice.id],
    });
    // The other half of the same claim, and the one a reader of the plan sees:
    // `long` keeps a late finish at or after its early finish. Under the
    // dropped filter it does not.
    const longRow = rowFor(tree, long).schedule;
    expect(longRow.latestFinish).toBeGreaterThanOrEqual(longRow.earliestFinish);
  });

  it('names the later of the two pools that jointly held a slice, and both their releases', async () => {
    // tasks.md 4.11 (d), the contended two-pool case on the production path.
    //
    // `pinned` draws from BOTH pools and each holds one, so it needs a slot in
    // each and starts at the instant the LATER of them frees — which is the
    // whole point of the item: the joint window is later than either pool's own
    // earliest fit. Alpha frees at day 4 and Beta at day 6, so the floor is 6.
    //
    // The arithmetic, spelled out because every leaf carries an unestimated QA
    // slice worth `ASSUMED_SLICE_WORKDAYS` and that slice takes a slot from the
    // same pool its Dev slice did:
    //
    //   Alpha: `Alpha tenant` Dev 0–2, its QA 2–4   → Alpha free at 4
    //   Beta:  `Beta tenant`  Dev 0–4, its QA 4–6   → Beta  free at 6
    //   pinned Dev therefore 6–8, and its own QA 8–10.
    //
    // The tenants carry a lower `priority` number than `pinned` so that order
    // is the fixture's statement rather than the float ordering's: all three
    // leaves share a position and start on day 0, so without it the tie is
    // broken by float and `pinned` can take both slots first — measured, and
    // the case then reads 4 rather than 6 for a reason that has nothing to do
    // with what it is about.
    //
    // The pin sits ON that floor rather than above it, which the item requires
    // and which is what leaves the slice `'capacity'` with capacity fields to
    // assert on: above the floor `pinFloor` re-asks the window from its own
    // answer, the binding comes back empty by construction, and there is
    // nothing left for `annotateCapacity`'s gate to gate on (that is 4.11 (c)'s
    // decision, one case up). So the offsets here are the plan's own baseline —
    // spelled rather than left implicit, so a fixture that drifted fails on the
    // pinned start instead of quietly asserting a different plan.
    //
    // Three watched reds, each reddening this case alone:
    //
    // - `jointWindowFor`'s multi-pool loop asking `poolIds.slice(0, 1)` — the
    //   second pool never consulted — which answers 4;
    // - the same loop's `window.start > best` flipped to `<`, which is the
    //   other reading of a set ("either pool will do") and also answers 4;
    // - `annotateCapacity`'s `finishesByStart` narrowed from `<= start` to
    //   `=== start`, which keeps only Beta's QA: the set accumulates across the
    //   search's ROUNDS, and Alpha's reservations released at 2 and 4 are as
    //   much a reason this block could not start on day 0 as Beta's is.
    //
    // And two measured negatives, recorded because each looks like a proof this
    // case makes and is not:
    //
    // - `reserve` restricted to `poolIds[0]` leaves all six green. Every tenant
    //   here names ONE pool, so the per-pool WRITE has no second pool to lose;
    //   `pinned` is the only multi-pool block and nothing is placed after it
    //   that its own reservations would hold up. That half of decision 3 is
    //   `schedule-joint-capacity.test.ts`'s, not this file's.
    // - `capacityTeamId` taken as the first sorted BINDING pool also leaves all
    //   six green, and the reason is structural rather than a gap in the
    //   fixture: a pool that had room at the accepted start is not a binding
    //   pool at all, so `window.binding` here is `[BETA]` alone and every
    //   reading of a one-element set agrees. Two pools bind only when both
    //   released at the accepted instant, where their latest valid finishers
    //   tie and the pool-id tie-break is the rule — which is the tied-pool case
    //   in `schedule-joint-capacity.test.ts`. `team-alpha` sorting first still
    //   earns its name here: it is what makes `capacityTeamId: BETA` a claim
    //   about which pool ran out rather than about which id sorts first.
    await directory.addTeam({ id: ALPHA, name: 'Alpha' }, WROTE);
    await directory.addTeam({ id: BETA, name: 'Beta' }, WROTE);
    await capacity.set(projectId, ALPHA, 1, WROTE);
    await capacity.set(projectId, BETA, 1, WROTE);
    const alpha = await leaf('Alpha tenant', 2, ALPHA, 10);
    const beta = await leaf('Beta tenant', 4, BETA, 10);
    const pinned = await multiPoolLeaf('Pinned', 2, [ALPHA, BETA], 90);
    // Its own QA slice moves with it, which is this file's fixture rule: a case
    // states the offsets it moves and `servedBy` fills the rest from the
    // baseline, so a slice left behind would be pinned under its own floor.
    const tree = await servedBy({
      [sliceKey(pinned, stepId)]: units(6),
      [sliceKey(pinned, laterStepId)]: units(8),
    });

    const held = slicedForStep(tree, pinned, stepId);
    expect(held).toMatchObject({
      earliestStart: 6,
      earliestFinish: 8,
      boundBy: 'capacity',
      capacityTeamId: BETA,
    });
    // Alpha's own earliest fit, named so a failure reads as the min-of-the-pools
    // answer it would be rather than as an arbitrary wrong number.
    expect(held.earliestStart).not.toBe(4);
    // Every reservation either pool had to release, which is **all four** of
    // the tenants' slices and not just the two the pools were holding at day 6:
    // the joint search accumulates across its rounds, and Alpha's Dev slice at
    // 0–2 is as much a reason this block could not start on day 0 as its QA
    // slice at 2–4 is a reason it could not start on day 2. Measured; the four
    // are the answer this file states rather than the two a "what was live at
    // the accepted instant" reading would give.
    expect([...held.capacityPredecessorIds].sort()).toEqual(
      [
        slicedForStep(tree, alpha, stepId).id,
        slicedForStep(tree, alpha, laterStepId).id,
        slicedForStep(tree, beta, stepId).id,
        slicedForStep(tree, beta, laterStepId).id,
      ].sort(),
    );
  });
});
