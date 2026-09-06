import { describe, expect, it } from 'bun:test';

import type { DependencyReach } from './dependency-reach';
import type { PlannedRow } from './derive-numbers';
import {
  type DependencyEdge,
  type PoolSizes,
  type Schedule,
  schedule,
  type ScheduledSlice,
  type Slice,
  sliceKey,
} from './schedule';

/**
 * The generated corpus over **resource-constrained** plans — task 9.1 and 9.3.
 *
 * `schedule-identity.test.ts` already runs a thousand generated plans, and it
 * is deliberately blind to everything this file is about: its oracle is the
 * `role-crud` engine, which has no leveller, so every plan it generates carries
 * `personId: null`, no pool, no priority and the default reach
 * (`schedule-identity.test.ts:290-300`). That is not an oversight there — a
 * differential against an engine without resources has to hand both arms a plan
 * without resources. It does mean the five facts the leveller exists for have
 * no generated coverage at all, only the hand-written cases in
 * `schedule-capacity`, `schedule-leveling`, `schedule-priority` and the eight
 * in `fast-golden-corpus.ts`.
 *
 * With no second engine to compare against, this corpus asserts two things
 * instead:
 *
 * 1. **Invariants**, on every seed: nobody is in two places at once, no pool is
 *    oversubscribed, and no manual floor is undercut. These hold for any
 *    correct schedule and need no oracle.
 * 2. **That each fact is actually reached** — for each of people, capacity,
 *    priority, dependency-reach and manual-floor, the same plan is scheduled
 *    twice, once as generated and once with that one fact stripped out, and the
 *    two schedules must disagree on a stated number of seeds. This is the shape
 *    task 9.1 asks for: if the generator stopped emitting the fact, stripping it
 *    would be a no-op, the disagreement count would fall to zero and the case
 *    would go red. A coverage count taken off the generator's own output instead
 *    would only prove the generator wrote the field down, not that the engine
 *    ever read it.
 *
 * Measured on h2puni at `90408467`, seeds 1..1000 — the seeds each fact moves:
 * people 554, capacity 255, priority 461, dependency-reach 239,
 * manual-floor 699.
 *
 * Watched red for all five together, by shadowing `strip` with `undefined`
 * inside `generateResourcePlan` so the stripped plan IS the generated plan and
 * every difference vanishes: 6 pass / 5 fail, the five coverage cases red and
 * the three invariants and the three 9.3 cases still green.
 *
 * Each invariant carries its own observed fault at the assertion it guards, and
 * each of those faults also reddened the 9.3 cases or a coverage case, so no
 * check in this file is one whose failure mode has never been seen.
 */

/** Seeds 1..1000, which is task 9.1's ">=1,000 seeds". */
const SEEDS = 1000;

/**
 * How many seeds a fact has to move before this file believes it is covered.
 *
 * A floor rather than `> 0`: one surviving plan out of a thousand is a corpus
 * that has stopped generating the fact and kept a single accident, which is the
 * state 9.1 exists to prevent. Set well under every measured figure (the
 * tightest is dependency-reach) so ordinary generator drift does not redden it.
 */
const COVERAGE_FLOOR = 50;

const PEOPLE = ['kat', 'ola', 'raj'] as const;
const POOLS = ['alpha', 'beta'] as const;

/** The same LCG `schedule-identity.test.ts:139` uses, so a seed names one plan here too. */
function randomFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

interface ResourcePlan {
  rows: PlannedRow[];
  edges: DependencyEdge[];
  slices: Slice[];
  notBefore: Map<string, number>;
  poolSizes: Map<string, number>;
  reach: DependencyReach;
}

/** The five facts this corpus is about, and the one it is `strip`ped of. */
type Fact = 'people' | 'capacity' | 'priority' | 'dependency-reach' | 'manual-floor';

