/**
 * How many workdays the schedule gives a slice nobody has estimated.
 *
 * Unknown length is not zero length. A slice with no estimate used to take no
 * time at all, so an unestimated work item finished where it started, everything
 * depending on it started immediately, and a half-estimated plan drew an order
 * in which the unestimated work was free. Two workdays is the stand-in: short
 * enough that nobody mistakes it for an estimate, wide enough that the slice
 * occupies its assignee, spends its team's pool and pushes its successors.
 *
 * **It is an assumption of the schedule, never a fact about the project.**
 * Nothing writes an estimate for it: the days column stays blank, the roll-up
 * stays blank, the readiness badge still counts the gap, the export still says
 * unestimated, and the dependency anchor still walks past the slice to the first
 * one somebody actually estimated. "Has a duration" and "is estimated" are
 * different questions after this constant, and only the second reads estimate
 * rows.
 *
 * Lives here rather than beside either reader because both read it: be-01's
 * `schedule.ts` places the slice across it, and fe-01's `gantt-geometry.ts`
 * draws the bar across it. Two copies would be two rules that agree until one is
 * edited, and the disagreement would show up as a bar whose width contradicts
 * the Start and End columns printed beside it.
 *
 * Deliberately not configurable: it is a constant the way the drawing's was.
 */
export const ASSUMED_SLICE_WORKDAYS = 2;
