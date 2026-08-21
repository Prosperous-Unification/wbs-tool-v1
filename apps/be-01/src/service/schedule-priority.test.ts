import { describe, expect, it } from 'bun:test';

import type { WorkItem } from '../repository';
import type { DependencyEdge, Schedule, ScheduledSlice, Slice } from './schedule';
import { schedule, sliceKey } from './schedule';

/**
 * Priority, which is a prioritising of the leveller's queue and nothing else.
 *
 * Every case here is built around **contention**: two slices that could both
 * start, wanting the same person. That is the only situation in which the
 * schedule has a choice to make, and priority exists to decide it. A plan with
 * nobody assigned appears here exactly once — in the regression that says it
 * does not move.
 */

const DEV = 'role-dev';
const QA = 'role-qa';

let position = 0;
const item = (
  id: string,
  parentId: string | null = null,
  priority: number | null = null,
): WorkItem => ({
  id,
  projectId: 'p1',
  parentId,
  position: (position += 10),
  name: id,
  notes: '',
  frozenNumber: null,
  startNoEarlierThan: null,
  priority,
  serviceTeamId: null,
  serviceId: null,
  maxParallel: 1,
  revision: 0,
});

const edge = (predecessorId: string, successorId: string): DependencyEdge => ({
  predecessorId,
  successorId,
});

const slice = (
  workItemId: string,
  roleId: string,
  days: number | null,
  personId: string | null = null,
): Slice => ({ workItemId, roleId, days, personId, width: 1, poolId: null });

/** One slice's schedule, or a throw — a missing key is a broken fixture, not a null. */
const planned = (found: Schedule, workItemId: string, roleId: string): ScheduledSlice => {
  const one = found.slices.get(sliceKey(workItemId, roleId));
  if (one === undefined) throw new Error(`no slice for ${workItemId}/${roleId}`);
  return one;
};

describe('priority orders the leveller’s queue', () => {
  it('starts the smaller priority first when two work items want one person', () => {
    // `a` reads first and has the *less* slack of the two, so without priority
    // it takes the person and `b` waits — see the tie-break rule in
    // `goesFirst`. Priority 1 on `b` inverts exactly that.
    const rows = [item('a', null, 2), item('b', null, 1)];
    const slices = [slice('a', DEV, 3, 'kat'), slice('b', DEV, 2, 'kat')];

    const found = schedule(rows, [], slices);

    expect(planned(found, 'b', DEV)).toMatchObject({ earliestStart: 0, earliestFinish: 2 });
    expect(planned(found, 'a', DEV)).toMatchObject({
      earliestStart: 2,
      earliestFinish: 5,
      boundBy: 'person',
    });
  });

  it('puts a work item nobody has given a priority behind one somebody has', () => {
    // The unset priority is `+Infinity`, not zero and not "wherever the row sits":
    // a plan half-prioritised is a plan whose prioritised work goes first.
    const rows = [item('a'), item('b', null, 9)];
    const slices = [slice('a', DEV, 3, 'kat'), slice('b', DEV, 2, 'kat')];

    const found = schedule(rows, [], slices);

    expect(planned(found, 'b', DEV)).toMatchObject({ earliestStart: 0, earliestFinish: 2 });
    expect(planned(found, 'a', DEV)).toMatchObject({ earliestStart: 2, boundBy: 'person' });
  });

  it('asks priority before float, and float still decides between equals', () => {
    // The same two work items twice. Ranked equally, the float rule that has
    // always decided this decides it — `a` has none and goes first. Ranked
    // apart, priority overrules it and the slacker goes first, which is the
    // whole point: a planner who says "this one matters" is overruling the
    // engine's own guess at what matters.
    const tied = schedule(
      [item('a', null, 3), item('b', null, 3)],
      [],
      [slice('a', DEV, 3, 'kat'), slice('b', DEV, 2, 'kat')],
    );
    expect(planned(tied, 'a', DEV)).toMatchObject({ earliestStart: 0 });
    expect(planned(tied, 'b', DEV)).toMatchObject({ earliestStart: 3, boundBy: 'person' });

    const prioritised = schedule(
      [item('a', null, 3), item('b', null, 2)],
      [],
      [slice('a', DEV, 3, 'kat'), slice('b', DEV, 2, 'kat')],
    );
    expect(planned(prioritised, 'b', DEV)).toMatchObject({ earliestStart: 0 });
    expect(planned(prioritised, 'a', DEV)).toMatchObject({ earliestStart: 2, boundBy: 'person' });
  });
});

