import {
  type DependencyEdge,
  FAST_GOLDEN_CASES,
  type PlannedRow,
  type PoolSizes,
  schedule,
  type ScheduledSlice,
  ScheduleInvalidOptimizedStartError,
  type Slice,
  sliceKey,
  SOLVER_QUANTUM,
} from '@wbs/domain';
import { describe, expect, it } from 'bun:test';

import { materialiseOptimized } from './materialise-optimized';
import { quantisedFastBaseline } from './quantised-baseline';
import type { SolverOffsetMap } from './wire-types';

const row = (id: string, position: number, parentId: string | null = null): PlannedRow => ({
  id,
  parentId,
  position,
  frozenNumber: null,
  priority: null,
});

const sliceOf = (
  workItemId: string,
  stepId: string | null,
  days: number | null,
  extra: Partial<Slice> = {},
): Slice => ({ workItemId, stepId, days, personId: null, width: 1, poolIds: [], ...extra });

const noEdges: readonly DependencyEdge[] = [];

/**
 * Three serial whole-day slices, which is the fixture the round trip needs.
 *
 * `days: 1, width: 1` is exactly one workday and exactly {@link SOLVER_QUANTUM}
 * units, so the quantum rounds nothing and the quantised baseline's offsets
 * divide back to Fast's own starts as exact doubles. That is what makes the
 * round trip below a statement about the WIRING rather than about the quantum:
 * on this fixture any difference between the materialised schedule and Fast's
 * is the dequantisation's, because the quantisation had nothing to lose.
 *
 * The `fiveWide` fixture `quantised-baseline.test.ts` uses is the opposite
 * fixture on purpose and belongs to 4.11b, not here — 0.2 workdays rounds up to
 * 10 units, so its baseline offsets divide back to starts strictly LATER than
 * Fast's and the materialised schedule is legitimately a different one.
 */
const wholeDays = {
  rows: [row('A', 0)],
  edges: noEdges,
  slices: [sliceOf('A', 'one', 1), sliceOf('A', 'two', 1), sliceOf('A', 'three', 1)] as const,
};

const key = {
  one: sliceKey('A', 'one'),
  two: sliceKey('A', 'two'),
  three: sliceKey('A', 'three'),
  four: sliceKey('A', 'four'),
};

const materialise = (offsets: SolverOffsetMap) =>
  materialiseOptimized(
    wholeDays.rows,
    wholeDays.edges,
    wholeDays.slices,
    new Map(),
    new Map(),
    'whole-item',
    offsets,
  );

/** Keys read back with the NUL written as an escape, so a failure prints something. */
const readableKey = (key: string): string => key.replace('\u0000', '/');

const readableStarts = (slices: ReadonlyMap<string, ScheduledSlice>): Record<string, number> =>
  Object.fromEntries([...slices].map(([at, slice]) => [readableKey(at), slice.earliestStart]));

