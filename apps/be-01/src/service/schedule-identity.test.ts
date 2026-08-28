import { describe, expect, it } from 'bun:test';

import type { WorkItem } from '../repository';
import {
  type DependencyEdge,
  expandToLeaves,
  indexTree,
  schedule,
  type Scheduled,
  type Slice,
  sliceKey,
} from './schedule';

/**
 * The engine as it stood at `role-crud` (2026-08-08), kept as the oracle the
 * slice engine is measured against.
 *
 * Copied rather than imported because it no longer exists: the point of this
 * file is that the numbers the previous engine produced are the numbers the new
 * one produces, for every plan that has no resource constraint — which, until
 * leveling arrives, is every plan there is. A reasoned argument that they agree
 * is not the same thing as a thousand plans through both.
 *
 * Only the pass itself is copied. `indexTree` and `expandToLeaves` are imported,
 * because they are unchanged and a second copy of them would let this file pass
 * against a tree the real one no longer builds.
 */
function previousSchedule(
  rows: readonly WorkItem[],
  edges: readonly DependencyEdge[],
  durations: ReadonlyMap<string, number>,
  notBefore: ReadonlyMap<string, number> = new Map(),
): Map<string, Scheduled> {
  const index = indexTree(rows);
  const { leafIds } = index;
  const isLeaf = new Set(leafIds);
  const leafEdges = expandToLeaves(index, edges);

  const incoming = new Map(leafIds.map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const { predecessorId, successorId } of leafEdges) {
    outgoing.set(predecessorId, [...(outgoing.get(predecessorId) ?? []), successorId]);
    incoming.set(successorId, (incoming.get(successorId) ?? 0) + 1);
  }
  const ready = leafIds.filter((id) => incoming.get(id) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift();
    if (id === undefined) break;
    order.push(id);
    for (const next of outgoing.get(id) ?? []) {
      const left = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, left);
      if (left === 0) ready.push(next);
    }
  }
  if (order.length !== leafIds.length) throw new Error('cycle');

  const predecessorsOf = new Map<string, string[]>();
  const successorsOf = new Map<string, string[]>();
  for (const { predecessorId, successorId } of leafEdges) {
    predecessorsOf.set(successorId, [...(predecessorsOf.get(successorId) ?? []), predecessorId]);
    successorsOf.set(predecessorId, [...(successorsOf.get(predecessorId) ?? []), successorId]);
  }

  const durationOf = (id: string): number => durations.get(id) ?? 0;
  const earliestStart = new Map<string, number>();
  const earliestFinish = new Map<string, number>();
  for (const id of order) {
    const start = Math.max(
      0,
      notBefore.get(id) ?? 0,
      ...(predecessorsOf.get(id) ?? []).map((p) => earliestFinish.get(p) ?? 0),
    );
    earliestStart.set(id, start);
    earliestFinish.set(id, start + durationOf(id));
  }

  const projectFinish = Math.max(0, ...leafIds.map((id) => earliestFinish.get(id) ?? 0));
  const latestFinish = new Map<string, number>();
  const latestStart = new Map<string, number>();
  for (const id of [...order].reverse()) {
    const successors = successorsOf.get(id) ?? [];
    const finish =
      successors.length === 0
        ? projectFinish
        : Math.min(...successors.map((s) => latestStart.get(s) ?? projectFinish));
    latestFinish.set(id, finish);
    latestStart.set(id, finish - durationOf(id));
  }

  const scheduled = new Map<string, Scheduled>();
  for (const id of leafIds) {
    const start = earliestStart.get(id) ?? 0;
    const late = latestStart.get(id) ?? 0;
    scheduled.set(id, {
      duration: durationOf(id),
      estimated: durations.has(id),
      earliestStart: start,
      earliestFinish: earliestFinish.get(id) ?? 0,
      latestStart: late,
      latestFinish: latestFinish.get(id) ?? 0,
      float: late - start,
      critical: late - start === 0,
    });
  }

  for (const row of rows) {
    if (isLeaf.has(row.id)) continue;
    const beneath = (index.leavesUnder.get(row.id) ?? [])
      .map((id) => scheduled.get(id))
      .filter((s): s is Scheduled => s !== undefined);
    const starts = beneath.map((s) => s.earliestStart);
    const finishes = beneath.map((s) => s.earliestFinish);
    const spanStart = Math.min(...starts, Infinity) === Infinity ? 0 : Math.min(...starts);
    const spanFinish = Math.max(0, ...finishes);
    scheduled.set(row.id, {
      duration: 0,
      estimated: beneath.some((s) => s.estimated),
      earliestStart: spanStart,
      earliestFinish: spanFinish,
      latestStart: Math.min(...beneath.map((s) => s.latestStart), spanStart),
      latestFinish: Math.max(0, ...beneath.map((s) => s.latestFinish)),
      float:
        Math.min(...beneath.map((s) => s.float), Infinity) === Infinity
          ? 0
          : Math.min(...beneath.map((s) => s.float)),
      critical: beneath.some((s) => s.critical),
    });
  }
  return scheduled;
}

