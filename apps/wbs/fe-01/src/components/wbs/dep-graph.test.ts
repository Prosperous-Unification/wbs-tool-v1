import { describe, expect, it } from 'vitest';

import { type EdgeRefusal, type GraphRow, indexDepGraph, refusalFor } from './dep-graph';

/** A project as these tests describe one: a tree, and the edges written over it. */
const project = (
  tree: readonly (readonly [id: string, parentId: string | null])[],
  edges: readonly (readonly [predecessorId: string, successorId: string])[] = [],
): GraphRow[] =>
  tree.map(([id, parentId]) => ({
    id,
    parentId,
    dependsOn: edges
      .filter(([, successorId]) => successorId === id)
      .map(([predecessorId]) => predecessorId),
  }));

const refusal = (
  rows: readonly GraphRow[],
  predecessorId: string,
  successorId: string,
): EdgeRefusal | null => refusalFor(indexDepGraph(rows), { predecessorId, successorId });

/**
 * ```
 * step          (parent)
 *   early
 *   late
 * after
 * loose
 * ```
 * The fixture of `libs/core/src/service/dependency.test.ts`, so the cases below
 * are that file's cases and not a paraphrase of them.
 */
const FIXTURE: readonly (readonly [string, string | null])[] = [
  ['step', null],
  ['early', 'step'],
  ['late', 'step'],
  ['after', null],
  ['loose', null],
];

/**
 * The refusal as be-01 words it.
 *
 * `canDepend` answers `ancestor` for a row onto itself, onto its parent and
 * onto its child alike — one word is all an API needs to say no with. The
 * picker has to write a different sentence under each, so the predictor keeps
 * the three apart; this folds them back before comparing, and it is the only
 * licensed difference between the two rules.
 */
const asBe01 = (refused: EdgeRefusal | null): 'ancestor' | 'cycle' | null =>
  refused === 'self' || refused === 'descendant' ? 'ancestor' : refused;

/**
 * Every `canDepend` case from `libs/core/src/service/dependency.test.ts`, with
 * the expectation that file asserts.
 *
 * Copied deliberately rather than shared: fe-01 and be-01 are separate compiles
 * and the point is that two implementations of one rule cannot drift apart
 * unseen. The `not_found` cases are not here — they are the throw below, because
 * the picker takes both ends out of the rows it was handed rather than off the
 * wire.
 */
const BE_01_CASES: readonly {
  readonly what: string;
  readonly tree: readonly (readonly [string, string | null])[];
  readonly edges: readonly (readonly [string, string])[];
  readonly predecessorId: string;
  readonly successorId: string;
  readonly expected: 'ancestor' | 'cycle' | null;
}[] = [
  {
    what: 'allows an edge between two unrelated work items',
    tree: FIXTURE,
    edges: [],
    predecessorId: 'after',
    successorId: 'loose',
    expected: null,
  },
  {
    what: 'allows an edge onto a parent, which is the point of declaring one there',
    tree: FIXTURE,
    edges: [],
    predecessorId: 'step',
    successorId: 'after',
    expected: null,
  },
  {
    what: 'allows an edge from a parent, the other way round',
    tree: FIXTURE,
    edges: [],
    predecessorId: 'after',
    successorId: 'step',
    expected: null,
  },
  {
    what: 'refuses a work item depending on itself',
    tree: FIXTURE,
    edges: [],
    predecessorId: 'after',
    successorId: 'after',
    expected: 'ancestor',
  },
  {
    what: 'refuses a work item depending on its own parent',
    tree: FIXTURE,
    edges: [],
    predecessorId: 'step',
    successorId: 'early',
    expected: 'ancestor',
  },
  {
    what: 'refuses a work item depending on its own child',
    tree: FIXTURE,
    edges: [],
    predecessorId: 'early',
    successorId: 'step',
    expected: 'ancestor',
  },
  {
    what: 'allows two siblings to depend on each other',
    tree: FIXTURE,
    edges: [],
    predecessorId: 'early',
    successorId: 'late',
    expected: null,
  },
  {
    what: 'refuses an edge that closes a cycle',
    tree: FIXTURE,
    edges: [['after', 'loose']],
    predecessorId: 'loose',
    successorId: 'after',
    expected: 'cycle',
  },
  {
    what: 'refuses a cycle closed through three work items',
    tree: FIXTURE,
    edges: [
      ['after', 'loose'],
      ['loose', 'early'],
    ],
    predecessorId: 'early',
    successorId: 'after',
    expected: 'cycle',
  },
  {
    what: 'allows a diamond, which is not a cycle',
    tree: FIXTURE,
    edges: [
      ['after', 'early'],
      ['after', 'late'],
      ['early', 'loose'],
    ],
    predecessorId: 'late',
    successorId: 'loose',
    expected: null,
  },
  {
    what: 'follows the tree when a cycle runs through a parent',
    tree: FIXTURE,
    edges: [['step', 'after']],
    predecessorId: 'after',
    successorId: 'early',
    expected: 'cycle',
  },
  {
    // codex's cross-review example. `step → after` expands to `leaf → after`,
    // which with an existing `after → leaf` is a cycle.
    what: 'refuses an edge whose expansion closes a cycle through a parent',
    tree: [
      ['step', null],
      ['leaf', 'step'],
      ['after', null],
    ],
    edges: [['after', 'leaf']],
    predecessorId: 'step',
    successorId: 'after',
    expected: 'cycle',
  },
  {
    // agy's, found independently. `a1 → b1` exists; `b → a` expands to
    // `b1 → a1`, which closes the loop.
    what: 'refuses an edge between two branches whose leaves already point back',
    tree: [
      ['a', null],
      ['a1', 'a'],
      ['b', null],
      ['b1', 'b'],
    ],
    edges: [['a1', 'b1']],
    predecessorId: 'b',
    successorId: 'a',
    expected: 'cycle',
  },
  {
    what: 'still allows the same shape when the leaves do not point back',
    tree: [
      ['a', null],
      ['a1', 'a'],
      ['b', null],
      ['b1', 'b'],
    ],
    edges: [['a1', 'b1']],
    predecessorId: 'a',
    successorId: 'b',
    expected: null,
  },
];

