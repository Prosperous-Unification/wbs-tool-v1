import { describe, expect, it } from 'bun:test';

import { FAST_GOLDEN_CASES } from './fast-golden-corpus';
import {
  type PoolSizes,
  type Schedule,
  schedule,
  ScheduleInvalidOptimizedStartError,
  type Slice,
  sliceKey,
} from './schedule';

/**
 * Task 4.9's behaviour-preservation proof, and the three refusals around it.
 *
 * `schedule(input, pinnedStarts)` is the optimized materialiser: the same pass,
 * with each slice's start overridden and every other rule — the floor, the
 * tiling, the pool's explanation, the resource referent, the backward pass —
 * running unchanged and once. 4.9 asks for the split to be proved
 * behaviour-preserving **before** anything optimized is built on it, and states
 * the proof precisely: `annotate(input, chooseStarts(input))` must equal
 * `placeSlices(input)` over the Fast golden corpus.
 *
 * It is not a tautology, and that is the point of running it rather than
 * arguing it. Fast drains its eligible set in **priority** order and the replay
 * drains it in ascending `(start, canonical slice order)`, so the two passes
 * reach each slice with different ledgers behind them: a different set of pool
 * reservations is present when the joint window is searched, and a different
 * set of people are busy. The claim under test is that pinning Fast's own
 * answers makes those differences invisible — every slice lands on the start it
 * already had, so every floor resolves to the same word and every ledger write
 * repeats.
 */

/**
 * `chooseStarts`: the half of the split that decides, read off a finished schedule.
 *
 * `earliestStart` and not `start`, because a {@link ScheduledSlice} has no
 * `start`: the forward pass's answer is the slice's early start and the backward
 * pass adds a late one beside it. Written as `start` first, and every case here
 * threw `no start was returned for it` — the map was eight keys onto `undefined`.
 */
const startsOf = (produced: Schedule): Map<string, number> =>
  new Map([...produced.slices].map(([key, each]): [string, number] => [key, each.earliestStart]));

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

describe('the optimized materialiser is Fast with its starts pinned', () => {
  for (const each of FAST_GOLDEN_CASES) {
    it(`replays ${each.name} into the schedule Fast produced`, () => {
      const notBefore = each.notBefore ?? new Map<string, number>();
      const poolSizes: PoolSizes = each.poolSizes ?? new Map();
      const reach = each.reach ?? 'whole-item';
      const fast = schedule(each.rows, each.edges, each.slices, notBefore, poolSizes, reach);

      const replayed = schedule(
        each.rows,
        each.edges,
        each.slices,
        notBefore,
        poolSizes,
        reach,
        startsOf(fast),
      );

      // The whole answer, not the dates: `boundBy`, the resource referent, the
      // capacity set, the team, both wait counters and every work-item
      // projection are what a transcription gets wrong, and comparing starts
      // alone would call four of the five extractions proved when none of them
      // had been read.
      expect(replayed.slices).toEqual(fast.slices);
      expect(replayed.workItems).toEqual(fast.workItems);
      expect(replayed.waitingForPerson).toBe(fast.waitingForPerson);
      expect(replayed.waitingForCapacity).toBe(fast.waitingForCapacity);
    });
  }
});

describe('a pinned start the plan refuses', () => {
  const rows = [leafRow('a', 10), leafRow('b', 20)];
  const chain = [{ predecessorId: 'a', successorId: 'b' }];
  const slices = [work('a', 2), work('b', 2)];

  it('throws when a start is earlier than the floor its predecessor sets', () => {
    const fast = schedule(rows, chain, slices);
    const pinned = startsOf(fast);
    // `b` follows `a`, which takes two days, so day 1 is inside its
    // predecessor. Not a worse schedule — not a schedule.
    pinned.set(sliceKey('b', null), 1);

    expect(() =>
      schedule(rows, chain, slices, new Map(), new Map(), 'whole-item', new Map(), pinned),
    ).toThrow(ScheduleInvalidOptimizedStartError);
  });

  it('throws when a start has no room in the pool it named', () => {
    const pooled = [work('a', 2, { poolIds: ['team'] }), work('b', 2, { poolIds: ['team'] })];
    const sizes: PoolSizes = new Map([['team', 1]]);
    // `a` idled to day 3 is legal — the pool is free there and nothing else
    // wants it — and it puts `b` at day 4 **inside** `a`, where the pool of one
    // has no second slot. The earlier branch cannot catch this: 4 is strictly
    // later than every floor `b` has, because `b` depends on nothing and the
    // pool is free at 0.
    const pinned = new Map([
      [sliceKey('a', null), 3],
      [sliceKey('b', null), 4],
    ]);

    expect(() =>
      schedule(rows, [], pooled, new Map(), sizes, 'whole-item', new Map(), pinned),
    ).toThrow(ScheduleInvalidOptimizedStartError);
  });

  it('throws when the optimizer returned no start for a slice the plan has', () => {
    const pinned = new Map([[sliceKey('a', null), 0]]);

    expect(() =>
      schedule(rows, chain, slices, new Map(), new Map(), 'whole-item', new Map(), pinned),
    ).toThrow(ScheduleInvalidOptimizedStartError);
  });
});