/**
 * One random resource-constrained plan: a two-level tree, up to two steps a
 * leaf, and every one of the five facts sprinkled over it.
 *
 * Whole-day estimates, unlike `schedule-identity.test.ts`'s PERT thirds. That
 * file's sixths exist to make two arithmetics disagree in the last bits; here
 * there is no second arithmetic, and whole days let the invariants below be
 * exact comparisons rather than epsilon ones.
 *
 * `strip` removes exactly one fact **at generation time** rather than editing a
 * built plan, because the two are not the same thing: dropping `poolIds` from
 * finished slices would leave the pool sizes behind, and a stripped plan has to
 * be the plan a generator that never knew the fact would have produced.
 *
 * **Every draw below is unconditional, and `strip` only ever discards a value
 * that was already drawn.** Skipping the draw instead is the bug the first
 * version of this file shipped: `strip === 'people' || random() > 0.55`
 * short-circuits, the LCG stream diverges from that point on, and the "stripped"
 * plan is a different plan rather than the same one missing a fact. It measured
 * people and capacity at 1000/1000 — a difference count that would have stayed
 * at 1000 against an engine that ignored people and pools entirely, which is the
 * check-that-cannot-fail failure the counts exist to avoid.
 */
function generateResourcePlan(seed: number, strip?: Fact): ResourcePlan {
  const random = randomFrom(seed);
  const pick = <T>(from: readonly T[]): T => from[Math.floor(random() * from.length)];

  const rows: PlannedRow[] = [];
  const roots = 2 + Math.floor(random() * 3);
  for (let r = 0; r < roots; r += 1) {
    const rootId = `r${String(r)}`;
    // A priority on a parent reaches its leaves (`schedule.ts:1732`), so put
    // some up the tree and some on the leaf itself — the two paths differ.
    const hasRootPriority = random() > 0.7;
    const rootPriority = hasRootPriority ? 1 + Math.floor(random() * 3) : null;
    rows.push({
      id: rootId,
      parentId: null,
      position: rows.length * 10,
      frozenNumber: null,
      priority: strip === 'priority' ? null : rootPriority,
    });
    const children = 1 + Math.floor(random() * 3);
    for (let c = 0; c < children; c += 1) {
      const childPriority = random() > 0.6 ? 1 + Math.floor(random() * 4) : null;
      rows.push({
        id: `${rootId}c${String(c)}`,
        parentId: rootId,
        position: rows.length * 10,
        frozenNumber: null,
        priority: strip === 'priority' ? null : childPriority,
      });
    }
  }

  const hasChildren = new Set(rows.map((row) => row.parentId).filter((id) => id !== null));
  const leaves = rows.filter((row) => !hasChildren.has(row.id));

  // Forwards through the row order only, which cannot close a loop, and never
  // onto a descendant — the same two refusals `schedule-identity.test.ts:241`
  // makes, and for the same reasons.
  const edges: DependencyEdge[] = [];
  const wanted = Math.floor(random() * 5);
  for (let e = 0; e < wanted; e += 1) {
    const fromAt = Math.floor(random() * rows.length);
    const toAt = fromAt + 1 + Math.floor(random() * Math.max(1, rows.length - fromAt - 1));
    const from = rows[fromAt];
    const to = rows.at(toAt);
    if (to === undefined || from.id === to.id) continue;
    if (to.parentId === from.id) continue;
    edges.push({ predecessorId: from.id, successorId: to.id });
  }

  // Sized before the slices, so a slice can only ever carry a pool that exists:
  // `schedule()` reserves nothing for a pool absent from this map, and a corpus
  // that carried unsized pools would be generating the no-capacity plan under a
  // capacity-shaped name.
  const drawnSizes = new Map<string, number>();
  for (const pool of POOLS) {
    const sized = random() > 0.35;
    const size = 1 + Math.floor(random() * 2);
    if (sized) drawnSizes.set(pool, size);
  }
  const sizedPools = [...drawnSizes.keys()];
  const poolSizes = strip === 'capacity' ? new Map<string, number>() : drawnSizes;

  const slices: Slice[] = [];
  for (const leaf of leaves) {
    const steps = random() > 0.45 ? ['step-design', 'step-dev'] : ['step-dev'];
    // One person for the whole work item, which is the `assumedAssignee` reading
    // the caller is required to have already made (`schedule.ts:31`); a person
    // resolved per slice would be a second implementation of that rule.
    const assigned = random() <= 0.55;
    const whom = pick(PEOPLE);
    const person = strip === 'people' || !assigned ? null : whom;
    const pooled = random() > 0.4;
    // `pick` on an empty array is `undefined`, so draw against a fixed-length
    // stand-in and resolve afterwards: the draw has to happen whether or not any
    // pool was sized, or a seed that sized none would shift every later draw.
    const which = POOLS[Math.floor(random() * POOLS.length)];
    const pool = strip === 'capacity' || !pooled || !sizedPools.includes(which) ? null : which;
    for (const stepId of steps) {
      slices.push({
        workItemId: leaf.id,
        stepId,
        days: random() > 0.15 ? pick([1, 2, 3, 4]) : null,
        personId: person,
        // Width 1 throughout: the caller drops it to 1 for a named assignee and
        // clamps it to the pool anyway (`schedule.ts:31`), and width is not one
        // of the five facts 9.1 names. Holding it fixed keeps the capacity
        // difference below attributable to the pool rather than to the tiling.
        width: 1,
        poolIds: pool === null ? [] : [pool],
      });
    }
  }

  const notBefore = new Map<string, number>();
  for (const leaf of leaves) {
    const floored = random() > 0.75;
    const floor = 1 + Math.floor(random() * 6);
    if (floored && strip !== 'manual-floor') notBefore.set(leaf.id, floor);
  }

  // `whole-item` is the column's default and therefore what a generator blind to
  // reach produces; stripping the fact is pinning every plan back to it.
  const reach: DependencyReach =
    strip === 'dependency-reach' ? 'whole-item' : seed % 2 === 0 ? 'anchor-slice' : 'whole-item';

  return { rows, edges, slices, notBefore, poolSizes, reach };
}

