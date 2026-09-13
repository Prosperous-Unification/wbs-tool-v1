import { describe, expect, it } from 'bun:test';

import { preflightSolverRequest } from './solver-preflight';
import { SOLVER_HORIZON_UNITS_MAX, type SolverSlice } from './wire-types';

const sliceOf = (over: Partial<SolverSlice> = {}): SolverSlice => ({
  workItemKey: 'work',
  key: 'k',
  durationUnits: 48,
  width: 1,
  personId: null,
  poolIds: [],
  priorityWeight: 0,
  notBeforeUnits: 0,
  deadlineUnits: null,
  workItemIsMilestone: false,
  ...over,
});

/**
 * One entry for the one key every slice above carries — the tests below are
 * about the horizon and the priority product, and a baseline of zero leaves
 * MOVEMENT's own worst case at `horizonUnits` per slice, which none of them is
 * near. MOVEMENT gets its own block at the end.
 */
const atZero = { k: 0 };

describe('preflightSolverRequest', () => {
  it('is the SERIAL bound: the latest floor plus every duration', () => {
    const preflight = preflightSolverRequest(
      [
        sliceOf({ durationUnits: 10, notBeforeUnits: 5 }),
        sliceOf({ durationUnits: 7, notBeforeUnits: 100 }),
      ],
      atZero,
    );
    expect(preflight).toEqual({ ok: true, horizonUnits: 117 });
  });

  it('seeds the floor with zero, so a plan with no manual floors has a horizon', () => {
    // The common case: an unseeded max over an empty set has no value.
    expect(preflightSolverRequest([sliceOf({ durationUnits: 3 })], atZero)).toEqual({
      ok: true,
      horizonUnits: 3,
    });
    expect(preflightSolverRequest([], atZero)).toEqual({ ok: true, horizonUnits: 0 });
  });

  it('accepts a horizon exactly at the maximum', () => {
    const preflight = preflightSolverRequest(
      [sliceOf({ durationUnits: SOLVER_HORIZON_UNITS_MAX })],
      atZero,
    );
    expect(preflight).toEqual({ ok: true, horizonUnits: SOLVER_HORIZON_UNITS_MAX });
  });

  it('refuses one unit past it with horizon-overflow', () => {
    const preflight = preflightSolverRequest(
      [sliceOf({ durationUnits: SOLVER_HORIZON_UNITS_MAX }), sliceOf({ durationUnits: 1 })],
      atZero,
    );
    expect(preflight.ok).toBe(false);
    if (preflight.ok) throw new Error('unreachable');
    expect(preflight.failure).toBe('horizon-overflow');
  });

  it('counts a floor toward the horizon, not only the durations', () => {
    const preflight = preflightSolverRequest(
      [sliceOf({ durationUnits: 1, notBeforeUnits: SOLVER_HORIZON_UNITS_MAX })],
      atZero,
    );
    expect(preflight.ok).toBe(false);
    if (preflight.ok) throw new Error('unreachable');
    expect(preflight.failure).toBe('horizon-overflow');
  });

  it('sums in bigint, so the check cannot pass by having already lost precision', () => {
    // Three slices whose Number sum rounds: 2^53 - 1 twice over is not a safe
    // integer, and a Number accumulator would compare a value it had already
    // corrupted. The horizon check must catch this, not the objective one.
    const preflight = preflightSolverRequest(
      [
        sliceOf({ durationUnits: Number.MAX_SAFE_INTEGER }),
        sliceOf({ durationUnits: Number.MAX_SAFE_INTEGER }),
        sliceOf({ durationUnits: 1 }),
      ],
      atZero,
    );
    expect(preflight.ok).toBe(false);
    if (preflight.ok) throw new Error('unreachable');
    expect(preflight.failure).toBe('horizon-overflow');
    expect(preflight.detail).toContain('18014398509481983');
  });

  it('refuses a priority worst case above MAX_SAFE_INTEGER with objective-overflow', () => {
    // Horizon is comfortably legal; the product is not. Weight x horizon is the
    // coefficient the solver would carry, and above MAX_SAFE_INTEGER it stops
    // surviving the round trip through Bun and JSON.
    const preflight = preflightSolverRequest(
      [sliceOf({ durationUnits: 1_000_000_000, priorityWeight: 10_000_000 })],
      atZero,
    );
    expect(preflight.ok).toBe(false);
    if (preflight.ok) throw new Error('unreachable');
    expect(preflight.failure).toBe('objective-overflow');
  });

  it('bounds the priority worst case at the FINISH, not at the horizon', () => {
    // Measured in TASK-219 run 20 chunk 1, on the solver itself: `horizonUnits`
    // bounds a slice's START, and PRIORITY is a sum over FINISHES. So the worst
    // case is Sum w(s) x (horizonUnits + durationUnits(s)), and the earlier
    // Sum w(s) x horizonUnits was short by exactly Sum w(s) x durationUnits(s).
    //
    // This instance is the boundary and every number in it is real. Horizon is
    // 2^31 - 1, the schema's own maximum; weight is 2^22. The old bound is
    // 2^22 x (2^31 - 1) = 9007199250546688, which is under MAX_SAFE_INTEGER and
    // was therefore accepted. The model's own PRIORITY ceiling is
    // 2^22 x 2^31 = 2^53 = MAX_SAFE_INTEGER + 1, and a placement at the horizon
    // reaching it was proved OPTIMAL by CP-SAT. Accepting this request means
    // publishing a `priority.value` the response schema's own `safeInteger`
    // refuses — Bun rejecting the response it asked for.
    const preflight = preflightSolverRequest(
      [
        sliceOf({
          durationUnits: 1,
          notBeforeUnits: SOLVER_HORIZON_UNITS_MAX - 1,
          priorityWeight: 2 ** 22,
        }),
      ],
      atZero,
    );
    expect(preflight.ok).toBe(false);
    if (preflight.ok) throw new Error('unreachable');
    expect(preflight.failure).toBe('objective-overflow');
    expect(preflight.detail).toContain('9007199254740992');
  });

  it('accepts the same plan one unit of weight lower', () => {
    // The boundary is a boundary, not a blanket refusal of large weights. At
    // 2^22 - 1 the finish-based worst case is 9007197107257344, inside
    // MAX_SAFE_INTEGER, and this is the request the case above is one unit from.
    const preflight = preflightSolverRequest(
      [
        sliceOf({
          durationUnits: 1,
          notBeforeUnits: SOLVER_HORIZON_UNITS_MAX - 1,
          priorityWeight: 2 ** 22 - 1,
        }),
      ],
      atZero,
    );
    expect(preflight).toEqual({ ok: true, horizonUnits: SOLVER_HORIZON_UNITS_MAX });
  });

  it('checks the horizon FIRST, so an over-horizon plan is not misreported', () => {
    // Both bounds are broken here. The horizon is the cause and the objective
    // failure is its consequence; naming the consequence would send a user to
    // their priorities when the plan is simply too long.
    const preflight = preflightSolverRequest(
      [sliceOf({ durationUnits: Number.MAX_SAFE_INTEGER, priorityWeight: 1_000_000 })],
      atZero,
    );
    expect(preflight.ok).toBe(false);
    if (preflight.ok) throw new Error('unreachable');
    expect(preflight.failure).toBe('horizon-overflow');
  });

  it('passes a plan whose weights are all zero, whatever the horizon', () => {
    // Nobody prioritised anything, which is most plans. The product is zero and
    // the objective bound is not in play.
    expect(
      preflightSolverRequest([sliceOf({ durationUnits: SOLVER_HORIZON_UNITS_MAX })], atZero).ok,
    ).toBe(true);
  });
});

