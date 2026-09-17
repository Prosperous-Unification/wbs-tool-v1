import { describe, expect, it } from 'vitest';

import { haveSameSliceOrder, type SliceStarts } from './schedule-order';

/**
 * The relation as tasks.md 8.7 defines it, written out over the pairs.
 *
 * This is the **oracle**, not a second implementation to be kept: it is the
 * shipped pairwise form of the comparison, and every case below asserts that
 * `haveSameSliceOrder`'s dense-rank form answers exactly what it answers. Kept
 * here rather than in the module so there is one production implementation and
 * one independent statement of the contract it has to satisfy.
 */
function sameOrderByPairs(left: SliceStarts, right: SliceStarts): boolean {
  const shared = [...left.keys()].filter((key) => right.has(key)).sort();
  for (let first = 0; first < shared.length; first += 1) {
    for (let second = first + 1; second < shared.length; second += 1) {
      const firstKey = shared[first];
      const secondKey = shared[second];
      const leftFirst = left.get(firstKey)?.earliestStart;
      const leftSecond = left.get(secondKey)?.earliestStart;
      const rightFirst = right.get(firstKey)?.earliestStart;
      const rightSecond = right.get(secondKey)?.earliestStart;
      if (
        leftFirst === undefined ||
        leftSecond === undefined ||
        rightFirst === undefined ||
        rightSecond === undefined
      ) {
        throw new Error('shared schedule slice vanished during comparison');
      }
      if (Math.sign(leftFirst - leftSecond) !== Math.sign(rightFirst - rightSecond)) return false;
    }
  }
  return true;
}

const starts = (entries: Readonly<Record<string, number>>): SliceStarts =>
  new Map(Object.entries(entries).map(([key, earliestStart]) => [key, { earliestStart }]));

/** A seeded generator, so a disagreeing pair can be reproduced from its seed alone. */
function randomFrom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * One pair of start maps over the same keys, drawn from a small pool of values
 * so that **ties are common** on either side.
 *
 * A pool of five values across up to eight slices is the point: starts drawn
 * from a continuum would almost never tie, and the tie is the only case where
 * dense ranking and sorted-index ranking disagree — so a corpus without ties
 * would agree with the oracle whether the production code handled ties or not.
 */
function drawnPair(random: () => number): { left: SliceStarts; right: SliceStarts } {
  const pool = [0, 0.5, 1, 1 + 1 / 96, 3];
  const count = 2 + Math.floor(random() * 7);
  const keys = Array.from({ length: count }, (_, at) => `slice-${String(at)}`);
  const pick = (): number => {
    // `.at`, so the bounds check below is a check: a plain index is typed
    // non-optional under this workspace's compiler options and the guard reads
    // as dead code to the linter.
    const value = pool.at(Math.floor(random() * pool.length));
    if (value === undefined) throw new Error('pool index out of range');
    return value;
  };
  return {
    left: starts(Object.fromEntries(keys.map((key) => [key, pick()]))),
    right: starts(Object.fromEntries(keys.map((key) => [key, pick()]))),
  };
}

describe('haveSameSliceOrder', () => {
  it.each([
    ['a uniform shift is not a reorder', { a: 0, b: 1, c: 4 }, { a: 2, b: 3, c: 6 }, true],
    ['a broken tie is a reorder', { a: 0, b: 0, c: 4 }, { a: 0, b: 1, c: 4 }, false],
    ['a made tie is a reorder', { a: 0, b: 1, c: 4 }, { a: 2, b: 2, c: 6 }, false],
    ['a swap is a reorder', { a: 0, b: 1 }, { a: 1, b: 0 }, false],
    ['ties on both sides agree', { a: 3, b: 3, c: 3 }, { a: 7, b: 7, c: 7 }, true],
    [
      'a fractional difference is compared in the real domain',
      { a: 1, b: 1 + 1 / 96 },
      { a: 1, b: 1 + 1 / 96 },
      true,
    ],
    [
      'a fractional pair reordered inside one workday is a reorder',
      { a: 1, b: 1 + 1 / 96 },
      { a: 1 + 1 / 96, b: 1 },
      false,
    ],
  ] as const)('%s', (_what, left, right, expected) => {
    expect(haveSameSliceOrder(starts(left), starts(right))).toBe(expected);
    // The oracle agrees on every named case, so a case that stops describing
    // the relation fails here rather than silently pinning new behaviour.
    expect(sameOrderByPairs(starts(left), starts(right))).toBe(expected);
  });

  it('reads only the slices present in both', () => {
    // `c` is ordered differently on the two sides and is absent from the
    // overlap, so it may not be consulted at all.
    const left = starts({ a: 0, b: 1, c: 9 });
    const right = starts({ a: 0, b: 1, d: 0 });
    expect(haveSameSliceOrder(left, right)).toBe(true);
    expect(sameOrderByPairs(left, right)).toBe(true);
  });

  it.each([
    ['no overlap', { a: 0 }, { b: 0 }],
    ['one shared slice', { a: 0, b: 5 }, { a: 3 }],
    ['both empty', {}, {}],
  ] as const)('has no pair to disagree about with %s', (_what, left, right) => {
    expect(haveSameSliceOrder(starts(left), starts(right))).toBe(true);
    expect(sameOrderByPairs(starts(left), starts(right))).toBe(true);
  });

  /**
   * Proof: with `denseRanks` giving every start its **own** rank — the values
   * paired with their index, stably sorted, and the sort position written back
   * as the rank — this case failed on `seed 52 · left
   * {"slice-0":0.5,"slice-1":1.0104166666666667} · Expected: false · Received:
   * true`, together with the two named tie cases above. Ordinal ranks are a
   * permutation, so a broken tie leaves them *unchanged* and the comparison
   * reports two schedules that disagree as agreeing. Watched 2026-09-08.
   *
   * Note what is **not** the fault here: competition ranking (`indexOf` plus
   * the count of equal values) was injected first and passed, correctly — it
   * still gives tied starts one shared value, so it represents the same weak
   * order. What has to be injected is a ranking that splits a tie group.
   */
  it('answers exactly what the pairwise definition answers, over 400 seeded pairs', () => {
    const random = randomFrom(1);
    let tied = 0;
    for (let seed = 0; seed < 400; seed += 1) {
      const { left, right } = drawnPair(random);
      const leftValues = [...left.values()].map((placed) => placed.earliestStart);
      if (new Set(leftValues).size < leftValues.length) tied += 1;
      expect(
        haveSameSliceOrder(left, right),
        `seed ${String(seed)} · left ${JSON.stringify(Object.fromEntries([...left].map(([key, placed]) => [key, placed.earliestStart])))}`,
      ).toBe(sameOrderByPairs(left, right));
    }
    // The corpus is only evidence about ties if it draws them, and a pool
    // change that stopped drawing them would leave the negative above
    // unobservable. Measured: 324 of 400.
    expect(tied).toBeGreaterThan(200);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY] as const)(
    'refuses a non-finite start (%s) rather than answering about it',
    (start) => {
      expect(() => haveSameSliceOrder(starts({ a: start, b: 1 }), starts({ a: 0, b: 1 }))).toThrow(
        /non-finite start/,
      );
    },
  );
});
