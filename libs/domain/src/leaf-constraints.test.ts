import { describe, expect, it } from 'bun:test';

import type { PlannedRow } from './derive-numbers';
import { leafDeadlinesOf, leafFloorsOf } from './leaf-constraints';
import { indexTree } from './schedule';

/** A grandparent, a parent under it, and two leaves under the parent. */
const rows: readonly PlannedRow[] = [
  { id: 'G', parentId: null, position: 0, frozenNumber: null, priority: null },
  { id: 'P', parentId: 'G', position: 0, frozenNumber: null, priority: null },
  { id: 'L1', parentId: 'P', position: 0, frozenNumber: null, priority: null },
  { id: 'L2', parentId: 'P', position: 1, frozenNumber: null, priority: null },
  { id: 'X', parentId: null, position: 1, frozenNumber: null, priority: null },
];
const index = indexTree(rows);

describe('leafFloorsOf', () => {
  it('carries a floor written on a parent down to every leaf beneath it', () => {
    expect([...leafFloorsOf(new Map([['P', 4]]), index)]).toEqual([
      ['L1', 4],
      ['L2', 4],
    ]);
  });

  it('keeps each leaf the LATEST of its own floor and every ancestor’s', () => {
    // The defect this rule exists for, in one assertion: a copy-down would give
    // L1 the parent's day 3 and lose its own day 9. `Math.max`, never a
    // copy-down — watched failing 2026-08-10 in `schedule-shapes.test.ts`.
    const floors = leafFloorsOf(
      new Map([
        ['P', 3],
        ['L1', 9],
      ]),
      index,
    );
    expect(floors.get('L1')).toBe(9);
    expect(floors.get('L2')).toBe(3);
  });

  it('reaches two levels down, from a grandparent', () => {
    const floors = leafFloorsOf(new Map([['G', 6]]), index);
    expect(floors.get('L1')).toBe(6);
    expect(floors.get('L2')).toBe(6);
  });

  it('leaves a leaf no floor reaches out of the map entirely', () => {
    // Absence is the unconstrained state, and it is the common one: callers
    // read it as day zero. Present-with-a-zero would be the same number and a
    // different fact.
    expect(leafFloorsOf(new Map([['P', 4]]), index).has('X')).toBe(false);
    expect([...leafFloorsOf(new Map(), index)]).toEqual([]);
  });

  it('floors at day zero, because a start before day zero has no representation', () => {
    expect(leafFloorsOf(new Map([['L1', -5]]), index).get('L1')).toBe(0);
  });

  it('ignores an id the tree does not carry rather than throwing', () => {
    // A floor on a deleted row is stale data, not a corrupt plan: it binds
    // nothing because nothing is beneath it.
    expect([...leafFloorsOf(new Map([['gone', 7]]), index)]).toEqual([]);
  });
});

