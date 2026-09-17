import { describe, expect, it } from 'bun:test';

import type { PlannedRow } from './derive-numbers';
import type { DependencyReach } from './index';
import type { DependencyEdge, Slice } from './schedule';
import { schedule, sliceKey } from './schedule';

/**
 * Graph shapes the scheduling engine has to hold: diamonds, ties, deep parent
 * expansion, degenerate edges, and the arithmetic over long chains. The basics
 * — chains, fan-in, floats on a two-branch plan — live in `schedule.test.ts`;
 * this file is the shapes that file does not draw.
 */

const DEV = 'step-dev';
const QA = 'step-qa';
/** A step in front of `DEV`, for the plans whose point is what sits before it. */
const DESIGN = 'step-design';

let position = 0;
const item = (id: string, parentId: string | null = null): PlannedRow => ({
  id,
  parentId,
  position: (position += 10),
  frozenNumber: null,
  priority: null,
});

const edge = (predecessorId: string, successorId: string): DependencyEdge => ({
  predecessorId,
  successorId,
});

/** One unassigned slice per leaf, from a `days` record; a missing id is unestimated. */
const plan = (
  rows: readonly PlannedRow[],
  edges: readonly DependencyEdge[],
  days: Record<string, number>,
  notBefore?: ReadonlyMap<string, number>,
) => {
  const childless = new Set(rows.map((row) => row.parentId).filter((id) => id !== null));
  const slices: Slice[] = rows
    .filter((row) => !childless.has(row.id))
    .map((row) => ({
      workItemId: row.id,
      stepId: DEV,
      days: row.id in days ? days[row.id] : null,
      personId: null,
      width: 1,
      poolIds: [],
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
   * level of nesting under each. Single-step leaves, so each anchor is the
   * leaf entire — the multi-step reading has its own describe below.
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
    // slice, these leaves being single-step.
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

/**
 * Two slices per leaf — `[Dev, QA]` days in role order; null is unestimated.
 *
 * `reach` is spelled at every call rather than defaulted, so a fixture written
 * for one rule cannot silently be read under the other. The `anchor-slice`
 * calls below are the figures `dep-waits-on-first-role` shipped, kept as that
 * arm's oracle rather than deleted (`dep-reach-whole-item`, tasks 3.1).
 */
const steppedPlan = (
  rows: readonly PlannedRow[],
  edges: readonly DependencyEdge[],
  days: Record<string, [number | null, number | null]>,
  reach: DependencyReach,
  notBefore?: ReadonlyMap<string, number>,
) => {
  const childless = new Set(rows.map((row) => row.parentId).filter((id) => id !== null));
  const slices: Slice[] = rows
    .filter((row) => !childless.has(row.id))
    .flatMap((row) => [
      {
        workItemId: row.id,
        stepId: DEV,
        days: days[row.id][0],
        personId: null,
        width: 1,
        poolIds: [],
      },
      {
        workItemId: row.id,
        stepId: QA,
        days: days[row.id][1],
        personId: null,
        width: 1,
        poolIds: [],
      },
    ]);
  return schedule(rows, edges, slices, notBefore, undefined, reach);
};

/**
 * The same, for a **three**-step project listing `Design, Dev, QA` in that
 * order — the shape the anchor rule is about, because it has a step in front
 * of `Dev` that a plan may well leave unestimated.
 */
const threeStepPlan = (
  rows: readonly PlannedRow[],
  edges: readonly DependencyEdge[],
  days: Record<string, [number | null, number | null, number | null]>,
  reach: DependencyReach,
  notBefore?: ReadonlyMap<string, number>,
) => {
  const childless = new Set(rows.map((row) => row.parentId).filter((id) => id !== null));
  const slices: Slice[] = rows
    .filter((row) => !childless.has(row.id))
    .flatMap((row) => [
      {
        workItemId: row.id,
        stepId: DESIGN,
        days: days[row.id][0],
        personId: null,
        width: 1,
        poolIds: [],
      },
      {
        workItemId: row.id,
        stepId: DEV,
        days: days[row.id][1],
        personId: null,
        width: 1,
        poolIds: [],
      },
      {
        workItemId: row.id,
        stepId: QA,
        days: days[row.id][2],
        personId: null,
        width: 1,
        poolIds: [],
      },
    ]);
  return schedule(rows, edges, slices, notBefore, undefined, reach);
};

/** One work item's projection, or a throw — a test asserting on `undefined` asserts nothing. */
const projectionOf = (found: ReturnType<typeof schedule>, id: string) => {
  const row = found.workItems.get(id);
  if (row === undefined) throw new Error(`${id} lost its schedule`);
  return row;
};

describe('shapes — a dependency waits on the anchor slice', () => {
  it('waits for the first step, not the last', () => {
    // `B` needs `A`'s Dev, never its QA: the anchor — `A`'s first slice in
    // role order — finishes on day 3, and `A`'s QA runs 3→5 alongside `B`.
    const found = steppedPlan(
      [item('A'), item('B')],
      [edge('A', 'B')],
      {
        A: [3, 2],
        B: [1, 1],
      },
      'anchor-slice',
    );

    expect(projectionOf(found, 'B').earliestStart).toBe(3);
    expect(found.slices.get(sliceKey('A', QA))).toMatchObject({
      earliestStart: 3,
      earliestFinish: 5,
    });
  });

  it('an unestimated first step does not escape the wait', () => {
    // Green under the last-slice rule too — kept as the guard that the
    // successor side did not move (design.md D2): the edge lands on `B`'s
    // first slice plain, never its first *estimated* one, so the row waits
    // even though nobody has put a number on its Dev.
    const found = steppedPlan(
      [item('A'), item('B')],
      [edge('A', 'B')],
      {
        A: [3, null],
        B: [null, 2],
      },
      'anchor-slice',
    );

    // Re-derived by `assumed-duration-schedules` (2026-08-29): `B`'s
    // unestimated `Dev` is two workdays wide, so it runs 3→5 and its `QA`
    // follows at 5. The claim is unmoved — the edge lands on `B`'s first slice
    // plain and `B` starts at day 3, not day zero.
    expect(found.slices.get(sliceKey('B', DEV))).toMatchObject({
      earliestStart: 3,
      earliestFinish: 5,
    });
    expect(found.slices.get(sliceKey('B', QA))).toMatchObject({
      earliestStart: 5,
      earliestFinish: 7,
    });
    expect(projectionOf(found, 'B').earliestStart).toBe(3);
  });

  it('walks past an unestimated step to the first one somebody estimated', () => {
    // `A`'s Dev carries no estimate, so the anchor is not it: the walk goes on
    // down the step order and stops at `A`'s QA, the first slice of `A`
    // anybody put a number on (design.md D1). `B` waits until day 4.
    //
    // Until 2026-08-11 this read the other way — the anchor was the first
    // slice plain, zero days long, and `B` started on day 0 with the edge
    // having decided nothing. Dany's call, on the probe below: "first in list
    // of project roles, then first that is estimated".
    const found = steppedPlan(
      [item('A'), item('B')],
      [edge('A', 'B')],
      {
        A: [null, 4],
        B: [2, null],
      },
      'anchor-slice',
    );

    // Re-derived by `assumed-duration-schedules` (2026-08-29): `A`'s
    // unestimated `Dev` occupies 0→2, so the `QA` the walk stops at runs 2→6
    // and `B` waits until day 6. **The walk itself is what this test is for
    // and it did not move**: the anchor is still `A`'s first *estimated*
    // slice, not its first slice with a duration — which, after this change,
    // every slice has.
    expect(projectionOf(found, 'B').earliestStart).toBe(6);
    expect(found.slices.get(sliceKey('A', QA))).toMatchObject({
      earliestStart: 2,
      earliestFinish: 6,
    });
  });

  it('a chain does not collapse because a project lists a step nobody estimated', () => {
    // The probe that settled the rule (2026-08-11). Three steps — `Design`,
    // `Dev`, `QA` — and a plan that estimates only `Dev`, which is every plan
    // in `refs/gantt/`. `c1 → c2 → c3`, four days of Dev each.
    //
    // Under the first-slice-plain rule every one of these anchors was the
    // unestimated `Design`, zero days long, so every edge in the plan went
    // inert and all three rows started on day 0 — twelve days of work drawn
    // as four. The estimated-anchor rule is what stops that: the chain runs
    // 0→4, 4→8, 8→12, and only `Design` and `QA` are free to sit anywhere.
    const found = threeStepPlan(
      [item('c1'), item('c2'), item('c3')],
      [edge('c1', 'c2'), edge('c2', 'c3')],
      { c1: [null, 4, null], c2: [null, 4, null], c3: [null, 4, null] },
      'anchor-slice',
    );

    // Re-derived by `assumed-duration-schedules` (2026-08-29): the `Design` and
    // `QA` nobody estimated are two workdays each rather than none, so every
    // row is 8 days long and each starts at its predecessor's `Dev` finish —
    // 0→8, 6→14, 12→20. The rule the test exists for is unmoved: the chain
    // does not collapse, and it is `Dev` the edges leave from.
    expect(projectionOf(found, 'c1')).toMatchObject({ earliestStart: 0, earliestFinish: 8 });
    expect(projectionOf(found, 'c2')).toMatchObject({ earliestStart: 6, earliestFinish: 14 });
    expect(projectionOf(found, 'c3')).toMatchObject({ earliestStart: 12, earliestFinish: 20 });
    // Both sides of the asymmetry in one row: the edge *arrives* at `c3`'s
    // `Design` — its first slice plain, unestimated and now two workdays wide —
    // and its `Dev` follows in step order behind it, while the edge *left* `c2`
    // from the `Dev` that was `c2`'s first estimate.
    expect(found.slices.get(sliceKey('c3', DESIGN))).toMatchObject({
      earliestStart: 12,
      earliestFinish: 14,
      boundBy: 'predecessor',
    });
    expect(found.slices.get(sliceKey('c3', DEV))).toMatchObject({
      earliestStart: 14,
      boundBy: 'stepOrder',
    });
  });

  it('anchors a predecessor nobody estimated at all on its finish', () => {
    // No slice of `A` carries a number, so there is no estimated slice to
    // anchor on and the walk falls through to `A`'s **finish**
    // (`dep-waits-on-first-role` design.md D1, unmoved).
    //
    // Re-derived by `assumed-duration-schedules` (2026-08-29), and this is the
    // case that change is for. That finish used to be `A`'s own start, so the
    // edge imposed nothing and `B` began beside the work it depends on. `A`'s
    // three unestimated steps are now two workdays each, so `A` runs 0→6 and
    // `B` waits for it — a plan nobody has estimated has a believable order
    // rather than every row on day zero.
    //
    // On `anchor-slice` because that is what this block is the oracle for, and
    // the reach decides nothing here either way: with nothing estimated both
    // arms fall through to the same last slice. The `under either reach` case
    // in the reach block below is the one that asserts that.
    const found = threeStepPlan(
      [item('A'), item('B')],
      [edge('A', 'B')],
      {
        A: [null, null, null],
        B: [2, null, null],
      },
      'anchor-slice',
    );

    expect(projectionOf(found, 'A')).toMatchObject({ earliestStart: 0, earliestFinish: 6 });
    expect(projectionOf(found, 'B').earliestStart).toBe(6);
  });

  it('carries an unestimated predecessor’s own wait through to its successor', () => {
    // The fall-through is the item's finish, not day zero: `A` is estimated,
    // `B` is estimated nowhere, `C` waits on `B`. `B` starts at `A`'s anchor
    // and `C` waits for `B`'s finish — the wait `A` imposed is carried rather
    // than lost.
    //
    // Re-derived by `assumed-duration-schedules` (2026-08-29): `A`'s
    // unestimated `Design` pushes its `Dev` to 2→5, so `B` starts at day 5,
    // and `B`'s three unestimated steps take it to day 11 instead of ending it
    // where it began. `C` now waits for six days of unsized work rather than
    // for none of it.
    const found = threeStepPlan(
      [item('A'), item('B'), item('C')],
      [edge('A', 'B'), edge('B', 'C')],
      { A: [null, 3, 9], B: [null, null, null], C: [1, null, null] },
      'anchor-slice',
    );

    expect(projectionOf(found, 'B')).toMatchObject({ earliestStart: 5, earliestFinish: 11 });
    expect(projectionOf(found, 'C').earliestStart).toBe(11);
  });

  it('a branch anchors each leaf on its own first estimate', () => {
    // Two leaves under `P`, each with a different step estimated: `P1` only
    // its `Dev`, `P2` only its `QA`. Each leaf's anchor is its own first
    // estimated slice, and `Q` waits for the latest of them — not for `P1`'s
    // and not for day zero.
    //
    // Re-derived by `assumed-duration-schedules` (2026-08-29): the steps each
    // leaf leaves blank are two workdays each, so `P1`'s `Dev` anchors at day
    // 4 and `P2`'s `QA` at day 9. `Q` waits for 9.
    const found = threeStepPlan(
      [item('P'), item('P1', 'P'), item('P2', 'P'), item('Q')],
      [edge('P', 'Q')],
      { P1: [null, 2, null], P2: [null, null, 5], Q: [1, null, null] },
      'anchor-slice',
    );

    expect(projectionOf(found, 'Q').earliestStart).toBe(9);
  });

  it('a branch releases at its anchors', () => {
    // `Q` waits for all of `P`'s first-step work: `P1`'s anchor ends day 2,
    // `P2`'s day 4, and the latest of them releases `Q` on day 4 while `P`'s
    // own projection runs to day 5 (design.md D3).
    const found = steppedPlan(
      [item('P'), item('P1', 'P'), item('P2', 'P'), item('Q')],
      [edge('P', 'Q')],
      { P1: [2, 3], P2: [4, 1], Q: [1, null] },
      'anchor-slice',
    );

    expect(projectionOf(found, 'Q').earliestStart).toBe(4);
    expect(projectionOf(found, 'P')).toMatchObject({ earliestStart: 0, earliestFinish: 5 });
  });

  it('splits critical from slack inside the predecessor when the successor runs on', () => {
    // `B`'s ten-day Dev runs 3→13. `A`'s Dev (0→3) releases it, so Dev cannot
    // slip: float 0, critical. `A`'s QA (3→5) has no successor at all after the
    // flip — the edge leaves the anchor — so it may run as late as the project
    // allows, and shows no red. The row projects the min-slice rule: `A`
    // reports slack 0 and critical because its Dev is, with room to spare on
    // its QA.
    //
    // Re-derived by `assumed-duration-schedules` (2026-08-29): `B`'s
    // unestimated QA runs 13→15 behind its Dev rather than 13→13, so the
    // project finishes on day 15 and `A`'s QA has ten days of slack rather
    // than eight. `A`'s own numbers, which are what this test is about, are
    // unmoved.
    //
    // On `anchor-slice`: "the edge leaves the anchor" is the whole premise, so
    // this fixture belongs to that arm. Under `whole-item` the edge would leave
    // `A`'s QA and `B` would start on day 5.
    const found = steppedPlan(
      [item('A'), item('B')],
      [edge('A', 'B')],
      {
        A: [3, 2],
        B: [10, null],
      },
      'anchor-slice',
    );

    expect(found.slices.get(sliceKey('A', DEV))).toMatchObject({
      earliestStart: 0,
      earliestFinish: 3,
      float: 0,
      critical: true,
    });
    expect(found.slices.get(sliceKey('A', QA))).toMatchObject({
      earliestStart: 3,
      earliestFinish: 5,
      latestStart: 13,
      latestFinish: 15,
      float: 10,
      critical: false,
    });
    expect(projectionOf(found, 'A')).toMatchObject({ float: 0, critical: true });
    expect(projectionOf(found, 'B')).toMatchObject({
      earliestFinish: 15,
      float: 0,
      critical: true,
    });
  });

  it('a chain of anchors: each successor starts at its predecessor’s Dev finish', () => {
    // Three two-step items in a line. `A`'s Dev 0→2 releases `B` on day 2
    // while `A`'s QA runs 2→5 beside it; `B`'s Dev 2→6 releases `C` on day 6
    // while `B`'s QA runs 6→8 beside it. The rows: `A` 0→5, `B` 2→8, `C`
    // 6→12 — each QA tail overlapping the successor it no longer holds.
    const found = steppedPlan(
      [item('A'), item('B'), item('C')],
      [edge('A', 'B'), edge('B', 'C')],
      {
        A: [2, 3],
        B: [4, 2],
        C: [1, 5],
      },
      'anchor-slice',
    );

    expect(projectionOf(found, 'A')).toMatchObject({ earliestStart: 0, earliestFinish: 5 });
    expect(projectionOf(found, 'B')).toMatchObject({ earliestStart: 2, earliestFinish: 8 });
    expect(projectionOf(found, 'C')).toMatchObject({ earliestStart: 6, earliestFinish: 12 });
    // Day 6 is `B`'s Dev finish, not its QA's day 8: the wait was the anchor's.
    expect(found.slices.get(sliceKey('C', DEV))).toMatchObject({
      earliestStart: 6,
      boundBy: 'predecessor',
    });
  });

  it('a multi-step diamond joins at the latest anchor, not the latest projection', () => {
    // `A` [1, 1] fans out to `B` [3, 4] and `C` [6, 1]; `D` [2, 2] joins the
    // fan back in. Both branches start at `A`'s Dev finish, day 1: `B`'s Dev
    // 1→4, QA 4→8; `C`'s Dev 1→7, QA 7→8. Both projections end on day 8 — so
    // a join at the projections would put `D` at 8 either way. The anchors
    // differ: `B`'s Dev ends day 4, `C`'s day 7, and `D` starts at 7 — `C`'s
    // longer Dev is the binding predecessor.
    const found = steppedPlan(
      [item('A'), item('B'), item('C'), item('D')],
      [edge('A', 'B'), edge('A', 'C'), edge('B', 'D'), edge('C', 'D')],
      { A: [1, 1], B: [3, 4], C: [6, 1], D: [2, 2] },
      'anchor-slice',
    );

    expect(found.slices.get(sliceKey('C', DEV))).toMatchObject({ earliestFinish: 7 });
    expect(found.slices.get(sliceKey('B', DEV))).toMatchObject({ earliestFinish: 4 });
    expect(projectionOf(found, 'D')).toMatchObject({ earliestStart: 7, earliestFinish: 11 });
    expect(found.slices.get(sliceKey('D', DEV))).toMatchObject({ boundBy: 'predecessor' });
  });
});

describe('shapes — the project decides how far a dependency reaches', () => {
  it('a project’s reach decides what a successor waits for', () => {
    // The same plan, twice. `A` is Dev 0→3 then QA 3→5; `B` depends on it.
    // Under `whole-item` the wait is `A`'s **last** slice, so `B` starts on
    // day 5 and nothing of `A` runs beside it. Under `anchor-slice` the wait
    // is `A`'s Dev and `B` starts on day 3 with `A`'s QA alongside — the rule
    // `dep-waits-on-first-role` shipped on 2026-08-11, kept reachable.
    //
    // The dates that must **not** move are asserted beside the ones that do:
    // `A`'s own projection is 0→5 under either reach, because the reach
    // decides what an edge *leaves from* and never what a work item costs.
    //
    // Proof: `reachedSliceOf`'s `whole-item` arm made to return the anchor
    // index — the rule this change replaced — and this failed on
    // `expect(received).toBe(expected) / Expected: 5 / Received: 3`; watched
    // 2026-08-29.
    const whole = steppedPlan(
      [item('A'), item('B')],
      [edge('A', 'B')],
      { A: [3, 2], B: [1, 1] },
      'whole-item',
    );

    expect(projectionOf(whole, 'B')).toMatchObject({ earliestStart: 5, earliestFinish: 7 });
    expect(whole.slices.get(sliceKey('B', DEV))).toMatchObject({
      earliestStart: 5,
      boundBy: 'predecessor',
    });
    expect(whole.slices.get(sliceKey('A', QA))).toMatchObject({
      earliestStart: 3,
      earliestFinish: 5,
    });
    expect(projectionOf(whole, 'A')).toMatchObject({ earliestStart: 0, earliestFinish: 5 });

    const anchored = steppedPlan(
      [item('A'), item('B')],
      [edge('A', 'B')],
      { A: [3, 2], B: [1, 1] },
      'anchor-slice',
    );

    expect(projectionOf(anchored, 'B')).toMatchObject({ earliestStart: 3, earliestFinish: 5 });
    // Unmoved by the reach: the predecessor's own span is what its estimates say.
    expect(projectionOf(anchored, 'A')).toMatchObject({ earliestStart: 0, earliestFinish: 5 });
  });

  it('the anchor reach is still available and still means what it did', () => {
    // The August rule's own probe, run under the value that now asks for it:
    // three roles, only `Dev` estimated, a chain of three. `Design` is
    // unestimated, so the anchor walk steps **over** it — that walk reads
    // `days !== null` and not a duration, which is exactly what
    // `assumed-duration-schedules` left alone — and each edge leaves its
    // predecessor's `Dev`.
    //
    // **Re-derived by `assumed-duration-schedules` (2026-08-29), and the
    // re-derivation is worth reading rather than skipping.** Until it landed,
    // `Design` and `QA` were zero days long, so this fixture ran 0→4, 4→8,
    // 8→12 and **the two reaches agreed on it** — `c1`'s last slice finished
    // where its `Dev` did. They no longer agree: an unestimated step is two
    // workdays, so `c1` is Design 0→2, Dev 2→6, QA 6→8, and the anchor's day 6
    // and the last slice's day 8 are two days apart. The reach is therefore
    // asserted on both arms here rather than pinned to one, because this
    // fixture has become a place they can be told apart.
    const anchored = threeStepPlan(
      [item('c1'), item('c2'), item('c3')],
      [edge('c1', 'c2'), edge('c2', 'c3')],
      { c1: [null, 4, null], c2: [null, 4, null], c3: [null, 4, null] },
      'anchor-slice',
    );

    // Each successor starts at its predecessor's **Dev** finish: 6, then 12.
    expect(projectionOf(anchored, 'c2')).toMatchObject({ earliestStart: 6, earliestFinish: 14 });
    expect(projectionOf(anchored, 'c3')).toMatchObject({ earliestStart: 12, earliestFinish: 20 });

    const whole = threeStepPlan(
      [item('c1'), item('c2'), item('c3')],
      [edge('c1', 'c2'), edge('c2', 'c3')],
      { c1: [null, 4, null], c2: [null, 4, null], c3: [null, 4, null] },
      'whole-item',
    );

    // And at its predecessor's **QA** finish under the default: 8, then 16.
    expect(projectionOf(whole, 'c2')).toMatchObject({ earliestStart: 8, earliestFinish: 16 });
    expect(projectionOf(whole, 'c3')).toMatchObject({ earliestStart: 16, earliestFinish: 24 });
    // And the predecessor's later steps really do run alongside the successor,
    // which is the whole of what the anchor reach is for. `A`'s QA is
    // estimated here so that "alongside" is a span rather than a point.
    const alongside = steppedPlan(
      [item('A'), item('B')],
      [edge('A', 'B')],
      { A: [2, 6], B: [3, 1] },
      'anchor-slice',
    );

    expect(alongside.slices.get(sliceKey('A', QA))).toMatchObject({
      earliestStart: 2,
      earliestFinish: 8,
    });
    expect(alongside.slices.get(sliceKey('B', DEV))).toMatchObject({
      earliestStart: 2,
      earliestFinish: 5,
    });
  });

  it('a predecessor nobody estimated is reached at its own finish under either reach', () => {
    // The degenerate case, and the one place the two arms are the same line of
    // code: `anchor-slice` falls through to the leaf's last slice when nothing
    // is estimated, and `whole-item` is that fall-through unconditionally. So
    // both name the same slice, and both answer the same day.
    //
    // **Re-derived by `assumed-duration-schedules` (2026-08-29.)** That day used
    // to be zero — an unestimated leaf finished where it started, so the edge
    // imposed nothing. `A`'s three unestimated steps are two workdays each now,
    // so `A` runs 0→6 and `B` waits until 6 under either reach. The claim this
    // case makes is unchanged and is the reason it survives the re-derivation:
    // the two arms agree, whatever the number is.
    for (const reach of ['whole-item', 'anchor-slice'] as const) {
      const found = threeStepPlan(
        [item('A'), item('B')],
        [edge('A', 'B')],
        { A: [null, null, null], B: [2, null, null] },
        reach,
      );

      expect(projectionOf(found, 'A'), reach).toMatchObject({
        earliestStart: 0,
        earliestFinish: 6,
      });
      expect(projectionOf(found, 'B').earliestStart, reach).toBe(6);
    }

    // And the wait such a predecessor was itself under is carried through
    // rather than lost — under either reach, at each reach's own day.
    //
    // **The two reaches part company here now, and they did not before.** `A`
    // is Design 0→2 (assumed), Dev 2→5 (estimated), QA 5→7 (assumed). Its
    // anchor is the Dev, finishing on day 5; its last slice is the QA,
    // finishing on day 7. While an unestimated slice took no time those were
    // the same day, and this loop could assert one number for both arms. They
    // are two days apart now, which makes this case a sharper test of the
    // reach than it was: `B` — estimated nowhere, six assumed days long —
    // carries whichever wait it was put under through to `C`.
    for (const [reach, waited, carried] of [
      ['whole-item', 7, 13],
      ['anchor-slice', 5, 11],
    ] as const) {
      const found = threeStepPlan(
        [item('A'), item('B'), item('C')],
        [edge('A', 'B'), edge('B', 'C')],
        { A: [null, 3, null], B: [null, null, null], C: [1, null, null] },
        reach,
      );

      expect(projectionOf(found, 'B'), reach).toMatchObject({
        earliestStart: waited,
        earliestFinish: carried,
      });
      expect(projectionOf(found, 'C').earliestStart, reach).toBe(carried);
    }
  });

  it('a parent predecessor expands to its leaves under either reach', () => {
    // `P` holds two leaves and `Q` waits on `P`. Each leaf's own reached slice
    // has to finish before `Q` starts, and the two reaches disagree about
    // which slice that is: `P1` is Dev 0→2 then QA 2→5, `P2` is Dev 0→1 then
    // QA 1→2. Anchors finish on days 2 and 1 — `Q` at 2. Last slices finish on
    // days 5 and 2 — `Q` at 5.
    //
    // The successor side is asserted, not just the number: the edge lands on
    // `Q`'s **first** slice plain under either reach, and `Q`'s QA follows in
    // step order behind it. That is the asymmetry `dep-waits-on-first-role`
    // established and this change does not touch.
    //
    // Proof: the reach applied to the successor's end as well — the edge
    // joined to `reachedNodeOf(successorId)` instead of `firstNodeOf` — and
    // this failed on `expect(received).toMatchObject(expected)`, `Q`'s
    // projection `{ earliestStart: 5, earliestFinish: 11 }` against a received
    // `{ earliestStart: 0, earliestFinish: 7 }`: the row's own first step
    // escaped the wait entirely and only its QA was held. Watched 2026-08-30.
    const rows = [item('P'), item('P1', 'P'), item('P2', 'P'), item('Q')];
    const days: Record<string, [number | null, number | null]> = {
      P1: [2, 3],
      P2: [1, 1],
      Q: [4, 2],
    };

    const whole = steppedPlan(rows, [edge('P', 'Q')], days, 'whole-item');

    expect(projectionOf(whole, 'Q')).toMatchObject({ earliestStart: 5, earliestFinish: 11 });
    expect(whole.slices.get(sliceKey('Q', DEV))).toMatchObject({
      earliestStart: 5,
      earliestFinish: 9,
      boundBy: 'predecessor',
    });
    expect(whole.slices.get(sliceKey('Q', QA))).toMatchObject({
      earliestStart: 9,
      boundBy: 'stepOrder',
    });
    // The parent itself is spanned over its leaves and is not moved by the reach.
    expect(projectionOf(whole, 'P')).toMatchObject({ earliestStart: 0, earliestFinish: 5 });

    const anchored = steppedPlan(rows, [edge('P', 'Q')], days, 'anchor-slice');

    expect(projectionOf(anchored, 'Q')).toMatchObject({ earliestStart: 2, earliestFinish: 8 });
    expect(anchored.slices.get(sliceKey('Q', DEV))).toMatchObject({
      earliestStart: 2,
      boundBy: 'predecessor',
    });
    expect(projectionOf(anchored, 'P')).toMatchObject({ earliestStart: 0, earliestFinish: 5 });
  });

  it('two plans in one run keep their own reaches', () => {
    // The reach is an argument, so it has to be read per call and not once.
    // Two schedules of the same rows in one process, in both orders, so a
    // module-level memo of the first answer is visible whichever way round it
    // is cached.
    //
    // Proof: `reachedSliceOf` given a module-level `let held` memo of its first
    // answer and this failed on `Expected: 5 / Received: 3` for the second
    // plan's `B`; watched 2026-08-29.
    const rows = [item('A'), item('B')];
    const days: Record<string, [number | null, number | null]> = { A: [3, 2], B: [1, 1] };

    const anchoredFirst = steppedPlan(rows, [edge('A', 'B')], days, 'anchor-slice');
    const wholeSecond = steppedPlan(rows, [edge('A', 'B')], days, 'whole-item');

    expect(projectionOf(anchoredFirst, 'B').earliestStart).toBe(3);
    expect(projectionOf(wholeSecond, 'B').earliestStart).toBe(5);

    const wholeFirst = steppedPlan(rows, [edge('A', 'B')], days, 'whole-item');
    const anchoredSecond = steppedPlan(rows, [edge('A', 'B')], days, 'anchor-slice');

    expect(projectionOf(wholeFirst, 'B').earliestStart).toBe(5);
    expect(projectionOf(anchoredSecond, 'B').earliestStart).toBe(3);
  });

  it('refuses a cycle under either reach', () => {
    // The reach moves which slice an edge leaves from, and every chain it can
    // leave from is still one work item's own private forward path — so a
    // cycle is still a property of the leaf graph and still a refusal. Asserted
    // rather than argued, because "the reach cannot reach a cycle" is exactly
    // the kind of claim that stops being true quietly.
    for (const reach of ['whole-item', 'anchor-slice'] as const) {
      expect(() =>
        steppedPlan(
          [item('A'), item('B')],
          [edge('A', 'B'), edge('B', 'A')],
          { A: [3, 2], B: [1, 1] },
          reach,
        ),
      ).toThrow(/cycle/i);
    }
  });
});

describe('shapes — a multi-role dependency beside a manual floor', () => {
  it('lets the floor win over the anchor when it is the later of the two', () => {
    // `A`'s anchor lets go on day 2 (Dev 0→2, QA 2→4 beside everything), and
    // `B`'s own floor says day 5: the floor is later, `B`'s Dev runs 5→8, its
    // QA 8→9, and the floor is named.
    const found = steppedPlan(
      [item('A'), item('B')],
      [edge('A', 'B')],
      { A: [2, 2], B: [3, 1] },
      'anchor-slice',
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
    const found = steppedPlan(
      [item('A'), item('B')],
      [edge('A', 'B')],
      { A: [4, 2], B: [3, 1] },
      'anchor-slice',
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
    const rows: PlannedRow[] = [];
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
