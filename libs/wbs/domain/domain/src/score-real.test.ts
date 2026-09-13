import { describe, expect, it } from 'bun:test';

import { schedule, type Slice, sliceKey } from './schedule';
import { scoreReal } from './score-real';

/**
 * The real-domain scorer 4.11b's publication guard compares with, and 4.12b
 * stores the `value` of.
 *
 * Two claims, and only the second of them is arithmetic: the three terms are
 * `max finish`, `Σ w·finish` and `Σ |start − baseline|`; and they are
 * accumulated over the slices in **one order both sides of a comparison
 * share**, which is the sorted key list rather than the `Map`'s own placement
 * order.
 */

const leafRow = (id: string, position: number, priority: number | null = null) => ({
  id,
  parentId: null,
  position,
  frozenNumber: null,
  priority,
});

const work = (workItemId: string, days: number, extra: Partial<Slice> = {}): Slice => ({
  workItemId,
  stepId: null,
  days,
  personId: null,
  width: 1,
  poolIds: [],
  ...extra,
});

const NO_BASELINE = () => 0;
const UNWEIGHTED = () => 1;

describe('the three terms', () => {
  it('takes the latest finish, the weighted finish sum and the absolute movement', () => {
    // `b` follows `a`, so the plan is 0→2 then 2→5 and the makespan is 5.
    const rows = [leafRow('a', 10), leafRow('b', 20)];
    const chain = [{ predecessorId: 'a', successorId: 'b' }];
    const produced = schedule(rows, chain, [work('a', 2), work('b', 3)]);

    const weights = new Map([
      [sliceKey('a', null), 4],
      [sliceKey('b', null), 1],
    ]);
    // One baseline earlier than its start and one later, so the term is 1 + 2
    // and the absolute value is load-bearing: signed, the two cancel to −1.
    const baseline = new Map([
      [sliceKey('a', null), -1],
      [sliceKey('b', null), 4],
    ]);

    const scored = scoreReal(
      produced,
      (key) => weights.get(key) ?? 0,
      (key) => baseline.get(key) ?? 0,
    );

    expect(scored.makespan).toBe(5);
    // 4·2 + 1·5.
    expect(scored.priority).toBe(13);
    // |0 − (−1)| + |2 − 4|.
    expect(scored.movement).toBe(3);
  });

  it('answers zero on every term over a plan with no slices', () => {
    const produced = schedule([], [], []);

    expect(scoreReal(produced, UNWEIGHTED, NO_BASELINE)).toEqual({
      makespan: 0,
      priority: 0,
      movement: 0,
    });
  });
});

describe('the order the terms are accumulated in', () => {
  it('sums over the sorted keys, not over the placement order', () => {
    // `z` carries the better priority, so the pass places it first and it is
    // written into `Schedule.slices` first — while its key sorts last. The two
    // orders therefore disagree, which is what makes the assertion below a rule
    // rather than a coincidence.
    const rows = [leafRow('z', 10, 1), leafRow('a', 20, 5)];
    const slices = [work('z', 2, { personId: 'kat' }), work('a', 3, { personId: 'kat' })];
    const produced = schedule(rows, [], slices, new Map(), new Map(), 'whole-item');

    expect([...produced.slices.keys()]).toEqual([sliceKey('z', null), sliceKey('a', null)]);

    // The callback records what it is asked for, which is the accumulation
    // order itself rather than a proxy for it: no arithmetic fixture can
    // separate two orders that agree to the last bit, and a fixture that does
    // not agree would be a float puzzle standing in for a rule.
    //
    // Watched red: iterate `produced.slices` directly and this comes back
    // `['z', 'a']` — the placement order, which the optimized replay and real
    // Fast do not share, and which the guard's epsilon-free `>` would then
    // decide on.
    const asked: string[] = [];
    scoreReal(
      produced,
      (key) => {
        asked.push(key);
        return 1;
      },
      NO_BASELINE,
    );

    expect(asked).toEqual([sliceKey('a', null), sliceKey('z', null)]);
  });
});
