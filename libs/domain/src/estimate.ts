import { type } from '@wbs/validation';

import { snapWorkdays } from './workday';

/**
 * The largest duration one slice can put on the optimized solver's 48-unit
 * workday axis without crossing its signed 32-bit horizon.
 *
 * This is deliberately a bound on each authored point, even though capacity
 * can shorten a slice: assignments change after estimates are stored, and a
 * legal estimate must remain representable when the work returns to one
 * person. Plans whose individually legal slices overflow in aggregate are
 * still handled by the solver preflight as a plan-level refusal.
 */
export const MAX_ESTIMATE_DAYS = 44_739_242;

/**
 * Three durations in days for one work item and one step.
 *
 * Days, not hours, and fractional days are allowed: half a day is a real
 * estimate and rounding it up is a lie the plan then carries.
 *
 * The ordering is part of the type rather than a rule the callers remember.
 * `optimistic` is the run where no unknown unknowns appear, `pessimistic` is the
 * one where every unknown you can sense does, and `realistic` is a best guess
 * rather than the midpoint of the two — which is why it is asserted to sit
 * between them and not computed from them.
 */
export const ThreePointEstimate = type({
  optimistic: 'number>=0',
  realistic: 'number>=0',
  pessimistic: 'number>=0',
}).narrow((estimate, ctx) => {
  if (!(estimate.optimistic <= estimate.realistic && estimate.realistic <= estimate.pessimistic)) {
    return ctx.mustBe('ordered optimistic <= realistic <= pessimistic');
  }
  if (estimate.pessimistic > MAX_ESTIMATE_DAYS) {
    return ctx.mustBe(`no point above ${String(MAX_ESTIMATE_DAYS)} days`);
  }
  return true;
});
export type ThreePointEstimate = typeof ThreePointEstimate.infer;

/** A three-point estimate together with the step it was given for. */
export const StepEstimate = type({
  stepId: 'string',
  estimate: ThreePointEstimate,
});
export type StepEstimate = typeof StepEstimate.infer;

/**
 * The coefficients one project weighs the three points of a PERT estimate by.
 *
 * The divisor is **their sum**, which is what makes 1/4/1 the textbook
 * `(o + 4r + p) / 6` and 1/1/1 the plain average of the three. A weight of zero
 * drops its point out of the average altogether rather than counting it as a
 * zero-day estimate.
 *
 * Validated as a value rather than checked by its callers, because the two
 * places it enters this system are boundaries — a PATCH body and a `project`
 * row — and every use after them is arithmetic that must not have to ask. The
 * narrow refuses the three triples that cannot average anything: a negative
 * coefficient (a duration that shrinks as the estimate grows), a non-finite one
 * (`1e999`, the only one JSON can express, which divides every step to zero),
 * and three zeroes (no divisor at all).
 */
export const PertWeights = type({
  optimistic: 'number>=0',
  realistic: 'number>=0',
  pessimistic: 'number>=0',
}).narrow((weights, ctx) => {
  const divisor = weights.optimistic + weights.realistic + weights.pessimistic;
  if (Number.isFinite(divisor) && divisor > 0) return true;
  return ctx.mustBe('weights that sum to a finite number above zero');
});
export type PertWeights = typeof PertWeights.infer;

/**
 * The weights every project has until it says otherwise: the textbook PERT
 * 1/4/1, which is the arithmetic every plan in this tool was computed with
 * before the weights could be set at all.
 */
export const DEFAULT_PERT_WEIGHTS: PertWeights = {
  optimistic: 1,
  realistic: 4,
  pessimistic: 1,
};

/**
 * The weighted PERT duration of a three-point estimate, in days, **before** the
 * project's rounding.
 *
 * `(w.o × o + w.r × r + w.p × p) / (w.o + w.r + w.p)`. Under the default
 * weights the realistic figure counts four times because it is the one somebody
 * actually thought about, and the other two are the edges of the distribution —
 * which is why a `2 / 3 / 10` estimate expects 4 days rather than the midpoint's
 * 6. A project that disagrees about that shape says so in its weights; see
 * {@link PertWeights}.
 *
 * Fractional on purpose, and it stays that way here: the whole-day figure a plan
 * is charged is {@link finalDays}, one rounding at one place, and rounding
 * inside this would round twice.
 */
export function expectedDays(estimate: ThreePointEstimate, weights: PertWeights): number {
  const weighted =
    weights.optimistic * estimate.optimistic +
    weights.realistic * estimate.realistic +
    weights.pessimistic * estimate.pessimistic;
  return weighted / (weights.optimistic + weights.realistic + weights.pessimistic);
}

/**
 * How a project turns its three-point estimates into the one number it plans
 * with.
 *
 * PERT is the default and the reason three points are collected at all. The
 * other three are the honest answers to "we are quoting the best case" and
 * "this date has to hold": a team committing a deadline plans on `pessimistic`,
 * a team quoting a possibility plans on `optimistic`, and `realistic` is the
 * single figure most people mean when they say "the estimate". Which one a
 * project uses is a decision about risk appetite, not a calculation, so it is
 * stored rather than inferred.
 */
export const ESTIMATE_METHODS = ['pert', 'optimistic', 'realistic', 'pessimistic'] as const;
export type EstimateMethod = (typeof ESTIMATE_METHODS)[number];

/** Whether `value` is one of the four methods — the boundary check for stored and posted data. */
export function isEstimateMethod(value: unknown): value is EstimateMethod {
  return typeof value === 'string' && (ESTIMATE_METHODS as readonly string[]).includes(value);
}