describe('materialiseOptimized', () => {
  it('divides the offsets by the quantum and hands them to schedule() as pinned starts', () => {
    const placed = materialise({
      [key.one]: 0,
      [key.two]: SOLVER_QUANTUM * 3,
      [key.three]: SOLVER_QUANTUM * 4,
    });

    // Half the assertion is the arithmetic and half is that it reached the
    // placement at all: 144 units is day 3, not day 144 and not unit 144.
    expect(readableStarts(placed.slices)).toEqual({ 'A/one': 0, 'A/two': 3, 'A/three': 4 });
  });

  it('round-trips the quantised baseline back onto Fast on a fixture the quantum rounds nothing on', () => {
    const { rows, edges, slices } = wholeDays;
    const offsets = quantisedFastBaseline(rows, edges, slices, new Map(), new Map(), 'whole-item');
    const fast = schedule(rows, edges, slices, new Map(), new Map(), 'whole-item');
    const placed = materialise(offsets);

    expect(readableStarts(placed.slices)).toEqual(readableStarts(fast.slices));
    // Not just the dates: a pin that landed a hair above its floor would keep
    // the same start and change the WORD, so the floors are the sharper half of
    // the round trip.
    expect([...placed.slices.values()].map((slice) => slice.boundBy)).toEqual(
      [...fast.slices.values()].map((slice) => slice.boundBy),
    );
    expect(placed.waitingForPerson).toBe(fast.waitingForPerson);
    expect(placed.waitingForCapacity).toBe(fast.waitingForCapacity);
  });

  /**
   * The same round trip on a fixture where the quantum's snap is doing work —
   * which is where chunk 1's named ulp hazard actually bites.
   *
   * `days: 5/12, width: 5` is exactly 4 solver units, so `durationUnits` snaps
   * `4.000000000000001` back to 4 and the quantised baseline puts `A/two` at
   * offset 4. Dividing that back down gives `0.08333333333333333`, while Fast's
   * own floor for `A/two` — `days / width`, the double it accumulated — is
   * `0.08333333333333334`. One ulp apart, denoting the same real number, and
   * `pinFloor` compared them with `<`: the plan's OWN baseline came back as
   * `ScheduleInvalidOptimizedStartError`, "before its stepOrder floor".
   *
   * Not a corner: over every width 1–1000 and every offset 1–480 whose real
   * duration is an exact unit multiple, 53,451 of 480,000 pairs put the
   * dequantised pin strictly below Fast's floor and 52,691 put it strictly
   * above — where the start was right and only the WORD was wrong, `'optimizer'`
   * for a slice sitting on its own floor. Measured, run 40 chunk 2.
   */
  it('round-trips a baseline whose dequantised pin lands a ulp off Fast’s own floor', () => {
    const rows = [row('A', 0)];
    const slices = [
      sliceOf('A', 'one', 5 / 12, { width: 5 }),
      sliceOf('A', 'two', 1),
    ] as readonly Slice[];
    const offsets = quantisedFastBaseline(
      rows,
      noEdges,
      slices,
      new Map(),
      new Map(),
      'whole-item',
    );
    const fast = schedule(rows, noEdges, slices, new Map(), new Map(), 'whole-item');

    const placed = materialiseOptimized(
      rows,
      noEdges,
      slices,
      new Map(),
      new Map(),
      'whole-item',
      offsets,
    );

    // The floor's own double survives, not the pin's: a pin that IS the floor up
    // to drift is the floor, so the schedule stays on one axis.
    expect(readableStarts(placed.slices)).toEqual(readableStarts(fast.slices));
    expect([...placed.slices.values()].map((slice) => slice.boundBy)).toEqual(
      [...fast.slices.values()].map((slice) => slice.boundBy),
    );
  });

  /**
   * The fractional offset is deliberately **above** every floor of its slice and
   * the rest of the plan is deliberately feasible around it.
   *
   * The first version of this case put 24.5 on `A/two`, where it divides to
   * 0.51 workdays and lands below `A/one`'s finish — so `schedule()` refused it
   * for its own reason and the case passed with this file's guard deleted
   * (measured, run 40 chunk 1: mutation M2 was green against it). Pinned on the
   * first slice instead, 24.5 units is 0.51 workdays against a `projectStart`
   * floor of 0, which is a legal `'optimizer'` start — nothing but the guard
   * refuses it, and what it is refused for is being half a unit off the axis
   * every other start in the model sits on.
   */
  it('refuses an offset that is not a whole unit even where the plan would accept it', () => {
    expect(() =>
      materialise({
        [key.one]: 24.5,
        [key.two]: SOLVER_QUANTUM * 2,
        [key.three]: SOLVER_QUANTUM * 4,
      }),
    ).toThrow(ScheduleInvalidOptimizedStartError);
  });

  /**
   * A negative offset is below `projectStart` on every plan, so `schedule()`
   * would refuse it too — this case pins WHICH refusal answers, because the two
   * say different things to whoever reads the log. Asserting the class alone
   * would pass with the guard deleted.
   */
  it('refuses a negative offset in its own words rather than as a floor violation', () => {
    expect(() =>
      materialise({
        [key.one]: -SOLVER_QUANTUM,
        [key.two]: SOLVER_QUANTUM * 3,
        [key.three]: SOLVER_QUANTUM * 4,
      }),
    ).toThrow(/is not a whole non-negative unit offset/);
  });

  it('refuses an offset key the plan has no slice for', () => {
    expect(() =>
      materialise({
        [key.one]: 0,
        [key.two]: SOLVER_QUANTUM * 3,
        [key.three]: SOLVER_QUANTUM * 4,
        [key.four]: SOLVER_QUANTUM * 5,
      }),
    ).toThrow(/A\/four/);
  });

  it('leaves a missing key to schedule()’s own refusal rather than restating it', () => {
    expect(() => materialise({ [key.one]: 0, [key.two]: SOLVER_QUANTUM * 3 })).toThrow(
      /no start was returned for it/,
    );
  });
});

