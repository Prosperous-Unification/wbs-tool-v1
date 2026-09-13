/**
 * Every leaf's priority as a **dense rank**, which is the only form of a
 * priority a solver objective may multiply.
 *
 * `(R + 1) − rank(p)` over the `R` distinct priorities actually present, with
 * rank 1 the most important — the smallest number, the same direction
 * `goesFirst` reads. So the most important work present weighs `R`, the least
 * important present weighs `1`, and a leaf nobody prioritised weighs `0`,
 * strictly below every stated priority rather than tied with the lowest one.
 *
 * **The absolute priority is never the weight.** `asOptionalPriority` accepts
 * any safe integer, so a plan may legally carry `Number.MAX_SAFE_INTEGER` as a
 * priority; `P_max + 1` is then not representable, every "invert the scale"
 * formula loses precision at exactly the value a user is most likely to have
 * typed to mean "last", and the objective's `Σ w(s) × horizonUnits` bound stops
 * being checkable. Ranking first replaces an unbounded input with one bounded
 * by the number of distinct priorities in the plan, which is at most the number
 * of rows.
 *
 * **Dense and not competition rank**: three leaves at priorities 1, 1 and 9 are
 * two distinct statements, so they weigh 2, 2 and 1. Competition rank would
 * make the third weigh nothing and collapse it into "unprioritised", which is a
 * different thing a plan can also say.
 *
 * Reads {@link priorityByLeaf} rather than the rows, so the resolution rule —
 * nearest ancestor wins, an override and never a floor — is stated once in the
 * scheduler and is the same rule the bars are drawn from. A second walk here
 * would be the one that gets it backwards, because every neighbouring field
 * (the floor, the deadline) resolves by taking the strictest.
 */
export function priorityWeights(leafPriorities: ReadonlyMap<string, number>): Map<string, number> {
  const distinct = [...new Set(leafPriorities.values())].sort((left, right) => left - right);
  // The rank of each distinct priority, densely: equal priorities share a rank
  // and the next distinct one is the next integer.
  const weightOf = new Map(distinct.map((priority, at) => [priority, distinct.length - at]));
  const weights = new Map<string, number>();
  for (const [leafId, priority] of leafPriorities) weights.set(leafId, weightOf.get(priority) ?? 0);
  return weights;
}

/**
 * The weight of one leaf, including the leaves the map does not mention.
 *
 * Absence is the common case and it is not an error: {@link priorityByLeaf}
 * omits every leaf with nobody's priority above it, which on most plans is most
 * of them. Reading it as `0` here rather than making each caller remember the
 * `?? 0` is the same choice `goesFirst` makes when it reads absence as
 * `Infinity` — the default belongs beside the map, not beside each reader.
 */
export function priorityWeightOf(weights: ReadonlyMap<string, number>, leafId: string): number {
  return weights.get(leafId) ?? 0;
}
