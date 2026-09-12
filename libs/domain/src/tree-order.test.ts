import { describe, expect, it } from 'bun:test';

import { byTreeOrder, siblingGroupsOf, treeOrder, type TreePlacement } from './tree-order';

function place(id: string, parentId: string | null, position: number): TreePlacement {
  return { id, parentId, position };
}

/** The ids in tree order, which is what every assertion below is really about. */
function walked(placements: readonly TreePlacement[]): string[] {
  return [...treeOrder(placements).entries()]
    .sort((left, right) => left[1] - right[1])
    .map(([id]) => id);
}

describe('treeOrder', () => {
  it('walks depth-first, a parent before the children under it', () => {
    const rows = [
      place('a', null, 10),
      place('b', null, 20),
      place('a2', 'a', 20),
      place('a1', 'a', 10),
      place('a1x', 'a1', 10),
    ];

    expect(walked(rows)).toEqual(['a', 'a1', 'a1x', 'a2', 'b']);
  });

  it('orders siblings by position, not by the order they arrived in', () => {
    const rows = [place('third', null, 30), place('first', null, 10), place('second', null, 20)];

    expect(walked(rows)).toEqual(['first', 'second', 'third']);
  });

  it('falls to the id when two siblings share a position', () => {
    // ADR 0016: a tie is legal — two appends racing on one parent both compute
    // the same number — and `work_item.id` ascending is its documented
    // resolution. Arbitrary, but it never moves, and that is the property.
    const rows = [place('zed', null, 10), place('abe', null, 10)];

    expect(walked(rows)).toEqual(['abe', 'zed']);
  });

  it('answers the same order however the rows are handed to it', () => {
    // Proof: the `id` comparison in `siblingGroupsOf` deleted, leaving
    // `Array#sort`'s stability to inherit the caller's order — watched failing
    // on `Expected: [ "abe", "zed" ] · Received: [ "zed", "abe" ]`, the two
    // argument orders giving two different projects. `falls to the id when two
    // siblings share a position` went red beside it; restored 2026-09-11.
    const tied = [place('zed', null, 10), place('abe', null, 10)];

    expect(walked(tied)).toEqual(walked([...tied].reverse()));
  });

  it('refuses a work item whose parent is not in the project', () => {
    expect(() => treeOrder([place('a', null, 10), place('orphan', 'gone', 10)])).toThrow(/orphan/);
  });

  it('refuses a parent cycle rather than looping forever', () => {
    // Neither row is reachable from a root, so the walk visits nothing and the
    // count check is what catches it. A walk that followed `parentId` upwards
    // instead would not return at all.
    expect(() => treeOrder([place('a', 'b', 10), place('b', 'a', 10)])).toThrow(/unreachable/);
  });
});

describe('siblingGroupsOf', () => {
  it('groups children under their parent and roots under null', () => {
    const groups = siblingGroupsOf([
      place('a', null, 10),
      place('a1', 'a', 10),
      place('b', null, 20),
    ]);

    expect(groups.get(null)?.map((each) => each.id)).toEqual(['a', 'b']);
    expect(groups.get('a')?.map((each) => each.id)).toEqual(['a1']);
  });

  it('keeps the fields the caller handed it', () => {
    // The grouping is generic so `deriveNumbers` can group rows that carry a
    // `frozenNumber` through the very same function the tree order uses.
    const groups = siblingGroupsOf([
      { id: 'a', parentId: null, position: 10, frozenNumber: '010' },
    ]);

    expect(groups.get(null)?.[0]?.frozenNumber).toBe('010');
  });
});

describe('byTreeOrder', () => {
  it('sorts rows into the order the project is drawn in', () => {
    const rows = [place('b', null, 20), place('a1', 'a', 10), place('a', null, 10)];
    const sorted = [...rows].sort(byTreeOrder(treeOrder(rows)));

    expect(sorted.map((each) => each.id)).toEqual(['a', 'a1', 'b']);
  });

  it('refuses a row the order does not hold rather than sorting it somewhere', () => {
    // Proof: the throw replaced by `?? 0` — watched failing on `Received
    // function did not throw · Received value: [ { id: "stranger", … } ]`, the
    // stranger sorted to the top of somebody's plan on a place it was never
    // given; restored 2026-09-11.
    const known = [place('a', null, 10)];
    const compare = byTreeOrder(treeOrder(known));

    expect(() => [place('stranger', null, 20), ...known].sort(compare)).toThrow(/stranger/);
  });
});
