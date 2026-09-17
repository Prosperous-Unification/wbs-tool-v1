import { describe, expect, it } from 'bun:test';

import { priorityWeightOf, priorityWeights } from './priority-weight';

describe('priorityWeights', () => {
  it('ranks densely, so the most important present weighs the most', () => {
    const weights = priorityWeights(
      new Map([
        ['a', 1],
        ['b', 5],
        ['c', 9],
      ]),
    );
    expect([...weights]).toEqual([
      ['a', 3],
      ['b', 2],
      ['c', 1],
    ]);
  });

  it('gives equal priorities equal weight and does not skip the next one', () => {
    // Dense, not competition rank. Three leaves at 1, 1 and 9 are TWO distinct
    // statements: competition rank would weigh the third 0 and collapse it into
    // "nobody prioritised this", which is a different thing a plan can say.
    const weights = priorityWeights(
      new Map([
        ['a', 1],
        ['b', 1],
        ['c', 9],
      ]),
    );
    expect([...weights]).toEqual([
      ['a', 2],
      ['b', 2],
      ['c', 1],
    ]);
  });

  it('bounds the top weight by the DISTINCT count, not by the leaf count', () => {
    // This is the case `1, 1, 9` cannot make. Deduplication reaches the answer
    // through two different mechanisms — the `Set`, and the `Map` constructor's
    // last-wins over a duplicated key — and on a run of TWO they agree, so a
    // three-leaf fixture passes with the `Set` deleted. Measured: with
    // `new Set` removed the suite stayed 342/0. Here the duplicate run is three
    // long, and the two mechanisms disagree: `a` weighs 3 (one of three
    // distinct statements) and not 5 (one of five leaves). A weight that counts
    // leaves is not bounded by the rank set at all, which is the property the
    // objective's `Σ w(s) × horizonUnits` bound is checked against.
    const weights = priorityWeights(
      new Map([
        ['a', 1],
        ['b', 5],
        ['c', 5],
        ['d', 5],
        ['e', 9],
      ]),
    );
    expect([...weights]).toEqual([
      ['a', 3],
      ['b', 2],
      ['c', 2],
      ['d', 2],
      ['e', 1],
    ]);
  });

  it('weighs an unprioritised leaf below every stated priority', () => {
    // `priorityByLeaf` omits them, so absence arrives as a missing key.
    const weights = priorityWeights(
      new Map([
        ['a', 1],
        ['b', 9],
      ]),
    );
    expect(priorityWeightOf(weights, 'a')).toBe(2);
    expect(priorityWeightOf(weights, 'b')).toBe(1);
    expect(priorityWeightOf(weights, 'nobody-said')).toBe(0);
  });

  it('is bounded by the plan even when the priority is the largest safe integer', () => {
    // The whole reason the absolute priority is never the weight:
    // `asOptionalPriority` accepts any safe integer, so this plan is legal, and
    // `P_max + 1` is not representable — every invert-the-scale formula loses
    // precision at exactly the number somebody types to mean "last".
    const weights = priorityWeights(
      new Map([
        ['a', 1],
        ['b', Number.MAX_SAFE_INTEGER],
      ]),
    );
    expect([...weights]).toEqual([
      ['a', 2],
      ['b', 1],
    ]);
    for (const weight of weights.values()) expect(Number.isSafeInteger(weight)).toBe(true);
  });

  it('reads a negative priority as more important, not as absent', () => {
    // Ordering is by the number and nothing else, so a plan that used negatives
    // to mean "before everything" gets what it asked for.
    expect([
      ...priorityWeights(
        new Map([
          ['a', -3],
          ['b', 0],
          ['c', 2],
        ]),
      ),
    ]).toEqual([
      ['a', 3],
      ['b', 2],
      ['c', 1],
    ]);
  });

  it('is empty for a plan nobody prioritised', () => {
    expect([...priorityWeights(new Map())]).toEqual([]);
    expect(priorityWeightOf(new Map(), 'anything')).toBe(0);
  });
});
