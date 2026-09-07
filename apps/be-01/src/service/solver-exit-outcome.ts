import type { BuiltSolverRequest } from '@wbs/contracts/solver/build-request';
import { materialiseOptimized } from '@wbs/contracts/solver/materialise-optimized';
import { publishOptimizedResult } from '@wbs/contracts/solver/optimized-result';
import { parseSolverResponse } from '@wbs/contracts/solver/parse-solver-response';
import {
  type PlanInfeasibleResult,
  planInfeasibleResultOf,
} from '@wbs/contracts/solver/plan-infeasible';
import {
  revalidateOptimizedDeadlines,
  revalidateSolverResult,
} from '@wbs/contracts/solver/revalidate-solver-result';
import {
  dispositionOfParseFailure,
  dispositionOfRevalidationFailure,
  type SolverFailureReason,
} from '@wbs/contracts/solver/solver-failure-disposition';
import { guardRealPublication, SOLVER_QUANTUM } from '@wbs/domain';
import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';

import type { OutcomeToStore } from '../repository/optimized-schedule-cache';

type SolverRequest = Extract<BuiltSolverRequest, { readonly ok: true }>['request'];

/** The process supervisor classifies OS failures before this deterministic seam. */
export type SolverProcessOutcome =
  | { readonly kind: 'response'; readonly stdout: string }
  | { readonly kind: 'failed'; readonly reason: SolverFailureReason };

export type EvaluatedSolverOutcome =
  | OutcomeToStore
  | { readonly kind: 'plan-infeasible'; readonly certificate: PlanInfeasibleResult };

/**
 * Turn one classified child outcome into the exact cache value it earned.
 *
 * Parsing and independent revalidation happen before materialisation, and
 * before the response status is dispositioned — so `infeasible` and `unknown`
 * are answers about a request that was proved usable first (TASK-329). A
 * feasible answer is then replayed through the domain scheduler and compared
 * with real Fast before it becomes an OptimizedResult. Nothing in this seam
 * knows the slot token; the caller stores its answer through
 * `storeOptimizedOutcome`, where that token is the final fence.
 */
export function evaluateSolverOutcome(
  input: ScheduleInput,
  request: SolverRequest,
  outcome: SolverProcessOutcome,
): EvaluatedSolverOutcome {
  if (outcome.kind === 'failed') return { kind: 'failed', reason: outcome.reason };

  const parsed = parseSolverResponse(outcome.stdout);
  if (!parsed.ok) {
    return { kind: 'failed', reason: dispositionOfParseFailure(parsed.failure) };
  }
  const response = parsed.response;
  // TASK-329 AC #1. Re-validation runs BEFORE the status is dispositioned, and
  // the ordering is the fix rather than a tidy-up. Most of what
  // `revalidateSolverResult` proves is about the REQUEST, and a request that
  // cannot support a verdict must not be given one. Ordered the other way — as
  // this was until TASK-329 — a schema-valid but arithmetically meaningless
  // request (a zero-duration slice with `notBeforeUnits: 1` and
  // `deadlineUnits: 1`) is genuinely infeasible to CP-SAT, and that answer was
  // stored as a `plan-infeasible` certificate having passed no
  // request-relative validation at all. `Retry` refuses to re-solve such a hit
  // and `inputHash` cannot distinguish a derived `deadlineUnits` that diverges
  // from the authored deadline it hashes, so the certificate is sticky: a
  // deterministic statement about the user's deadlines derived from a request
  // that does not mean anything.
  //
  // Nothing else moves. `revalidateSolverResult` returns
  // `{ ok: true, published: false }` for every non-feasible status before it
  // reads a single offset, so the only outcomes this ordering changes are the
  // ones that were malformed all along — and `unknown` now reports the
  // malformed request instead of `no-solution`, which is the more accurate of
  // the two.
  const checked = revalidateSolverResult(request, response);
  if (!checked.ok) {
    return { kind: 'failed', reason: dispositionOfRevalidationFailure(checked.failure) };
  }
  if (response.status !== 'feasible') {
    if (response.status === 'unknown') return { kind: 'failed', reason: 'no-solution' };
    const certificate = planInfeasibleResultOf(input);
    return certificate.items.length === 0
      ? { kind: 'failed', reason: 'invalid-output' }
      : { kind: 'plan-infeasible', certificate };
  }

  try {
    const optimized = materialiseOptimized(
      input.rows,
      input.edges,
      input.slices,
      input.notBefore,
      input.poolSizes,
      input.reach,
      response.offsets,
    );
    const deadlines = revalidateOptimizedDeadlines(request, optimized);
    if (!deadlines.ok) {
      return {
        kind: 'failed',
        reason: dispositionOfRevalidationFailure(deadlines.failure),
      };
    }
    const weights = new Map(request.slices.map((slice) => [slice.key, slice.priorityWeight]));
    const weightOf = (key: string): number => {
      const weight = weights.get(key);
      if (weight === undefined) throw new Error(`request has no priority weight for ${key}`);
      return weight;
    };
    const baselineStartOf = (key: string): number => {
      return request.baselineOffsets[key] / SOLVER_QUANTUM;
    };
    const decision = guardRealPublication(
      input,
      optimized,
      request.objective === 'pri' ? 'priority' : 'makespan',
      weightOf,
      baselineStartOf,
    );
    return {
      kind: 'ok',
      result: publishOptimizedResult(decision, response.objectiveValues),
    };
  } catch {
    return { kind: 'failed', reason: 'invalid-output' };
  }
}
