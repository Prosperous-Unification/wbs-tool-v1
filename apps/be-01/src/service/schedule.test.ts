import { describe, expect, it } from 'bun:test';

import type { WorkItem } from '../repository';
import type { DependencyEdge, Scheduled, ScheduledSlice, Slice } from './schedule';
import { schedule as planSlices, sliceKey } from './schedule';

/** The one role this file's fixtures plan in. Their subject is the graph, not the roles. */
const ONLY_ROLE = 'role-dev';

/**
 * Every assertion below this line predates slices and is unchanged, because
 * the change that introduced them promised no plan would move. `durations`
 * becomes one slice per leaf and the projection is read back out — the
 * expectations are the ones the previous engine was written against.
 *
 * Nobody is assigned to any of it, which is the second promise: leveling is
 * invisible until somebody is. `resource-leveling` added the field and changed
 * nothing else in this file.
 */
const schedule = (
  rows: readonly WorkItem[],
  edges: readonly DependencyEdge[],
  durations: ReadonlyMap<string, number>,
  notBefore?: ReadonlyMap<string, number>,
): Map<string, Scheduled> => {
  const childless = new Set(rows.map((row) => row.parentId).filter((id) => id !== null));
  const slices: Slice[] = rows
    .filter((row) => !childless.has(row.id))
    .map((row) => ({
      workItemId: row.id,
      roleId: ONLY_ROLE,
      days: durations.get(row.id) ?? null,
      personId: null,
      width: 1,
      poolIds: [],
    }));
  return planSlices(rows, edges, slices, notBefore).workItems;
};

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

/** Whole days per leaf, the shape `schedule` takes rather than raw estimates. */
const days = (entries: Record<string, number>): Map<string, number> =>
  new Map(Object.entries(entries));

describe('schedule — the forward pass', () => {
  it('starts a leaf with no predecessor on day zero', () => {
    const rows = [item('a')];

    const found = schedule(rows, [], days({ a: 3 }));

    expect(found.get('a')).toMatchObject({ earliestStart: 0, earliestFinish: 3 });
  });

  it('makes a leaf wait for the one it depends on', () => {
    const rows = [item('a'), item('b')];

    const found = schedule(rows, [edge('a', 'b')], days({ a: 3, b: 2 }));

    expect(found.get('b')).toMatchObject({ earliestStart: 3, earliestFinish: 5 });
  });

  it('waits for the later of two predecessors', () => {
    const rows = [item('a'), item('b'), item('c')];

    const found = schedule(rows, [edge('a', 'c'), edge('b', 'c')], days({ a: 3, b: 7, c: 1 }));

    expect(found.get('c')).toMatchObject({ earliestStart: 7, earliestFinish: 8 });
  });

  it('accumulates along a chain', () => {
    const rows = [item('a'), item('b'), item('c')];

    const found = schedule(rows, [edge('a', 'b'), edge('b', 'c')], days({ a: 1, b: 2, c: 4 }));

    expect(found.get('c')).toMatchObject({ earliestStart: 3, earliestFinish: 7 });
  });
});

describe('schedule — float and the critical path', () => {
  /**
   * ```
   * long-1 (5) ─→ long-2 (5)      finishes day 10
   * short  (3)                    finishes day 3, and has 7 days of slack
   * ```
   */
  const parallel = () => {
    const rows = [item('long-1'), item('long-2'), item('short')];
    return schedule(rows, [edge('long-1', 'long-2')], days({ 'long-1': 5, 'long-2': 5, short: 3 }));
  };

  it('gives the long chain no float and marks it critical', () => {
    const found = parallel();

    expect(found.get('long-1')).toMatchObject({ float: 0, critical: true });
    expect(found.get('long-2')).toMatchObject({ float: 0, critical: true });
  });

  it('gives the short branch its slack and does not mark it', () => {
    const found = parallel();

    expect(found.get('short')).toMatchObject({
      earliestStart: 0,
      latestStart: 7,
      float: 7,
      critical: false,
    });
  });

  it('measures float against the project finish, not against a neighbour', () => {
    // `b` can slip two days and still make the day-6 finish `c` sets.
    const rows = [item('a'), item('b'), item('c')];

    const found = schedule(rows, [edge('a', 'b'), edge('a', 'c')], days({ a: 2, b: 2, c: 4 }));

    expect(found.get('b')?.float).toBe(2);
    expect(found.get('c')?.float).toBe(0);
  });
});

