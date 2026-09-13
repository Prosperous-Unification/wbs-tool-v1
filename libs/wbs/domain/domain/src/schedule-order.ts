/**
 * The starts one schedule placed its slices at, which is all an order
 * comparison reads.
 *
 * A narrow shape rather than {@link Schedule}: the relation is about the
 * relative position of shared slices and nothing else, and a function taking
 * whole schedules could not be exercised without building two of them. A
 * `Map<string, ScheduledSlice>` satisfies it structurally, so both callers pass
 * `schedule.slices` unchanged.
 */
export type SliceStarts = ReadonlyMap<string, { readonly earliestStart: number }>;

/**
 * Whether two schedules place the slices present in **both** in the same
 * relative order.
 *
 * The relation `dual-optimized-scheduler` tasks.md 8.7 defines: it holds iff for
 * every pair of slices `s`, `t` present in both,
 * `sign(startLeft(s) - startLeft(t)) === sign(startRight(s) - startRight(t))`,
 * compared in the real fractional-workday domain rather than in quantised
 * units — real Fast's starts need not lie on the unit grid, and quantised
 * comparison would report a reorder produced purely by rounding.
 *
 * **Computed as a dense-rank comparison rather than over the pairs**, which is
 * the same relation and not an approximation of it: that matrix of pairwise
 * signs *is* the weak order the starts induce, and a weak order is determined
 * by its dense rank — tied starts share a rank, and a rank vector therefore
 * fixes every pairwise sign. The pairwise form is O(n²) and shipped when the
 * comparison ran once per plan read, for the one variant on screen; it now runs
 * once per **ready** variant (slice 8b), so the rank form is what keeps a plan
 * read linearithmic in its slices. The equivalence is proven rather than
 * asserted: `schedule-order.test.ts` runs this against the pairwise definition
 * written out as an oracle, over a corpus that includes ties on both sides,
 * ties on one side only, reversals and a shared-key subset.
 *
 * @throws Error when a start is not finite. R5: the starts come from
 * `schedule()` and from a re-validated solver payload, so a `NaN` here is a
 * defect upstream rather than a case to model — and it is the one input on
 * which the rank form and the pairwise form would *disagree*, since `NaN`
 * equals itself under `SameValueZero` while `sign(NaN - NaN)` is `NaN`.
 * Reporting "same order" for it would be this function answering about numbers
 * it cannot compare.
 */
export function haveSameSliceOrder(left: SliceStarts, right: SliceStarts): boolean {
  const shared = [...left.keys()].filter((key) => right.has(key)).sort();
  // Fewer than two shared slices has no pair to disagree about, and the
  // pairwise definition is vacuously true there — stated rather than left to
  // fall out of the rank comparison, which would also return true.
  if (shared.length < 2) return true;
  const leftRanks = denseRanks(startsOf(left, shared));
  const rightRanks = denseRanks(startsOf(right, shared));
  return leftRanks.every((rank, at) => rank === rightRanks[at]);
}

/** The shared keys' starts, in the caller's key order. */
function startsOf(starts: SliceStarts, shared: readonly string[]): number[] {
  return shared.map((key) => {
    const placed = starts.get(key);
    // Both callers filtered `shared` by `has` on this very map, so an absent
    // key is a map mutated mid-comparison rather than a slice legitimately
    // missing. It was already this loud in the pairwise form.
    if (placed === undefined) throw new Error('shared schedule slice vanished during comparison');
    if (!Number.isFinite(placed.earliestStart)) {
      throw new Error(
        `schedule slice ${key} has a non-finite start: ${String(placed.earliestStart)}`,
      );
    }
    return placed.earliestStart;
  });
}

/**
 * Each start's position among the **distinct** starts, so equal starts share a
 * rank.
 *
 * Densely, and that is the whole of the equivalence: ranking by sorted index
 * would give two slices that begin on the same day two different ranks, which
 * reports a reorder between two schedules that agree — the failure
 * `schedule-order.test.ts`'s negative injects.
 *
 * `-0` and `0` land on one entry, which is what the pairwise form says too:
 * `Math.sign(0 - -0)` is `0`.
 */
function denseRanks(starts: readonly number[]): number[] {
  const ascending = [...new Set(starts)].sort((first, second) => first - second);
  const rankOf = new Map(ascending.map((start, rank) => [start, rank] as const));
  return starts.map((start) => {
    const rank = rankOf.get(start);
    if (rank === undefined)
      throw new Error(`start ${String(start)} is absent from its own ranking`);
    return rank;
  });
}
