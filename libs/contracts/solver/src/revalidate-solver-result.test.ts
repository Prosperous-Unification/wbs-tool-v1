import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'bun:test';

import { revalidateOptimizedDeadlines, revalidateSolverResult } from './revalidate-solver-result';
import type {
  SolverObjectiveTerm,
  SolverObjectiveValues,
  SolverRequest,
  SolverResponse,
  SolverSlice,
} from './wire-types';

/**
 * 2.5's re-validation half. Every violation 2.4's placement rules name gets one
 * case, and each of them is paired with the nearest legal neighbour — a floor
 * met exactly, an edge met exactly, a pool filled exactly — because a check
 * that rejects the violation and its neighbour alike is a check that has not
 * been aimed.
 */

const slice = (over: Partial<SolverSlice> & { key: string }): SolverSlice => ({
  durationUnits: 10,
  width: 1,
  personId: null,
  poolIds: ['team'],
  priorityWeight: 0,
  notBeforeUnits: 0,
  deadlineUnits: null,
  ...over,
});

const request = (over: Partial<SolverRequest> = {}): SolverRequest => ({
  wireVersion: 1,
  contractVersion: '7+0.1.0',
  solverVersion: '0.1.0',
  objective: 'pri',
  budgetMs: 30_000,
  stageBudgetSplit: [0.6, 0.25, 0.15],
  quantum: 48,
  horizonUnits: 100,
  slices: [slice({ key: 'a' }), slice({ key: 'b' })],
  edges: [],
  pools: { team: 2 },
  baselineOffsets: { a: 0, b: 0 },
  fastHint: { a: 0, b: 0 },
  ...over,
});

const term = (value: number): SolverObjectiveValues[SolverObjectiveTerm] => ({
  value,
  stageValue: value,
  bound: value,
  status: 'feasible',
});

/**
 * The three cost terms of 5.2 over the default fixtures, where every slice runs
 * 10 units, carries `priorityWeight` 0 and has baseline 0. Computed rather than
 * written down, because every placement case below moves the offsets and the
 * re-validator now checks the arithmetic: a hand-written constant would turn
 * each of those cases into an objective failure wearing a placement name.
 */
const valuesFor = (
  offsets: Record<string, number>,
  over: Partial<SolverObjectiveValues> = {},
): SolverObjectiveValues => ({
  makespan: term(Math.max(0, ...Object.values(offsets).map((offset) => offset + 10))),
  priority: term(0),
  movement: term(Object.values(offsets).reduce((sum, offset) => sum + offset, 0)),
  ...over,
});

const feasible = (
  offsets: Record<string, number>,
  over: Partial<SolverObjectiveValues> = {},
): SolverResponse => ({
  wireVersion: 1,
  status: 'feasible',
  offsets,
  objectiveValues: valuesFor(offsets, over),
});

const rejects = (result: ReturnType<typeof revalidateSolverResult>, failure: string): void => {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.failure).toBe(failure as never);
};

describe('revalidateSolverResult accepts', () => {
  it('a schedule that meets every placement rule', () => {
    const result = revalidateSolverResult(request(), feasible({ a: 0, b: 0 }));
    expect(result).toEqual({ ok: true, published: true });
  });

  it('a non-publishing response with nothing checked', () => {
    for (const status of ['infeasible', 'unknown'] as const) {
      const result = revalidateSolverResult(request(), { wireVersion: 1, status });
      // `published: false` is the point: the response is acceptable AND there is
      // no plan, and a caller that reads `ok` alone would publish nothing at all.
      expect(result).toEqual({ ok: true, published: false });
    }
  });
});