const scheduleOf = (plan: ResourcePlan): Schedule =>
  schedule(plan.rows, plan.edges, plan.slices, plan.notBefore, plan.poolSizes, plan.reach);

/**
 * What "the same schedule" means for the difference counts below.
 *
 * The dates, the float, the named floor and the resource referent: the fields
 * the leveller **derives**, and not every reader-visible field. Two deliberate
 * omissions, both of which would otherwise inflate a count:
 *
 * - `personId` and `capacityTeamId` are echoes of the plan's own input, so a
 *   stripped arm differs in them whether or not the engine did anything with
 *   the fact — the people and capacity counts would read 1000/1000 again, this
 *   time honestly computed off a dishonest fingerprint.
 * - `Schedule.eventsVisited` is the leveller's own instrumentation
 *   (`schedule.ts:266`) and moves the moment a pool exists at all, so carrying
 *   it would report capacity as covered on plans whose dates never moved a day.
 *
 * `critical` and `latestFinish` are absent because `float` already carries
 * them: `critical` is `float === 0`, and durations are identical between the
 * two arms, so a `latestFinish` that moved moved `latestStart` with it.
 */
const fingerprint = (found: Schedule): string =>
  [...found.slices.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(
      ([key, s]) =>
        `${key}|${String(s.earliestStart)}|${String(s.earliestFinish)}|${String(s.latestStart)}|${String(s.float)}|${s.boundBy}|${s.resourcePredecessorId ?? ''}`,
    )
    .join('\n');

/**
 * The thousand unstripped schedules, computed once.
 *
 * The generated arm does not depend on which fact is being stripped, and
 * `it.each` calls {@link seedsMovedBy} five times — recomputing it per fact is
 * 5,000 schedule runs for 1,000 distinct answers.
 */
const AS_GENERATED: readonly string[] = Array.from({ length: SEEDS }, (_, i) =>
  fingerprint(scheduleOf(generateResourcePlan(i + 1))),
);

/** How many of the thousand seeds `fact` moves the schedule of. */
const seedsMovedBy = (fact: Fact): number => {
  let moved = 0;
  for (let seed = 1; seed <= SEEDS; seed += 1) {
    const stripped = fingerprint(scheduleOf(generateResourcePlan(seed, fact)));
    if (AS_GENERATED[seed - 1] !== stripped) moved += 1;
  }
  return moved;
};

describe('resource corpus — every generated fact reaches the schedule', () => {
  // One `it` per fact rather than a loop over the five: a loop reports "the
  // corpus" red and leaves the reader to find which fact stopped being
  // generated, and the whole point of 9.1 is naming the one that went missing.
  it.each<[Fact]>([['people'], ['capacity'], ['priority'], ['dependency-reach'], ['manual-floor']])(
    '%s changes the schedule of enough of the thousand plans',
    (fact) => {
      expect(seedsMovedBy(fact)).toBeGreaterThanOrEqual(COVERAGE_FLOOR);
    },
  );
});

/** Every slice with real duration, as an interval, for the invariants. */
const busy = (found: Schedule): ScheduledSlice[] =>
  [...found.slices.values()].filter((s) => s.earliestFinish > s.earliestStart);

const overlaps = (a: ScheduledSlice, b: ScheduledSlice): boolean =>
  a.earliestStart < b.earliestFinish && b.earliestStart < a.earliestFinish;

describe('resource corpus — invariants over a thousand resource-constrained plans', () => {
  it('never puts one person in two places at once', () => {
    // Proof, from the failure output: the `busyUntil.set(personId, …)` write at
    // `schedule.ts:1676` deleted, so the leveller never records that an assignee
    // is occupied. This went red with `"seed 3: raj on two slices"`, taking the
    // `people` coverage case with it — 9 pass / 2 fail.
    //
    // The obvious fault does NOT reach here, which is why it is not the one
    // recorded: assigning `personId` per slice rather than per work item leaves
    // this green, because `schedule()` serialises every slice sharing a person
    // whoever put them there. A comment claiming that fault would have named an
    // assertion the fault never reaches.
    const clashes: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const running = busy(scheduleOf(generateResourcePlan(seed)));
      for (let i = 0; i < running.length; i += 1) {
        for (let j = i + 1; j < running.length; j += 1) {
          const [a, b] = [running[i], running[j]];
          if (a.personId === null || a.personId !== b.personId) continue;
          if (overlaps(a, b)) clashes.push(`seed ${String(seed)}: ${a.personId} on two slices`);
        }
      }
    }

    expect(clashes).toEqual([]);
  });

  it('never runs more slices in a pool than the pool holds', () => {
    // Proof: the leveling pass at `schedule.ts:2334` handed every pool widened
    // to 99 instead of its real size. Red here, and with it the `capacity`
    // coverage case and the 9.3 slip case — 8 pass / 3 fail.
    const over: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const plan = generateResourcePlan(seed);
      const running = busy(scheduleOf(plan));
      const poolOf = new Map(
        plan.slices.map((s) => [sliceKey(s.workItemId, s.stepId), s.poolIds] as const),
      );
      for (const [pool, size] of plan.poolSizes) {
        const inPool = running.filter((s) =>
          (poolOf.get(sliceKey(s.workItemId, s.stepId)) ?? []).includes(pool),
        );
        // Sampled at every start: occupancy only ever rises at one, so a window
        // that breaches the size has to breach it at the start that opened it.
        for (const at of inPool.map((s) => s.earliestStart)) {
          const held = inPool.filter((s) => s.earliestStart <= at && at < s.earliestFinish).length;
          if (held > size)
            over.push(`seed ${String(seed)}: ${pool} held ${String(held)} of ${String(size)}`);
        }
      }
    }

    expect(over).toEqual([]);
  });

  it('never starts a work item before its own manual floor', () => {
    // Proof: `leafFloors` at `schedule.ts:2135` replaced with an empty map, so
    // the engine is handed the plan's floors and forgets them. Red here, and
    // with it the `manual-floor` coverage case and two of the three 9.3 cases —
    // 7 pass / 4 fail.
    const early: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const plan = generateResourcePlan(seed);
      const found = scheduleOf(plan);
      for (const [workItemId, floor] of plan.notBefore) {
        const item = found.workItems.get(workItemId);
        // A throw rather than a `continue`: every id in `notBefore` is a leaf of
        // `plan.rows`, so the engine owes a projection for each of them. Skipping
        // the miss would turn "the engine dropped a floored work item" into a
        // pass, which is the check that cannot fail.
        if (item === undefined)
          throw new Error(`seed ${String(seed)}: ${workItemId} missing from the schedule`);
        if (item.earliestStart < floor)
          early.push(
            `seed ${String(seed)}: ${workItemId} at ${String(item.earliestStart)} under ${String(floor)}`,
          );
      }
    }

    expect(early).toEqual([]);
  });
});

