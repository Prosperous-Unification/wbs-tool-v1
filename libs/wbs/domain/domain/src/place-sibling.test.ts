import { describe, expect, it } from 'bun:test';

import { placeAfter, POSITION_STEP, type Sibling } from './place-sibling';

const at = (id: string, position: number): Sibling => ({ id, position });

describe('placeAfter', () => {
  it('starts an empty group at the first step', () => {
    const placed = placeAfter([], null);

    expect(placed.position).toBe(POSITION_STEP);
    expect(placed.renumbered).toEqual([]);
  });

  it('takes the midpoint between two siblings, writing neither', () => {
    const placed = placeAfter([at('a', 10), at('b', 20)], 'a');

    expect(placed.position).toBe(15);
    expect(placed.renumbered).toEqual([]);
  });

  it('appends a step past the last sibling', () => {
    const placed = placeAfter([at('a', 10), at('b', 20)], 'b');

    expect(placed.position).toBe(30);
    expect(placed.renumbered).toEqual([]);
  });

  it('goes before the first sibling when there is room', () => {
    const placed = placeAfter([at('a', 10)], null);

    expect(placed.position).toBe(5);
    expect(placed.renumbered).toEqual([]);
  });

  it('renumbers the group when two siblings are adjacent', () => {
    // 10 and 11 have no integer between them. The group is respaced and the new
    // work item lands in the gap that respacing creates.
    const placed = placeAfter([at('a', 10), at('b', 11)], 'a');

    expect(placed.renumbered).toEqual([
      { id: 'a', position: 10 },
      { id: 'b', position: 30 },
    ]);
    expect(placed.position).toBe(20);
  });

  it('renumbers when there is no room before the first sibling', () => {
    const placed = placeAfter([at('a', 1)], null);

    expect(placed.renumbered).toEqual([{ id: 'a', position: 20 }]);
    expect(placed.position).toBe(10);
  });

  it('refuses an afterId that is not in the group', () => {
    // Silently appending would put the work item somewhere the user did not ask
    // for, and the number derived from that position would look deliberate.
    expect(() => placeAfter([at('a', 10)], 'nope')).toThrow(/nope/);
  });

  it('leaves every sibling in its original order after a renumber', () => {
    const group = [at('a', 1), at('b', 2), at('c', 3)];

    const placed = placeAfter(group, 'b');

    const after = [...placed.renumbered, { id: 'new', position: placed.position }].sort(
      (x, y) => x.position - y.position,
    );
    expect(after.map((s) => s.id)).toEqual(['a', 'b', 'new', 'c']);
  });
});