describe('revalidateSolverResult refuses the request it cannot judge', () => {
  it('a duplicate slice key', () => {
    const twice = request({ slices: [slice({ key: 'a' }), slice({ key: 'a' })] });
    rejects(revalidateSolverResult(twice, feasible({ a: 0 })), 'malformed-request');
  });

  it('an edge naming a slice that does not exist', () => {
    const dangling = request({ edges: [{ predecessorKey: 'a', successorKey: 'ghost' }] });
    rejects(revalidateSolverResult(dangling, feasible({ a: 0, b: 0 })), 'malformed-request');
  });

  it('a pool membership with no capacity', () => {
    const unfunded = request({ pools: {} });
    rejects(revalidateSolverResult(unfunded, feasible({ a: 0, b: 0 })), 'malformed-request');
  });

  /**
   * TASK-329 AC #1. The rule TASK-303 wrote is now stated here, above the
   * non-feasible early return, so it reaches the paths that carry no schedule.
   * `infeasible` is the case the review filed: CP-SAT is right that a
   * zero-duration slice due at unit 1 and floored at unit 1 has no solution,
   * and answering it at all is what turns a meaningless request into a stored
   * `plan-infeasible` certificate. `unknown` is here for the same reason with
   * a different disposition downstream.
   */
  it('a deadlineUnits that is not a multiple of the quantum, on EVERY response status', () => {
    const malformed = request({
      slices: [slice({ key: 'a', durationUnits: 0, notBeforeUnits: 1, deadlineUnits: 1 })],
      baselineOffsets: { a: 0 },
      fastHint: { a: 0 },
    });
    for (const status of ['infeasible', 'unknown'] as const) {
      rejects(revalidateSolverResult(malformed, { wireVersion: 1, status }), 'malformed-request');
    }
    rejects(revalidateSolverResult(malformed, feasible({ a: 1 })), 'malformed-request');
  });

  /**
   * The nearest legal neighbours, because a check that refuses the violation
   * and its neighbour alike has not been aimed. `0` is TASK-267's unmeetable
   * sentinel and is a multiple; `null` is no deadline at all. Both still pass
   * on a non-publishing response, which is what proves the new call did not
   * turn the early return into a refusal of everything.
   */
  it('and accepts the multiples beside it on a non-publishing response', () => {
    for (const deadlineUnits of [null, 0, 48, 96]) {
      const legal = request({
        slices: [slice({ key: 'a', durationUnits: 0, deadlineUnits })],
        baselineOffsets: { a: 0 },
        fastHint: { a: 0 },
      });
      expect(revalidateSolverResult(legal, { wireVersion: 1, status: 'infeasible' })).toEqual({
        ok: true,
        published: false,
      });
    }
  });
});

describe('revalidateSolverResult checks the offset map', () => {
  it('rejects an offset map that omits a slice', () => {
    rejects(revalidateSolverResult(request(), feasible({ a: 0 })), 'offset-key-mismatch');
  });

  it('rejects an offset map that carries a slice the request never sent', () => {
    rejects(
      revalidateSolverResult(request(), feasible({ a: 0, b: 0, c: 0 })),
      'offset-key-mismatch',
    );
  });

  it('rejects a fractional, negative, or past-horizon offset (2.9)', () => {
    for (const offset of [0.5, -1, 101]) {
      rejects(revalidateSolverResult(request(), feasible({ a: offset, b: 0 })), 'offset-domain');
    }
  });

  it('accepts an offset sitting exactly on the horizon', () => {
    expect(revalidateSolverResult(request(), feasible({ a: 100, b: 0 })).ok).toBe(true);
  });
});

describe('revalidateSolverResult checks floors and edges', () => {
  it('rejects a slice starting before its floor, and accepts one starting on it', () => {
    const floored = request({
      slices: [slice({ key: 'a', notBeforeUnits: 5 }), slice({ key: 'b' })],
    });
    rejects(revalidateSolverResult(floored, feasible({ a: 4, b: 0 })), 'floor-violated');
    expect(revalidateSolverResult(floored, feasible({ a: 5, b: 0 })).ok).toBe(true);
  });

  it('rejects a successor starting before its predecessor finishes', () => {
    const chained = request({ edges: [{ predecessorKey: 'a', successorKey: 'b' }] });
    rejects(revalidateSolverResult(chained, feasible({ a: 0, b: 9 })), 'edge-violated');
    // The hand-off instant belongs to the successor: occupancy is half-open, so
    // finish == start is met exactly and not a violation by one unit.
    expect(revalidateSolverResult(chained, feasible({ a: 0, b: 10 })).ok).toBe(true);
  });
});