/**
 * Task 9.3: the capacity/floor hand-off audit finding, pinned as a corpus case
 * that is asserted to **still reproduce**.
 *
 * The finding: a capacity hand-off is not promoted into the backward graph
 * (`schedule.ts:1341-1350` keeps a capacity predecessor out of it when the
 * blocker does not finish by the accepted start, and no hand-off edge is added
 * for the plain case either), so the backward pass never learns that `a` is
 * holding the only slot `b` needs. `a` has no successor, takes the project
 * finish as its late finish, and reports two days of float it does not have —
 * slipping `a` by a day pushes `b` by a day.
 *
 * It is knowingly open: `dual-optimized-scheduler`'s design records "no fix to
 * the known capacity/floor hand-off audit finding" (`design.md:18`). This case
 * exists so that stays a decision rather than a drift. If the optimizer's
 * re-validation, or any later change, quietly fixes or quietly worsens it, this
 * goes red and somebody has to say which — a corpus that only pinned the fixed
 * behaviour would have let the masked case through silently, which is exactly
 * what 9.3 forbids.
 *
 * **Read the direction of this test before editing it.** A red here is not
 * automatically a regression: if `float` on `a` becomes 0 the finding has been
 * FIXED, and the right move is to close it in the design and replace this case
 * with the fixed expectation, not to restore the false float.
 */
