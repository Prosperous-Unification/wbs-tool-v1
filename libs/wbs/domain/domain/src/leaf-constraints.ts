/**
 * The two per-leaf calendar constraints a plan can carry, folded down the tree
 * once and read by both the Fast pass and the solver request builder.
 *
 * They are here rather than inside `schedule()` because the solver wire needs
 * the same numbers: every slice carries `notBeforeUnits` and `deadlineUnits`
 * **already folded**, so Python never receives the tree. A second walk in
 * `libs/contracts` would be the copy that gets it backwards — which is not a
 * hypothetical here. The floor fold below was already wrong once, for a whole
 * month: until 2026-08-10 the map was read for leaf ids alone, so a floor
 * written on a parent was accepted, stored, echoed back and constrained
 * nothing. That is the same class of defect 2.0 published `priorityByLeaf`
 * to prevent, and the reason this file exists at all.
 *
 * **The two folds go in opposite directions, and neither is `priorityByLeaf`'s
 * rule.** All three walk leaf-upward over the same `leavesUnder`
 * index, and there the resemblance stops:
 *
 * | field | rule | why |
 * |---|---|---|
 * | priority | nearest ancestor **wins** | it is an override — leaf 5 under parent 1 resolves to 5 |
 * | floor | the **latest** binds | every "not before" is a separate promise; the strictest is the one that holds |
 * | deadline | the **earliest** binds | same argument, mirrored — the tightest constraint is the binding one |
 *
 * Writing them beside each other is deliberate. The floor and the deadline read
 * as symmetric and are, but only after both are read as *constraints* rather
 * than as values; the priority two lines away is the one that looks like them
 * and is not.
 */

/**
 * The half of `TreeIndex` a fold needs: for any id, the leaves beneath it, with
 * a leaf mapping to itself.
 *
 * Named structurally rather than imported, so this module depends on no other.
 * `TreeIndex` satisfies it and is what every caller passes; taking the whole
 * index would make `schedule.ts` — which owns that type — import a module that
 * imports it back, and a type-only cycle is still a cycle to read.
 */
export interface LeavesUnderIndex {
  leavesUnder: ReadonlyMap<string, readonly string[]>;
}

/**
 * The earliest offset each leaf may start at, in whole days from day zero.
 *
 * A floor keyed by any row constrains every leaf beneath it, exactly as a
 * dependency declared on a parent does: "this step starts no earlier than the
 * 12th" means none of its work does. Each leaf takes the **latest** of its own
 * floor and every ancestor's — `Math.max`, never a copy-down, because a
 * parent's day 3 must not overwrite a child's own day 9.
 *
 * Proof, watched 2026-08-10 with the `Math.max` replaced by a bare copy-down:
 * two `schedule-shapes.test.ts` cases failed — `composes ancestor floors with a
 * dependency, each leaf keeping its own maximum` on `L2` at `earliestStart: 5`
 * where its own day-9 floor was owed, and `carries a grandparent's floor two
 * levels down to the leaf` on `earliestStart: 3` where the grandparent's day 6
 * was.
 *
 * **Seeded with zero**, so the result is a floor at or above day zero whatever
 * the input says. That is not defensive rounding: a negative offset is a start
 * before the project's own day zero, which the placement has no representation
 * for, and it is the behaviour `schedule()` has always had.
 *
 * A leaf absent from the result is unconstrained; callers read absence as `0`,
 * which is the same thing.
 */
export function leafFloorsOf(
  notBefore: ReadonlyMap<string, number>,
  index: LeavesUnderIndex,
): Map<string, number> {
  const floors = new Map<string, number>();
  for (const [flooredId, atLeast] of notBefore) {
    for (const leafId of index.leavesUnder.get(flooredId) ?? []) {
      floors.set(leafId, Math.max(floors.get(leafId) ?? 0, atLeast));
    }
  }
  return floors;
}

/**
 * The latest offset each leaf may **finish** by, in whole days from day zero —
 * the *effective* deadline, which is what the solver request carries and what
 * an infeasibility certificate names.
 *
 * The mirror of {@link leafFloorsOf} in every respect but two.
 *
 * **`Math.min`, because a deadline is a promise about the same work.** A parent
 * due on day 20 with a child due on day 12 owes day 12 for that child: the
 * ancestor's date binds everything beneath it, the leaf's own binds itself, and
 * a leaf under both owes the tighter. Taking the maximum instead would let a
 * loose parent date *relax* a child's own — a constraint that an edit somewhere
 * above can only ever weaken is not a deadline.
 *
 * **No zero seed.** A floor's identity is day zero and a plan with no floors
 * has every leaf at 0; a deadline has no such value — the identity would be
 * `Infinity`, which is not a deadline but the absence of one. So an
 * unconstrained leaf is **absent** from the result rather than present with a
 * sentinel, and the wire spells that absence `deadlineUnits: null`. It matters
 * that the two disagree here: reading an unstated deadline as `0` would make
 * every unconstrained plan instantly infeasible, and reading it as a large
 * number would put a bound in the model that nobody authored.
 *
 * Keyed by **as-authored** ids on the way in, like every other constraint map,
 * so a date written on a parent that binds no leaf today still binds one after
 * a move.
 */
export function leafDeadlinesOf(
  deadlines: ReadonlyMap<string, number>,
  index: LeavesUnderIndex,
): Map<string, number> {
  const folded = new Map<string, number>();
  for (const [deadlinedId, noLaterThan] of deadlines) {
    for (const leafId of index.leavesUnder.get(deadlinedId) ?? []) {
      const own = folded.get(leafId);
      folded.set(leafId, own === undefined ? noLaterThan : Math.min(own, noLaterThan));
    }
  }
  return folded;
}
