import { describe, expect, it } from 'bun:test';

import { type GroupableSlice, groupSlicesByLeaf } from './slice-groups';

const sliceOf = (workItemId: string, width = 1): GroupableSlice & { readonly tag: string } => ({
  workItemId,
  width,
  tag: `${workItemId}:${String(width)}`,
});

describe('groupSlicesByLeaf', () => {
  it('keeps each leaf’s own slices in the order they were handed over', () => {
    // That order is step precedence: it decides which slice an edge's position
    // names, in this pass and in the solver request alike.
    const a1 = sliceOf('A');
    const b = sliceOf('B');
    const a2 = sliceOf('A', 2);
    const grouped = groupSlicesByLeaf(['A', 'B'], [a1, b, a2]);
    expect(grouped.get('A')).toEqual([a1, a2]);
    expect(grouped.get('B')).toEqual([b]);
  });

  it('gives the caller its own slice type back, not a narrowed one', () => {
    // The two refusals read `workItemId` and `width`; everything else rides
    // through, which is what lets `schedule()` and the request builder share
    // one grouping over two different slice shapes.
    const grouped = groupSlicesByLeaf(['A'], [sliceOf('A', 3)]);
    expect(grouped.get('A')?.[0].tag).toBe('A:3');
  });

  it('leaves a leaf nobody handed a slice for out of the map entirely', () => {
    // Absent rather than empty: an empty group would let a caller draw an edge
    // onto position 0 of a leaf that has no slice. `schedule()`'s `slicesOf`
    // and `buildSolverEdges` both refuse on the absence.
    expect(groupSlicesByLeaf(['A', 'B'], [sliceOf('A')]).has('B')).toBe(false);
  });

  it('refuses a slice for something that is not a leaf of this project', () => {
    // A parent has no work of its own and a stranger has no place in the graph.
    expect(() => groupSlicesByLeaf(['A'], [sliceOf('P')])).toThrow(
      'slice for P, which is not a leaf of this project',
    );
  });

  it('refuses a width that is not a whole number of people', () => {
    // A width is people and duration is effort divided by it: 0 is Infinity
    // days, and 1.5 is six days over two and a half people.
    expect(() => groupSlicesByLeaf(['A'], [sliceOf('A', 0)])).toThrow('claims a width of 0');
    expect(() => groupSlicesByLeaf(['A'], [sliceOf('A', 1.5)])).toThrow('claims a width of 1.5');
  });
});
