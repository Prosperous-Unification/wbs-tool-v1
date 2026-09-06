import { describe, expect, it } from 'bun:test';

import type { ScheduleInput } from './canonical-schedule-input';
import { guardRealPublication } from './publication-guard';
import { schedule, type Slice, sliceKey } from './schedule';
import { SOLVER_QUANTUM } from './solver-quantum';

/**
 * Task 4.11b's steps (a) and (c) at the seam they are decided in.
 *
 * The two fixtures the item mandates are here in the domain, where the
 * comparison happens; the production write path is where they are proved
 * DURABLE, and that is the next chunk. What these prove is the decision
 * itself: the width-5 case, where the quantisation-optimal answer is worse in
 * the real domain and the Baseline must be substituted, and the
 * equal-primary/better-secondary case, where it must not be.
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

const inputOf = (
  rows: ScheduleInput['rows'],
  edges: ScheduleInput['edges'],
  slices: ScheduleInput['slices'],
): ScheduleInput => ({
  rows,
  edges,
  slices,
  notBefore: new Map(),
  poolSizes: new Map(),
  reach: 'whole-item',
  deadlines: new Map(),
});

const NO_MOVEMENT = () => 0;
const UNWEIGHTED = () => 1;

const key = (id: string) => sliceKey(id, null);

describe('(i) the width-5 case: quantisation costs more than the search won', () => {
  // 2.11's own fixture. Three serial `days=1, width=5` slices: `durationOf` is
  // `1 / 5`, so real Fast runs 0 → 0.2 → 0.4 → 0.6, while the model the solver
  // actually sees has every duration rounded up to a whole SOLVER_QUANTUM unit
  // — 0.2 workdays is 9.6 units, which rounds to 10 — and its optimal answer
  // is 0, 10, 20 units. Converted back that is 0.625 workdays of makespan
  // against Fast's 0.6. The solver did not do anything wrong; it answered
  // exactly the question it was asked, and the question had been rounded.
  const rows = [leafRow('a', 10), leafRow('b', 20), leafRow('c', 30)];
  const chain = [
    { predecessorId: 'a', successorId: 'b' },
    { predecessorId: 'b', successorId: 'c' },
  ];
  const slices = [
    work('a', 1, { width: 5 }),
    work('b', 1, { width: 5 }),
    work('c', 1, { width: 5 }),
  ];
  const input = inputOf(rows, chain, slices);

  /** The quantised answer materialised: whole units divided back into workdays. */
  const quantisedOptimum = new Map([
    [key('a'), 0 / SOLVER_QUANTUM],
    [key('b'), 10 / SOLVER_QUANTUM],
    [key('c'), 20 / SOLVER_QUANTUM],
  ]);

  it('substitutes the Baseline when the optimized primary is strictly worse', () => {
    const optimized = schedule(
      rows,
      chain,
      slices,
      new Map(),
      new Map(),
      'whole-item',
      new Map(),
      quantisedOptimum,
    );

    const decision = guardRealPublication(input, optimized, 'makespan', UNWEIGHTED, NO_MOVEMENT);

    // The two numbers the decision rests on, asserted in the domain they are
    // compared in. Watched red: score in the QUANTISED domain instead of the
    // real one — round each finish up to a whole unit before comparing — and
    // both sides read 30 units, the `>` goes false, and this case fails by
    // publishing the worse schedule as the solver's.
    expect(decision.baselineValues.makespan).toBeCloseTo(0.6, 12);
    expect(decision.optimizedValues.makespan).toBeCloseTo(20 / SOLVER_QUANTUM + 0.2, 12);
    expect(decision.optimizedValues.makespan).toBeGreaterThan(decision.baselineValues.makespan);

    expect(decision.chosen).toBe('baseline');
    // The stored schedule is Fast's own, not the solver's — a floor row IS the
    // Baseline, which is why `publication` is stored rather than inferred.
    expect(decision.schedule).toBe(decision.baseline);
    expect(decision.values).toEqual(decision.baselineValues);
    expect([...decision.schedule.slices.keys()].sort()).toEqual([key('a'), key('b'), key('c')]);
  });

  it('computes the Baseline from the input rather than taking one on trust', () => {
    // Step (a) is this function's, and the assertion is that it produced real
    // Fast over the same canonical input: every start on the fractional axis,
    // none of them on a unit boundary the solver would have used.
    const decision = guardRealPublication(
      input,
      schedule(
        rows,
        chain,
        slices,
        new Map(),
        new Map(),
        'whole-item',
        new Map(),
        quantisedOptimum,
      ),
      'makespan',
      UNWEIGHTED,
      NO_MOVEMENT,
    );

    const starts = [...decision.baseline.slices.keys()]
      .sort()
      .map((k) => decision.baseline.slices.get(k)?.earliestStart);
    expect(starts[0]).toBe(0);
    expect(starts[1]).toBeCloseTo(0.2, 12);
    expect(starts[2]).toBeCloseTo(0.4, 12);
  });
});