describe('revalidateSolverResult checks capacity', () => {
  it('rejects a pool over capacity and accepts one filled exactly', () => {
    const heavy = request({
      slices: [slice({ key: 'a', width: 2 }), slice({ key: 'b', width: 1 })],
    });
    rejects(revalidateSolverResult(heavy, feasible({ a: 0, b: 0 })), 'pool-overcapacity');
    // Same widths, no shared instant: the release runs before the acquisition.
    expect(revalidateSolverResult(heavy, feasible({ a: 0, b: 10 })).ok).toBe(true);
  });

  it('counts the whole width in EVERY pool a slice names, not just the first', () => {
    // `a` fits `team` and would fit `guild` alone; the overload exists only in
    // the second membership, so a check reading one pool per slice passes here.
    const shared = request({
      pools: { team: 4, guild: 1 },
      slices: [
        slice({ key: 'a', width: 2, poolIds: ['team', 'guild'] }),
        slice({ key: 'b', width: 1, poolIds: ['guild'] }),
      ],
    });
    rejects(revalidateSolverResult(shared, feasible({ a: 0, b: 0 })), 'pool-overcapacity');
  });

  it('rejects a double-booked assignee and accepts consecutive slices', () => {
    const person = request({
      slices: [slice({ key: 'a', personId: 'p-1' }), slice({ key: 'b', personId: 'p-1' })],
    });
    rejects(revalidateSolverResult(person, feasible({ a: 0, b: 5 })), 'assignee-double-booked');
    expect(revalidateSolverResult(person, feasible({ a: 0, b: 10 })).ok).toBe(true);
  });
});