describe("a start no floor of the plan explains is the optimizer's", () => {
  it("labels a deliberately idled slice 'optimizer' and names no resource for it", () => {
    const rows = [leafRow('a', 10)];
    const slices = [work('a', 2, { poolIds: ['team'] })];
    const sizes: PoolSizes = new Map([['team', 1]]);
    const pinned = new Map([[sliceKey('a', null), 5]]);

    const produced = schedule(rows, [], slices, new Map(), sizes, 'whole-item', new Map(), pinned);
    const only = produced.slices.get(sliceKey('a', null));

    expect(only?.earliestStart).toBe(5);
    expect(only?.boundBy).toBe('optimizer');
    // The render invariant, additively: `'optimizer'` is not a resource, so it
    // names none — the same rule `projectStart` already takes. A pool bound at
    // its own pinned instant would name a team here, and `annotateCapacity`
    // throws rather than let that reach a bar.
    expect(only?.resourcePredecessorId).toBeNull();
    expect(only?.capacityPredecessorIds).toEqual([]);
    expect(only?.capacityTeamId).toBeNull();
    expect(produced.waitingForPerson).toBe(0);
    expect(produced.waitingForCapacity).toBe(0);
  });
});

describe('the two rules the corpus cannot see, because it pins Fast onto Fast', () => {
  /**
   * Both of these came out of mutations that stayed **green** on the corpus and
   * on every case above it (run 39, chunk 1, M4 and M5). Neither is a defect —
   * the behaviour-preservation proof pins Fast's own answers, so by construction
   * it cannot separate a replay that reorders from one that does not, nor a pool
   * re-ask from one that keeps a window nothing was binding. They need starts an
   * optimizer would return and Fast would not.
   */

  it("replays a person queue in the optimizer's order, not in the priority order", () => {
    // `kat` does both, and the optimizer swaps them against their priorities:
    // `a` outranks `b` and is nonetheless idled to day 3 while `b` takes day 0.
    const rows = [leafRow('a', 10, 1), leafRow('b', 20, 5)];
    const slices = [work('a', 2, { personId: 'kat' }), work('b', 2, { personId: 'kat' })];
    const pinned = new Map([
      [sliceKey('a', null), 3],
      [sliceKey('b', null), 0],
    ]);

    const produced = schedule(
      rows,
      [],
      slices,
      new Map(),
      new Map(),
      'whole-item',
      new Map(),
      pinned,
    );

    // Drained in priority order this throws rather than misreporting: `a` is
    // reached first, `kat` is busy until 5, and `b`'s pinned 0 is then below its
    // own person floor — a legal optimized schedule refused as invalid output.
    // Watched red: M4 forced `levelOrder` back to `goesFirst` and this case is
    // the one that reddens.
    expect(produced.slices.get(sliceKey('b', null))?.earliestStart).toBe(0);
    expect(produced.slices.get(sliceKey('a', null))?.earliestStart).toBe(3);
    // `b` went first, so it is nobody's successor and `a` is behind it. The edge
    // is the pass's own `busyUntil`, which is why the drain order decides it.
    expect(produced.slices.get(sliceKey('b', null))?.boundBy).toBe('projectStart');
    expect(produced.slices.get(sliceKey('a', null))?.boundBy).toBe('optimizer');
  });

  it('re-asks the pool at the pinned instant rather than keeping the floor window', () => {
    // A pool of one that IS binding at `b`'s plan floor — `a` holds it until
    // day 2 — and free at the day 3 the optimizer pinned `b` to. The floor
    // window therefore carries a `binding` entry the pinned window does not.
    const rows = [leafRow('a', 10), leafRow('b', 20)];
    const pooled = [work('a', 2, { poolIds: ['team'] }), work('b', 2, { poolIds: ['team'] })];
    const sizes: PoolSizes = new Map([['team', 1]]);
    const pinned = new Map([
      [sliceKey('a', null), 0],
      [sliceKey('b', null), 3],
    ]);

    const produced = schedule(rows, [], pooled, new Map(), sizes, 'whole-item', new Map(), pinned);
    const idled = produced.slices.get(sliceKey('b', null));

    expect(idled?.earliestStart).toBe(3);
    expect(idled?.boundBy).toBe('optimizer');
    // Watched red: M5 left `window` as the floor's, so `annotateCapacity` read a
    // non-empty `binding` beside `boundBy: 'optimizer'` and threw `names team
    // with no pool binding it` — the render invariant catching the fault one
    // layer down, which is what it is for.
    expect(idled?.capacityTeamId).toBeNull();
    expect(idled?.capacityPredecessorIds).toEqual([]);
    expect(idled?.resourcePredecessorId).toBeNull();
    // Nothing in this plan is capacity-bound once the optimizer has moved `b`
    // clear of the pool, so the header says so.
    expect(produced.waitingForCapacity).toBe(0);
  });
});