/** A seeded generator, so a plan that disagrees can be reproduced from its seed alone. */
function randomFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const PERT = (optimistic: number, realistic: number, pessimistic: number): number =>
  (optimistic + 4 * realistic + pessimistic) / 6;

/** One work item's estimate for one role, before either engine has been given it. */
interface EstimateRow {
  workItemId: string;
  roleId: string;
  days: number | null;
}

interface GeneratedPlan {
  rows: WorkItem[];
  edges: DependencyEdge[];
  /** In role order, which is the order both the repository and the adapter hand them over in. */
  estimates: EstimateRow[];
  notBefore: Map<string, number>;
}

/**
 * One random plan: a tree up to three deep, dependencies between the rows that
 * can take them, `roleCount` roles, PERT figures, and a few manual floors.
 *
 * The estimates are PERT thirds on purpose. Whole days would agree through any
 * arithmetic; the sixths are what make the difference between adding a work
 * item's roles up first and accumulating them one slice at a time visible in
 * the last bits.
 *
 * It hands back the estimates rather than the two engines' inputs, and the two
 * are derived separately below. Building both in one loop is how the first
 * version of this file made the sums agree by construction — the old engine was
 * handed a total added up in exactly the order the slices were made in, which is
 * the one order it was guaranteed to match.
 */
function generatePlan(seed: number, roleCount: number): GeneratedPlan {
  const random = randomFrom(seed);
  const pick = <T>(from: readonly T[]): T => from[Math.floor(random() * from.length)];
  const roleIds = Array.from({ length: roleCount }, (_, i) => `role-${String(i)}`);

  const rows: WorkItem[] = [];
  const newRow = (id: string, parentId: string | null): WorkItem => ({
    id,
    projectId: 'p1',
    parentId,
    position: rows.length * 10,
    name: id,
    notes: '',
    frozenNumber: null,
    priority: null,
    startNoEarlierThan: null,
    serviceTeamId: null,
    serviceId: null,
    maxParallel: 1,
    revision: 0,
  });
  const roots = 2 + Math.floor(random() * 4);
  for (let r = 0; r < roots; r += 1) {
    const rootId = `r${String(r)}`;
    rows.push(newRow(rootId, null));
    const children = Math.floor(random() * 3);
    for (let c = 0; c < children; c += 1) {
      const childId = `${rootId}c${String(c)}`;
      rows.push(newRow(childId, rootId));
      const grandchildren = Math.floor(random() * 2);
      for (let g = 0; g < grandchildren; g += 1) {
        rows.push(newRow(`${childId}g${String(g)}`, childId));
      }
    }
  }

  // Edges strictly forwards through the row order, which cannot close a loop —
  // a cycle is a refusal in both engines and proves nothing about their numbers.
  const edges: DependencyEdge[] = [];
  const wanted = Math.floor(random() * 6);
  for (let e = 0; e < wanted; e += 1) {
    const fromAt = Math.floor(random() * rows.length);
    const toAt = fromAt + 1 + Math.floor(random() * Math.max(1, rows.length - fromAt - 1));
    const from = rows[fromAt];
    // `.at`, not `[]`: `toAt` can run past the end, and the index signature
    // would type the miss as a row rather than as the `undefined` it is.
    const to = rows.at(toAt);
    if (to === undefined || from.id === to.id) continue;
    // Not onto its own descendant: the write path refuses those, and the
    // expansion would put a leaf in front of itself.
    if (to.parentId === from.id || rows.find((row) => row.id === to.parentId)?.parentId === from.id)
      continue;
    edges.push({ predecessorId: from.id, successorId: to.id });
  }

  const hasChildren = new Set(rows.map((row) => row.parentId).filter((id) => id !== null));
  const estimates: EstimateRow[] = [];
  for (const row of rows) {
    if (hasChildren.has(row.id)) continue;
    for (const roleId of roleIds) {
      const estimated = random() > 0.25;
      const days = estimated
        ? PERT(pick([0, 1, 2, 3]), pick([1, 2, 3, 5, 8]), pick([2, 4, 7, 9, 13]))
        : null;
      estimates.push({ workItemId: row.id, roleId, days });
    }
  }

  const notBefore = new Map<string, number>();
  for (const row of rows) {
    if (hasChildren.has(row.id)) continue;
    if (random() > 0.85) notBefore.set(row.id, Math.floor(random() * 8));
  }

  return { rows, edges, estimates, notBefore };
}

