import {
  OPTIMIZATION_ADMISSION_STATES,
  type OptimizationAdmissionState,
  OPTIMIZED_SCHEDULE_STATUSES,
  type OptimizedScheduleStatus,
  SCHEDULE_ENGINES,
  type ScheduleEngine,
  SOLVER_FAILURE_REASONS,
  SOLVER_OBJECTIVES,
  SOLVER_SLOT_LIFECYCLES,
  type SolverFailureReason,
  type SolverObjectiveName,
  type SolverSlotLifecycle,
} from './schema';

/**
 * The read boundary of the four optimizer tables (tasks.md 3.8).
 *
 * A database `CHECK` refuses a bad write; it says nothing about a row already
 * stored — one written by an earlier release, restored from a backup taken
 * before the constraint existed, or repaired by hand. So every enum kept in its
 * own scalar column is validated again on the way out, and an unknown value
 * throws naming the column and the value rather than being cast or defaulted.
 * That is the rule {@link file://./project.ts} `toProject` already applies to
 * `estimate_method`, `dep_reach` and `estimate_rounding`; these functions are
 * the same rule for the optimizer's tables, and every repository read of those
 * tables goes through them.
 *
 * **A stored enum is a column, not a type.** `objective` is the same
 * `'pri' | 'time'` in three tables, and validating the cache's copy covers
 * neither `solver_slot.objective` nor `solver_queue.objective` — the defect
 * Fable r18 Important 1 found after the same one had been found at
 * `solver_slot.lifecycle` (Fable r14 Important 2). So there is one
 * {@link isSolverObjective} and three validated columns: the validator list
 * does not grow, the column list does.
 *
 * The dequeue is why `solver_queue.objective` is not cosmetic. It reads that
 * column into the typed spawn identity, so a corrupted row would launch a
 * garbage-objective solve whose failed-marker write then violates the cache's
 * own `CHECK (objective IN ('pri','time'))`: no marker and no
 * `schedule_optimization_failed` event could ever be written for that key, and
 * the plan read wedges unnotified.
 */

/** One `'pri' | 'time'` column, wherever it is stored. */
export function isSolverObjective(value: string): value is SolverObjectiveName {
  return (SOLVER_OBJECTIVES as readonly string[]).includes(value);
}

/**
 * One `'fast' | 'optimized'` column — today only `project.schedule_engine`
 * (tasks.md 3b.8).
 *
 * It lives beside the optimizer-table validators rather than in `project.ts`
 * because the rule is the same one this file exists to state, and a second home
 * for "stored enum checked on the way out" is how the two drift. There is no
 * `isScheduleObjective` beside it, which tasks.md 3b.8 named before the rule
 * above was settled: `project.schedule_objective` stores the vocabulary
 * {@link isSolverObjective} already checks, so it is a fourth **column** on the
 * existing validator rather than a second validator over the same three
 * strings — the growth this file's header forbids.
 */
export function isScheduleEngine(value: string): value is ScheduleEngine {
  return (SCHEDULE_ENGINES as readonly string[]).includes(value);
}

export function isOptimizedScheduleStatus(value: string): value is OptimizedScheduleStatus {
  return (OPTIMIZED_SCHEDULE_STATUSES as readonly string[]).includes(value);
}

export function isSolverFailureReason(value: string): value is SolverFailureReason {
  return (SOLVER_FAILURE_REASONS as readonly string[]).includes(value);
}

export function isOptimizationAdmissionState(value: string): value is OptimizationAdmissionState {
  return (OPTIMIZATION_ADMISSION_STATES as readonly string[]).includes(value);
}

export function isSolverSlotLifecycle(value: string): value is SolverSlotLifecycle {
  return (SOLVER_SLOT_LIFECYCLES as readonly string[]).includes(value);
}

/**
 * The message every validator below throws, so a corrupted row is diagnosable
 * from the log line alone: which table, which column, and what was actually
 * stored.
 *
 * Exported for `project.ts`, whose two settings columns are refused with the
 * same sentence rather than a second wording of it: an operator grepping a log
 * for `in the database:` should find every corrupted enum in this codebase, not
 * the subset that happens to live in an optimizer table.
 */
export function unknownStoredValue(table: string, column: string, value: string): Error {
  return new Error(`unknown ${table}.${column} in the database: ${value}`);
}

/**
 * One `optimized_schedule_cache` row, with its three scalar enums proved.
 *
 * `failure_reason` is nullable and its NULL is meaningful — the row is not a
 * failure — so NULL passes and only stored text is checked.
 */
export function toOptimizedScheduleCacheRow<
  T extends { objective: string; status: string; failureReason: string | null },
>(
  row: T,
): Omit<T, 'objective' | 'status' | 'failureReason'> & {
  objective: SolverObjectiveName;
  status: OptimizedScheduleStatus;
  failureReason: SolverFailureReason | null;
} {
  const { objective, status, failureReason, ...rest } = row;
  if (!isSolverObjective(objective)) {
    throw unknownStoredValue('optimized_schedule_cache', 'objective', objective);
  }
  if (!isOptimizedScheduleStatus(status)) {
    throw unknownStoredValue('optimized_schedule_cache', 'status', status);
  }
  if (failureReason !== null && !isSolverFailureReason(failureReason)) {
    throw unknownStoredValue('optimized_schedule_cache', 'failure_reason', failureReason);
  }
  return { ...rest, objective, status, failureReason };
}

/** One `optimization_generation` row, with `admission_state` proved. */
export function toOptimizationGenerationRow<T extends { admissionState: string }>(
  row: T,
): Omit<T, 'admissionState'> & { admissionState: OptimizationAdmissionState } {
  const { admissionState, ...rest } = row;
  if (!isOptimizationAdmissionState(admissionState)) {
    throw unknownStoredValue('optimization_generation', 'admission_state', admissionState);
  }
  return { ...rest, admissionState };
}

/**
 * One `solver_slot` row, with `lifecycle` and `objective` proved.
 *
 * Both are checked in one pass rather than by two chained helpers: the return
 * type of a generic mapper must nest its `Omit`s in the order the body applies
 * them, and one destructure of both columns is one `Omit` and no nesting.
 */
export function toSolverSlotRow<T extends { lifecycle: string; objective: string }>(
  row: T,
): Omit<T, 'lifecycle' | 'objective'> & {
  lifecycle: SolverSlotLifecycle;
  objective: SolverObjectiveName;
} {
  const { lifecycle, objective, ...rest } = row;
  if (!isSolverSlotLifecycle(lifecycle)) {
    throw unknownStoredValue('solver_slot', 'lifecycle', lifecycle);
  }
  if (!isSolverObjective(objective)) {
    throw unknownStoredValue('solver_slot', 'objective', objective);
  }
  return { ...rest, lifecycle, objective };
}

/**
 * One `solver_queue` row, with `objective` proved.
 *
 * This is the one the dequeue reads into the spawn identity, so it is the
 * column whose absence from the validated list was the wedge described above.
 */
export function toSolverQueueRow<T extends { objective: string }>(
  row: T,
): Omit<T, 'objective'> & { objective: SolverObjectiveName } {
  const { objective, ...rest } = row;
  if (!isSolverObjective(objective)) {
    throw unknownStoredValue('solver_queue', 'objective', objective);
  }
  return { ...rest, objective };
}
