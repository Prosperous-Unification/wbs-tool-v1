import { describe, expect, it } from 'bun:test';

import { isWithin, type ParentedRow, parentIndexOf } from './is-within';

/** A shed: two roots, one of which is three deep. */
const ROWS: ParentedRow[] = [
  { id: 'walls', parentId: null },
  { id: 'frame', parentId: 'walls' },
  { id: 'stud', parentId: 'frame' },
  { id: 'roof', parentId: null },
];

const parentOf = parentIndexOf(ROWS);

describe('isWithin', () => {
  it('holds for the root itself', () => {
    // Every caller depends on this: it is how a row is refused a drag into
    // itself and an edge onto itself.
    expect(isWithin(parentOf, 'frame', 'frame')).toBe(true);
  });

  it('holds all the way up a chain, not just one step', () => {
    expect(isWithin(parentOf, 'stud', 'walls')).toBe(true);
  });

  it('does not hold downward', () => {
    expect(isWithin(parentOf, 'walls', 'stud')).toBe(false);
  });

  it('does not hold across roots', () => {
    expect(isWithin(parentOf, 'roof', 'walls')).toBe(false);
  });

  it('answers false for an id the index has no row for', () => {
    // A cross-project id at `canDepend`, or a row a refetch removed while a
    // drag was in flight. Both ends are read this way.
    expect(isWithin(parentOf, 'someone-elses-row', 'walls')).toBe(false);
    expect(isWithin(parentOf, 'stud', 'someone-elses-row')).toBe(false);
  });
});
