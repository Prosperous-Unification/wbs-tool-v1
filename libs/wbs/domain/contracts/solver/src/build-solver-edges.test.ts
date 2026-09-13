import { type LeafEdge, type Slice, sliceKey } from '@wbs/domain';
import { describe, expect, it } from 'bun:test';

import { buildSolverEdges } from './build-solver-edges';
import { buildSolverSlices, type LeafConstraintMaps } from './build-solver-slices';

const none: LeafConstraintMaps = { floors: new Map(), deadlines: new Map(), weights: new Map() };

const sliceOf = (workItemId: string, stepId: string | null, days: number | null): Slice => ({
  workItemId,
  stepId,
  days,
  personId: null,
  width: 1,
  poolIds: [],
});

/** `A` has three steps and nobody estimated its first two; `B` has two; `C` has one. */
const groups: Record<string, readonly Slice[] | undefined> = {
  A: [sliceOf('A', 'design', null), sliceOf('A', 'dev', null), sliceOf('A', 'qa', 3)],
  B: [sliceOf('B', 'dev', 2), sliceOf('B', 'qa', 1)],
  C: [sliceOf('C', 'dev', 5)],
};
const leafIds = ['A', 'B', 'C'];
const slicesOf = (leafId: string): readonly Slice[] => {
  const found = groups[leafId];
  if (found === undefined) throw new Error(`no slice for work item ${leafId}`);
  return found;
};

/**
 * `A/design→A/dev`, as the assertions below spell an edge.
 *
 * `sliceKey` separates with a NUL, which is what these keys actually hold; the
 * slash is only so a failure prints something readable. Written as an ESCAPE
 * and never typed — a literal NUL in a source file makes git call the file
 * binary, the trap `sliceKey`'s own doc warns about and which this file walked
 * into on its first write, as 2.2's slice projection did before it. Exactly one
 * separator per key, so a single `replace` is the whole job.
 */
const wire = (edges: readonly { predecessorKey: string; successorKey: string }[]): string[] =>
  edges.map(
    (edge) =>
      `${edge.predecessorKey.replace('\u0000', '/')}→${edge.successorKey.replace('\u0000', '/')}`,
  );

describe('buildSolverEdges', () => {
  it('keys the chain and the join the domain derived, and nothing else', () => {
    const edges: readonly LeafEdge[] = [{ predecessorId: 'A', successorId: 'B' }];
    expect(wire(buildSolverEdges(leafIds, slicesOf, edges, 'whole-item'))).toEqual([
      'A/design→A/dev',
      'A/dev→A/qa',
      'B/dev→B/qa',
      // whole-item leaves A's LAST slice and arrives at B's FIRST, plain.
      'A/qa→B/dev',
    ]);
  });

  it('carries the reach through to the keys, on the predecessor side only', () => {
    const edges: readonly LeafEdge[] = [{ predecessorId: 'A', successorId: 'B' }];
    // anchor-slice steps over A's two blank steps to `qa`, which is also its
    // last, so this pair cannot tell the arms apart — B→A can.
    const back: readonly LeafEdge[] = [{ predecessorId: 'B', successorId: 'A' }];
    expect(wire(buildSolverEdges(leafIds, slicesOf, back, 'anchor-slice'))).toContain(
      // B's first ESTIMATED step is its first; A's first step plain, not its
      // first estimated one — the successor side never reads the reach.
      'B/dev→A/design',
    );
    expect(wire(buildSolverEdges(leafIds, slicesOf, edges, 'anchor-slice'))).toContain(
      'A/qa→B/dev',
    );
  });

  it('emits keys buildSolverSlices emits, for the same slices — an oracle, not an assumption', () => {
    // The two builders are keyed independently, and an edge naming a key no
    // slice carries is a request Bun wrote and would then reject as a solver
    // fault. Paired here so a change to either projection's key breaks this
    // rather than the re-validator.
    const flat = leafIds.flatMap((leafId) => [...slicesOf(leafId)]);
    const keys = new Set(buildSolverSlices(flat, none).map((slice) => slice.key));
    const edges = buildSolverEdges(
      leafIds,
      slicesOf,
      [
        { predecessorId: 'C', successorId: 'A' },
        { predecessorId: 'A', successorId: 'B' },
      ],
      'anchor-slice',
    );
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(keys.has(edge.predecessorKey)).toBe(true);
      expect(keys.has(edge.successorKey)).toBe(true);
    }
  });

  it('names both endpoints, never a positional pair', () => {
    // The schema's own reason: the two ends are chosen by different rules, and
    // a 2-array hides which is which at every call site.
    const [edge] = buildSolverEdges(['A'], slicesOf, [], 'whole-item');
    expect(Object.keys(edge).sort()).toEqual(['predecessorKey', 'successorKey']);
    expect(edge.predecessorKey).toBe(sliceKey('A', 'design'));
    expect(edge.successorKey).toBe(sliceKey('A', 'dev'));
  });

  it('refuses a position its group has no slice for rather than keying undefined', () => {
    // Unreachable through `sliceGraphEdges`, which only ever emits 0 and
    // `reachedSliceOf`'s answer. Guarded because the alternative is the string
    // `"undefined"` reaching the wire as a key, and the re-validator reporting
    // Bun's own malformed request as a missing slice from Python.
    const empty = (leafId: string): readonly Slice[] => (leafId === 'E' ? [] : slicesOf(leafId));
    expect(() =>
      buildSolverEdges(['E', 'A'], empty, [{ predecessorId: 'E', successorId: 'A' }], 'whole-item'),
    ).toThrow('no slice -1 for work item E');
  });
});