/**
 * How a project turns one step's combined figure into the days it is charged:
 * `floor`, `round`, `ceil` — or `exact`, which charges the figure as it came
 * out of the method.
 *
 * `round` is JavaScript's — a half day goes up. The choice is a statement about
 * risk in the same way {@link ESTIMATE_METHODS} is: `ceil` says a step that
 * needs any of a day occupies the day, `floor` says a plan should not be
 * charged for work nobody committed to, and `round` says the error should
 * cancel out across a plan.
 *
 * **`exact` is the arithmetic every plan in this tool had until 2026-08-30**,
 * and it is kept for two reasons rather than as a courtesy. A project that
 * genuinely plans in half days loses nothing to a default it did not choose;
 * and the whole fractional machinery below the schedule — `snapWorkdays` and
 * the calendar boundaries it guards — would otherwise be reachable by no
 * project at all, which turns a shipped guard and its proofs into checks that
 * cannot fail. It is the arm the identity oracles replay on, exactly as
 * `anchor-slice` is for `DependencyReach`.
 */
export const ESTIMATE_ROUNDINGS = ['exact', 'floor', 'round', 'ceil'] as const;
export type EstimateRounding = (typeof ESTIMATE_ROUNDINGS)[number];

/** Whether `value` is one of the three — the boundary check for stored and posted data. */
export function isEstimateRounding(value: unknown): value is EstimateRounding {
  return typeof value === 'string' && (ESTIMATE_ROUNDINGS as readonly string[]).includes(value);
}

/**
 * A project's whole answer to "what one number does this estimate mean": the
 * method that combines the three points, the weights PERT combines them by, and
 * the rounding the combined figure is charged at.
 *
 * One value rather than three parameters. Passing them apart lets a caller
 * combine one project's method with another's weights and the compiler says
 * nothing; a rule is assembled once, from the project being read.
 */
export interface EstimateRule {
  method: EstimateMethod;
  pertWeights: PertWeights;
  rounding: EstimateRounding;
}

/**
 * The rule a project has until it says otherwise: PERT, weighted 1/4/1, charged
 * whole days rounded up.
 *
 * `ceil` rather than the fractions this tool carried until 2026-08-30 — Dany's
 * call, and the reasoning is
 * `docs/adr/0011-final-days-are-whole-days-rounded-per-step.md`.
 */
export const DEFAULT_ESTIMATE_RULE: EstimateRule = {
  method: 'pert',
  pertWeights: DEFAULT_PERT_WEIGHTS,
  rounding: 'ceil',
};

/**
 * The figure one step's three points combine to under `rule`'s method, in days
 * and **before** its rounding.
 *
 * Separate from {@link finalDays} because the two answer different questions: a
 * reader asking what the estimate means wants this, and everything that plans,
 * schedules or sums wants the rounded one. Nothing is charged in these units.
 */
export function combinedDays(estimate: ThreePointEstimate, rule: EstimateRule): number {
  if (rule.method === 'pert') return expectedDays(estimate, rule.pertWeights);
  // Not a defensive flourish: `estimate[method]` for a method this does not
  // know returns `undefined`, and the arithmetic downstream turns that into
  // `NaN` — a schedule of NaN days that renders as blank cells and reports
  // itself as estimated. Caught here, it is one loud error naming the value.
  if (!isEstimateMethod(rule.method)) {
    throw new Error(`unknown estimate method: ${JSON.stringify(rule.method)}`);
  }
  return estimate[rule.method];
}

/**
 * `days` as the whole number of days `rounding` charges for it.
 *
 * {@link snapWorkdays} first, and that is the load-bearing half. A weighted
 * average is a division, and a division leaves bits behind: `0.4 / 1.1 / 1.2`
 * under 1/4/1 is exactly 1 day in arithmetic and `1.0000000000000002` in
 * doubles, which `Math.ceil` charges as **two** days. The snap's window is the
 * one `schedule-floor-and-drift` put on the calendar boundaries — eight orders
 * of magnitude below a sixth of a day, so it cannot swallow work somebody
 * estimated.
 *
 * Proof: with the snap dropped (a bare `Math.ceil(days)`), `does not mint a day
 * out of a division's leftover bits` failed on `Expected: 1, Received: 2`;
 * watched 2026-08-30.
 */
function roundDays(days: number, rounding: EstimateRounding): number {
  // Before the snap, not after it: `exact` reports what the method computed,
  // drifted bits and all, which is what the wire has always carried and what
  // `datesOf`'s own snap at the calendar boundary exists to handle.
  if (rounding === 'exact') return days;
  const snapped = snapWorkdays(days);
  if (rounding === 'floor') return Math.floor(snapped);
  if (rounding === 'round') return Math.round(snapped);
  return Math.ceil(snapped);
}

/**
 * The whole number of days a project charges for one step of one work item.
 *
 * The single place the choice is applied, and the order is the product decision:
 * the three points are combined **for one step**, that figure is rounded, and
 * only then are steps summed (`rollUpFinals` in be-01). Summing first and
 * rounding once would charge two half-day steps as one day when the plan runs
 * them as two.
 *
 * The schedule's durations and the figure shown beside the trio are both this
 * number — two implementations of "the final estimate" is exactly how a table
 * comes to disagree with the dates printed next to it.
 */
export function finalDays(estimate: ThreePointEstimate, rule: EstimateRule): number {
  return roundDays(combinedDays(estimate, rule), rule.rounding);
}