/**
 * The pool re-ask is the floor comparison one branch down, and it drifts for
 * the same reason.
 *
 * Run 40 chunk 2 closed `pinFloor`'s floor comparison — `<` and `===` against
 * two different roundings of one real number — and named the re-ask below it as
 * the same shape, unproved. It is reachable, and the fixture needs nothing
 * exotic: `a` is one slice of `1 / 48` of a day pinned at solver unit 7, so the
 * pool releases at `7 / 48 + 1 / 48`, which is one ulp ABOVE unit 8. Pin `b`
 * there — abutting on the solver's own integer axis, which is the commonest
 * thing an optimizer does — and `window.start !== pinned` refused it.
 *
 * The two sides are the same two roundings the floor branch already reconciles:
 * the pin divides back from `k / SOLVER_QUANTUM`, the release accumulated
 * through `start + days / width`.
 */
describe('a pinned start the pool releases a ulp later', () => {
  const rows = [leafRow('a', 10), leafRow('b', 20)];
  const sizes: PoolSizes = new Map([['team', 1]]);
  // `b` is short enough to fit in the gap before `a`, so its plan floor is 0
  // and the pin is STRICTLY later than every floor it has — which is the only
  // way into the re-ask branch at all.
  const pooled = [
    work('a', 1 / 48, { poolIds: ['team'] }),
    work('b', 2 / 48, { poolIds: ['team'] }),
  ];
  const PINNED_A = 7 / 48;
  const PINNED_B = 8 / 48;
  /** What the pass itself computes for `a`'s finish: `start + days / width`. */
  const RELEASE = PINNED_A + 1 / 48;

  it("places the slice on the pool's own double rather than refusing it", () => {
    const pinned = new Map([
      [sliceKey('a', null), PINNED_A],
      [sliceKey('b', null), PINNED_B],
    ]);

    // The drift is real arithmetic and not a constructed one: assert it here so
    // the case fails loudly if a future change to `durationOf` or to the
    // quantum moves the fixture off the ulp it is about, rather than passing
    // vacuously as an ordinary abutment.
    expect(RELEASE).toBeGreaterThan(PINNED_B);
    expect(RELEASE - PINNED_B).toBeLessThan(1e-15);

    const produced = schedule(rows, [], pooled, new Map(), sizes, 'whole-item', new Map(), pinned);
    const abutting = produced.slices.get(sliceKey('b', null));

    // **The pool's double wins, not the pin's** — the same rule the floor
    // branch takes one line up, for the same reason: the schedule stays on one
    // axis, and a start one ulp inside a live reservation would leave the
    // profile genuinely over-allocated.
    expect(abutting?.earliestStart).toBe(RELEASE);
    expect(abutting?.boundBy).toBe('optimizer');
    // The re-ask from the pool's own instant is a fixpoint, so `binding` is
    // empty and the render invariant holds additively — a ulp is not a wait,
    // and naming `team` here would be a sentence about a block nothing held up.
    expect(abutting?.capacityTeamId).toBeNull();
    expect(abutting?.capacityPredecessorIds).toEqual([]);
    expect(abutting?.resourcePredecessorId).toBeNull();
    expect(produced.waitingForCapacity).toBe(0);
  });

  it('still refuses a pin one whole solver unit inside the reservation', () => {
    // The guard on the window above, and the reason it cannot hide anything:
    // the solver places integers, so a pin that genuinely has no room is short
    // by at least `1 / SOLVER_QUANTUM` — 0.0208 of a day against a 1e-9 window,
    // nine orders of magnitude. Widen `DRIFT` past a unit and this case fails.
    const pinned = new Map([
      [sliceKey('a', null), PINNED_A],
      [sliceKey('b', null), PINNED_A],
    ]);

    expect(() =>
      schedule(rows, [], pooled, new Map(), sizes, 'whole-item', new Map(), pinned),
    ).toThrow(ScheduleInvalidOptimizedStartError);
  });
});

/**
 * **4.10b's Fast arm is NOT here, and was not written twice.** It already
 * exists as `schedule-placement-order.test.ts` — run 38 audited it and pinned
 * the same fixture, a zero-duration predecessor whose id sorts after its
 * successor sharing one start. This file wrote it a second time in run 39 and
 * the duplicate was caught by its own mutation, which reddened three cases
 * where it should have reddened one; the copy is deleted rather than kept
 * beside the original. What 4.10b still owes is the OPTIMIZED half, and the
 * case above — the person queue replayed in the optimizer's order — is it.
 */