describe('priority never overrides a hard constraint', () => {
  it('still waits for a predecessor', () => {
    // The sentence this file exists to make true: priority decides who goes
    // first when the schedule has a choice, not who defies their dependencies.
    const rows = [item('a', null, 9), item('b', null, 1)];
    const slices = [slice('a', DEV, 3, 'kat'), slice('b', DEV, 2, 'kat')];

    const found = schedule(rows, [edge('a', 'b')], slices);

    expect(planned(found, 'a', DEV)).toMatchObject({ earliestStart: 0, earliestFinish: 3 });
    expect(planned(found, 'b', DEV)).toMatchObject({
      earliestStart: 3,
      earliestFinish: 5,
      boundBy: 'predecessor',
    });
  });

  it('still waits for its own floor', () => {
    const rows = [item('a', null, 9), item('b', null, 1)];
    const slices = [slice('a', DEV, 3, 'kat'), slice('b', DEV, 2, 'kat')];

    const found = schedule(rows, [], slices, new Map([['b', 4]]));

    // `b` outranks `a` and is still not allowed to begin before day 4: the
    // floor binds whatever the priority says, which is the claim.
    expect(planned(found, 'b', DEV)).toMatchObject({
      earliestStart: 4,
      earliestFinish: 6,
      boundBy: 'notBefore',
    });
    // And `a` waits for `kat` rather than filling the gap in front of `b`.
    // That is the leveller this repository already had — one pass, every slice
    // placed once and never moved, nothing backfilled — and prioritising `b` first
    // is therefore a decision to hold the person for it. It is the honest
    // reading of "more priority means start earlier": the prioritised work gets the
    // person, and the cost is idle days in front of it.
    expect(planned(found, 'a', DEV)).toMatchObject({
      earliestStart: 6,
      earliestFinish: 9,
      boundBy: 'person',
    });
  });

  it('keeps a work item’s own roles in role order', () => {
    // Priority is per work item, so both of a work item's slices carry it —
    // and a priority cannot reorder them against each other, because the role
    // chain is a plan edge like any other.
    const rows = [item('a', null, 2), item('b', null, 1)];
    const slices = [
      slice('a', DEV, 2, 'kat'),
      slice('a', QA, 2, 'sam'),
      slice('b', DEV, 2, 'kat'),
      slice('b', QA, 2, 'sam'),
    ];

    const found = schedule(rows, [], slices);

    expect(planned(found, 'b', DEV)).toMatchObject({ earliestStart: 0, earliestFinish: 2 });
    expect(planned(found, 'b', QA)).toMatchObject({ earliestStart: 2, earliestFinish: 4 });
    expect(planned(found, 'a', DEV)).toMatchObject({ earliestStart: 2, earliestFinish: 4 });
    expect(planned(found, 'a', QA)).toMatchObject({ earliestStart: 4, earliestFinish: 6 });
  });

  it('gives a slice nobody has estimated no place in the queue, whatever its priority', () => {
    // A slice of no length is not work: it neither waits for its assignee nor
    // makes them busy. Ranking it first must not change that — a priority decides
    // an order, and an empty slice occupies nobody for any of it.
    const rows = [item('a', null, 1), item('b', null, 2)];
    const slices = [
      slice('a', DEV, null, 'kat'),
      slice('a', QA, 3, 'kat'),
      slice('b', DEV, 2, 'kat'),
    ];

    const found = schedule(rows, [], slices);

    expect(planned(found, 'a', DEV)).toMatchObject({
      earliestStart: 0,
      earliestFinish: 0,
      boundBy: 'projectStart',
    });
    expect(planned(found, 'a', QA)).toMatchObject({ earliestStart: 0, earliestFinish: 3 });
    expect(planned(found, 'b', DEV)).toMatchObject({ earliestStart: 3, boundBy: 'person' });
  });
});