describe('revalidateSolverResult recomputes the objective', () => {
  // 5.2: MAKESPAN = max finish, PRIORITY = Σ weight · finish,
  // MOVEMENT = Σ |start − baseline|. Hand-computed here so the assertion does
  // not share an implementation with the thing it is checking.
  const weighted = request({
    slices: [
      slice({ key: 'a', priorityWeight: 3 }),
      slice({ key: 'b', priorityWeight: 5, durationUnits: 4 }),
    ],
    baselineOffsets: { a: 7, b: 0 },
  });
  // a: finish 10, b: finish 20+4 = 24. makespan 24; priority 3·10 + 5·24 = 150;
  // movement |0−7| + |20−0| = 27.
  const truth: SolverObjectiveValues = {
    makespan: term(24),
    priority: term(150),
    movement: term(27),
  };
  const answer = (values: SolverObjectiveValues): SolverResponse => ({
    wireVersion: 1,
    status: 'feasible',
    offsets: { a: 0, b: 20 },
    objectiveValues: values,
  });
  const withMakespan = (
    over: SolverObjectiveValues[SolverObjectiveTerm],
  ): SolverObjectiveValues => ({ ...truth, makespan: over });

  it('accepts all three terms recomputed from the offsets', () => {
    expect(revalidateSolverResult(weighted, answer(truth))).toEqual({
      ok: true,
      published: true,
    });
  });

  it('rejects each term that disagrees with the offsets, one at a time', () => {
    const wrong: SolverObjectiveValues[] = [
      { ...truth, makespan: term(25) },
      { ...truth, priority: term(151) },
      { ...truth, movement: term(28) },
    ];
    for (const values of wrong) {
      rejects(revalidateSolverResult(weighted, answer(values)), 'objective-mismatch');
    }
  });

  it('accepts a value strictly better than its stage incumbent', () => {
    // A later stage may legitimately improve an earlier term below the
    // incumbent that stage proved; rejecting that rejects valid answers.
    const better = withMakespan({ value: 24, stageValue: 99, bound: 0, status: 'feasible' });
    expect(revalidateSolverResult(weighted, answer(better)).ok).toBe(true);
  });

  it('rejects a value worse than its stage incumbent', () => {
    // Every later stage carries an inequality at `stageValue`, so publishing
    // worse than it is a contract violation and not a better answer.
    const worse = withMakespan({ value: 24, stageValue: 23, bound: 0, status: 'feasible' });
    rejects(revalidateSolverResult(weighted, answer(worse)), 'objective-regression');
  });

  it('checks nothing against a null stageValue or bound', () => {
    const unproved = withMakespan({ value: 24, stageValue: null, bound: null, status: 'unknown' });
    expect(revalidateSolverResult(weighted, answer(unproved)).ok).toBe(true);
  });

  it('rejects a wire value that is not a non-negative safe integer', () => {
    for (const stageValue of [-1, 0.5, Number.MAX_SAFE_INTEGER + 2]) {
      const bad = withMakespan({ value: 24, stageValue, bound: 0, status: 'feasible' });
      rejects(revalidateSolverResult(weighted, answer(bad)), 'objective-domain');
    }
  });

  it('refuses to round an overflow instead of reporting it', () => {
    // 2^31 slices' worth of weight against a 2^31 horizon is past
    // MAX_SAFE_INTEGER by two orders of magnitude. A `number` accumulator would
    // round the product and then agree with whatever the solver claimed.
    const huge = request({
      horizonUnits: 2_147_483_647,
      slices: [slice({ key: 'a', priorityWeight: 2_147_483_647, durationUnits: 1 })],
      baselineOffsets: { a: 0 },
      fastHint: { a: 0 },
    });
    const response: SolverResponse = {
      wireVersion: 1,
      status: 'feasible',
      offsets: { a: 2_147_483_646 },
      objectiveValues: {
        makespan: term(2_147_483_647),
        priority: term(0),
        movement: term(2_147_483_646),
      },
    };
    rejects(revalidateSolverResult(huge, response), 'objective-overflow');
  });

  it('refuses a request whose arithmetic cannot be done', () => {
    // `BigInt(1.5)` throws, and a re-validator that crashes reports nothing.
    const fractional = request({ slices: [slice({ key: 'a', priorityWeight: 1.5 })] });
    rejects(revalidateSolverResult(fractional, feasible({ a: 0 })), 'malformed-request');
    const unbaselined = request({ baselineOffsets: { a: 0 } });
    rejects(revalidateSolverResult(unbaselined, feasible({ a: 0, b: 0 })), 'malformed-request');
  });
});

describe('the golden corpus proves the schema cannot answer this question', () => {
  const read = (path: string): unknown =>
    JSON.parse(readFileSync(new URL(`../fixtures/${path}`, import.meta.url), 'utf8'));

  it("rejects the corpus's own schema-valid request and response", () => {
    // `request/valid-two-slices.json` is valid on purpose and draws a width-5
    // slice against a capacity-2 pool; `response/valid-feasible.json` answers it
    // with offsets that satisfy the edge. Both pass their schema branch. The
    // pair is still unpublishable, which is the whole reason 2.4 exists.
    const corpusRequest = read('request/valid-two-slices.json') as SolverRequest;
    const corpusResponse = read('response/valid-feasible.json') as SolverResponse;
    rejects(revalidateSolverResult(corpusRequest, corpusResponse), 'pool-overcapacity');
  });
});

/**
 * 2.5's DEADLINE half — one case per rule 2.4's deadline clause names, each
 * paired with its nearest legal neighbour for the same reason the placement
 * cases are.
 *
 * The clause reads the MATERIALISED schedule, so these feed
 * `revalidateOptimizedDeadlines` a placement map directly rather than routing
 * through `materialiseOptimized`: the arithmetic under test is
 * `lastWorkdayOf(start, finish) <= deadlineUnits / quantum - 1`, and running a
 * real solve first would decide the numbers the assertions are about.
 *
 * `deadlineUnits` is `(D + 1) x quantum`, so day 0 is `48` and day 1 is `96`.
 */