describe('schedule — parents', () => {
  it('spans its children rather than summing them', () => {
    // Two independent children of 3 and 4 days: 7 days of effort, 4 days of span.
    // The roll-up already reports the effort; conflating the two is the mistake
    // this separation exists to prevent.
    const rows = [item('parent'), item('kid-a', 'parent'), item('kid-b', 'parent')];

    const found = schedule(rows, [], days({ 'kid-a': 3, 'kid-b': 4 }));

    expect(found.get('parent')).toMatchObject({ earliestStart: 0, earliestFinish: 4 });
  });

  it('starts when the earliest of its descendants starts', () => {
    const rows = [item('parent'), item('kid-a', 'parent'), item('kid-b', 'parent'), item('before')];

    const found = schedule(
      rows,
      [edge('before', 'kid-a')],
      days({ before: 2, 'kid-a': 1, 'kid-b': 5 }),
    );

    // `kid-b` is free to start at 0; `kid-a` waits until 2. The branch spans both.
    expect(found.get('parent')).toMatchObject({ earliestStart: 0, earliestFinish: 5 });
  });

  it('reaches through more than one level', () => {
    const rows = [item('top'), item('mid', 'top'), item('leaf', 'mid')];

    const found = schedule(rows, [], days({ leaf: 6 }));

    expect(found.get('top')).toMatchObject({ earliestStart: 0, earliestFinish: 6 });
    expect(found.get('mid')).toMatchObject({ earliestStart: 0, earliestFinish: 6 });
  });
});

describe('schedule — a dependency declared on a parent', () => {
  it('waits for every leaf beneath the predecessor', () => {
    const rows = [item('phase'), item('p-fast', 'phase'), item('p-slow', 'phase'), item('after')];

    const found = schedule(
      rows,
      [edge('phase', 'after')],
      days({ 'p-fast': 1, 'p-slow': 6, after: 2 }),
    );

    expect(found.get('after')).toMatchObject({ earliestStart: 6, earliestFinish: 8 });
  });

  it('constrains every leaf beneath the successor', () => {
    const rows = [item('first'), item('phase'), item('p-a', 'phase'), item('p-b', 'phase')];

    const found = schedule(rows, [edge('first', 'phase')], days({ first: 4, 'p-a': 1, 'p-b': 2 }));

    expect(found.get('p-a')?.earliestStart).toBe(4);
    expect(found.get('p-b')?.earliestStart).toBe(4);
  });
});

describe('schedule — what it refuses and what it admits', () => {
  it('throws on a cyclic graph rather than returning a schedule', () => {
    // A schedule computed from a cycle is wrong in a way no reader could detect.
    // The write path refuses the edge that would close one; this protects the
    // computation from any graph it is handed, including a restored database.
    const rows = [item('a'), item('b')];

    expect(() => schedule(rows, [edge('a', 'b'), edge('b', 'a')], days({ a: 1, b: 1 }))).toThrow(
      /cycle/i,
    );
  });

  it('reports an unestimated leaf as unestimated, not merely as zero', () => {
    // A zero that means "instant" and a zero that means "nobody has looked" are
    // the same number and opposite facts.
    const rows = [item('done'), item('untouched')];

    const found = schedule(rows, [], days({ done: 2 }));

    expect(found.get('done')).toMatchObject({ duration: 2, estimated: true });
    expect(found.get('untouched')).toMatchObject({ duration: 0, estimated: false });
  });

  it('marks a parent unestimated when nothing beneath it is estimated', () => {
    const rows = [item('parent'), item('kid', 'parent')];

    const found = schedule(rows, [], days({}));

    expect(found.get('parent')?.estimated).toBe(false);
  });

  it('marks a parent estimated when any leaf beneath it is', () => {
    const rows = [item('parent'), item('kid-a', 'parent'), item('kid-b', 'parent')];

    const found = schedule(rows, [], days({ 'kid-a': 3 }));

    expect(found.get('parent')?.estimated).toBe(true);
  });

  it('schedules an empty project without complaint', () => {
    expect(schedule([], [], days({})).size).toBe(0);
  });
});

