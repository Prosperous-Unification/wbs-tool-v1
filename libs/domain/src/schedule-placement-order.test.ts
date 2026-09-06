import { describe, expect, it } from 'bun:test';

import type { PlannedRow } from './derive-numbers';
import type { DependencyEdge, Schedule, ScheduledSlice, Slice } from './schedule';
import { schedule, sliceKey } from './schedule';

/**
 * tasks.md 4.10b's Fast arm: **"Fast is audited for the same hazard in this
 * slice and fixed the same way if `placeSlices`' placement order can produce
 * it."**
 *
 * The hazard is that chronological order is not a topological order on legal
 * data. `durationOf` preserves an explicit `days: 0` and `windowFor` treats a
 * zero duration as legal no-work, so a zero-duration predecessor and its
 * successor can share a start; sort those two by `(start, canonical slice
 * order)` and an id tie-break orders them backwards. `lateTimes` walks its
 * `order` **backwards** and immediately reads `late[next].latestStart`, so it
 * would reach the predecessor before its successor has a `Late` at all.
 *
 * **The audit's answer is that Fast cannot produce it, and the reason is
 * structural rather than lucky.** `placeSlices` builds `order` by pushing a
 * node onto the eligible set only once `waitingOn[node]` has reached zero —
 * every plan and step-order edge is therefore respected in `order` by
 * construction — and it appends each resource-successor edge from an
 * already-placed blocker to the node being placed now, so those point forwards
 * in `order` too. `order` is a topological order of exactly the augmented graph
 * `schedule()` hands `lateTimes`. No fix is owed here; what is owed is a case
 * that fails if that ever stops being true, which is this file.
 *
 * The fixture is 4.10b's own: a zero-duration predecessor whose id sorts
 * **after** its successor, the two sharing one start. Placement order is
 * `[z, a]` and chronological order is `[a, z]` — the two disagree, which is
 * what makes the case load-bearing rather than a tautology on a fixture where
 * they happen to coincide.
 */
describe('the order Fast hands the backward pass', () => {
  const DEV = 'step-dev';

  let position = 0;
  const item = (id: string): PlannedRow => ({
    id,
    parentId: null,
    position: (position += 10),
    frozenNumber: null,
    priority: null,
  });

  const edge = (predecessorId: string, successorId: string): DependencyEdge => ({
    predecessorId,
    successorId,
  });

  const slice = (workItemId: string, days: number | null): Slice => ({
    workItemId,
    stepId: DEV,
    days,
    personId: null,
    width: 1,
    poolIds: [],
  });

  const planned = (found: Schedule, workItemId: string): ScheduledSlice => {
    const one = found.slices.get(sliceKey(workItemId, DEV));
    if (one === undefined) throw new Error(`no slice for ${workItemId}`);
    return one;
  };

  it('settles a zero-duration predecessor whose id sorts after its successor', () => {
    // `z` takes no time, so it finishes where it starts and `a` may start at
    // the same instant. `z` before `a` in the plan, `a` before `z` by id.
    const found = schedule(
      [item('z'), item('a')],
      [edge('z', 'a')],
      [slice('z', 0), slice('a', 2)],
    );

    const z = planned(found, 'z');
    const a = planned(found, 'a');

    // Load-bearing: over a fixture where the two do not share a start, or where
    // the ids sort the other way, the chronological order and the placement
    // order agree and the mutation below cannot redden.
    expect(z.duration).toBe(0);
    expect(z.earliestStart).toBe(0);
    expect(a.earliestStart).toBe(0);
    // The canonical order, which is what a chronological sort would tie-break
    // on — read off `sliceKey` rather than written as a literal comparison, so
    // it is the real key order and not a constant the linter can fold away.
    expect(sliceKey('a', DEV) < sliceKey('z', DEV)).toBe(true);

    // The backward pass reached `a` before `z`, which is the whole claim: `z`'s
    // late finish is `a`'s late start, not a number reconstructed from a `Late`
    // that did not exist yet.
    expect(a.latestStart).toBe(0);
    expect(z.latestFinish).toBe(0);
    expect(z.latestStart).toBe(0);
    expect(z.float).toBe(0);
    expect(z.critical).toBe(true);
    expect(a.critical).toBe(true);
  });

  /**
   * 4.10b's **optimized** arm, which is the half run 39 left open.
   *
   * The materialiser drains the same eligible set, but its comparator is
   * `(pinned start, canonical order)` rather than Fast's priority one — so on
   * this fixture the comparator alone would order `a` before `z`: both are
   * pinned at 0 and `a`'s key sorts first. It does not, and the reason is the
   * same structural one as Fast's: the eligible set is Kahn's ready set, so `z`
   * is admitted first and `a` only once `z` is placed. The two are never in the
   * set together and the comparator never gets to invert them.
   *
   * That is what makes this case worth its own `it` rather than a repeat: it is
   * the one fixture where the OPTIMIZED comparator, read on its own, gives the
   * wrong answer.
   */
  it('drains the same fixture topologically under a pinned-starts comparator', () => {
    const rows = [item('z'), item('a')];
    const edges = [edge('z', 'a')];
    const slices = [slice('z', 0), slice('a', 2)];
    const fast = schedule(rows, edges, slices);

    const pinned = schedule(
      rows,
      edges,
      slices,
      new Map(),
      new Map(),
      'whole-item',
      new Map(),
      // Fast's own starts, so the only thing that can differ is the ORDER the
      // backward pass was handed.
      new Map([
        [sliceKey('z', DEV), 0],
        [sliceKey('a', DEV), 0],
      ]),
    );

    // Read on its own the pinned comparator prefers `a`: equal starts, and the
    // canonical order is the tie-break. Kahn is what overrules it.
    expect(sliceKey('a', DEV) < sliceKey('z', DEV)).toBe(true);

    for (const id of ['z', 'a']) {
      const before = planned(fast, id);
      const after = planned(pinned, id);
      expect({
        id,
        earliestStart: after.earliestStart,
        latestStart: after.latestStart,
        latestFinish: after.latestFinish,
        float: after.float,
        critical: after.critical,
        boundBy: after.boundBy,
      }).toEqual({
        id,
        earliestStart: before.earliestStart,
        latestStart: before.latestStart,
        latestFinish: before.latestFinish,
        float: before.float,
        critical: before.critical,
        boundBy: before.boundBy,
      });
    }
  });

  it('keeps every resource-successor edge pointing forwards in that order', () => {
    // A person's queue is the edge Fast adds to the graph that is not in the
    // plan, and it is the other half of "topological over the **augmented**
    // graph". `kat` does `b` and then `c`; `c`'s late start is what `b` can
    // slip into, so a backward pass that met `b` before `c` would read a
    // missing `Late` here for the same reason.
    const found = schedule(
      [item('p'), item('q')],
      [],
      [
        { workItemId: 'p', stepId: DEV, days: 3, personId: 'kat', width: 1, poolIds: [] },
        { workItemId: 'q', stepId: DEV, days: 2, personId: 'kat', width: 1, poolIds: [] },
      ],
    );

    const p = planned(found, 'p');
    const q = planned(found, 'q');

    // The queue exists — without it the two would overlap and there would be no
    // resource edge to be topological about.
    expect(q.earliestStart).toBe(3);
    expect(q.boundBy).toBe('person');
    expect(q.resourcePredecessorId).toBe(sliceKey('p', DEV));

    // And it is tight: `p` cannot slip without moving `q`, which is only true
    // if the backward pass walked the augmented graph in an order that had
    // settled `q` first.
    expect(p.float).toBe(0);
    expect(p.critical).toBe(true);
  });
});
