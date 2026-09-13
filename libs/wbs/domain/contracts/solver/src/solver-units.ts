import { SOLVER_QUANTUM } from '@wbs/domain';

/**
 * The two calendar constraints converted from whole workdays into the solver's
 * integer unit axis — the last step before either reaches the wire.
 *
 * They are separated from the folds that produce them (`leafFloorsOf`,
 * `leafDeadlinesOf` in `@wbs/domain`) because the folds are Fast's own rules
 * and are shared with the placement, while the conversions below exist only
 * because CP-SAT places integers. Nothing in the domain has an opinion about
 * `SOLVER_QUANTUM`'s arithmetic; nothing here has an opinion about which
 * ancestor binds.
 *
 * **This module opens `libs/contracts` → `@wbs/domain`, which did not exist
 * before 2026-09-03.** It is a deliberate boundary decision rather than a side
 * effect, and it is the one the design already required: the request builder
 * lives in `libs/contracts/solver/src/` and Bun owns duration and graph
 * derivation, so it must read the domain's seams rather than restate them. The
 * tag constraints permit it — both libraries are `scope:shared` +
 * `runtime:isomorphic`. Worth knowing while reading:
 * `@nx/enforce-module-boundaries` is **skipped** in the gate this repository
 * runs (`No cached ProjectGraph is available`), so it would not have caught a
 * bad edge, and this one is argued rather than lint-approved.
 */

/**
 * A leaf's floor on the solver's axis: whole workdays × {@link SOLVER_QUANTUM}.
 *
 * Absence is day zero, which is what an unconstrained leaf means and what
 * `leafFloorsOf` says by omitting it. Reading it here rather than making the
 * builder remember `?? 0` keeps the default beside the conversion.
 *
 * A floor is a **start** bound, so it converts straight: day `N` begins at unit
 * `N × quantum`. This is the half that needs no `+ 1`, and it is written beside
 * the one that does for exactly that reason.
 */
export function notBeforeUnitsOf(floors: ReadonlyMap<string, number>, leafId: string): number {
  return (floors.get(leafId) ?? 0) * SOLVER_QUANTUM;
}

/**
 * A leaf's effective deadline on the solver's axis, or `null` for unconstrained.
 *
 * **`(D + 1) × quantum`, and the `+ 1` is the whole of its correctness.** A
 * deadline names a day the work must be *finished within*, inclusive — "due on
 * the 12th" is satisfied by work that runs to the end of the 12th. The solver
 * bounds a finish *instant*, and the last instant of day `D` is the first
 * instant of day `D + 1`. Converting `D × quantum` instead would silently
 * require the work to be finished by the **start** of its own due day, losing a
 * whole workday on every deadline in the plan and making a one-day task due the
 * day it starts infeasible.
 *
 * So the returned number is an **exclusive** upper bound on the finish, which
 * is the form CP-SAT wants and the form `deadlineUnits` is documented as on the
 * wire.
 *
 * `null` rather than a large sentinel: an unstated deadline is the absence of a
 * bound, not a distant one, and `leafDeadlinesOf` deliberately omits such a
 * leaf rather than seeding it. A sentinel here would put a constraint in the
 * model that nobody authored and that no error message could attribute.
 */
export function deadlineUnitsOf(
  deadlines: ReadonlyMap<string, number>,
  leafId: string,
): number | null {
  const day = deadlines.get(leafId);
  return day === undefined ? null : (day + 1) * SOLVER_QUANTUM;
}
