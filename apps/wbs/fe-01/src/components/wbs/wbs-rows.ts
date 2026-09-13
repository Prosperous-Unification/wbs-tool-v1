import type { ExternalRefView, WorkItemView } from '@/lib/wbs-api';

/** A work item with its children attached, which is the shape a table row model wants. */
export interface TreeRow extends WorkItemView {
  subRows: TreeRow[];
  /**
   * Required here where {@link WorkItemView} has it optional: `toTree` fills it,
   * so every surface above this one reads a set rather than checking for one.
   * The swap window that makes it optional on the wire is argued there and at
   * {@link toTree}.
   */
  tagIds: string[];
  /**
   * Required here where {@link WorkItemView} has it optional, `tagIds`' rule.
   *
   * The default is `[]`, which since task 10.2 **is** this field's unstated
   * state: an outgoing be-01's silence and a row nobody has labelled arrive at
   * every surface as the same answer, which is the answer both of them mean. It
   * defaulted to `null` while the field was a column and the sentence was the
   * same one.
   */
  serviceIds: string[];
  /**
   * Required here where {@link WorkItemView} has it optional, `tagIds`' rule and
   * the same swap window.
   *
   * The default is `[]`, and for this dimension `[]` is the **whole** answer
   * rather than the unstated half of one: a row with no types has none and takes
   * no ancestor's (`docs/adr/0009-a-work-item-type-does-not-inherit-at-all.md`).
   * So an outgoing be-01's silence and a row nobody has typed arrive at every
   * surface as the same answer — which for the three dimensions above means "ask
   * the ancestors", and here means "there is nothing".
   */
  typeIds: string[];
  /**
   * Required here where {@link WorkItemView} has it optional, `tagIds`' rule and
   * the same swap window.
   *
   * The default is `[]`, and it is the whole answer rather than half of one: a
   * row with no refs links to nothing and takes no ancestor's, so an outgoing
   * be-01's silence and a row nobody has wired up arrive at every surface as the
   * same thing — an empty cell.
   */
  externalRefs: ExternalRefView[];
}

/**
 * Nests a flat, tree-ordered list.
 *
 * be-01 already returns the rows in the order they read, so this adds no
 * ordering of its own — it only attaches children to parents, which is what
 * expansion needs to know a branch exists. A work item whose parent is missing
 * from the list is kept at the root rather than dropped: losing a row silently
 * is worse than showing it in the wrong place.
 *
 * **`tagIds` and `serviceId` are defaulted here**, and this is the one place they
 * may be: the type
 * says it is a `string[]` and every surface reads `.length` on it without
 * checking, so the wire has to be made to match the type at the boundary rather
 * than at each of them.
 *
 * The absence is a real state and not a paranoid one. Blue and green run
 * together during a swap: an fe-01 carrying this change can be served a tree by
 * the **outgoing** be-01, which has never heard of the field. `serviceTeamId`
 * documents the same window from the other side. An untagged plan for the
 * length of a deploy is right; a page that throws on every row is not.
 */
export function toTree(flat: readonly WorkItemView[]): TreeRow[] {
  const rows = new Map<string, TreeRow>(
    flat.map((item) => [
      item.id,
      {
        ...item,
        tagIds: item.tagIds ?? [],
        serviceIds: item.serviceIds ?? [],
        typeIds: item.typeIds ?? [],
        externalRefs: item.externalRefs ?? [],
        subRows: [],
      },
    ]),
  );
  const roots: TreeRow[] = [];
  for (const item of flat) {
    const row = rows.get(item.id);
    if (row === undefined) continue;
    const parent = item.parentId === null ? undefined : rows.get(item.parentId);
    if (parent === undefined) roots.push(row);
    else parent.subRows.push(row);
  }
  return roots;
}