describe('a priority written up the tree reaches the leaves', () => {
  it('carries a parent’s priority to a leaf that has none', () => {
    // `x` is declared first, so it holds the earlier number and takes the
    // person on every tie-break this engine had before priority. The parent's
    // 1 reaching its leaf is the only thing that can turn that round.
    const rows = [item('x', null, 2), item('p', null, 1), item('p-leaf', 'p')];
    const slices = [slice('x', DEV, 2, 'kat'), slice('p-leaf', DEV, 2, 'kat')];

    const found = schedule(rows, [], slices);

    expect(planned(found, 'p-leaf', DEV)).toMatchObject({ earliestStart: 0 });
    expect(planned(found, 'x', DEV)).toMatchObject({ earliestStart: 2, boundBy: 'person' });
  });

  it('lets a leaf’s own priority beat its parent’s, in both directions', () => {
    // Both directions, because a rule that only ever tightened would pass the
    // first of these on the floor rule's `Math.min` and fail the second.
    const beneath = schedule(
      [item('p', null, 1), item('p-leaf', 'p', 5), item('x', null, 2)],
      [],
      [slice('p-leaf', DEV, 2, 'kat'), slice('x', DEV, 2, 'kat')],
    );
    // The leaf says 5, its parent says 1, and 5 is what it is placed with: `x`
    // at 2 outranks it and goes first.
    expect(planned(beneath, 'x', DEV)).toMatchObject({ earliestStart: 0 });
    expect(planned(beneath, 'p-leaf', DEV)).toMatchObject({
      earliestStart: 2,
      boundBy: 'person',
    });

    const above = schedule(
      [item('q', null, 5), item('q-leaf', 'q', 1), item('y', null, 2)],
      [],
      [slice('q-leaf', DEV, 2, 'kat'), slice('y', DEV, 2, 'kat')],
    );
    expect(planned(above, 'q-leaf', DEV)).toMatchObject({ earliestStart: 0 });
    expect(planned(above, 'y', DEV)).toMatchObject({ earliestStart: 2, boundBy: 'person' });
  });

  it('gives the nearer ancestor’s priority to a leaf between two', () => {
    // Grandparent 1, parent 5, leaf unprioritised. The most specific statement
    // wins, so the leaf is a 5 and the standalone 2 outranks it. Under the
    // floor rule — the latest, or here the smallest, of everything that
    // applies — the leaf would be a 1 and would go first.
    const rows = [
      item('g', null, 1),
      item('g-mid', 'g', 5),
      item('g-leaf', 'g-mid'),
      item('z', null, 2),
    ];
    const slices = [slice('g-leaf', DEV, 2, 'kat'), slice('z', DEV, 2, 'kat')];

    const found = schedule(rows, [], slices);

    expect(planned(found, 'z', DEV)).toMatchObject({ earliestStart: 0 });
    expect(planned(found, 'g-leaf', DEV)).toMatchObject({ earliestStart: 2, boundBy: 'person' });
  });
});

/**
 * A plan with contention in every shape this engine knows — three people
 * queueing, a dependency, a floor, a work item split across two people, an
 * unestimated slice and a two-level parent — and **not one priority anywhere**.
 *
 * The numbers below were taken from this engine before priority existed
 * (`main` @ `94ed488`, 2026-08-11) and are pinned verbatim. They are the
 * regression: adding a prioritising to the queue must not move a plan that priorities
 * nothing, and the only proof of that is the plan itself.
 *
 * Three of them were **re-derived** at `dep-waits-on-first-role` (2026-08-11),
 * which moved this plan on purpose: `c-c` waits on `c-a`'s anchor — its `Dev`,
 * finishing day 7 — instead of on the whole of `c-a`, so `c-c/role-dev` starts
 * 8 → 7, and sam's queue reverses behind it: `c-a/role-qa` 7 → 9.5 with
 * `boundBy` `roleOrder` → `person` and `c-c/role-dev` as its resource
 * predecessor, while `c-p1/role-qa` — unestimated, floating — takes the
 * project's new finish, float 3.5 → 6.5. Everything else is untouched, which is
 * the point: the anchor rule moves what waits on a dependency and nothing else.
 * Priority is still what this pin is *for*; the plan still priorities nothing.
 */
const CONTENTION_ROWS: readonly WorkItem[] = [
  item('c-a'),
  item('c-b'),
  item('c-parent'),
  item('c-p1', 'c-parent'),
  item('c-p2', 'c-parent'),
  item('c-c'),
  item('c-d'),
];