describe('refusalFor — the same cases be-01 judges', () => {
  for (const testCase of BE_01_CASES) {
    it(testCase.what, () => {
      const rows = project(testCase.tree, testCase.edges);

      expect(asBe01(refusal(rows, testCase.predecessorId, testCase.successorId))).toBe(
        testCase.expected,
      );
    });
  }
});

describe('refusalFor — the part the picker needs that be-01 does not', () => {
  const rows = project(FIXTURE);

  it('says which way round an ancestor edge runs', () => {
    // The two sentences the dropdown writes are not the same sentence: one row
    // contains the row being edited, the other sits inside it. Fold these two
    // together and the picker tells half the people the wrong thing.
    expect(refusal(rows, 'step', 'early')).toBe('ancestor');
    expect(refusal(rows, 'early', 'step')).toBe('descendant');
  });

  it('names a row onto itself as itself, not as an ancestor', () => {
    expect(refusal(rows, 'after', 'after')).toBe('self');
  });

  it('throws when either end is not a row of this project', () => {
    // be-01 answers `not_found` because it takes ids off the wire — a
    // cross-project id is a request someone made. Here both ends come out of
    // the array this function was handed, so an id it has never seen is a bug
    // in the caller and nothing to model (R5).
    expect(() => refusal(rows, 'ghost', 'after')).toThrow(/ghost/);
    expect(() => refusal(rows, 'after', 'ghost')).toThrow(/ghost/);
  });
});

describe('indexDepGraph', () => {
  it('reads the successor→predecessors of every row as the project’s edges', () => {
    // The client never sees an edge list; it sees each row's `dependsOn`. The
    // graph is those, turned back into edges — and the cycle above proves it
    // reads them the right way round.
    const rows = project(FIXTURE, [['after', 'loose']]);

    expect(refusalFor(indexDepGraph(rows), { predecessorId: 'loose', successorId: 'after' })).toBe(
      'cycle',
    );
    expect(refusalFor(indexDepGraph(rows), { predecessorId: 'after', successorId: 'loose' })).toBe(
      null,
    );
  });

  it('ignores a dependsOn naming a row it has never seen, exactly as be-01’s expansion does', () => {
    // `expandToLeaves` reads an unknown end as no leaves and contributes
    // nothing. Mirroring that is the port; throwing here instead would make the
    // client refuse edges be-01 accepts, on data be-01 is happy with.
    const rows: GraphRow[] = [
      { id: 'after', parentId: null, dependsOn: ['gone'] },
      { id: 'loose', parentId: null, dependsOn: [] },
    ];

    expect(refusalFor(indexDepGraph(rows), { predecessorId: 'after', successorId: 'loose' })).toBe(
      null,
    );
  });
});
