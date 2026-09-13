import { describe, expect, it } from 'bun:test';

import type { EstimatedSlice, LeafEdge, SlicePositionEdge } from './slice-edges';
import { reachedSliceOf, sliceGraphEdges } from './slice-edges';

/**
 * Three leaves. `A` has three steps and nobody estimated its first two, `B` has
 * two, `C` has one — enough for the chain, both reach arms and the join's
 * asymmetry to be told apart.
 */
const groups: Record<string, readonly EstimatedSlice[] | undefined> = {
  A: [{ days: null }, { days: null }, { days: 3 }],
  B: [{ days: 2 }, { days: 1 }],
  C: [{ days: 5 }],
};
const leafIds = ['A', 'B', 'C'];
const slicesOf = (leafId: string): readonly EstimatedSlice[] => {
  const found = groups[leafId];
  if (found === undefined) throw new Error(`no slice for work item ${leafId}`);
  return found;
};

/** `A0→A1`, as the assertions below spell an edge. */
const wire = (edges: readonly SlicePositionEdge[]): string[] =>
  edges.map(
    (edge) => `${edge.from.leafId}${String(edge.from.at)}→${edge.to.leafId}${String(edge.to.at)}`,
  );

describe('reachedSliceOf', () => {
  it('reaches the LAST slice under whole-item', () => {
    expect(reachedSliceOf('whole-item', slicesOf('A'))).toBe(2);
    expect(reachedSliceOf('whole-item', slicesOf('C'))).toBe(0);
  });

  it('reaches the first ESTIMATED slice under anchor-slice, stepping over the blanks', () => {
    expect(reachedSliceOf('anchor-slice', slicesOf('A'))).toBe(2);
    expect(reachedSliceOf('anchor-slice', slicesOf('B'))).toBe(0);
  });

  it('falls through to the last slice when nobody estimated any of them', () => {
    // Not index 0. An unestimated leaf now runs its assumed durations end to
    // end, so a dependency on it waits for the whole of it under either arm.
    expect(reachedSliceOf('anchor-slice', [{ days: null }, { days: null }])).toBe(1);
  });

  it('reads days !== null, so an explicit zero is an estimate', () => {
    // `days > 0` would step over somebody's stated "this takes no time" and
    // anchor the wait on the step behind it.
    expect(reachedSliceOf('anchor-slice', [{ days: 0 }, { days: 4 }])).toBe(0);
  });
});

describe('sliceGraphEdges', () => {
  it('chains each leaf’s own steps in the order the group was given', () => {
    expect(wire(sliceGraphEdges(leafIds, slicesOf, [], 'whole-item'))).toEqual([
      'A0→A1',
      'A1→A2',
      'B0→B1',
    ]);
  });

  it('leaves a leaf of one slice out of the chain entirely', () => {
    expect(wire(sliceGraphEdges(['C'], slicesOf, [], 'whole-item'))).toEqual([]);
  });

  it('joins the predecessor’s REACHED slice to the successor’s FIRST, plain', () => {
    const edges: readonly LeafEdge[] = [{ predecessorId: 'A', successorId: 'B' }];
    // whole-item reaches A's last; the successor side is 0 under either arm.
    expect(wire(sliceGraphEdges(leafIds, slicesOf, edges, 'whole-item'))).toContain('A2→B0');
    // anchor-slice reaches B's first estimated step — which is B0 — and still
    // arrives at the successor's first. The reach never touches that side: with
    // it applied to both ends this case would read `B0→A2`, and A's own two
    // blank steps would escape the wait entirely.
    const back: readonly LeafEdge[] = [{ predecessorId: 'B', successorId: 'A' }];
    expect(wire(sliceGraphEdges(leafIds, slicesOf, back, 'anchor-slice'))).toContain('B0→A0');
  });

  it('emits every chain before any external edge — the order the adjacency is walked in', () => {
    // This is the ONLY thing holding that order. Watched: with the two loops
    // swapped, every one of the 356 domain tests that predate this file stays
    // green and this case alone fails (364 pass / 1 fail, h2puni, 2026-09-04).
    // So it pins the order `schedule()`'s inline chain produced — which is what
    // makes the move a move — and it does not claim the placement depends on
    // it, because nothing measured says it does.
    const edges: readonly LeafEdge[] = [
      { predecessorId: 'C', successorId: 'A' },
      { predecessorId: 'A', successorId: 'B' },
    ];
    expect(wire(sliceGraphEdges(leafIds, slicesOf, edges, 'whole-item'))).toEqual([
      'A0→A1',
      'A1→A2',
      'B0→B1',
      'C0→A0',
      'A2→B0',
    ]);
  });

  it('asks the lookup for BOTH ends, so a successor with no group refuses', () => {
    // The value is unused on that side — position 0 is 0 whatever the group
    // holds — so an implementation that only reads the predecessor would draw
    // an edge onto a node that does not exist and lose the dependency silently.
    expect(() =>
      sliceGraphEdges(['A'], slicesOf, [{ predecessorId: 'A', successorId: 'gone' }], 'whole-item'),
    ).toThrow('no slice for work item gone');
    expect(() =>
      sliceGraphEdges(['A'], slicesOf, [{ predecessorId: 'gone', successorId: 'A' }], 'whole-item'),
    ).toThrow('no slice for work item gone');
  });
});
