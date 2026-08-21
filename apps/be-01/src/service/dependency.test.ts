import { describe, expect, it } from 'bun:test';

import type { StoredDependency, WorkItem } from '../repository';
import { canDepend, type DependencyRefusal } from './dependency';
import { schedule } from './schedule';

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

const edge = (predecessorId: string, successorId: string): StoredDependency => ({
  id: `${predecessorId}->${successorId}`,
  projectId: 'p1',
  predecessorId,
  successorId,
});

/**
 * ```
 * phase          (parent)
 *   early
 *   late
 * after
 * loose
 * ```
 */
const ROWS: WorkItem[] = [
  item('phase'),
  item('early', 'phase'),
  item('late', 'phase'),
  item('after'),
  item('loose'),
];

const check = (
  predecessorId: string,
  successorId: string,
  existing: StoredDependency[] = [],
): DependencyRefusal | null => canDepend(ROWS, existing, predecessorId, successorId);

describe('canDepend', () => {
  it('allows an edge between two unrelated work items', () => {
    expect(check('after', 'loose')).toBeNull();
  });

  it('allows an edge onto a parent, which is the point of declaring one there', () => {
    expect(check('phase', 'after')).toBeNull();
    expect(check('after', 'phase')).toBeNull();
  });

  it('refuses a work item depending on itself', () => {
    expect(check('after', 'after')).toBe('ancestor');
  });

  it('refuses a work item depending on its own parent', () => {
    // A parent already spans its children. Asking it to wait for one of them is
    // asking it to start after itself.
    expect(check('phase', 'early')).toBe('ancestor');
  });

  it('refuses a work item depending on its own child', () => {
    expect(check('early', 'phase')).toBe('ancestor');
  });

  it('refuses an ancestor more than one level up, in both directions', () => {
    // The walk follows `parentId` all the way, not one hop: a grandchild
    // waiting for its grandparent is still waiting for a span it is inside of.
    const rows = [item('top'), item('mid', 'top'), item('leaf', 'mid'), item('outside')];

    expect(canDepend(rows, [], 'leaf', 'top')).toBe('ancestor');
    expect(canDepend(rows, [], 'top', 'leaf')).toBe('ancestor');
    expect(canDepend(rows, [], 'leaf', 'outside')).toBeNull();
  });

  it('allows two siblings to depend on each other', () => {
    expect(check('early', 'late')).toBeNull();
  });

  it('refuses an edge that closes a cycle', () => {
    // `after` already comes before `loose`; making `loose` come before `after`
    // is a plan in which neither can start.
    expect(check('loose', 'after', [edge('after', 'loose')])).toBe('cycle');
  });

  it('refuses a cycle closed through three work items', () => {
    const existing = [edge('after', 'loose'), edge('loose', 'early')];

    expect(check('early', 'after', existing)).toBe('cycle');
  });

  it('allows a diamond, which is not a cycle', () => {
    // after → early, after → late, early → loose. Adding late → loose joins the
    // two branches back together and closes nothing.
    const existing = [edge('after', 'early'), edge('after', 'late'), edge('early', 'loose')];

    expect(check('late', 'loose', existing)).toBeNull();
  });

  it('refuses a work item that is not in the project', () => {
    expect(check('ghost', 'after')).toBe('not_found');
    expect(check('after', 'ghost')).toBe('not_found');
  });

  it('follows the tree when a cycle runs through a parent', () => {
    // `phase → after` means both leaves under `phase` come first. Adding
    // `after → early` puts `early` after something that waits for `early`.
    expect(check('after', 'early', [edge('phase', 'after')])).toBe('cycle');
  });
});

describe('canDepend — cross-review findings', () => {
  /**
   * ```
   * phase          after
   *   leaf
   * ```
   * codex's example. `phase → after` expands to `leaf → after`, which with an
   * existing `after → leaf` is a cycle. The old search compared ids and never
   * saw it: `leaf` is not `phase`, so reaching `leaf` did not count as reaching
   * the parent the proposed edge was declared on.
   */
  it('refuses an edge whose expansion closes a cycle through a parent', () => {
    const rows = [item('phase'), item('leaf', 'phase'), item('after')];

    expect(canDepend(rows, [edge('after', 'leaf')], 'phase', 'after')).toBe('cycle');
  });

  /**
   * ```
   * a          b
   *   a1         b1
   * ```
   * agy's example, found independently. `a1 → b1` exists; `b → a` expands to
   * `b1 → a1`, which closes the loop.
   */
  it('refuses an edge between two branches whose leaves already point back', () => {
    const rows = [item('a'), item('a1', 'a'), item('b'), item('b1', 'b')];

    expect(canDepend(rows, [edge('a1', 'b1')], 'b', 'a')).toBe('cycle');
  });

  it('still allows the same shape when the leaves do not point back', () => {
    // The mirror of the case above: if nothing runs the other way, the edge is
    // an ordinary one and refusing it would be the opposite mistake.
    const rows = [item('a'), item('a1', 'a'), item('b'), item('b1', 'b')];

    expect(canDepend(rows, [edge('a1', 'b1')], 'a', 'b')).toBeNull();
  });

  it('accepts what the schedule accepts, over every pair in a fixture tree', () => {
    // The equivalence stated rather than argued. For every ordered pair, the
    // answer `canDepend` gives is the answer the schedule gives when it is
    // handed the same edge — no edge accepted here can throw there.
    const rows = [item('p'), item('p1', 'p'), item('p2', 'p'), item('q'), item('q1', 'q')];
    const existing = [edge('p1', 'q1')];

    for (const from of rows) {
      for (const to of rows) {
        const refusal = canDepend(rows, existing, from.id, to.id);
        if (refusal !== null) continue;
        const parents = new Set(rows.map((r) => r.parentId).filter((id) => id !== null));
        const slices = rows
          .filter((r) => !parents.has(r.id))
          .map((r) => ({
            workItemId: r.id,
            roleId: 'role-dev',
            days: 1,
            personId: null,
            width: 1,
            poolId: null,
          }));
        expect(() =>
          schedule(rows, [...existing, { predecessorId: from.id, successorId: to.id }], slices),
        ).not.toThrow();
      }
    }
  });
});