/**
 * `SOLVER_QUANTUM`'s own feasibility claim, asserted for the first time instead
 * of argued in a doc comment.
 *
 * The quantum rounds every duration UP, so every schedule feasible in the
 * quantised model is feasible in the real one — "quantisation costs optimality
 * and never validity". Two things follow, and both are checked here over all
 * eight Fast cases rather than over one fixture chosen to agree:
 *
 * 1. Materialising the quantised baseline never throws. This is the property
 *    run 40 chunk 2 found broken: `pinFloor` compared the dequantised pin to
 *    Fast's floor with `===`, so the plan's own baseline came back as
 *    `ScheduleInvalidOptimizedStartError` whenever the two roundings landed a
 *    ulp apart. **These eight cases do NOT prove that fix** — measured, not
 *    assumed: restoring the `===` reddens the hand-built `days: 5/12, width: 5`
 *    fixture above and none of the eight (M6, run 40 chunk 3). Every corpus
 *    duration happens to quantise exactly, so the corpus is a breadth check on
 *    the property, and the drift proof rests on that one fixture alone.
 * 2. No slice lands EARLIER than Fast put it. Later is the quantum's cost and
 *    is expected; earlier would mean a rounding went the wrong way and a
 *    materialised answer can break a constraint the model thought it held,
 *    which is the failure the whole rounding policy exists to prevent.
 */
describe('materialiseOptimized over the Fast golden corpus', () => {
  for (const each of FAST_GOLDEN_CASES) {
    it(`materialises ${each.name}'s own quantised baseline into a legal schedule`, () => {
      const notBefore = each.notBefore ?? new Map<string, number>();
      const poolSizes: PoolSizes = each.poolSizes ?? new Map();
      const reach = each.reach ?? 'whole-item';

      const offsets = quantisedFastBaseline(
        each.rows,
        each.edges,
        each.slices,
        notBefore,
        poolSizes,
        reach,
      );
      const fast = schedule(each.rows, each.edges, each.slices, notBefore, poolSizes, reach);
      const placed = materialiseOptimized(
        each.rows,
        each.edges,
        each.slices,
        notBefore,
        poolSizes,
        reach,
        offsets,
      );

      expect(placed.slices.size).toBe(fast.slices.size);
      // Reported as a map of the slices that went backwards rather than as a
      // bare boolean, so a failure names which ones did.
      const earlier = Object.fromEntries(
        [...placed.slices]
          .filter(([at, slice]) => {
            // A raw `<` is correct and a drift window here would be dead code,
            // measured rather than assumed: M7 dropped a `!withinDrift(...)`
            // clause from this predicate and reddened nothing. It cannot redden,
            // because `pinFloor` now returns the FLOOR's own double whenever the
            // pin is within drift of it — so a slice the quantum did not move
            // comes back exactly equal, never a ulp under. The tolerance belongs
            // in the engine, and putting a second copy of it here would hide the
            // day the engine's own stopped working.
            return slice.earliestStart < (fast.slices.get(at)?.earliestStart ?? 0);
          })
          .map(([at, slice]) => [readableKey(at), slice.earliestStart]),
      );
      expect(earlier).toEqual({});
    });
  }
});
