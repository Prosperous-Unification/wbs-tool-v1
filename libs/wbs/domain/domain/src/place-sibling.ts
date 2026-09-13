/** The gap left between siblings so an insertion writes one row instead of the whole group. */
export const POSITION_STEP = 10;

export interface Sibling {
  id: string;
  position: number;
}

export interface Placement {
  /** Where the new work item goes. */
  position: number;
  /**
   * Existing siblings whose positions must be written, empty in the common
   * case. Every sibling appears when the group is respaced, including the ones
   * whose position is unchanged, so the caller writes one set rather than
   * working out which moved.
   */
  renumbered: Sibling[];
}

/**
 * Where a new work item sits when it is dropped after `afterId`, or first when
 * that is null.
 *
 * Usually this is the midpoint of two neighbours and nothing else is touched.
 * When the neighbours are adjacent integers there is no midpoint, so the whole
 * sibling group is respaced back to `10, 20, 30…` and the new work item takes
 * the gap that creates. Respacing is bounded by one parent's children and runs
 * inside the caller's transaction.
 *
 * Positions are never exposed; the number the user reads is derived from the
 * order this produces.
 */
export function placeAfter(group: readonly Sibling[], afterId: string | null): Placement {
  const ordered = [...group].sort((a, b) => a.position - b.position);
  const index = afterId === null ? -1 : ordered.findIndex((s) => s.id === afterId);
  if (afterId !== null && index === -1) {
    // Appending anyway would put the work item somewhere the user did not ask
    // for, and the number derived from that position would look deliberate.
    throw new Error(`cannot place after ${afterId}: not a sibling in this group`);
  }

  // `.at` rather than `[]`, and an explicit ternary for the -1 case. Without
  // `noUncheckedIndexedAccess` a bracket index is typed as always present, so
  // TypeScript reads the `undefined` checks below as dead code — while at
  // runtime an index past the end is exactly how "append to the end of the
  // group" arrives here. `.at` is not usable for `index` itself: -1 means "no
  // sibling before this one" here and "the last element" to `.at`.
  const before = index === -1 ? undefined : ordered[index];
  const upper = ordered.at(index + 1)?.position;
  const after = before?.position ?? 0;

  if (upper === undefined) return { position: after + POSITION_STEP, renumbered: [] };
  if (upper - after >= 2) return { position: Math.floor((after + upper) / 2), renumbered: [] };

  const finalOrder = [...ordered.slice(0, index + 1), null, ...ordered.slice(index + 1)];
  const renumbered: Sibling[] = [];
  let position = 0;
  finalOrder.forEach((sibling, i) => {
    const respaced = (i + 1) * POSITION_STEP;
    if (sibling === null) position = respaced;
    else renumbered.push({ id: sibling.id, position: respaced });
  });
  return { position, renumbered };
}