/**
 * What the adapter builds: one slice per pair, in role order, unestimated ones
 * included — and nobody on any of them.
 *
 * The `personId` is the second half of what this file proves. Leveling is on
 * for every plan, so these thousand go through the levelled engine rather than
 * around it; with nobody assigned there is no queue, no resource edge and no
 * tight-path rule, and the numbers have to be the ones the previous engine
 * produced. Watched: with `?? 'nobody'` here, so that unassigned slices share
 * one person, the differential fails at seed 1.
 */
const slicesFrom = (plan: GeneratedPlan): Slice[] =>
  plan.estimates.map((each) => ({
    workItemId: each.workItemId,
    roleId: each.roleId,
    days: each.days,
    personId: null,
    // Width 1 on no pool, which is the state this whole corpus is about: a
    // plan that sets neither capacity field must schedule byte for byte as it
    // did before either existed.
    width: 1,
    poolIds: [],
  }));

/**
 * What the previous engine's adapter built: one total per leaf, summed in the
 * order the estimate rows arrived in.
 *
 * `shuffle` is the point of this function existing. Before this change nothing
 * ordered `EstimateRepository.listByProject`, so the order was SQLite's to
 * choose, and a total is a chain of floating-point additions whose result
 * depends on it. Handing the old engine a **differently ordered** sum is what
 * makes the identity claim a claim about the plan rather than about the loop
 * that built the test.
 */
function durationsFrom(plan: GeneratedPlan, shuffle: boolean, seed: number): Map<string, number> {
  const random = randomFrom(seed * 7919 + 13);
  const perWorkItem = new Map<string, number[]>();
  for (const each of plan.estimates) {
    if (each.days === null) continue;
    const held = perWorkItem.get(each.workItemId);
    if (held === undefined) perWorkItem.set(each.workItemId, [each.days]);
    else held.push(each.days);
  }

  const durations = new Map<string, number>();
  for (const [workItemId, days] of perWorkItem) {
    const addends = [...days];
    if (shuffle) {
      for (let i = addends.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        const held = addends[i];
        addends[i] = addends[j];
        addends[j] = held;
      }
    }
    let total = 0;
    for (const each of addends) total += each;
    durations.set(workItemId, total);
  }
  return durations;
}