describe('(ii) an equal primary carrying a strictly better secondary', () => {
  // One person, so the two leaves serialise. `hi` has the better priority and
  // Fast therefore drains it first — but it is also ten times longer, and
  // running the short one first leaves the makespan untouched while cutting
  // the weighted finish sum. That is a real improvement the user asked for,
  // and the whole reason the predicate is `worse` and not "not strictly
  // better".
  const rows = [leafRow('hi', 10, 1), leafRow('lo', 20, 5)];
  const slices = [work('hi', 10, { personId: 'kat' }), work('lo', 1, { personId: 'kat' })];
  const input = inputOf(rows, [], slices);

  const weights = new Map([
    [key('hi'), 2],
    [key('lo'), 1],
  ]);
  const weightOf = (k: string) => weights.get(k) ?? 0;

  /** The short one first: same finish for the plan, a cheaper priority sum. */
  const smithOrder = new Map([
    [key('lo'), 0],
    [key('hi'), 1],
  ]);

  it('publishes the solver schedule on a tie', () => {
    const optimized = schedule(
      rows,
      [],
      slices,
      new Map(),
      new Map(),
      'whole-item',
      new Map(),
      smithOrder,
    );

    const decision = guardRealPublication(input, optimized, 'makespan', weightOf, NO_MOVEMENT);

    // Fast: hi 0→10, lo 10→11. Optimized: lo 0→1, hi 1→11. The primary ties.
    expect(decision.optimizedValues.makespan).toBe(11);
    expect(decision.baselineValues.makespan).toBe(11);
    // The secondary is where the win is: 1·1 + 2·11 against 2·10 + 1·11.
    expect(decision.optimizedValues.priority).toBe(23);
    expect(decision.baselineValues.priority).toBe(31);

    // Watched red: weaken the predicate to "not strictly better"
    // (`optimized >= baseline`) and this case fails by substituting Fast,
    // throwing away the better secondary.
    expect(decision.chosen).toBe('optimized');
    expect(decision.schedule).toBe(optimized);
    expect(decision.values).toEqual(decision.optimizedValues);
  });

  it('reads the primary the variant names, and only that term', () => {
    // The same two schedules under PRI. The primary is now the term the
    // optimized answer wins, so the decision is unchanged — but for the other
    // reason, which is what makes the argument load-bearing rather than a
    // second copy of the case above.
    const optimized = schedule(
      rows,
      [],
      slices,
      new Map(),
      new Map(),
      'whole-item',
      new Map(),
      smithOrder,
    );

    const decision = guardRealPublication(input, optimized, 'priority', weightOf, NO_MOVEMENT);

    expect(decision.optimizedValues.priority).toBeLessThan(decision.baselineValues.priority);
    expect(decision.chosen).toBe('optimized');
  });
});