describe('schedule — on a graph the size of a real plan', () => {
  /** `branches` parents of `perBranch` leaves each, chained one branch to the next. */
  const bigPlan = (branches: number, perBranch: number) => {
    const rows: WorkItem[] = [];
    const edges: DependencyEdge[] = [];
    const durations = new Map<string, number>();
    for (let b = 0; b < branches; b++) {
      rows.push(item(`branch-${String(b)}`));
      for (let l = 0; l < perBranch; l++) {
        const id = `leaf-${String(b)}-${String(l)}`;
        rows.push(item(id, `branch-${String(b)}`));
        durations.set(id, 1);
      }
      // Declared parent to parent, which is the expensive shape: it expands to
      // every pair of leaves across the two branches.
      if (b > 0) edges.push(edge(`branch-${String(b - 1)}`, `branch-${String(b)}`));
    }
    return { rows, edges, durations };
  };

  it('schedules a hundred branches of twenty leaves without falling over', () => {
    // codex, high: the first version rebuilt the whole child index twice per
    // edge and once per parent, and copied adjacency arrays with a spread. This
    // is 2,000 leaves and 99 parent-to-parent edges, which expand to about
    // 39,600 leaf edges. A number rather than an assurance — the claim in
    // `verify.md` used to be "fine for hundreds", untested.
    const { rows, edges, durations } = bigPlan(100, 20);

    const started = performance.now();
    const found = schedule(rows, edges, durations);
    const took = performance.now() - started;

    expect(found.size).toBe(rows.length);
    // The last branch waits for all ninety-nine before it, each one day long.
    expect(found.get('leaf-99-0')).toMatchObject({ earliestStart: 99, earliestFinish: 100 });
    expect(took).toBeLessThan(4000);
  });
});

const DEV = 'role-dev';
const QA = 'role-qa';

/** A slice of work with nobody on it — this file's subject is the graph, not the queue. */
const work = (workItemId: string, roleId: string | null, days: number | null): Slice => ({
  workItemId,
  roleId,
  days,
  personId: null,
  // One at a time, on no pool: the state every plan is in until somebody
  // sizes a team or says two people may share a work item.
  width: 1,
  poolIds: [],
});

/** One slice's schedule, or a throw — a test asserting on `undefined` asserts nothing. */
const sliceOf = (
  found: ReturnType<typeof planSlices>,
  workItemId: string,
  roleId: string | null,
): ScheduledSlice => {
  const each = found.slices.get(sliceKey(workItemId, roleId));
  if (each === undefined) throw new Error(`no slice ${workItemId}/${String(roleId)}`);
  return each;
};

describe('schedule — a work item’s roles run one after another', () => {
  it('starts the second role when the first finishes', () => {
    const rows = [item('a')];

    const found = planSlices(rows, [], [work('a', DEV, 3), work('a', QA, 2)]);

    expect(sliceOf(found, 'a', DEV)).toMatchObject({ earliestStart: 0, earliestFinish: 3 });
    expect(sliceOf(found, 'a', QA)).toMatchObject({ earliestStart: 3, earliestFinish: 5 });
  });

  it('runs them in the order they are given, which is the project’s role order', () => {
    const rows = [item('a')];

    const found = planSlices(rows, [], [work('a', QA, 2), work('a', DEV, 3)]);

    expect(sliceOf(found, 'a', QA)).toMatchObject({ earliestStart: 0, earliestFinish: 2 });
    expect(sliceOf(found, 'a', DEV)).toMatchObject({ earliestStart: 2, earliestFinish: 5 });
  });

  it('gives an unestimated slice no time, and says nobody has looked', () => {
    const rows = [item('a')];

    const found = planSlices(rows, [], [work('a', DEV, null), work('a', QA, 4)]);

    expect(sliceOf(found, 'a', DEV)).toMatchObject({
      duration: 0,
      estimated: false,
      earliestStart: 0,
      earliestFinish: 0,
    });
    expect(sliceOf(found, 'a', QA)).toMatchObject({ earliestStart: 0, earliestFinish: 4 });
  });
});

