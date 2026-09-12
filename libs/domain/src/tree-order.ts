/** Where a work item sits: under whom, and among its siblings. */
export interface TreePlacement {
  id: string;
  parentId: string | null;
  position: number;
}

/**
 * One project's work items grouped under their parents, each group in sibling
 * order — {@link TreePlacement.position} ascending, a tie falling to `id`.
 *
 * **One grouping, shared**, for the reason `slice-groups` gives about slices: a
 * number, a tree order and an arrangement that each grouped their own siblings
 * could disagree about which work item is second, and the first two of those
 * are drawn on the same screen. {@link deriveNumbers}, {@link treeOrder} and
 * `arrangeBySchedule` all start here.
 *
 * **The `id` tie-break is ADR 0016's, made explicit.** Two siblings may share a
 * position — `placeAfter` reads its group outside any lock, so two appends race
 * to the same number — and the resolution is `work_item.id` ascending. That
 * used to be imposed by `listByProject`'s `ORDER BY` and inherited here through
 * `Array#sort` being stable, which is a promise about the *caller's* argument
 * order. Sorting on it here is the same answer from a rule instead of from a
 * convention, so a caller holding rows in any other order gets the project the
 * repository would have handed it.
 */
export function siblingGroupsOf<T extends TreePlacement>(
  placements: readonly T[],
): Map<string | null, T[]> {
  const groups = new Map<string | null, T[]>();
  for (const placement of placements) {
    const group = groups.get(placement.parentId) ?? [];
    group.push(placement);
    groups.set(placement.parentId, group);
  }
  for (const group of groups.values()) {
    group.sort((left, right) =>
      left.position !== right.position
        ? left.position - right.position
        : left.id < right.id
          ? -1
          : left.id > right.id
            ? 1
            : 0,
    );
  }
  return groups;
}

/**
 * Each work item's place in **tree order** — the order a project is drawn in:
 * depth-first from the roots, siblings by {@link siblingGroupsOf}'s rule.
 *
 * This is the order every reader sorts by since ADR 0023. Until then the
 * spelling was the work item number, whose labels were built so that a
 * byte-wise sort equalled this walk — true only while frozen labels ascend
 * along position, which is what the `frozen` move refusal used to guarantee. A
 * frozen number is a name now, so the walk is stated directly rather than
 * inferred from a string.
 *
 * @throws if a work item is not reachable from any root — its `parentId` names
 * something outside these placements, or it sits in a parent cycle. Both mean
 * the caller is holding something that is not a tree, and answering for the
 * reachable ones would hand back a project silently missing rows.
 * {@link deriveNumbers} refuses the same shape for the same reason.
 */
export function treeOrder(placements: readonly TreePlacement[]): ReadonlyMap<string, number> {
  const groups = siblingGroupsOf(placements);
  const places = new Map<string, number>();
  const walk = (parentId: string | null): void => {
    for (const placement of groups.get(parentId) ?? []) {
      places.set(placement.id, places.size);
      walk(placement.id);
    }
  };
  walk(null);

  if (places.size !== placements.length) {
    const unreachable = placements.filter((each) => !places.has(each.id)).map((each) => each.id);
    throw new Error(`work items unreachable from any root: ${unreachable.join(', ')}`);
  }
  return places;
}

/**
 * The comparator every reader sorts a project's rows with, over a
 * {@link treeOrder} taken from the same rows.
 *
 * A factory rather than four copies of two `Map` lookups and a subtraction:
 * the plan read, the directory's usage panel and fe-01's fake each sorted by
 * the number string in their own words, and the one that was forgotten is how
 * a reader would see a moved frozen work item drawn where its old label says
 * rather than where it is.
 *
 * @throws for a work item the order does not hold. Never a default: a row that
 * was not among the placements the order was taken from is a caller fault, and
 * sorting it to the top or the bottom would put it somewhere the project does
 * not say it goes.
 */
export function byTreeOrder<T extends { id: string }>(
  order: ReadonlyMap<string, number>,
): (left: T, right: T) => number {
  const placeOf = (id: string): number => {
    const place = order.get(id);
    if (place === undefined) throw new Error(`no tree place for work item ${id}`);
    return place;
  };
  return (left, right) => placeOf(left.id) - placeOf(right.id);
}
