import type { PlannedRow, Slice } from '@wbs/domain';
import { describe, expect, it } from 'bun:test';

import { buildSolverRequest, type SolverRequestPlan } from './build-solver-request';
import { quantisedFastBaseline } from './quantised-baseline';
import { revalidateSolverResult } from './revalidate-solver-result';
import { SOLVER_WIRE_VERSION, type SolverResponse } from './wire-types';

/**
 * 2.11's remaining clause: **the hint is feasible**.
 *
 * The claim the whole quantised baseline exists to make is that
 * `baselineOffsets` is a feasible solution of *exactly the model the solver
 * receives* — otherwise stage 1's upper bound is a bound the search cannot
 * meet, and the hint is infeasible in the model it hints. Real Fast's answer is
 * not that: three serial slices at `days: 1, width: 5` finish at 28.8 units,
 * which no CP-SAT variable holds, while the rounded model needs 30.
 *
 * **The checker already existed and is not reimplemented here.**
 * `revalidateSolverResult` is the same constraint pass that stands between a
 * solver's answer and a published schedule — offsets in domain, key sets equal,
 * every edge respected, every floor respected, no pool over capacity, no person
 * double-booked. Feeding the baseline back through it *as a response* asks the
 * feasibility question with the code that will ask it in production, rather
 * than with a second copy of the rules that could agree with the baseline by
 * being written from it.
 *
 * The response is assembled here rather than round-tripped through the parser
 * because the parser proves bytes and this proves placement; the three
 * objective values are hand-computed below and are part of the proof, since the
 * re-validator recomputes `value` from the offsets and refuses a mismatch.
 */

/** 2.11's plan: one leaf, three serial steps, `days: 1` across five people. */
const rows: readonly PlannedRow[] = [
  { id: 'A', parentId: null, position: 0, frozenNumber: null, priority: null },
];
const slices: readonly Slice[] = ['one', 'two', 'three'].map((stepId) => ({
  workItemId: 'A',
  stepId,
  days: 1,
  personId: null,
  width: 5,
  poolIds: [],
}));

const plan: SolverRequestPlan = {
  rows,
  edges: [],
  slices,
  notBefore: new Map(),
  poolSizes: new Map(),
  reach: 'whole-item',
  deadlines: new Map(),
};

const requestOf = () => {
  const built = buildSolverRequest(plan, 'pri', {
    baselineOffsets: quantisedFastBaseline(
      plan.rows,
      plan.edges,
      plan.slices,
      plan.notBefore,
      plan.poolSizes,
      plan.reach,
    ),
    solverVersion: '0.1.0',
    budgetMs: 30_000,
  });
  if (!built.ok) throw new Error(`expected a request, got ${built.failure}: ${built.detail}`);
  return built.request;
};

/**
 * The baseline, dressed as the response a solver that found exactly it would
 * send.
 *
 * The three terms are the definitions in `revalidate-solver-result.ts`, worked
 * out by hand on this plan rather than recomputed from the offsets:
 * `MAKESPAN = max finish` is `20 + 10 = 30`; `PRIORITY = Σ w(s) · finish(s)` is
 * `0`, because no row in this plan carries a priority and an absent leaf weighs
 * 0; `MOVEMENT = Σ |start − baseline|` is `0`, necessarily, because the offsets
 * ARE the baseline. `stageValue` and `bound` are null and `status` is
 * `unknown`: they are statements about a stage, and no stage ran.
 */
const asResponse = (offsets: Readonly<Record<string, number>>): SolverResponse => ({
  wireVersion: SOLVER_WIRE_VERSION,
  status: 'feasible',
  offsets,
  objectiveValues: {
    makespan: { value: 30, stageValue: null, bound: null, status: 'unknown' },
    priority: { value: 0, stageValue: null, bound: null, status: 'unknown' },
    movement: { value: 0, stageValue: null, bound: null, status: 'unknown' },
  },
});

describe('the quantised baseline as a solution the solver could publish', () => {
  it('passes the same re-validation a real solver answer has to pass', () => {
    const request = requestOf();
    expect(revalidateSolverResult(request, asResponse(request.baselineOffsets))).toEqual({
      ok: true,
      published: true,
    });
  });

  it('and the check is live on this plan, not vacuous', () => {
    // Without this, the assertion above would still pass if the re-validator
    // never looked at the edges. One slice pulled back on top of its
    // predecessor breaks the intra-item step chain the request carries, and the
    // failure names the constraint rather than the arithmetic.
    const request = requestOf();
    const [, second] = request.slices;
    const collided = { ...request.baselineOffsets, [second.key]: 0 };
    const refused = revalidateSolverResult(request, asResponse(collided));
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('expected a refusal');
    expect(refused.failure).toBe('edge-violated');
  });

  it('measures MOVEMENT as zero against itself, which is what makes it the origin', () => {
    // Not a tautology worth skipping: MOVEMENT is the one term whose definition
    // reads `baselineOffsets` out of the REQUEST, so this fails the moment the
    // builder ships a baseline that is not the map the offsets came from — the
    // divergence a wire carrying two copies of one value invites.
    const request = requestOf();
    const moved = { ...request.baselineOffsets, [request.slices[2].key]: 25 };
    const refused = revalidateSolverResult(request, asResponse(moved));
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('expected a refusal');
    // 25 is still after slice two's finish at 20, so the chain holds and the
    // arithmetic is what breaks: MAKESPAN becomes 35 and MOVEMENT 5.
    expect(refused.failure).toBe('objective-mismatch');
  });
});