describe('leafDeadlinesOf', () => {
  it('carries a deadline written on a parent down to every leaf beneath it', () => {
    // Compared as the whole map and not with two `get`s, because the entries
    // that are *absent* are half of 3.3: a dated row constrains exactly the
    // leaves under it, so a row that has children does not constrain itself and
    // a fold that also emitted `['P', 20]` fails here on the extra entry rather
    // than passing unnoticed. The childless half is the pruned-subtree case
    // below, where the row *is* the leaf under it and does take its own date.
    expect([...leafDeadlinesOf(new Map([['P', 20]]), index)]).toEqual([
      ['L1', 20],
      ['L2', 20],
    ]);
  });

  it('keeps each leaf the EARLIEST of its own deadline and every ancestor’s', () => {
    // The mirror of the floor rule and the whole reason the two functions are
    // not one with a comparator argument. `Math.max` here would let a loose
    // parent date RELAX a child's own — a constraint an edit above can only
    // ever weaken is not a deadline.
    const deadlines = leafDeadlinesOf(
      new Map([
        ['P', 20],
        ['L1', 12],
      ]),
      index,
    );
    expect(deadlines.get('L1')).toBe(12);
    expect(deadlines.get('L2')).toBe(20);
  });

  it('lets an EARLIER parent tighten a later child, which is the other direction', () => {
    // tasks.md 3.2, and the case the file was missing. Above, the parent is the
    // looser of the two and `min` is indistinguishable from "the leaf's own
    // date wins". Here the parent is the tighter, so a fold that simply
    // preferred the leaf's own value would return 20 and pass every other case
    // in this describe. One direction proves nothing about a fold's direction.
    const deadlines = leafDeadlinesOf(
      new Map([
        ['P', 12],
        ['L1', 20],
      ]),
      index,
    );
    expect(deadlines.get('L1')).toBe(12);
    expect(deadlines.get('L2')).toBe(12);
  });

  it('takes the tighter ancestor when two of them bind', () => {
    const deadlines = leafDeadlinesOf(
      new Map([
        ['G', 30],
        ['P', 18],
      ]),
      index,
    );
    expect(deadlines.get('L1')).toBe(18);
    expect(deadlines.get('L2')).toBe(18);
  });

  it('leaves an unconstrained leaf absent and does NOT seed it with zero', () => {
    // The one place the two folds must disagree. A floor's identity is day
    // zero; a deadline has none, so absence is the answer and the wire spells
    // it `deadlineUnits: null`. A zero seed would make every unconstrained plan
    // instantly infeasible.
    const deadlines = leafDeadlinesOf(new Map([['L1', 12]]), index);
    expect(deadlines.has('L2')).toBe(false);
    expect(deadlines.has('X')).toBe(false);
    expect([...leafDeadlinesOf(new Map(), index)]).toEqual([]);
  });

  it('keeps a day-zero deadline, which is a real and very tight constraint', () => {
    // Guards the `?? 0`-shaped mistake from the other side: written with an
    // `own ?? Infinity` seed this still passes, but written with `own ?? 0` —
    // the floor's own idiom — day zero would win every later comparison.
    const deadlines = leafDeadlinesOf(
      new Map([
        ['P', 0],
        ['L1', 12],
      ]),
      index,
    );
    expect(deadlines.get('L1')).toBe(0);
    expect(deadlines.get('L2')).toBe(0);
  });

  it('ignores an id the tree does not carry rather than throwing', () => {
    expect([...leafDeadlinesOf(new Map([['gone', 7]]), index)]).toEqual([]);
  });

  it('keeps a dated parent’s own date when its subtree is deleted', () => {
    // tasks.md 3.3. A row with no children **is** a leaf in `indexTree`, so
    // `leavesUnder` is never empty for a row the tree carries and "a parent
    // with no leaves" names no reachable state. The reachable neighbour is the
    // delete: `P`'s children are gone, `P` is now a leaf, and the date written
    // on it binds `P` itself.
    //
    // No constraint is emitted for the children that no longer exist, nothing
    // throws, and the stored date is not silently dropped on the way through.
    // The alternative — treating a formerly-parent id as unresolvable and
    // discarding it — would delete a date the user wrote by deleting rows
    // underneath it, which is a data loss no undo would catch because nothing
    // recorded it. `P` is then an ordinary dated leaf, ordered and reported
    // late like any other, which is the intended consequence and not a leak.
    const pruned = indexTree([
      { id: 'G', parentId: null, position: 0, frozenNumber: null, priority: null },
      { id: 'P', parentId: 'G', position: 0, frozenNumber: null, priority: null },
    ]);

    expect([...leafDeadlinesOf(new Map([['P', 12]]), pruned)]).toEqual([['P', 12]]);
  });

  it('emits nothing at all for a subtree the fold is handed no dates for', () => {
    // The empty-map arm of 3.3, separated from the case above because they fail
    // differently: this one goes red on a fold that seeds every leaf, and the
    // one above goes red on a fold that drops an id whose children left.
    expect([...leafDeadlinesOf(new Map(), indexTree(rows))]).toEqual([]);
  });
});