describe('revalidateOptimizedDeadlines', () => {
  const placedOf = (
    spans: Record<string, readonly [number, number]>,
  ): {
    readonly slices: ReadonlyMap<string, { earliestStart: number; earliestFinish: number }>;
  } => ({
    slices: new Map(
      Object.entries(spans).map(([key, [earliestStart, earliestFinish]]) => [
        key,
        { earliestStart, earliestFinish },
      ]),
    ),
  });

  it('accepts work that runs to the end of its own due day', () => {
    const found = revalidateOptimizedDeadlines(
      request({ slices: [slice({ key: 'a', deadlineUnits: 96 })] }),
      placedOf({ a: [0, 2] }),
    );
    expect(found).toEqual({ ok: true, published: true });
  });

  it('rejects work whose last day is one past the deadline', () => {
    const found = revalidateOptimizedDeadlines(
      request({ slices: [slice({ key: 'a', deadlineUnits: 96 })] }),
      placedOf({ a: [0, 3] }),
    );
    expect(found.ok).toBe(false);
    if (found.ok) throw new Error('unreachable');
    expect(found.failure).toBe('deadline-violated');
    expect(found.detail).toContain('day 2');
  });

  /**
   * The clause that is the reason this is not checked in quantised units. A
   * span finishing at 1.5 days occupies part of day 1, so its last workday is
   * 1 and a day-0 deadline is broken — while `Math.floor` on the same number,
   * or a units comparison against `48`, would call it met.
   */
  it('counts a fractional finish as spilling into the day it touches', () => {
    const found = revalidateOptimizedDeadlines(
      request({ slices: [slice({ key: 'a', deadlineUnits: 48 })] }),
      placedOf({ a: [0, 1.5] }),
    );
    expect(found.ok).toBe(false);
    if (found.ok) throw new Error('unreachable');
    expect(found.failure).toBe('deadline-violated');
  });

  it('accepts the same slice finishing exactly on the day boundary', () => {
    expect(
      revalidateOptimizedDeadlines(
        request({ slices: [slice({ key: 'a', deadlineUnits: 48 })] }),
        placedOf({ a: [0, 1] }),
      ),
    ).toEqual({ ok: true, published: true });
  });

  /**
   * The pair that proves this side and the CP-SAT side now read one predicate.
   * A zero-duration milestone is the only input on which
   * `end <= deadlineUnits` and `start + max(duration, 1) <= deadlineUnits`
   * differ, and `libs/solver-py/tests/test_model.py`'s W2 pair fixes the same
   * two placements in units: unit 48 refused, unit 47 admitted. Day 1 and day
   * 47/48 are those two placements in the fractional domain this side works in.
   *
   * Before `tasks.md` 8.3 the model admitted the first of them while this
   * refused it, so a deterministic `plan-infeasible` arrived at the coordinator
   * as `invalid-output`. If either half of this pair ever disagrees with its
   * Python twin, that confusion is back.
   */
  it('refuses a zero-duration milestone standing on the exclusive boundary', () => {
    const found = revalidateOptimizedDeadlines(
      request({ slices: [slice({ key: 'a', durationUnits: 0, deadlineUnits: 48 })] }),
      placedOf({ a: [1, 1] }),
    );
    expect(found.ok).toBe(false);
    if (found.ok) throw new Error('unreachable');
    expect(found.failure).toBe('deadline-violated');
    expect(found.detail).toContain('day 1');
  });

  /**
   * TASK-303, and the Sol seat's own input verbatim: quantum 48, duration 0,
   * `deadlineUnits` 49, start unit 48.
   *
   * **The disagreement this closes is between two halves that are each right.**
   * The CP-SAT model accepts the placement — `48 + max(0, 1) = 49 <= 49` —
   * while this side derives a due day of `49 / 48 - 1 = 1/48`, a *fractional*
   * day {@link isOnTime} was never written to take, and refuses a feasible plan
   * as `deadline-violated`. That is the same feasible/`invalid-output` mismatch
   * 8.3 closed at the zero-duration boundary, surviving one level up through a
   * field nothing validated: the wire schema accepts every non-negative safe
   * integer, and a cross-field `multipleOf` against the request's own `quantum`
   * is not expressible in JSON Schema, so this is the contract boundary.
   *
   * `malformed-request` and not `deadline-violated` is the whole point. The
   * input is not a plan that misses a deadline; it is a request that does not
   * mean anything, and the two answers send a reader to different files.
   */
  it('refuses a deadline that is not a whole number of workdays', () => {
    const found = revalidateOptimizedDeadlines(
      request({ slices: [slice({ key: 'a', durationUnits: 0, deadlineUnits: 49 })] }),
      placedOf({ a: [1, 1] }),
    );
    expect(found.ok).toBe(false);
    if (found.ok) throw new Error('unreachable');
    expect(found.failure).toBe('malformed-request');
    expect(found.detail).toContain('49');
  });

  /**
   * The neighbour that keeps the new refusal from swallowing a real state.
   * `deadlineUnits: 0` is TASK-267's `UNMEETABLE_DEADLINE_OFFSET = -1` mapped
   * through `deadlineUnitsOf`, and `0 % 48 === 0`, so it stays a well-formed
   * request whose due day is `-1` — every non-negative placement misses it.
   * Refusing it as malformed would turn a deadline the user cannot meet into an
   * engine failure, which is the confusion `plan-infeasible` exists to prevent.
   */
  it('keeps an unmeetable zero deadline well-formed and simply missed', () => {
    const found = revalidateOptimizedDeadlines(
      request({ slices: [slice({ key: 'a', durationUnits: 0, deadlineUnits: 0 })] }),
      placedOf({ a: [0, 0] }),
    );
    expect(found.ok).toBe(false);
    if (found.ok) throw new Error('unreachable');
    expect(found.failure).toBe('deadline-violated');
  });

  it('accepts the same milestone one unit inside its due day', () => {
    expect(
      revalidateOptimizedDeadlines(
        request({ slices: [slice({ key: 'a', durationUnits: 0, deadlineUnits: 48 })] }),
        placedOf({ a: [47 / 48, 47 / 48] }),
      ),
    ).toEqual({ ok: true, published: true });
  });

  it('leaves a slice with no deadline unconstrained however late it runs', () => {
    expect(
      revalidateOptimizedDeadlines(
        request({ slices: [slice({ key: 'a', deadlineUnits: null })] }),
        placedOf({ a: [0, 900] }),
      ),
    ).toEqual({ ok: true, published: true });
  });

  /**
   * A gap in the key sets is OUR bug — `materialiseOptimized` has already
   * proved they are equal by the time a schedule exists — so it is reported as
   * `malformed-request` and not as a broken deadline. Blaming the solver would
   * send the repair to the wrong side of the seam.
   */
  it('reports a missing placement as malformed-request, not as a violation', () => {
    const found = revalidateOptimizedDeadlines(
      request({ slices: [slice({ key: 'a', deadlineUnits: 96 })] }),
      placedOf({ b: [0, 1] }),
    );
    expect(found.ok).toBe(false);
    if (found.ok) throw new Error('unreachable');
    expect(found.failure).toBe('malformed-request');
  });

  it('refuses a deadlineUnits outside the safe non-negative integers', () => {
    const found = revalidateOptimizedDeadlines(
      request({ slices: [slice({ key: 'a', deadlineUnits: 48.5 })] }),
      placedOf({ a: [0, 1] }),
    );
    expect(found.ok).toBe(false);
    if (found.ok) throw new Error('unreachable');
    expect(found.failure).toBe('malformed-request');
  });

  it('checks every slice, not only the first', () => {
    const found = revalidateOptimizedDeadlines(
      request({
        slices: [slice({ key: 'a', deadlineUnits: 480 }), slice({ key: 'b', deadlineUnits: 96 })],
      }),
      placedOf({ a: [0, 2], b: [0, 5] }),
    );
    expect(found.ok).toBe(false);
    if (found.ok) throw new Error('unreachable');
    expect(found.detail).toContain('"b"');
  });
});
