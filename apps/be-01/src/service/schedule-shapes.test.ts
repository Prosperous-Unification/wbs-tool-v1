import { describe, expect, it } from 'bun:test';

import type { WorkItem } from '../repository';
import type { DependencyEdge, Slice } from './schedule';
import { schedule, sliceKey } from './schedule';

/**
 * Graph shapes the scheduling engine has to hold: diamonds, ties, deep parent
 * expansion, degenerate edges, and the arithmetic over long chains. The basics
 * — chains, fan-in, floats on a two-branch plan — live in `schedule.test.ts`;
 * this file is the shapes that file does not draw.
 */

const DEV = 'role-dev';
const QA = 'role-qa';
/** A role in front of `DEV`, for the plans whose point is what sits before it. */
const DESIGN = 'role-design';

let position = 0;
const item = (id: string, parentId: string | null = null): WorkItem => ({
  id,
  projectId: 'p1',
  parentId,
  position: (position += 10),
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

const edge = (predecessorId: string, successorId: string): DependencyEdge => ({
  predecessorId,
  successorId,
});

/** One unassigned slice per leaf, from a `days` record; a missing id is unestimated. */
const plan = (
  rows: readonly WorkItem[],
  edges: readonly DependencyEdge[],
  days: Record<string, number>,
  notBefore?: ReadonlyMap<string, number>,
) => {
  const childless = new Set(rows.map((row) => row.parentId).filter((id) => id !== null));
  const slices: Slice[] = rows
    .filter((row) => !childless.has(row.id))
    .map((row) => ({
      workItemId: row.id,
      roleId: DEV,
      days: row.id in days ? days[row.id] : null,
      personId: null,
      width: 1,
      poolId: null,
    }));
  return schedule(rows, edges, slices, notBefore);
};

describe('shapes — a diamond', () => {
  /**
   * ```
   *        ┌→ b (3) ─┐
   * a (2) ─┤         ├→ d (1)
   *        └→ c (5) ─┘
   * ```
   * One path through `c` is the long one; `b` rides beside it with two days
   * of room.
   */
  const diamond = () =>
    plan(
      [item('a'), item('b'), item('c'), item('d')],
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd')],
      { a: 2, b: 3, c: 5, d: 1 },
    ).workItems;

  it('joins the fan back in at the later branch', () => {
    const found = diamond();

    expect(found.get('d')).toMatchObject({ earliestStart: 7, earliestFinish: 8 });
  });

  it('marks exactly the long path critical, and no other row', () => {
    const found = diamond();

    expect(found.get('a')).toMatchObject({ float: 0, critical: true });
    expect(found.get('c')).toMatchObject({ float: 0, critical: true });
    expect(found.get('d')).toMatchObject({ float: 0, critical: true });
    expect(found.get('b')).toMatchObject({ latestStart: 4, float: 2, critical: false });
  });
});

describe('shapes — a critical-path tie', () => {
  it('marks both of two equally long paths critical', () => {
    // Two three-day predecessors of one join: neither can slip, so a plan that
    // painted only one red would be telling the reader the other has room.
    const found = plan([item('a'), item('b'), item('c')], [edge('a', 'c'), edge('b', 'c')], {
      a: 3,
      b: 3,
      c: 1,
    }).workItems;

    expect(found.get('a')).toMatchObject({ float: 0, critical: true });
    expect(found.get('b')).toMatchObject({ float: 0, critical: true });
    expect(found.get('c')).toMatchObject({ float: 0, critical: true });
  });
});

describe('shapes — a dependency between two nested branches', () => {
  /**
   * ```
   * P                Q
   *   C1               D1
   *     L1 (2)           M1 (3)
   *     L2 (4)           M2 (1)
   *   L3 (1)
   * ```
   * `P → Q`, declared at the top: every leaf's anchor under one branch before
   * any leaf under the other, through a parent on **both** sides and a second
   * level of nesting under each. Single-role leaves, so each anchor is the
   * leaf entire — the multi-role reading has its own describe below.
   */
  const branches = () =>
    plan(
      [
        item('P'),
        item('C1', 'P'),
        item('L1', 'C1'),
        item('L2', 'C1'),
        item('L3', 'P'),
        item('Q'),
        item('D1', 'Q'),
        item('M1', 'D1'),
        item('M2', 'D1'),
      ],
      [edge('P', 'Q')],
      { L1: 2, L2: 4, L3: 1, M1: 3, M2: 1 },
    ).workItems;

  it('holds every leaf under the successor until every predecessor leaf’s anchor finishes', () => {
    const found = branches();

    // `L2`'s anchor is the last of `P`'s to finish, two levels down — its one
    // slice, these leaves being single-role.
    expect(found.get('M1')).toMatchObject({ earliestStart: 4, earliestFinish: 7 });
    expect(found.get('M2')).toMatchObject({ earliestStart: 4, earliestFinish: 5 });
  });

  it('spans both parents over what their leaves actually do', () => {
    const found = branches();

    expect(found.get('P')).toMatchObject({ earliestStart: 0, earliestFinish: 4 });
    expect(found.get('Q')).toMatchObject({ earliestStart: 4, earliestFinish: 7 });
    expect(found.get('D1')).toMatchObject({ earliestStart: 4, earliestFinish: 7 });
  });
});

/** Two slices per leaf — `[Dev, QA]` days in role order; null is unestimated. */
const roledPlan = (
  rows: readonly WorkItem[],
  edges: readonly DependencyEdge[],
  days: Record<string, [number | null, number | null]>,
  notBefore?: ReadonlyMap<string, number>,
) => {
  const childless = new Set(rows.map((row) => row.parentId).filter((id) => id !== null));
  const slices: Slice[] = rows
    .filter((row) => !childless.has(row.id))
    .flatMap((row) => [
      {
        workItemId: row.id,
        roleId: DEV,
        days: days[row.id][0],
        personId: null,
        width: 1,
        poolId: null,
      },
      {
        workItemId: row.id,
        roleId: QA,
        days: days[row.id][1],
        personId: null,
        width: 1,
        poolId: null,
      },
    ]);
  return schedule(rows, edges, slices, notBefore);
};

/**
 * The same, for a **three**-role project listing `Design, Dev, QA` in that
 * order — the shape the anchor rule is about, because it has a role in front
 * of `Dev` that a plan may well leave unestimated.
 */
const threeRolePlan = (
  rows: readonly WorkItem[],
  edges: readonly DependencyEdge[],
  days: Record<string, [number | null, number | null, number | null]>,
  notBefore?: ReadonlyMap<string, number>,
) => {
  const childless = new Set(rows.map((row) => row.parentId).filter((id) => id !== null));
  const slices: Slice[] = rows
    .filter((row) => !childless.has(row.id))
    .flatMap((row) => [
      {
        workItemId: row.id,
        roleId: DESIGN,
        days: days[row.id][0],
        personId: null,
        width: 1,
        poolId: null,
      },
      {
        workItemId: row.id,
        roleId: DEV,
        days: days[row.id][1],
        personId: null,
        width: 1,
        poolId: null,
      },
      {
        workItemId: row.id,
        roleId: QA,
        days: days[row.id][2],
        personId: null,
        width: 1,
        poolId: null,
      },
    ]);
  return schedule(rows, edges, slices, notBefore);
};

/** One work item's projection, or a throw — a test asserting on `undefined` asserts nothing. */
const projectionOf = (found: ReturnType<typeof schedule>, id: string) => {
  const row = found.workItems.get(id);
  if (row === undefined) throw new Error(`${id} lost its schedule`);
  return row;
};

describe('shapes — a dependency waits on the anchor slice', () => {
  it('waits for the first role, not the last', () => {
    // `B` needs `A`'s Dev, never its QA: the anchor — `A`'s first slice in
    // role order — finishes on day 3, and `A`'s QA runs 3→5 alongside `B`.
    const found = roledPlan([item('A'), item('B')], [edge('A', 'B')], {
      A: [3, 2],
      B: [1, 1],
    });

    expect(projectionOf(found, 'B').earliestStart).toBe(3);
    expect(found.slices.get(sliceKey('A', QA))).toMatchObject({
      earliestStart: 3,
      earliestFinish: 5,
    });
  });

  it('an unestimated first role does not escape the wait', () => {
    // Green under the last-slice rule too — kept as the guard that the
    // successor side did not move (design.md D2): the edge lands on `B`'s
    // first slice plain, never its first *estimated* one, so the row waits
    // even though nobody has put a number on its Dev.
    const found = roledPlan([item('A'), item('B')], [edge('A', 'B')], {
      A: [3, null],
      B: [null, 2],
    });

    expect(found.slices.get(sliceKey('B', DEV))).toMatchObject({
      earliestStart: 3,
      earliestFinish: 3,
    });
    expect(found.slices.get(sliceKey('B', QA))).toMatchObject({
      earliestStart: 3,
      earliestFinish: 5,
    });
    expect(projectionOf(found, 'B').earliestStart).toBe(3);
  });

  it('walks past an unestimated role to the first one somebody estimated', () => {
    // `A`'s Dev carries no estimate, so the anchor is not it: the walk goes on
    // down the role order and stops at `A`'s QA, the first slice of `A`
    // anybody put a number on (design.md D1). `B` waits until day 4.
    //
    // Until 2026-08-11 this read the other way — the anchor was the first
    // slice plain, zero days long, and `B` started on day 0 with the edge
    // having decided nothing. Dany's call, on the probe below: "first in list
    // of project roles, then first that is estimated".
    const found = roledPlan([item('A'), item('B')], [edge('A', 'B')], {
      A: [null, 4],
      B: [2, null],
    });

    expect(projectionOf(found, 'B').earliestStart).toBe(4);
    expect(found.slices.get(sliceKey('A', QA))).toMatchObject({
      earliestStart: 0,
      earliestFinish: 4,
    });
  });

  it('a chain does not collapse because a project lists a role nobody estimated', () => {
    // The probe that settled the rule (2026-08-11). Three roles — `Design`,
    // `Dev`, `QA` — and a plan that estimates only `Dev`, which is every plan
    // in `refs/gantt/`. `c1 → c2 → c3`, four days of Dev each.
    //
    // Under the first-slice-plain rule every one of these anchors was the
    // unestimated `Design`, zero days long, so every edge in the plan went
    // inert and all three rows started on day 0 — twelve days of work drawn
    // as four. The estimated-anchor rule is what stops that: the chain runs
    // 0→4, 4→8, 8→12, and only `Design` and `QA` are free to sit anywhere.
    const found = threeRolePlan(
      [item('c1'), item('c2'), item('c3')],
      [edge('c1', 'c2'), edge('c2', 'c3')],
      { c1: [null, 4, null], c2: [null, 4, null], c3: [null, 4, null] },
    );

    expect(projectionOf(found, 'c1')).toMatchObject({ earliestStart: 0, earliestFinish: 4 });
    expect(projectionOf(found, 'c2')).toMatchObject({ earliestStart: 4, earliestFinish: 8 });
    expect(projectionOf(found, 'c3')).toMatchObject({ earliestStart: 8, earliestFinish: 12 });
    // Both sides of the asymmetry in one row: the edge *arrives* at `c3`'s
    // `Design` — its first slice plain, unestimated and zero-length — and its
    // `Dev` follows in role order behind it, while the edge *left* `c2` from
    // the `Dev` that was `c2`'s first estimate.
    expect(found.slices.get(sliceKey('c3', DESIGN))).toMatchObject({
      earliestStart: 8,
      earliestFinish: 8,
      boundBy: 'predecessor',
    });
    expect(found.slices.get(sliceKey('c3', DEV))).toMatchObject({
      earliestStart: 8,
      boundBy: 'roleOrder',
    });
  });

  it('anchors a predecessor nobody estimated at all on its finish', () => {
    // No slice of `A` carries a number, so there is no estimated slice to
    // anchor on and the walk falls through to `A`'s **finish** — which for a
    // work item of no days at all is its own start. The edge then imposes
    // exactly what `A`'s own predecessors imposed, here nothing, and `B`
    // starts on day 0. That is the degenerate case kept deliberate rather
    // than accidental (design.md D1).
    const found = threeRolePlan([item('A'), item('B')], [edge('A', 'B')], {
      A: [null, null, null],
      B: [2, null, null],
    });

    expect(projectionOf(found, 'A')).toMatchObject({ earliestStart: 0, earliestFinish: 0 });
    expect(projectionOf(found, 'B').earliestStart).toBe(0);
  });

  it('carries an unestimated predecessor’s own wait through to its successor', () => {
    // The fall-through is the item's finish, not day zero: `A` is estimated,
    // `B` is estimated nowhere, `C` waits on `B`. `B` starts at `A`'s anchor
    // (day 3) and finishes there too, so `C` starts on day 3 — the wait `A`
    // imposed is carried rather than lost.
    const found = threeRolePlan(
      [item('A'), item('B'), item('C')],
      [edge('A', 'B'), edge('B', 'C')],
      { A: [null, 3, 9], B: [null, null, null], C: [1, null, null] },
    );

    expect(projectionOf(found, 'B')).toMatchObject({ earliestStart: 3, earliestFinish: 3 });
    expect(projectionOf(found, 'C').earliestStart).toBe(3);
  });

  it('a branch anchors each leaf on its own first estimate', () => {
    // Two leaves under `P`, each with a different role estimated: `P1` only
    // its `Dev` (0→2), `P2` only its `QA` (0→5, behind two zero-length roles).
    // Each leaf's anchor is its own first estimated slice, and `Q` waits for
    // the latest of them — day 5, not `P1`'s day 2 and not day 0.
    const found = threeRolePlan(
      [item('P'), item('P1', 'P'), item('P2', 'P'), item('Q')],
      [edge('P', 'Q')],
      { P1: [null, 2, null], P2: [null, null, 5], Q: [1, null, null] },
    );

    expect(projectionOf(found, 'Q').earliestStart).toBe(5);
  });

  it('a branch releases at its anchors', () => {
    // `Q` waits for all of `P`'s first-role work: `P1`'s anchor ends day 2,
    // `P2`'s day 4, and the latest of them releases `Q` on day 4 while `P`'s
    // own projection runs to day 5 (design.md D3).
    const found = roledPlan(
      [item('P'), item('P1', 'P'), item('P2', 'P'), item('Q')],
      [edge('P', 'Q')],
      { P1: [2, 3], P2: [4, 1], Q: [1, null] },
    );

    expect(projectionOf(found, 'Q').earliestStart).toBe(4);
    expect(projectionOf(found, 'P')).toMatchObject({ earliestStart: 0, earliestFinish: 5 });
  });

  it('splits critical from slack inside the predecessor when the successor runs on', () => {
    // `B`'s ten-day Dev runs 3→13 and is the whole project. `A`'s Dev (0→3)
    // releases it, so Dev cannot slip: float 0, critical. `A`'s QA (3→5) has
    // no successor at all after the flip — the edge leaves the anchor — so it
    // may run as late as 11→13: float 13 − 5 = 8, and no red. The row
    // projects the min-slice rule: `A` reports slack 0 and critical because
    // its Dev is, even with eight days of room on its QA.
    const found = roledPlan([item('A'), item('B')], [edge('A', 'B')], {
      A: [3, 2],
      B: [10, null],
    });

    expect(found.slices.get(sliceKey('A', DEV))).toMatchObject({
      earliestStart: 0,
      earliestFinish: 3,
      float: 0,
      critical: true,
    });
    expect(found.slices.get(sliceKey('A', QA))).toMatchObject({
      earliestStart: 3,
      earliestFinish: 5,
      latestStart: 11,
      latestFinish: 13,
      float: 8,
      critical: false,
    });
    expect(projectionOf(found, 'A')).toMatchObject({ float: 0, critical: true });
    expect(projectionOf(found, 'B')).toMatchObject({
      earliestFinish: 13,
      float: 0,
      critical: true,
    });
  });

  it('a chain of anchors: each successor starts at its predecessor’s Dev finish', () => {
    // Three two-role items in a line. `A`'s Dev 0→2 releases `B` on day 2
    // while `A`'s QA runs 2→5 beside it; `B`'s Dev 2→6 releases `C` on day 6
    // while `B`'s QA runs 6→8 beside it. The rows: `A` 0→5, `B` 2→8, `C`
    // 6→12 — each QA tail overlapping the successor it no longer holds.
    const found = roledPlan([item('A'), item('B'), item('C')], [edge('A', 'B'), edge('B', 'C')], {
      A: [2, 3],
      B: [4, 2],
      C: [1, 5],
    });

    expect(projectionOf(found, 'A')).toMatchObject({ earliestStart: 0, earliestFinish: 5 });
    expect(projectionOf(found, 'B')).toMatchObject({ earliestStart: 2, earliestFinish: 8 });
    expect(projectionOf(found, 'C')).toMatchObject({ earliestStart: 6, earliestFinish: 12 });
    // Day 6 is `B`'s Dev finish, not its QA's day 8: the wait was the anchor's.
    expect(found.slices.get(sliceKey('C', DEV))).toMatchObject({
      earliestStart: 6,
      boundBy: 'predecessor',
    });
  });

  it('a multi-role diamond joins at the latest anchor, not the latest projection', () => {
    // `A` [1, 1] fans out to `B` [3, 4] and `C` [6, 1]; `D` [2, 2] joins the
    // fan back in. Both branches start at `A`'s Dev finish, day 1: `B`'s Dev
    // 1→4, QA 4→8; `C`'s Dev 1→7, QA 7→8. Both projections end on day 8 — so
    // a join at the projections would put `D` at 8 either way. The anchors
    // differ: `B`'s Dev ends day 4, `C`'s day 7, and `D` starts at 7 — `C`'s
    // longer Dev is the binding predecessor.
    const found = roledPlan(
      [item('A'), item('B'), item('C'), item('D')],
      [edge('A', 'B'), edge('A', 'C'), edge('B', 'D'), edge('C', 'D')],
      { A: [1, 1], B: [3, 4], C: [6, 1], D: [2, 2] },
    );

    expect(found.slices.get(sliceKey('C', DEV))).toMatchObject({ earliestFinish: 7 });
    expect(found.slices.get(sliceKey('B', DEV))).toMatchObject({ earliestFinish: 4 });
    expect(projectionOf(found, 'D')).toMatchObject({ earliestStart: 7, earliestFinish: 11 });
    expect(found.slices.get(sliceKey('D', DEV))).toMatchObject({ boundBy: 'predecessor' });
  });
});

describe('shapes — a multi-role dependency beside a manual floor', () => {
  it('lets the floor win over the anchor when it is the later of the two', () => {
    // `A`'s anchor lets go on day 2 (Dev 0→2, QA 2→4 beside everything), and
    // `B`'s own floor says day 5: the floor is later, `B`'s Dev runs 5→8, its
    // QA 8→9, and the floor is named.
    const found = roledPlan(
      [item('A'), item('B')],
      [edge('A', 'B')],
      { A: [2, 2], B: [3, 1] },
      new Map([['B', 5]]),
    );

    expect(projectionOf(found, 'B')).toMatchObject({ earliestStart: 5, earliestFinish: 9 });
    expect(found.slices.get(sliceKey('B', DEV))).toMatchObject({
      earliestStart: 5,
      boundBy: 'notBefore',
    });
  });

  it('lets the anchor swallow the floor when the Dev runs past it', () => {
    // The same shape with `A`'s Dev at four days: day 2 is already gone when
    // the anchor lets go on day 4, so the floor decided nothing and the
    // dependency is named. `B`'s Dev 4→7, QA 7→8.
    const found = roledPlan(
      [item('A'), item('B')],
      [edge('A', 'B')],
      { A: [4, 2], B: [3, 1] },
      new Map([['B', 2]]),
    );

    expect(projectionOf(found, 'B')).toMatchObject({ earliestStart: 4, earliestFinish: 8 });
    expect(found.slices.get(sliceKey('B', DEV))).toMatchObject({
      earliestStart: 4,
      boundBy: 'predecessor',
    });
  });
});

describe('shapes — degenerate edges the engine must refuse', () => {
  it('throws on a work item depending on itself', () => {
    // The write path refuses this as `ancestor`; the engine has to refuse it
    // too, because a restored database is under no such guard.
    expect(() => plan([item('a')], [edge('a', 'a')], { a: 1 })).toThrow(/cycle/i);
  });

  it('backstops a stored parent→own-nested-leaf edge the write path would have refused', () => {
    // Honestly: this edge can only reach the engine from outside the API — a
    // restored or hand-edited database — because `canDepend` refuses it as
    // `ancestor` at the write path (`dependency.test.ts`, 'refuses an ancestor
    // more than one level up, in both directions'). What the engine sees is
    // not "an ancestor": `expandToLeaves` turns `P → L` into, among the pairs,
    // `L → L` — a self-loop — and the topological sort throws on that
    // artifact. A backstop, not the guard.
    const rows = [item('P'), item('C', 'P'), item('L', 'C'), item('other', 'P')];

    expect(() => plan(rows, [edge('P', 'L')], { L: 1, other: 1 })).toThrow(/cycle/i);
  });

  it('backstops the same stored edge drawn upward, leaf onto ancestor', () => {
    // As above: the write path's `ancestor` refusal is the guard; the engine
    // only ever sees the expansion's `L → L` self-loop and throws on that.
    const rows = [item('P'), item('C', 'P'), item('L', 'C'), item('other', 'P')];

    expect(() => plan(rows, [edge('L', 'P')], { L: 1, other: 1 })).toThrow(/cycle/i);
  });

  it('throws on a cycle closed through three work items', () => {
    const rows = [item('a'), item('b'), item('c')];

    expect(() =>
      plan(rows, [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')], { a: 1, b: 1, c: 1 }),
    ).toThrow(/cycle/i);
  });
});

describe('shapes — an estimate of zero is not an absent one', () => {
  it('schedules a zero-day leaf as estimated and instant', () => {
    // Somebody looked and said "no time at all" — a milestone. The number is
    // the same as nobody having looked; the fact is the opposite one.
    const found = plan([item('gate'), item('after')], [edge('gate', 'after')], {
      gate: 0,
      after: 2,
    }).workItems;

    expect(found.get('gate')).toMatchObject({
      duration: 0,
      estimated: true,
      earliestStart: 0,
      earliestFinish: 0,
    });
    expect(found.get('after')).toMatchObject({ earliestStart: 0, earliestFinish: 2 });
  });
});

describe('shapes — a manual floor beside a dependency', () => {
  it('lets the later dependency swallow the floor, and names the dependency', () => {
    // The floor is a floor, not a pin: day 2 is already past when the five-day
    // predecessor lets go, so the floor decided nothing and must not be named.
    const rows = [item('a'), item('b')];
    const found = plan(rows, [edge('a', 'b')], { a: 5, b: 1 }, new Map([['b', 2]]));

    expect(found.workItems.get('b')).toMatchObject({ earliestStart: 5 });
    expect(found.slices.get(sliceKey('b', DEV))).toMatchObject({ boundBy: 'predecessor' });
  });

  it('lets the floor win when it is the later of the two, and names the floor', () => {
    const rows = [item('a'), item('b')];
    const found = plan(rows, [edge('a', 'b')], { a: 1, b: 1 }, new Map([['b', 6]]));

    expect(found.workItems.get('b')).toMatchObject({ earliestStart: 6 });
    expect(found.slices.get(sliceKey('b', DEV))).toMatchObject({ boundBy: 'notBefore' });
  });

  it('carries a grandparent’s floor two levels down to the leaf', () => {
    // Three tiers, a floor on every one, the grandparent's the latest: the
    // leaf takes day 6, not its own day 3 and not the parent's day 1. One
    // level of expansion is not the fix — the floor walks the whole tree.
    const rows = [item('G'), item('P', 'G'), item('L', 'P')];
    const floors = new Map([
      ['G', 6],
      ['P', 1],
      ['L', 3],
    ]);
    const found = plan(rows, [], { L: 2 }, floors);

    expect(found.workItems.get('L')).toMatchObject({ earliestStart: 6, earliestFinish: 8 });
    expect(found.slices.get(sliceKey('L', DEV))).toMatchObject({ boundBy: 'notBefore' });
  });

  it('composes ancestor floors with a dependency, each leaf keeping its own maximum', () => {
    // Grandparent → parent → two leaves, a different floor at every level,
    // and a five-day predecessor onto the parent — later than every floor on
    // `L1`, earlier than `L2`'s own. `L1` starts when the dependency lets go
    // and names it; `L2`'s own day-9 floor survives every ancestor's earlier
    // one — the case a naive copy-down (parent overwrites child) gets wrong —
    // and names `notBefore`. `L2`'s floor is listed **first**: a copy-down
    // only shows when an ancestor iterates after the child, and nothing about
    // the map promises parents come first.
    const rows = [item('pre'), item('G'), item('P', 'G'), item('L1', 'P'), item('L2', 'P')];
    const floors = new Map([
      ['L2', 9],
      ['G', 2],
      ['P', 3],
      ['L1', 4],
    ]);
    const found = plan(rows, [edge('pre', 'P')], { pre: 5, L1: 1, L2: 1 }, floors);

    expect(found.workItems.get('L1')).toMatchObject({ earliestStart: 5, earliestFinish: 6 });
    expect(found.slices.get(sliceKey('L1', DEV))).toMatchObject({ boundBy: 'predecessor' });
    expect(found.workItems.get('L2')).toMatchObject({ earliestStart: 9, earliestFinish: 10 });
    expect(found.slices.get(sliceKey('L2', DEV))).toMatchObject({ boundBy: 'notBefore' });
  });
});

describe('shapes — arithmetic over a long chain', () => {
  it('keeps a forty-day chain of whole days exactly whole', () => {
    // Whole days must never acquire a fraction, however many additions they go
    // through: `toBe`, not `toBeCloseTo`, is the assertion.
    const rows: WorkItem[] = [];
    const edges: DependencyEdge[] = [];
    const days: Record<string, number> = {};
    for (let at = 0; at < 40; at += 1) {
      const id = `link-${String(at)}`;
      rows.push(item(id));
      days[id] = 1;
      if (at > 0) edges.push(edge(`link-${String(at - 1)}`, id));
    }

    const found = plan(rows, edges, days).workItems;

    expect(found.get('link-39')).toMatchObject({ earliestStart: 39, earliestFinish: 40 });
    expect(found.get('link-39')).toMatchObject({ float: 0, critical: true });
    expect(found.get('link-0')).toMatchObject({ float: 0, critical: true });
  });

  it('accumulates PERT sixths across a chain to within a bit, not to the bit', () => {
    // Three PERT finals of 45/6, 25/6 and 20/6 days — the trios 0/8/13, 3/4/6
    // and 0/3/8. The exact sum is 15 and the doubles land a few ULPs off it,
    // because a chain accumulates `finish = start + days` across work items
    // and the engine's anchoring — deliberately — reaches only within one work
    // item. The engine reports its arithmetic verbatim; the calendar boundary
    // (`snapWorkdays`, in `datesOf` and `addWorkdays`) absorbs the drift with
    // a 1e-9 window, so what matters — and what is asserted — is the bound
    // that window rests on: the drift is real but stays orders of magnitude
    // inside it. Pinning the exact drifted double (15.000000000000002, as this
    // test first did) would assert one platform's rounding, not the contract.
    const rows = [item('a'), item('b'), item('c')];
    const found = plan(rows, [edge('a', 'b'), edge('b', 'c')], {
      a: 45 / 6,
      b: 25 / 6,
      c: 20 / 6,
    }).workItems;

    const finish = found.get('c')?.earliestFinish ?? NaN;
    expect(finish).not.toBe(15);
    expect(Math.abs(finish - 15)).toBeLessThan(1e-9);
  });

  it('paints every row that ends the project red, drift and all', () => {
    // Cloud case A1, watched live on dev 2026-08-11. Three PERT finals of
    // 45/6, 25/6 and 20/6 days chained end to end — the trios 0/8/13, 3/4/6
    // and 0/3/8 — sum to exactly 15 and arrive as 15.000000000000002, and a
    // fourth row of a flat 15 days runs beside them. All four end the project
    // and none of them can slip by so much as an hour.
    //
    // The engine agreed about one of them. `flat`'s late start came back as
    // 15.000000000000002 − 15 = 1.8e-15 and the chain's own ends drifted the
    // same way, so `latestStart - earliestStart === 0` was false on three
    // rows of four: the Slack column printed `0` (it rounds to a tenth) with
    // no `critical` beside it and no red on the bar — a row saying in one
    // breath that it has no slack and that it is not what sets the finish.
    const rows = [item('chain-a'), item('chain-b'), item('chain-c'), item('flat')];
    const found = plan(rows, [edge('chain-a', 'chain-b'), edge('chain-b', 'chain-c')], {
      'chain-a': 45 / 6,
      'chain-b': 25 / 6,
      'chain-c': 20 / 6,
      flat: 15,
    }).workItems;

    // The drift is still there in the finish — this asserts the shape is the
    // one A1 hit, so a future engine that stops drifting does not leave this
    // test passing about nothing.
    expect(found.get('chain-c')?.earliestFinish).not.toBe(15);
    expect(found.get('chain-a')).toMatchObject({ float: 0, critical: true });
    expect(found.get('chain-b')).toMatchObject({ float: 0, critical: true });
    expect(found.get('chain-c')).toMatchObject({ float: 0, critical: true });
    expect(found.get('flat')).toMatchObject({ float: 0, critical: true });
  });

  it('reports no float on a row a notBefore floor stands at the project finish', () => {
    // A floor at day 13 stands a 23/6-day row past everything else in the
    // plan, so that row *is* the project finish and cannot slip at all. The
    // backward pass reconstructs its `latestStart` as `projectFinish - days`,
    // and `(13 + 23/6) - 23/6` is not 13 in doubles, so the raw subtraction
    // gives about -1.8e-15.
    //
    // **This test used to pin that** — `float < 0`, `critical: false` — as a
    // known defect, held so the day it changed would be a deliberate one
    // rather than a silent side effect. 2026-08-11 is that day: cloud case A1
    // hit the same arithmetic on a plain PERT chain and made the same row say
    // `0` in the Slack column with no red beside it. `slackOf` now snaps the
    // slack through `snapWorkdays`' 1e-9 window before reporting it and
    // before comparing it to zero, so what is printed and what is classified
    // are one number. The test guarded the defect; it guards the fix now.
    //
    // The tight-path rule in `lateTimes` is untouched and still scoped to
    // plans with resource queues — it moves `latestStart` itself, which the
    // identity claim rests on. This snaps only the difference the reader is
    // shown.
    //
    // Proof this test can fail: the `snapWorkdays` call dropped from
    // `slackOf`, and it failed on `Expected: 0 Received:
    // -1.7763568394002505e-15`; with the `-0` normalisation dropped instead
    // it failed on `Expected: 0 Received: -0`, which is the same day on
    // screen and a different number to `Object.is`. Both watched 2026-08-11.
    const rows = [item('done-early'), item('floored')];
    const found = plan(rows, [], { 'done-early': 3, floored: 23 / 6 }, new Map([['floored', 13]]));

    const floored = found.workItems.get('floored');
    if (floored === undefined) throw new Error('the floored row is not in the plan');
    // The floor held, and the row ends the project.
    expect(floored.earliestStart).toBe(13);
    expect(floored.earliestFinish).toBeGreaterThan(
      found.workItems.get('done-early')?.earliestFinish ?? NaN,
    );
    expect(found.slices.get(sliceKey('floored', DEV))).toMatchObject({ boundBy: 'notBefore' });
    // The drift is still in the numbers the snap is applied to — asserted so
    // this cannot quietly become a test about an engine that stopped drifting.
    expect(floored.latestStart).not.toBe(13);
    expect(floored.float).toBe(0);
    expect(floored.critical).toBe(true);
  });

  it('keeps a sixth of a day of real slack, and the row that has it out of the red', () => {
    // The other side of the snap, on the engine's own path: a sixth of a day
    // is the smallest fraction a PERT final can carry, and it is eight orders
    // of magnitude above the 1e-9 window. `short` rides beside a 2-day branch
    // with exactly that much room, and it must keep it — a window wide enough
    // to swallow this one would paint a row red that can be started a morning
    // late without touching the plan's finish.
    //
    // Proof: `DRIFT` in `@wbs/domain`'s `workday.ts` widened from 1e-9 to 0.5
    // and this test failed on the colour first — `Expected: false Received:
    // true` on `short`, a row with a morning of slack painted as the thing
    // that sets the plan's finish — and on `Expected: 0.16666666666666666
    // Received: 0` with that assertion taken out; both watched 2026-08-11.
    const rows = [item('long'), item('short'), item('join')];
    const found = plan(rows, [edge('long', 'join'), edge('short', 'join')], {
      long: 2,
      short: 11 / 6,
      join: 1,
    }).workItems;

    expect(found.get('long')).toMatchObject({ float: 0, critical: true });
    expect(found.get('short')?.critical).toBe(false);
    expect(found.get('short')?.float).toBeCloseTo(1 / 6, 12);
  });
});