describe('schedule — where a dependency lands on the slices', () => {
  it('waits for the predecessor’s anchor and runs beside its later roles', () => {
    // The anchor rule (`dep-waits-on-first-role`, 2026-08-11): the edge leaves
    // `a`'s first slice, so `b` starts when `a`'s Dev finishes on day 3 and
    // `a`'s QA runs 3→5 alongside it. Under the whole-item rule this replaced,
    // `b` sat at 5→6.
    const rows = [item('a'), item('b')];

    const found = planSlices(
      rows,
      [edge('a', 'b')],
      [work('a', DEV, 3), work('a', QA, 2), work('b', DEV, 1), work('b', QA, null)],
    );

    expect(sliceOf(found, 'b', DEV)).toMatchObject({ earliestStart: 3, earliestFinish: 4 });
    expect(found.workItems.get('b')).toMatchObject({ earliestStart: 3, earliestFinish: 4 });
    expect(sliceOf(found, 'a', QA)).toMatchObject({ earliestStart: 3, earliestFinish: 5 });
  });

  it('does not let an unestimated first role escape the wait', () => {
    // The edge lands on `b`'s first slice, not its first *estimated* one. Landing
    // it on `QA` would leave `Dev` with no predecessor at all: it would sit at
    // day zero, and the row — which starts when its earliest slice does — would
    // report `b` as starting before the thing it waits for.
    const rows = [item('a'), item('b')];

    const found = planSlices(
      rows,
      [edge('a', 'b')],
      [work('a', DEV, 3), work('b', DEV, null), work('b', QA, 2)],
    );

    expect(sliceOf(found, 'b', DEV)).toMatchObject({ earliestStart: 3, earliestFinish: 3 });
    expect(sliceOf(found, 'b', QA)).toMatchObject({ earliestStart: 3, earliestFinish: 5 });
    expect(found.workItems.get('b')).toMatchObject({ earliestStart: 3, earliestFinish: 5 });
  });

  it('puts a not-before floor on the first slice, and thereby on all of them', () => {
    const rows = [item('a')];

    const found = planSlices(
      rows,
      [],
      [work('a', DEV, null), work('a', QA, 2)],
      new Map([['a', 4]]),
    );

    expect(sliceOf(found, 'a', DEV)).toMatchObject({ earliestStart: 4 });
    expect(sliceOf(found, 'a', QA)).toMatchObject({ earliestStart: 4, earliestFinish: 6 });
  });
});

describe('schedule — the projection back onto the work item', () => {
  it('spans its slices and totals their durations', () => {
    const rows = [item('before'), item('a')];

    const found = planSlices(
      rows,
      [edge('before', 'a')],
      [work('before', DEV, 2), work('a', DEV, 3), work('a', QA, 1)],
    );

    expect(found.workItems.get('a')).toMatchObject({
      earliestStart: 2,
      earliestFinish: 6,
      duration: 4,
      estimated: true,
    });
  });

  it('is critical, with no slack, when its slices are on the long chain', () => {
    const rows = [item('long'), item('short')];

    const found = planSlices(
      rows,
      [],
      [work('long', DEV, 4), work('long', QA, 2), work('short', DEV, 1), work('short', QA, null)],
    );

    expect(found.workItems.get('long')).toMatchObject({ float: 0, critical: true });
    expect(found.workItems.get('short')).toMatchObject({ float: 5, critical: false });
  });

  it('schedules a leaf in a project that holds no roles at all', () => {
    // Reachable: a project's last role can be removed. The rows must still be in
    // the graph — a neighbour depends on one of them.
    const rows = [item('a'), item('b')];

    const found = planSlices(
      rows,
      [edge('a', 'b')],
      [work('a', null, null), work('b', null, null)],
    );

    expect(found.workItems.get('a')).toMatchObject({ estimated: false, earliestFinish: 0 });
    expect(found.workItems.get('b')).toMatchObject({ estimated: false, earliestStart: 0 });
  });
});

describe('schedule — the slices it refuses to plan', () => {
  it('refuses a leaf it was handed no slice for', () => {
    // Nothing depends on `b` here, so nothing else would notice it was missing:
    // it would simply be projected over no slices at all and come back with a
    // start of Infinity, which is what the throw is instead of.
    const rows = [item('a'), item('b')];

    expect(() => planSlices(rows, [], [work('a', DEV, 3)])).toThrow(/no slice for/);
  });

  it('refuses a dependency onto a leaf it has no slice for, and does not call it a cycle', () => {
    // The interesting half. An edge end that is not a slice key is a node the
    // sort has never heard of, and an unreachable node is how it reports a
    // cycle — so without the guard this answers "your dependencies run in a
    // circle" about a graph with two work items and one edge.
    const rows = [item('a'), item('b')];

    expect(() => planSlices(rows, [edge('a', 'b')], [work('a', DEV, 3)])).toThrow(/no slice for/);
  });

  it('refuses a slice for a work item that is not a leaf', () => {
    // A parent has no work of its own; scheduling one would give it a duration
    // beside the span it is supposed to be.
    const rows = [item('parent'), item('kid', 'parent')];

    expect(() => planSlices(rows, [], [work('kid', DEV, 1), work('parent', DEV, 2)])).toThrow(
      /not a leaf/,
    );
  });
});
