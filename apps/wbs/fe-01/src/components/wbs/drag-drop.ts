import { isWithin, parentIndexOf } from '@wbs/domain/is-within';

import type { WorkItemView } from '@/lib/wbs-api';

/** Where in a row the pointer is, and therefore what dropping there means. */
export type DropZone = 'above' | 'into' | 'below';

/**
 * `frozen` is gone since ADR 0023: a frozen work item moves like any other, and
 * be-01 no longer refuses the move this used to pre-empt.
 */
export type DropRefusal = 'cycle' | 'unchanged' | 'not_found';

/**
 * A resolved drop: exactly the two arguments `POST /work-items/:id/move` takes,
 * or a reason it will not be sent.
 */
export type MovePlan =
  | { ok: true; parentId: string | null; afterId: string | null }
  | { ok: false; reason: DropRefusal };

/**
 * Which third of the row the pointer is in.
 *
 * The middle is half the row and the two edges a quarter each, deliberately.
 * Making a row a child is the operation people reach for when they drag an
 * outline; the two reorder zones are recoverable in one more drag if you miss.
 */
export function zoneFor(offsetY: number, height: number): DropZone {
  if (height <= 0) return 'into';
  const fraction = offsetY / height;
  if (fraction < 0.25) return 'above';
  if (fraction > 0.75) return 'below';
  return 'into';
}

/** The rows directly under `parentId`, in tree order, without the row being dragged. */
function siblingsOf(
  rows: readonly WorkItemView[],
  parentId: string | null,
  excludingId: string,
): WorkItemView[] {
  return rows.filter((r) => r.parentId === parentId && r.id !== excludingId);
}

/**
 * Where a drop would put the dragged row, or why it will not be sent.
 *
 * Pure, and the whole decision surface of dragging: no event, no element, no
 * request. It takes the flat tree-ordered list be-01 returned, which is why a
 * drop into a branch that is collapsed on screen resolves correctly — what is
 * visible is not what is true.
 *
 * `frozen` and `cycle` are refusals be-01 makes too, and be-01 is the authority.
 * They are repeated here because a drag has no failure a person can read: the
 * row snaps back, and nothing says whether that was a rule, the network, or a
 * bug. A refusal decided locally can name itself in the same instant.
 */
export function planMove(
  rows: readonly WorkItemView[],
  draggedId: string,
  targetId: string,
  zone: DropZone,
  /**
   * Whether the target's children are on screen beneath it.
   *
   * It changes what "below this row" means. With the branch open, the next row
   * down is the target's first child, and a person aiming at the line between
   * them means "first child" — placing the row after the whole subtree instead
   * drops it several rows from where the marker was drawn. With the branch
   * closed, the next row down really is the target's next sibling.
   */
  targetShowsChildren = false,
): MovePlan {
  const dragged = rows.find((r) => r.id === draggedId);
  const target = rows.find((r) => r.id === targetId);
  // Unknown is not OK. A target the list does not hold is a bug in the caller,
  // not a move to guess at.
  if (dragged === undefined || target === undefined) return { ok: false, reason: 'not_found' };

  // Onto itself, or anywhere inside its own subtree. `above` and `below` a
  // descendant are cycles too: both put the row under that descendant's parent,
  // which is also inside the subtree.
  // Proof: this line deleted and three tests failed — the drop onto itself, the
  // drop into its own subtree in all three zones, and the only-child case that
  // then reported a move instead of `unchanged`.
  if (isWithin(parentIndexOf(rows), targetId, draggedId)) return { ok: false, reason: 'cycle' };

  const planned = resolve(rows, dragged, target, zone, targetShowsChildren);

  // Where it already is. Sending this renumbers nothing and yet records an
  // event, pushes it to every subscribed socket and makes every other client
  // refetch a tree that did not change.
  // Proof: the refusal below replaced with a fall-through and only `refuses a
  // drop that resolves to where the row already is` failed.
  const currentGroup = siblingsOf(rows, dragged.parentId, draggedId);
  const currentIndex = rows.filter((r) => r.parentId === dragged.parentId).indexOf(dragged);
  const currentAfterId = currentGroup[currentIndex - 1]?.id ?? null;
  if (planned.parentId === dragged.parentId && planned.afterId === currentAfterId) {
    return { ok: false, reason: 'unchanged' };
  }

  return { ok: true, ...planned };
}

function resolve(
  rows: readonly WorkItemView[],
  dragged: WorkItemView,
  target: WorkItemView,
  zone: DropZone,
  targetShowsChildren: boolean,
): { parentId: string | null; afterId: string | null } {
  // Below a row whose children are showing is above the first of them, because
  // that is the gap the marker was drawn in.
  if (zone === 'below' && targetShowsChildren) return { parentId: target.id, afterId: null };

  if (zone === 'into') {
    const children = siblingsOf(rows, target.id, dragged.id);
    return { parentId: target.id, afterId: children.at(-1)?.id ?? null };
  }

  const group = siblingsOf(rows, target.parentId, dragged.id);
  const index = group.findIndex((r) => r.id === target.id);
  if (zone === 'below') return { parentId: target.parentId, afterId: target.id };
  // `above`: the row before the target in its group. A ternary rather than
  // `group.at(index - 1)`: at index 0 there is nothing above, and `.at(-1)`
  // would return the *last* sibling and drop the row at the bottom of a group
  // someone aimed at the top of.
  return { parentId: target.parentId, afterId: index > 0 ? (group[index - 1]?.id ?? null) : null };
}