/**
 * The one field this engine deliberately no longer answers verbatim: slack,
 * with drift inside `@wbs/domain`'s 1e-9 window snapped to the whole number it
 * is a drifted reading of.
 *
 * Copied from `schedule.ts`'s `slackOf` rather than imported, for the reason
 * the oracle above is copied: a differential that calls the code under test to
 * decide what the code under test should say cannot see that code change. Two
 * lines, and the day they stop matching is a red run here.
 *
 * The old engine reported a raw `latestStart - earliestStart`, so on every plan
 * whose finish is a chain of PERT sixths its critical rows came back with a
 * float of about ±1.8e-15 and no red — cloud case A1, and the defect
 * `critical-snap` fixes. Applying the same snap to the oracle's answer is what
 * keeps this file a claim about the **engine** rather than about the drift:
 * every other field is still `toBe`-exact, and any difference in slack larger
 * than a snapped bit still fails.
 */
const snappedSlack = (slack: number): number => {
  const whole = Math.round(slack);
  const snapped = Math.abs(slack - whole) < 1e-9 ? whole : slack;
  return snapped === 0 ? 0 : snapped;
};

/**
 * Every field of every row, `toBe`-equal, or a throw naming the seed and the
 * two numbers — with `float` and `critical` read off the oracle's answer put
 * through {@link snappedSlack}, which is the whole of what this change moved.
 *
 * `critical` is derived from the snapped float rather than taken from the
 * oracle because the two are one fact. For a leaf that is immediate: the
 * oracle's `critical` **is** its own raw `float === 0` (line 103), so a leaf
 * whose 1.8e-15 became 0 is a leaf that became red. A parent's is
 * `beneath.some((s) => s.critical)` (line 127) rather than a comparison of its
 * own float — but its float is the least of those same leaves', so it snaps to
 * 0 exactly when one of them does, and the derived answer lands on the rows the
 * oracle would have marked either way.
 *
 * Reading it any other way would let the assertion pass on a plan where the
 * new engine paints slack red or leaves a tight row white.
 */
function expectSameSchedule(
  seed: number,
  expected: ReadonlyMap<string, Scheduled>,
  found: ReadonlyMap<string, Scheduled>,
): void {
  expect(found.size).toBe(expected.size);
  for (const [id, was] of expected) {
    const now = found.get(id);
    if (now === undefined) throw new Error(`seed ${String(seed)}: ${id} lost its schedule`);
    const slack = snappedSlack(was.float);
    const owed: Scheduled = { ...was, float: slack, critical: slack === 0 };
    for (const field of Object.keys(owed) as (keyof Scheduled)[]) {
      if (now[field] === owed[field]) continue;
      throw new Error(
        `seed ${String(seed)}, ${id}.${field}: ${String(owed[field])} became ${String(now[field])}`,
      );
    }
  }
}

/** `Dev` and `QA`: the most roles any project in a released database can hold. */
const RELEASED_ROLES = 2;

