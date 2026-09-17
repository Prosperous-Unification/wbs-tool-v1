import { describe, expect, it } from 'bun:test';

import { arrangeBySchedule, type ScheduleStarts } from './arrange-siblings';
import type { TreePlacement } from './tree-order';

function place(id: string, parentId: string | null, position: number): TreePlacement {
  return { id, parentId, position };
}

/** A schedule that says only when each work item begins, which is all this reads. */
function starting(days: Record<string, number>): ScheduleStarts {
  return new Map(Object.entries(days).map(([id, earliestStart]) => [id, { earliestStart }]));
}

describe('arrangeBySchedule', () => {
  it('puts two roots in the order their bars start', () => {
    const rows = [place('late', null, 10), place('early', null, 20)];

    const arranged = arrangeBySchedule(rows, starting({ late: 5, early: 0 }));

    expect(arranged.placements).toEqual([
      { id: 'early', parentId: null, position: 10 },
      { id: 'late', parentId: null, position: 20 },
    ]);
    expect([...arranged.moved].sort()).toEqual(['early', 'late']);
  });

  it('arranges a group at every depth, not only the roots', () => {
    const rows = [
      place('root', null, 10),
      place('kid-late', 'root', 10),
      place('kid-early', 'root', 20),
      place('grand-late', 'kid-early', 10),
      place('grand-early', 'kid-early', 20),
    ];

    const arranged = arrangeBySchedule(
      rows,
      starting({ root: 0, 'kid-late': 4, 'kid-early': 2, 'grand-late': 3, 'grand-early': 2 }),
    );

    const byParent = (parentId: string): string[] =>
      arranged.placements.filter((each) => each.parentId === parentId).map((each) => each.id);
    expect(byParent('root')).toEqual(['kid-early', 'kid-late']);
    expect(byParent('kid-early')).toEqual(['grand-early', 'grand-late']);
  });

  it('orders a parent by its own projection, wherever its children sit', () => {
    // A parent's `earliestStart` is the least of its leaves' — `projectOntoWorkItems`
    // computes that, and this function only reads the answer. The case is here
    // because the pair it separates is the one a reader notices: a branch whose
    // first bar is early sits above a leaf that starts later.
    const rows = [place('leaf', null, 10), place('branch', null, 20), place('kid', 'branch', 10)];

    const arranged = arrangeBySchedule(rows, starting({ leaf: 3, branch: 2, kid: 2 }));

    expect(arranged.placements.map((each) => each.id)).toEqual(['branch', 'leaf']);
  });

  it('keeps the order two work items already read in when they start together', () => {
    // Non-vacuous by construction: the ids are in the reverse of their current
    // order, so any comparison that reaches for `id` reorders them.
    //
    // Proof: `|| left.id.localeCompare(right.id)` appended to the comparator —
    // watched failing on `Expected: [] · Received: [ { "id": "a", "parentId":
    // null, "position": 10 }, … ]`, because the group then reads as changed and
    // three rows are rewritten for nothing; restored 2026-09-11.
    const rows = [place('c', null, 10), place('a', null, 20), place('b', null, 30)];

    const arranged = arrangeBySchedule(rows, starting({ a: 1, b: 1, c: 1 }));

    expect(arranged.placements).toEqual([]);
    expect(arranged.moved).toEqual([]);
  });

  it('writes nothing for a group that already reads in schedule order', () => {
    const rows = [place('first', null, 10), place('second', null, 20)];

    expect(arrangeBySchedule(rows, starting({ first: 0, second: 1 })).placements).toEqual([]);
  });

  it('leaves an unchanged group out while writing the one beside it', () => {
    const rows = [
      place('settled', null, 10),
      place('churned', null, 20),
      place('a', 'settled', 10),
      place('b', 'settled', 20),
      place('late', 'churned', 10),
      place('early', 'churned', 20),
    ];

    const arranged = arrangeBySchedule(
      rows,
      starting({ settled: 0, churned: 0, a: 0, b: 1, late: 5, early: 0 }),
    );

    expect(arranged.placements.map((each) => each.id)).toEqual(['early', 'late']);
  });

  it('respaces a changed group back to gaps of ten', () => {
    const rows = [place('c', null, 7), place('b', null, 8), place('a', null, 9)];

    const arranged = arrangeBySchedule(rows, starting({ a: 0, b: 1, c: 2 }));

    expect(arranged.placements.map((each) => each.position)).toEqual([10, 20, 30]);
  });

  it('names as moved only the work items whose place changed', () => {
    // `held` keeps its place while the two below it swap, so it is respaced
    // with the group and must not be reported as having moved: a position
    // carries no revision, and bumping it would refuse a peer's pending undo.
    //
    // Proof: `moved` filled from every placement instead — watched failing on
    // `expected [ 'held', 'last', 'middle' ] to equal [ 'last', 'middle' ]`;
    // restored 2026-09-11.
    const rows = [place('held', null, 10), place('middle', null, 20), place('last', null, 30)];

    const arranged = arrangeBySchedule(rows, starting({ held: 0, middle: 5, last: 2 }));

    expect(arranged.placements.map((each) => each.id)).toEqual(['held', 'last', 'middle']);
    expect([...arranged.moved].sort()).toEqual(['last', 'middle']);
  });

  it('arranges a frozen work item like any other', () => {
    // ADR 0023. The arrangement cannot even see a frozen number — it reads
    // `TreePlacement` — and that is the decision made structural: a rule that
    // held frozen rows in place would need a field this function is not given.
    const rows = [
      { id: 'frozen', parentId: null, position: 10, frozenNumber: '010' },
      { id: 'plain', parentId: null, position: 20, frozenNumber: null },
    ];

    const arranged = arrangeBySchedule(rows, starting({ frozen: 9, plain: 1 }));

    expect(arranged.placements.map((each) => each.id)).toEqual(['plain', 'frozen']);
  });

  it('answers the same arrangement however the rows are handed to it', () => {
    const rows = [
      place('root', null, 10),
      place('b', 'root', 20),
      place('a', 'root', 10),
      place('other', null, 20),
      place('d', 'other', 20),
      place('c', 'other', 10),
    ];
    const starts = starting({ root: 0, other: 0, a: 2, b: 1, c: 2, d: 1 });

    expect(arrangeBySchedule([...rows].reverse(), starts)).toEqual(arrangeBySchedule(rows, starts));
  });

  it('refuses a work item the schedule has no start for', () => {
    // Proof: the throw replaced by `?? Infinity` — watched failing on `Received
    // function did not throw · Received value: { placements: [], moved: [] }`.
    // Worth reading twice: the default does not merely misplace the unscheduled
    // row, it sorts it to the end, finds it already there, and reports an
    // arrangement of nothing — a silent no-op on half a project. Restored
    // 2026-09-11.
    const rows = [place('a', null, 10), place('b', null, 20)];

    expect(() => arrangeBySchedule(rows, starting({ a: 1 }))).toThrow(/no scheduled start.*b/);
  });

  it('refuses a work item that is not reachable from any root', () => {
    const rows = [place('a', null, 10), place('orphan', 'gone', 10)];

    expect(() => arrangeBySchedule(rows, starting({ a: 0, orphan: 0 }))).toThrow(/orphan/);
  });
});