const CONTENTION_SLICES: readonly Slice[] = [
  slice('c-a', DEV, 3, 'kat'),
  slice('c-a', QA, 1, 'sam'),
  slice('c-b', DEV, 2, 'kat'),
  slice('c-p1', DEV, 4, 'kat'),
  slice('c-p1', QA, null, 'sam'),
  slice('c-p2', DEV, 1, 'ro'),
  slice('c-c', DEV, 2.5, 'sam'),
  slice('c-d', DEV, 3, 'ro'),
];

const CONTENTION_EDGES: readonly DependencyEdge[] = [edge('c-a', 'c-c'), edge('c-parent', 'c-d')];

const CONTENTION_FLOORS = new Map([['c-b', 1]]);

describe('a plan that priorities nothing is scheduled exactly as it was', () => {
  it('answers what the engine answered before priority existed', () => {
    const found = schedule(CONTENTION_ROWS, CONTENTION_EDGES, CONTENTION_SLICES, CONTENTION_FLOORS);

    // The key is opaque and NUL-separated — written as an escape here for the
    // same reason `sliceKey` writes it as one: a literal NUL in a source file
    // makes git call the file binary.
    const readable = (key: string): string => key.replace('\u0000', '/');

    // **Every field of every slice**, not a projection of some of them. An
    // earlier version of this pin listed seven fields and left out
    // `resourcePredecessorId` — which is precisely the leveller's own artifact,
    // the record of *who waited behind whom*. A prioritising that reordered the
    // queue while landing every slice on the same day would have moved that
    // field and nothing else, and a seven-field pin would have called the plan
    // unchanged. `personId`, `duration` and `estimated` are here for the same
    // reason: what is not asserted is not pinned.
    const saidOfSlices = [...found.slices]
      .map(([key, placed]): [string, unknown] => [
        readable(key),
        {
          ...placed,
          resourcePredecessorId:
            placed.resourcePredecessorId === null ? null : readable(placed.resourcePredecessorId),
        },
      ])
      .sort(([left], [right]) => (left < right ? -1 : 1));

    expect(Object.fromEntries(saidOfSlices)).toEqual({
      'c-a/role-dev': {
        workItemId: 'c-a',
        roleId: 'role-dev',
        duration: 3,
        effort: 3,
        width: 1,
        estimated: true,
        earliestStart: 4,
        earliestFinish: 7,
        latestStart: 4,
        latestFinish: 7,
        float: 0,
        critical: true,
        personId: 'kat',
        boundBy: 'person',
        resourcePredecessorId: 'c-p1/role-dev',
        capacityPredecessorIds: [],
      },
      'c-a/role-qa': {
        workItemId: 'c-a',
        roleId: 'role-qa',
        duration: 1,
        effort: 1,
        width: 1,
        estimated: true,
        earliestStart: 9.5,
        earliestFinish: 10.5,
        latestStart: 9.5,
        latestFinish: 10.5,
        float: 0,
        critical: true,
        personId: 'sam',
        boundBy: 'person',
        resourcePredecessorId: 'c-c/role-dev',
        capacityPredecessorIds: [],
      },
      'c-b/role-dev': {
        workItemId: 'c-b',
        roleId: 'role-dev',
        duration: 2,
        effort: 2,
        width: 1,
        estimated: true,
        earliestStart: 7,
        earliestFinish: 9,
        latestStart: 8.5,
        latestFinish: 10.5,
        float: 1.5,
        critical: false,
        personId: 'kat',
        boundBy: 'person',
        resourcePredecessorId: 'c-a/role-dev',
        capacityPredecessorIds: [],
      },
      'c-c/role-dev': {
        workItemId: 'c-c',
        roleId: 'role-dev',
        duration: 2.5,
        effort: 2.5,
        width: 1,
        estimated: true,
        earliestStart: 7,
        earliestFinish: 9.5,
        latestStart: 7,
        latestFinish: 9.5,
        float: 0,
        critical: true,
        personId: 'sam',
        boundBy: 'predecessor',
        resourcePredecessorId: null,
        capacityPredecessorIds: [],
      },
      'c-d/role-dev': {
        workItemId: 'c-d',
        roleId: 'role-dev',
        duration: 3,
        effort: 3,
        width: 1,
        estimated: true,
        earliestStart: 4,
        earliestFinish: 7,
        latestStart: 7.5,
        latestFinish: 10.5,
        float: 3.5,
        critical: false,
        personId: 'ro',
        boundBy: 'predecessor',
        resourcePredecessorId: null,
        capacityPredecessorIds: [],
      },
      'c-p1/role-dev': {
        workItemId: 'c-p1',
        roleId: 'role-dev',
        duration: 4,
        effort: 4,
        width: 1,
        estimated: true,
        earliestStart: 0,
        earliestFinish: 4,
        latestStart: 0,
        latestFinish: 4,
        float: 0,
        critical: true,
        personId: 'kat',
        boundBy: 'projectStart',
        resourcePredecessorId: null,
        capacityPredecessorIds: [],
      },
      'c-p1/role-qa': {
        workItemId: 'c-p1',
        roleId: 'role-qa',
        duration: 0,
        effort: 0,
        width: 1,
        estimated: false,
        earliestStart: 4,
        earliestFinish: 4,
        latestStart: 10.5,
        latestFinish: 10.5,
        float: 6.5,
        critical: false,
        personId: 'sam',
        boundBy: 'roleOrder',
        resourcePredecessorId: null,
        capacityPredecessorIds: [],
      },
      'c-p2/role-dev': {
        workItemId: 'c-p2',
        roleId: 'role-dev',
        duration: 1,
        effort: 1,
        width: 1,
        estimated: true,
        earliestStart: 0,
        earliestFinish: 1,
        latestStart: 6.5,
        latestFinish: 7.5,
        float: 6.5,
        critical: false,
        personId: 'ro',
        boundBy: 'projectStart',
        resourcePredecessorId: null,
        capacityPredecessorIds: [],
      },
    });

    // The projection the table actually reads, pinned beside the slices it is
    // read off: `c-parent` appears here and nowhere above, so a change that
    // moved only the roll-up onto parents would pass a slices-only pin.
    //
    // Re-derived with the slices above at `dep-waits-on-first-role`: `c-a`
    // finishes 8 → 10.5 because its `QA` was pushed behind `c-c`, `c-c` runs
    // 7 → 9.5, and the two `latestFinish`es that read the project's end
    // (`c-p1`, `c-parent`) follow it 7.5 → 10.5.
    const saidOfWorkItems = [...found.workItems].sort(([left], [right]) => (left < right ? -1 : 1));

    expect(Object.fromEntries(saidOfWorkItems)).toEqual({
      'c-a': {
        duration: 4,
        estimated: true,
        earliestStart: 4,
        earliestFinish: 10.5,
        latestStart: 4,
        latestFinish: 10.5,
        float: 0,
        critical: true,
      },
      'c-b': {
        duration: 2,
        estimated: true,
        earliestStart: 7,
        earliestFinish: 9,
        latestStart: 8.5,
        latestFinish: 10.5,
        float: 1.5,
        critical: false,
      },
      'c-c': {
        duration: 2.5,
        estimated: true,
        earliestStart: 7,
        earliestFinish: 9.5,
        latestStart: 7,
        latestFinish: 9.5,
        float: 0,
        critical: true,
      },
      'c-d': {
        duration: 3,
        estimated: true,
        earliestStart: 4,
        earliestFinish: 7,
        latestStart: 7.5,
        latestFinish: 10.5,
        float: 3.5,
        critical: false,
      },
      'c-p1': {
        duration: 4,
        estimated: true,
        earliestStart: 0,
        earliestFinish: 4,
        latestStart: 0,
        latestFinish: 10.5,
        float: 0,
        critical: true,
      },
      'c-p2': {
        duration: 1,
        estimated: true,
        earliestStart: 0,
        earliestFinish: 1,
        latestStart: 6.5,
        latestFinish: 7.5,
        float: 6.5,
        critical: false,
      },
      'c-parent': {
        duration: 0,
        estimated: true,
        earliestStart: 0,
        earliestFinish: 4,
        latestStart: 0,
        latestFinish: 10.5,
        float: 0,
        critical: true,
      },
    });

    expect(found.waitingForPerson).toBe(2);
  });
});
