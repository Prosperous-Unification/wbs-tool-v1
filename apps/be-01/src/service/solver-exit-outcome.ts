import type { BuiltSolverRequest } from '@wbs/contracts/solver/build-request';
import { materialiseOptimized } from '@wbs/contracts/solver/materialise-optimized';
import { publishOptimizedResult } from '@wbs/contracts/solver/optimized-result';
import { parseSolverResponse } from '@wbs/contracts/solver/parse-solver-response';
import { revalidateSolverResult } from '@wbs/contracts/solver/revalidate-solver-result';
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

/** Stage-one infeasibility needs slice 7's certificate codec before it can be stored. */
export type EvaluatedSolverOutcome = OutcomeToStore | { readonly kind: 'plan-infeasible' };

/**
 * Turn one classified child outcome into the exact cache value it earned.
 *
 * Parsing and independent revalidation happen before materialisation. A
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
  if (response.status !== 'feasible') {
    return response.status === 'unknown'
      ? { kind: 'failed', reason: 'no-solution' }
      : { kind: 'plan-infeasible' };
  }

  const checked = revalidateSolverResult(request, response);
  if (!checked.ok) {
    return { kind: 'failed', reason: dispositionOfRevalidationFailure(checked.failure) };
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