describe("preflightSolverRequest's MOVEMENT bound", () => {
  const two = [sliceOf({ key: 'a', durationUnits: 60 }), sliceOf({ key: 'b', durationUnits: 40 })];

  it('accepts a baseline anywhere on the axis', () => {
    // Horizon 100. Worst case is max(b, 100 - b) per slice — 70 and 100 — which
    // is nowhere near MAX_SAFE_INTEGER and must not be refused.
    expect(preflightSolverRequest(two, { a: 30, b: 100 })).toEqual({
      ok: true,
      horizonUnits: 100,
    });
  });

  it('throws on a slice with no baseline, rather than reporting it to a user', () => {
    // The key sets are equal by construction — one grouping produces slices,
    // baselineOffsets and fastHint — so a gap is this package's bug. Every
    // failure token here is a sentence a client shows somebody; this is not one.
    expect(() => preflightSolverRequest(two, { a: 0 })).toThrow(/no baseline offset for slice b/);
  });

  it('cannot overflow below roughly four million slices, which is why no test spends one', () => {
    // Stated as arithmetic rather than as a fixture, because the fixture does
    // not exist: the check runs only after the horizon passed, so every term is
    // at most SOLVER_HORIZON_UNITS_MAX and the sum needs that many terms to
    // reach MAX_SAFE_INTEGER. The guard is therefore against a future horizon
    // bound, not against a plan anybody has — and the honest version of that
    // sentence is this assertion, not a comment.
    const termsNeeded = Math.ceil(Number.MAX_SAFE_INTEGER / SOLVER_HORIZON_UNITS_MAX);
    expect(termsNeeded).toBeGreaterThan(4_000_000);
    expect(SOLVER_HORIZON_UNITS_MAX * 4_000_000).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});
