/**
 * The quantum golden corpus: fixed slices, and their solver units kept as
 * **bytes**, version-pinned the same way Fast's corpus is.
 *
 * **Why a second corpus rather than a ninth case in the first one.**
 * `SCHEDULER_CONTRACT_VERSION` names `SOLVER_QUANTUM` on its bump list,
 * and `fast-golden-corpus.ts` cannot observe it however its durations are
 * chosen: `schedule.ts` does not import `solver-quantum`, so `quantise` is not
 * on the call graph any Fast case reaches. That was measured, not assumed. PR
 * 281 (`c1d9a40d`, TASK-302) changed `quantise`'s body — a Fast semantic change
 * squarely on the bump list — and the Fast corpus stayed **green** through it.
 * The bump that change owed was demanded by a human reading the constant's doc.
 *
 * A guard for a constant has to sit on the constant's own call graph. So the
 * cases below are quantised through the same {@link durationUnits} and
 * {@link durationRoundedUp} the solver spends, the results are serialized to
 * `../fixtures/solver-quantum-golden-corpus.json`, that file carries the
 * contract version it was produced under, and
 * `solver-quantum-golden-corpus.test.ts` refuses a mismatch in either
 * direction: bytes that moved without a version bump, or a version bump whose
 * bytes were not regenerated.
 *
 * **`solver-quantum.test.ts` already asserts this behaviour, and that is not
 * the same job.** TASK-302 shipped watched reds for PR 281 on the very input
 * this file's first case uses — `the drift window across the unit boundary`,
 * `1.0000000005` over width 1 — and they are good tests. They are also
 * *assertions*, so the commit that changes `quantise` deliberately edits them
 * to the new numbers, which is the correct way to change a behaviour test, and
 * the suite goes green with no bump demanded. Nothing there is keyed on
 * `SCHEDULER_CONTRACT_VERSION`. That is the same gap `fast-golden-corpus.ts`'s
 * header describes for `schedule-identity.test.ts`: a check with no stored
 * artefact has nothing for a cache key to protect. This file is that upgrade
 * for `quantise` — the numbers leave the source, and the only way to move them
 * is to bump the constant and regenerate, in that order.
 *
 * **What this is not.** It is not a hash of `solver-quantum.ts`. A source hash
 * would have reddened for PR 281, and it would have reddened just as loudly for
 * a comment, a rename or a reformat — trading silent misses for routine false
 * reds whose only repair is regeneration, which is verbatim the failure
 * `write-fast-golden-corpus.ts`'s header names. This corpus observes
 * **behaviour**, so a comment-only edit to `solver-quantum.ts` leaves every
 * byte below identical. That negative control is the whole difference, and it
 * is asserted in the test rather than left as a claim.
 *
 * Like Fast's, the inputs are hand-written. Eight fixed slices cannot cover an
 * input space either; what they can do is make one named constant impossible to
 * move in silence.
 */

import { SCHEDULER_CONTRACT_VERSION } from './contract-version';
import type { Slice } from './schedule';
import { durationRoundedUp, durationUnits } from './solver-quantum';

/** One corpus case: a whole `Slice` under a stable name. */
export interface QuantumGoldenCase {
  readonly name: string;
  readonly slice: Slice;
}

const work = (days: number | null, width: number): Slice => ({
  workItemId: 'w',
  stepId: null,
  days,
  personId: null,
  width,
  poolIds: [],
});

/**
 * The drift that separates the two snaps, as a literal rather than as an
 * expression, because a fixture whose input is computed from the constant it is
 * pinning moves with that constant and cannot see it change.
 *
 * `DRIFT` is `1e-9` in workday space (`workday.ts:109`). This offset sits
 * strictly inside `(DRIFT / SOLVER_QUANTUM, DRIFT)` — above the lower bound, so
 * the post-multiplication snap alone cannot clean it; below the upper, so the
 * pre-multiplication snap can. That band is the only place the two arrangements
 * of `quantise` disagree, and it is one workday-second wide.
 */
const BELOW_DRIFT = 5e-10;