describe('resource corpus — the capacity/floor hand-off finding still reproduces', () => {
  const leaf = (id: string, position: number): PlannedRow => ({
    id,
    parentId: null,
    position,
    frozenNumber: null,
    priority: null,
  });
  const held = (workItemId: string, days: number): Slice => ({
    workItemId,
    stepId: 'step-dev',
    days,
    personId: null,
    width: 1,
    poolIds: ['team'],
  });

  /** Capacity 1; `a` 0→2; `b` floored at 2 and therefore 2→4. */
  const handOff = (): Schedule =>
    schedule(
      [leaf('a', 10), leaf('b', 20)],
      [],
      [held('a', 2), held('b', 2)],
      new Map([['b', 2]]),
      new Map([['team', 1]]) satisfies PoolSizes,
    );

  it('places the two either side of the floor, in the one slot', () => {
    const found = handOff();

    expect(found.workItems.get('a')).toMatchObject({ earliestStart: 0, earliestFinish: 2 });
    expect(found.workItems.get('b')).toMatchObject({ earliestStart: 2, earliestFinish: 4 });
  });

  it('STILL reports two days of float on the slice that cannot slip', () => {
    const found = handOff();

    // The false float, kept as the finding says it is. `a` holds the pool's only
    // slot until day 2 and `b`'s floor is day 2, so a day of slip on `a` is a
    // day of slip on `b` and the real float is zero.
    expect(found.workItems.get('a')).toMatchObject({ float: 2, critical: false });
  });

  it('is false float rather than real slack: moving `a` later moves `b`', () => {
    // The proof that the two above are a defect and not a preference. If `a`
    // really had two days of room, floor `a` at 2 and `b` would still finish on
    // day 4. It does not — `b` goes to 4→6 and the project grows by the float
    // the schedule just claimed was free.
    const slipped = schedule(
      [leaf('a', 10), leaf('b', 20)],
      [],
      [held('a', 2), held('b', 2)],
      new Map([
        ['a', 2],
        ['b', 2],
      ]),
      new Map([['team', 1]]),
    );

    // `a` really did take the slip the float offered — asserted rather than
    // assumed, or `b` moving would be evidence about some other plan.
    expect(slipped.workItems.get('a')).toMatchObject({ earliestStart: 2, earliestFinish: 4 });
    expect(slipped.workItems.get('b')).toMatchObject({ earliestStart: 4, earliestFinish: 6 });
  });
});
