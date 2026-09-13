import { buildSolverRequest, type BuiltSolverRequest } from '@wbs/contracts/solver/build-request';
import { quantisedFastBaseline } from '@wbs/contracts/solver/quantised-baseline';
import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';

/** The two independent solver questions prepared from one canonical plan. */
export interface SolverRequestPair {
  readonly pri: BuiltSolverRequest;
  readonly time: BuiltSolverRequest;
}

/**
 * Builds PRI and Time against one quantised Fast baseline.
 *
 * The baseline is deliberately evaluated once. It is both objectives' movement
 * origin and search hint, so recomputing it per objective would compare two
 * solvers against two separately observed schedules. Preflight refusals remain
 * values for the coordinator to persist without starting a process.
 */
export function buildSolverRequestPair(
  input: ScheduleInput,
  solverVersion: string,
  budgetMs: number,
): SolverRequestPair {
  const baselineOffsets = quantisedFastBaseline(
    input.rows,
    input.edges,
    input.slices,
    input.notBefore,
    input.poolSizes,
    input.reach,
  );
  const spawn = { baselineOffsets, solverVersion, budgetMs };

  return {
    pri: buildSolverRequest(input, 'pri', spawn),
    time: buildSolverRequest(input, 'time', spawn),
  };
}