/**
 * Six slices, chosen so each one can lose something a different change to
 * `quantise` would break. The first is the one this corpus exists for.
 */
export const QUANTUM_GOLDEN_CASES: readonly QuantumGoldenCase[] = [
  {
    // **The case the Fast corpus could not hold, and the reason this file
    // exists.** A duration one half-billionth of a workday above a whole one.
    //
    // `quantise` snaps in workday space *before* multiplying and again after
    // (`solver-quantum.ts`, PR 281), so this cleans to exactly 1 workday and
    // then to exactly 48 units — 48, not rounded. Drop the inner snap, which
    // is precisely the arrangement PR 281 replaced, and `1.0000000005 * 48` is
    // `48.000000024`: 2.4e-8 off a whole unit, twenty-four times too far for
    // the surviving snap to reach, so it ceils to **49** and reports itself
    // rounded. One unit is a half-hour the plan never estimated, and it is the
    // difference between a model that agrees with `lastWorkdayOf` about a whole
    // day and one that reports `plan-infeasible` for a plan `isOnTime` calls on
    // time.
    //
    // No case in `fast-golden-corpus.ts` moves for that change, and no case
    // added to it could: the corpus never reaches this function.
    name: 'drift-above-a-whole-workday',
    slice: work(1 + BELOW_DRIFT, 1),
  },
  {
    // The *outer* snap, which the case above cannot pin because the inner one
    // has already answered it. `65 / 6` days over width 5 is exactly 13/6
    // workdays — nowhere near a whole day, so nothing snaps in workday space —
    // and exactly 104 units, which the double renders as `104.00000000000001`.
    // A bare ceiling reads 105. Removing the second snap must be as red as
    // removing the first, or "the second snap stays" is an unguarded claim in a
    // comment.
    name: 'exact-multiple-the-double-overshoots',
    slice: work(65 / 6, 5),
  },
  {
    // The ceiling itself, on a width outside 48's divisors: 1/5 of a workday is
    // 9.6 units and the solver cannot start the next slice at 9.6. Rounds up,
    // and says so — `durationRoundedUp` is stored beside the units precisely so
    // that a change which kept the count and lost the flag is still a diff.
    name: 'width-the-quantum-does-not-divide',
    slice: work(1, 5),
  },
  {
    // An exact fraction that must survive untouched. Half a workday is 24 units
    // with nothing to round and nothing to snap, so a rule that widened the
    // drift window far enough to matter would move this before it moved
    // anything else.
    name: 'exact-half-workday',
    slice: work(1, 2),
  },
  {
    // `durationOf`'s other arm: a null estimate takes `ASSUMED_SLICE_WORKDAYS`
    // whole and is never divided by width. That constant is on
    // `contract-version.ts`'s bump list too, and unlike `SOLVER_QUANTUM` the
    // Fast corpus does see it — this case is here so that the two corpora
    // disagree loudly rather than one of them quietly, if it ever moves.
    name: 'unestimated-takes-the-assumption-whole',
    slice: work(null, 3),
  },
  {
    // Zero is an answer, not a gap. A `quantise` that treated a zero-day slice
    // as missing — or that gave it a minimum unit so it could be "seen" on a
    // chart — would move this byte and nothing else in this file.
    name: 'explicit-zero',
    slice: work(0, 4),
  },
];

/** One case's quantised result: the pair the solver actually spends. */
export interface QuantumGoldenResult {
  readonly units: number;
  readonly rounded: boolean;
}

/** The corpus as it stands in this working tree, ready to compare or to write. */
export const computeQuantumGoldenCorpus = (): {
  contractVersion: number;
  cases: Record<string, QuantumGoldenResult>;
} => {
  const cases: Record<string, QuantumGoldenResult> = {};
  for (const each of QUANTUM_GOLDEN_CASES) {
    cases[each.name] = {
      units: durationUnits(each.slice),
      rounded: durationRoundedUp(each.slice),
    };
  }
  return { contractVersion: SCHEDULER_CONTRACT_VERSION, cases };
};