/**
 * The same claim on a plan where every constraint class is **live**.
 *
 * 2.11's own plan has no edge, no pool, no person and no floor, so the three
 * cases above ask the re-validator a question it answers with the intra-item
 * step chain alone. That is the right plan for 2.11 — it is the fixture whose
 * 28.8 units the whole slice exists to round — but it means "the baseline is
 * feasible" has been proved over one of the pass's five placement rules.
 *
 * **Measured rather than argued.** With `poolSizes` replaced by an empty map
 * inside `quantisedFastBaseline` — a baseline that ignores capacity entirely —
 * the contracts suite goes **147 pass / 10 fail**, and not one of the three
 * cases above is among the failures: their plan has no pool for a pool-blind
 * baseline to violate. The two cases below are, which is the whole reason they
 * are here rather than being the same test twice.
 *
 * The plan is the assembly fixture: a floor written on a **parent** (so the
 * fold is `leafFloorsOf`'s walk, not a lookup), an authored edge across two
 * leaves, a two-step leaf whose steps chain, a shared pool of two, and a
 * person queue.
 */
describe('the quantised baseline on a plan whose every constraint is live', () => {
  const richRows: readonly PlannedRow[] = [
    { id: 'P', parentId: null, position: 0, frozenNumber: null, priority: null },
    { id: 'A', parentId: 'P', position: 0, frozenNumber: null, priority: null },
    { id: 'B', parentId: 'P', position: 1, frozenNumber: null, priority: 1 },
  ];
  const richSlices: readonly Slice[] = [
    { workItemId: 'A', stepId: 'design', days: 2, personId: null, width: 1, poolIds: ['team-x'] },
    { workItemId: 'A', stepId: 'dev', days: 4, personId: null, width: 2, poolIds: ['team-x'] },
    { workItemId: 'B', stepId: 'dev', days: 3, personId: 'ann', width: 1, poolIds: [] },
  ];
  const richPlan: SolverRequestPlan = {
    rows: richRows,
    edges: [{ predecessorId: 'A', successorId: 'B' }],
    slices: richSlices,
    notBefore: new Map([['P', 3]]),
    poolSizes: new Map([['team-x', 2]]),
    reach: 'whole-item',
    deadlines: new Map(),
  };

  const richRequest = () => {
    const built = buildSolverRequest(richPlan, 'pri', {
      baselineOffsets: quantisedFastBaseline(
        richPlan.rows,
        richPlan.edges,
        richPlan.slices,
        richPlan.notBefore,
        richPlan.poolSizes,
        richPlan.reach,
      ),
      solverVersion: '0.1.0',
      budgetMs: 30_000,
    });
    if (!built.ok) throw new Error(`expected a request, got ${built.failure}: ${built.detail}`);
    return built.request;
  };

  /**
   * The three terms computed from the **request's own** projections — the
   * `durationUnits` and `priorityWeight` `buildSolverSlices` wrote — rather
   * than hand-worked as they are above. On 2.11's plan the numbers are 30/0/0
   * and writing them down is part of the proof; here a floor fold, a dense
   * rank and two widths decide them, and a hand-written constant would turn
   * any placement change into an objective failure wearing a placement name.
   */
  const valuesOf = (
    request: ReturnType<typeof richRequest>,
    offsets: Readonly<Record<string, number>>,
  ) => {
    const finishOf = (slice: (typeof request.slices)[number]) =>
      offsets[slice.key] + slice.durationUnits;
    const term = (value: number) => ({
      value,
      stageValue: null,
      bound: null,
      status: 'unknown' as const,
    });
    return {
      makespan: term(Math.max(0, ...request.slices.map(finishOf))),
      priority: term(
        request.slices.reduce((sum, slice) => sum + slice.priorityWeight * finishOf(slice), 0),
      ),
      movement: term(
        request.slices.reduce(
          (sum, slice) => sum + Math.abs(offsets[slice.key] - request.baselineOffsets[slice.key]),
          0,
        ),
      ),
    };
  };

  const richResponse = (
    request: ReturnType<typeof richRequest>,
    offsets: Readonly<Record<string, number>>,
  ): SolverResponse => ({
    wireVersion: SOLVER_WIRE_VERSION,
    status: 'feasible',
    offsets,
    objectiveValues: valuesOf(request, offsets),
  });

  it('passes the same re-validation with a pool, a person, an edge and a floor in play', () => {
    const request = richRequest();
    // The HINT is what the solver is handed as its starting point, so it is the
    // hint that has to be feasible. Asserted equal to the baseline first, so a
    // builder that stopped copying one into the other could not pass this by
    // validating the other map.
    expect(request.fastHint).toEqual(request.baselineOffsets);
    expect(revalidateSolverResult(request, richResponse(request, request.fastHint))).toEqual({
      ok: true,
      published: true,
    });
    expect(valuesOf(request, request.fastHint).movement.value).toBe(0);
  });

  it('and the check is live on this plan too: a leaf pulled onto its floor is refused', () => {
    const request = richRequest();
    // `B/dev` waits on the whole of `A` under `whole-item` reach. Moved back
    // onto the floor it is a legal offset in the variable domain and an illegal
    // one in the graph, which is the distinction the placement rules exist to
    // make — so the refusal is a dependency verdict rather than a domain one.
    const broken = {
      ...request.fastHint,
      [request.slices[2].key]: request.slices[0].notBeforeUnits,
    };
    const refused = revalidateSolverResult(request, richResponse(request, broken));
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('expected a refusal');
    expect(refused.failure).toBe('edge-violated');
  });
});