describe('the slice engine against the one it replaced', () => {
  it('answers what it answered for a two-role plan, however the old sum was ordered', () => {
    // The change's central claim, at the size every project that already exists
    // is: two roles, because `role-crud` and this change ship in the same
    // release train and nothing before them could write a third.
    //
    // The old engine is handed its totals **shuffled**, because nothing ordered
    // the estimate read it built them from. Two addends make that harmless —
    // IEEE addition commutes, so `a + b` is `b + a` to the bit — and this is
    // that argument executed rather than asserted.
    //
    // Every field `toBe`-equal, not `toBeCloseTo`: slack is a column and
    // `critical` is a red row, and both are read off exact comparisons with zero.
    //
    // Narrowed 2026-08-11 (`dep-waits-on-first-role`): the generated edges are
    // dropped from both engines. A dependency now waits on the predecessor's
    // anchor slice, so a multi-role plan with dependencies moves **by design**
    // and parity with the whole-item oracle holds only where the two rules
    // coincide — no dependencies here, edges kept in the single-role run below
    // (design.md D7). The anchor rule has direct tests instead:
    // `schedule-shapes.test.ts`, and the growth property at the end of this
    // block.
    for (let seed = 1; seed <= 1000; seed += 1) {
      const plan = generatePlan(seed, RELEASED_ROLES);
      const durations = durationsFrom(plan, true, seed);
      const expected = previousSchedule(plan.rows, [], durations, plan.notBefore);
      const found = schedule(plan.rows, [], slicesFrom(plan), plan.notBefore).workItems;

      expectSameSchedule(seed, expected, found);
    }
  });

  it('answers what it answered for a three-role plan summed in role order', () => {
    // Three roles are reachable the moment this release lands, and for three
    // addends the order is no longer free: association is not commutation. So
    // the order is **defined** — `EstimateRepository.listByProject` orders by
    // role position and the adapter slices in the same order — and this is that
    // definition held to: the same estimates, added up the way the repository
    // now hands them over, come out the same on both sides.
    //
    // Narrowed 2026-08-11 (`dep-waits-on-first-role`): edges dropped, for the
    // two-role run's reason — three roles with a dependency is exactly the
    // shape the anchor rule moves on purpose.
    for (let seed = 1; seed <= 1000; seed += 1) {
      const plan = generatePlan(seed, 3);
      const durations = durationsFrom(plan, false, seed);
      const expected = previousSchedule(plan.rows, [], durations, plan.notBefore);
      const found = schedule(plan.rows, [], slicesFrom(plan), plan.notBefore).workItems;

      expectSameSchedule(seed, expected, found);
    }
  });

  it('answers what it answered for a single-role plan, edges and all', () => {
    // The one multi-row scope where the anchor rule and the whole-item rule
    // are the same rule: with one role the first slice *is* the last slice, so
    // the edges stay in and every number still has to match the oracle to the
    // bit (2026-08-11, design.md D7). One addend per work item makes the
    // shuffle moot, so the totals are summed as they arrived.
    for (let seed = 1; seed <= 1000; seed += 1) {
      const plan = generatePlan(seed, 1);
      const durations = durationsFrom(plan, false, seed);
      const expected = previousSchedule(plan.rows, plan.edges, durations, plan.notBefore);
      const found = schedule(plan.rows, plan.edges, slicesFrom(plan), plan.notBefore).workItems;

      expectSameSchedule(seed, expected, found);
    }
  });

  it('answers what it answered with a sized team labelling every row', () => {
    // The `hasResourceEdges` scoping, over the corpus rather than over a
    // fixture. A team sized far past anything the plan can ask of it never
    // contends, so it emits no capacity edge, so the backward pass must run
    // with the tight-path rule **off** — exactly as it does on a plan with no
    // team in it at all — and every last bit has to be the one the unpooled run
    // produced.
    //
    // It is here rather than in `schedule-capacity.test.ts` because a
    // three-block fixture cannot carry the drift the rule exists to keep out:
    // an earlier fixture-sized version of this check was watched staying green
    // with the scoping deliberately widened to "a pool exists", which is what
    // makes a corpus the only honest place for it.
    //
    // The comparison is this engine against itself — pooled versus not — rather
    // than against the oracle, because that is the claim: turning a team's size
    // on cannot move a plan the size never binds. `eventsVisited` is left out
    // of it and only out of it, because it is instrumentation about the search
    // and not a fact about the schedule; the pooled run really does visit
    // events, and asserting it did not would be asserting the pool was never
    // consulted.
    //
    // Proof: `hasResourceEdges` read as `poolSizes.size > 0 ||
    // queues.some(...)` instead of from the edges actually emitted, and this
    // failed at seed 13 — `r0c0g0 role-0.latestFinish` came back
    // 2.8333333333333335 where 2.833333333333334 was owed, a row whose late
    // times moved because a team nobody contended for was merely sized;
    // watched 2026-08-12.
    const PLATFORM = 'team-platform';
    for (let seed = 1; seed <= 1000; seed += 1) {
      const plan = generatePlan(seed, RELEASED_ROLES);
      const bare = schedule(plan.rows, [], slicesFrom(plan), plan.notBefore);
      const labelled = plan.rows.map((row) => ({ ...row, serviceTeamId: PLATFORM }));
      const pooled = schedule(
        labelled,
        [],
        slicesFrom(plan).map((each) => ({ ...each, poolIds: [PLATFORM] })),
        plan.notBefore,
        new Map([[PLATFORM, 1000]]),
      );

      expectSameSchedule(seed, bare.workItems, pooled.workItems);
      expect(pooled.waitingForPerson).toBe(bare.waitingForPerson);
      expect(pooled.waitingForCapacity).toBe(0);
      // Every field of every slice, not only the projection: the projection is
      // a minimum over slices and can hide a slice that moved under one that
      // did not.
      expect(pooled.slices.size).toBe(bare.slices.size);
      for (const [key, was] of bare.slices) {
        const now = pooled.slices.get(key);
        if (now === undefined) throw new Error(`seed ${String(seed)}: ${key} lost its slice`);
        for (const field of Object.keys(was) as (keyof typeof was)[]) {
          if (field === 'capacityPredecessorIds') {
            expect(now.capacityPredecessorIds, `seed ${String(seed)}, ${key}`).toEqual([]);
            continue;
          }
          if (now[field] === was[field]) continue;
          throw new Error(
            `seed ${String(seed)}, ${key}.${field}: ` +
              `${String(was[field])} became ${String(now[field])}`,
          );
        }
      }
    }
  });

  it('holds plans the snap actually moves, so the comparison is not the old one in disguise', () => {
    // `expectSameSchedule` puts the oracle's slack through `snappedSlack`
    // before comparing it. If no plan in the corpus carried drifted slack that
    // would be a no-op, and the two tests above would still be green having
    // proved nothing about `critical-snap` — the shape R5 exists to stop. This
    // counts the rows where the old engine's raw slack and its snapped reading
    // differ, and the subset of those where the row changes colour.
    //
    // Both counts are asserted nonzero rather than pinned to a figure: the
    // exact number is the generator's, and pinning it would make an unrelated
    // change to the corpus look like a regression here.
    let drifted = 0;
    let turnedRed = 0;
    for (let seed = 1; seed <= 1000; seed += 1) {
      const plan = generatePlan(seed, RELEASED_ROLES);
      const durations = durationsFrom(plan, true, seed);
      for (const was of previousSchedule(
        plan.rows,
        plan.edges,
        durations,
        plan.notBefore,
      ).values()) {
        const slack = snappedSlack(was.float);
        if (slack === was.float) continue;
        drifted += 1;
        if (slack === 0 && !was.critical) turnedRed += 1;
      }
    }

    expect(drifted).toBeGreaterThan(0);
    expect(turnedRed).toBeGreaterThan(0);
  });

  it('never moves a successor when a predecessor’s later slices grow', () => {
    // The property the whole-item rule could never satisfy, and the new rule's
    // whole point: a successor waits on its predecessors' anchors alone, so
    // doubling every predecessor's non-first slice — QA grown everywhere — may
    // move late starts and floats, and must move no successor's start.
    //
    // Proof: with `anchorNode` in `schedule.ts` set to the leaf's **last**
    // node — the whole-item rule this change replaced — this failed at seed 3,
    // `r1c0 moved from 8.666666666666666 to 11.333333333333332 when only later
    // slices grew`, and alone: the narrowed parity runs above cannot see the
    // revert, which is exactly why this test exists. Watched 2026-08-11 and
    // re-watched against the estimated-anchor walk the same day.
    let grownPlans = 0;
    for (let seed = 1; seed <= 1000; seed += 1) {
      const plan = generatePlan(seed, RELEASED_ROLES);
      if (plan.edges.length === 0) continue;
      const index = indexTree(plan.rows);
      const predecessorLeaves = new Set(
        plan.edges.flatMap((each) => index.leavesUnder.get(each.predecessorId) ?? []),
      );
      const successorLeaves = new Set(
        plan.edges.flatMap((each) => index.leavesUnder.get(each.successorId) ?? []),
      );
      // `estimates` is in role order within each work item, so the first
      // **estimated** entry per leaf is its anchor slice — the one that must
      // keep its days. The unestimated entries in front of it are not anchors
      // and have no days to double anyway, so the walk is the engine's own
      // (`schedule.ts`: `own.findIndex((slice) => slice.days !== null)`) with
      // the `null` case falling out for free.
      const anchorSeen = new Set<string>();
      const grown: Slice[] = plan.estimates.map((each) => {
        const anchor = each.days !== null && !anchorSeen.has(each.workItemId);
        if (anchor) anchorSeen.add(each.workItemId);
        const doubled =
          !anchor && predecessorLeaves.has(each.workItemId) && each.days !== null
            ? each.days * 2
            : each.days;
        return {
          workItemId: each.workItemId,
          roleId: each.roleId,
          days: doubled,
          personId: null,
          width: 1,
          poolIds: [],
        };
      });
      if (grown.every((slice, at) => slice.days === plan.estimates[at].days)) continue;
      grownPlans += 1;

      const before = schedule(plan.rows, plan.edges, slicesFrom(plan), plan.notBefore).workItems;
      const after = schedule(plan.rows, plan.edges, grown, plan.notBefore).workItems;
      for (const id of successorLeaves) {
        const was = before.get(id)?.earliestStart;
        const now = after.get(id)?.earliestStart;
        if (now !== was) {
          throw new Error(
            `seed ${String(seed)}: ${id} moved from ${String(was)} to ${String(now)} ` +
              `when only later slices grew`,
          );
        }
      }
    }
    // The corpus half: a green run over plans nothing grew in would prove
    // nothing at all.
    expect(grownPlans).toBeGreaterThan(500);
  });

  it('holds the anchor rule’s own invariants over every multi-role plan with edges', () => {
    // What the narrowing cost, paid back. Parity with the whole-item oracle was
    // the only thing this corpus proved about multi-role plans *with*
    // dependencies, and this change had to drop it — the two engines disagree
    // there on purpose. The corpus itself is not the loss; it is a thousand
    // trees, floors and edge sets nothing else in the suite generates. So the
    // same plans run through the same generator, checked against the new rule's
    // own invariants instead of against an engine that no longer agrees:
    //
    //   1. every successor starts no earlier than the **latest anchor finish**
    //      among its predecessors — the rule itself, over every expanded edge;
    //   2. no slice carries negative float, which is what a backward pass that
    //      lost track of the new edges would produce;
    //   3. every leaf's projection spans its slices exactly.
    //
    // Read off `plan.estimates`, which is in role order per work item, so the
    // expected anchor is found the way `schedule.ts` finds it and not by
    // asking the engine where it put one.
    //
    // Proof: `anchorNode` set to the leaf's first node — the first slice
    // plain, this change's own predecessor — and this failed at seed 21,
    // `r1 starts 0, before r0's anchor finishes at 1.1666666666666667`;
    // watched 2026-08-11.
    let edgesChecked = 0;
    let walkedPast = 0;
    for (let seed = 1; seed <= 1000; seed += 1) {
      const plan = generatePlan(seed, RELEASED_ROLES);
      if (plan.edges.length === 0) continue;
      const index = indexTree(plan.rows);
      const found = schedule(plan.rows, plan.edges, slicesFrom(plan), plan.notBefore);

      const anchorRoleOf = new Map<string, string | null>();
      for (const each of plan.estimates) {
        if (each.days === null || anchorRoleOf.has(each.workItemId)) continue;
        anchorRoleOf.set(each.workItemId, each.roleId);
      }
      const anchorFinishOf = (leafId: string): number => {
        const roleId = anchorRoleOf.get(leafId);
        // Nothing estimated: the walk falls through to the work item's finish.
        if (roleId === undefined) {
          const row = found.workItems.get(leafId);
          if (row === undefined) throw new Error(`${leafId} lost its schedule`);
          return row.earliestFinish;
        }
        const anchor = found.slices.get(sliceKey(leafId, roleId));
        if (anchor === undefined) throw new Error(`${leafId} lost its anchor slice`);
        return anchor.earliestFinish;
      };

      for (const { predecessorId, successorId } of expandToLeaves(index, plan.edges)) {
        edgesChecked += 1;
        // The predecessor's first slice in role order carries no estimate, so
        // the anchor is not it and the walk had to step over something.
        if (plan.estimates.find((each) => each.workItemId === predecessorId)?.days === null) {
          walkedPast += 1;
        }
        const successor = found.workItems.get(successorId);
        if (successor === undefined) throw new Error(`${successorId} lost its schedule`);
        const owed = anchorFinishOf(predecessorId);
        // Not `toBe`: these are PERT sixths and the comparison is an
        // inequality, so the tolerance is the arithmetic's own and nothing is
        // being rounded away.
        if (successor.earliestStart < owed - 1e-9) {
          throw new Error(
            `seed ${String(seed)}: ${successorId} starts ${String(successor.earliestStart)}, ` +
              `before ${predecessorId}'s anchor finishes at ${String(owed)}`,
          );
        }
      }

      for (const [key, placed] of found.slices) {
        if (placed.float < -1e-9) {
          throw new Error(`seed ${String(seed)}: ${key} carries float ${String(placed.float)}`);
        }
      }

      for (const leafId of index.leafIds) {
        const own = plan.estimates
          .filter((each) => each.workItemId === leafId)
          .map((each) => found.slices.get(sliceKey(leafId, each.roleId)))
          .filter((placed) => placed !== undefined);
        if (own.length === 0) continue;
        const row = found.workItems.get(leafId);
        if (row === undefined) throw new Error(`${leafId} lost its schedule`);
        expect(row.earliestStart).toBe(Math.min(...own.map((s) => s.earliestStart)));
        expect(row.earliestFinish).toBe(Math.max(...own.map((s) => s.earliestFinish)));
      }
    }

    // The corpus half. `walkedPast` counts the edges whose predecessor's anchor
    // is **not** its first slice — the plans the estimated-anchor walk exists
    // for. A green run with that at zero would be this rule untested over the
    // whole corpus, which is the shape this test was written to stop.
    expect(edgesChecked).toBeGreaterThan(1000);
    expect(walkedPast).toBeGreaterThan(0);
  });

  it('generates plans worth measuring, so a green run is not an empty one', () => {
    // The generator is as capable of being wrong as the engine. This asserts the
    // corpus actually contains the shapes the claims are about — and that the
    // shuffle above really does permute, since a shuffle that never moved
    // anything would make the first test the same test as the second.
    let multiRole = 0;
    let withEdges = 0;
    let withParents = 0;
    let unestimated = 0;
    let floored = 0;
    let reordered = 0;
    for (let seed = 1; seed <= 1000; seed += 1) {
      const plan = generatePlan(seed, RELEASED_ROLES);
      const perWorkItem = new Map<string, number>();
      for (const each of plan.estimates) {
        perWorkItem.set(each.workItemId, (perWorkItem.get(each.workItemId) ?? 0) + 1);
      }
      if ([...perWorkItem.values()].some((count) => count > 1)) multiRole += 1;
      if (plan.edges.length > 0) withEdges += 1;
      if (plan.rows.some((row) => row.parentId !== null)) withParents += 1;
      if (plan.estimates.some((each) => each.days === null)) unestimated += 1;
      if (plan.notBefore.size > 0) floored += 1;

      // The shuffle is only observable through the order of the addends, so it
      // is re-run here and compared against the role-ordered one.
      const random = randomFrom(seed * 7919 + 13);
      const inOrder: number[] = [];
      for (const each of plan.estimates) if (each.days !== null) inOrder.push(each.days);
      const shuffled = [...inOrder];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        const held = shuffled[i];
        shuffled[i] = shuffled[j];
        shuffled[j] = held;
      }
      if (shuffled.some((each, at) => each !== inOrder[at])) reordered += 1;
    }

    expect(multiRole).toBeGreaterThan(500);
    expect(withEdges).toBeGreaterThan(500);
    expect(withParents).toBeGreaterThan(500);
    expect(unestimated).toBeGreaterThan(500);
    expect(floored).toBeGreaterThan(200);
    expect(reordered).toBeGreaterThan(900);
  });
});
