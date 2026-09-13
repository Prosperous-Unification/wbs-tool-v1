import { SOLVER_STAGE_COUNT, type SolverStageBudgetSplit } from './wire-types';

/**
 * How the wall-clock budget is divided between the three lexicographic stages.
 *
 * Dimensionless fractions of `budgetMs`, one per stage, and a stage that
 * finishes early donates its remainder to the next — so these are the shares of
 * a *worst case*, not reservations. Stage 1 gets the most because it is the one
 * that can return `infeasible` as a property of the plan rather than of the
 * engine; the later two refine an incumbent that already exists.
 *
 * **That the three sum to 1 is a builder invariant the schema cannot state.**
 * JSON Schema can bound each fraction and fix the array's length, and it does
 * both; it has no way to say the array adds up. So it is asserted here, in the
 * one place the constant is written.
 */
export const STAGE_BUDGET_SPLIT: SolverStageBudgetSplit = [0.6, 0.25, 0.15];

/**
 * Whether a split is one the builder may send.
 *
 * Exported as a predicate rather than run only over the constant, because the
 * request builder must check whatever it is handed — a split that came from
 * configuration is the case a constant-only assertion cannot cover.
 *
 * **The sum is compared inside a tolerance, and the reason is measured rather
 * than assumed.** `0.6 + 0.25 + 0.15` happens to be exactly `1` in IEEE-754
 * doubles — checked, because the obvious comment here is that it is not — so an
 * exact `=== 1` test would pass for the constant above and is still wrong for
 * the general case this predicate exists to cover: `0.7 + 0.2 + 0.1` is
 * `0.9999999999999999`, and the same three shares in the other order are `1`.
 * An authored split would then be accepted or refused according to the order it
 * was written in. The tolerance is one part in 2^40, far above the rounding of
 * three additions and far below any share anybody would author.
 *
 * Each fraction must also be **strictly above zero** and at most 1, matching
 * the schema's `exclusiveMinimum`: a stage given no budget is a stage that
 * cannot run, and expressing "skip stage 3" as a zero would leave the staged
 * matrix reading a timeout where a deliberate omission was meant.
 */
const SUM_TOLERANCE = 2 ** -40;

export function isValidStageBudgetSplit(split: readonly number[]): split is SolverStageBudgetSplit {
  if (split.length !== SOLVER_STAGE_COUNT) return false;
  if (!split.every((share) => Number.isFinite(share) && share > 0 && share <= 1)) return false;
  return Math.abs(split.reduce((total, share) => total + share, 0) - 1) <= SUM_TOLERANCE;
}
