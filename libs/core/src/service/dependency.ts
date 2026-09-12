import { hasCycle, indexTree, isWithin, parentIndexOf } from '@wbs/domain';

import type { StoredDependency } from '../ports/dependency-store';
import type { WorkItem } from '../ports/work-item-store';

export type DependencyRefusal = 'not_found' | 'ancestor' | 'cycle';

/**
 * Why an edge cannot be drawn, or `null` when it can.
 *
 * Pure, and the whole rule. be-01 refuses the write; the schedule's topological
 * sort throws on a cyclic graph anyway, because this guard protects the edges
 * this application creates and that one protects the computation from any graph
 * it is handed — see `design.md` D6.
 */
export function canDepend(
  rows: readonly WorkItem[],
  existing: readonly StoredDependency[],
  predecessorId: string,
  successorId: string,
): DependencyRefusal | null {
  const known = new Set(rows.map((row) => row.id));
  // Unknown is not OK, and it is also how a cross-project edge arrives: the rows
  // are one project's, so a work item from another is simply not among them.
  if (!known.has(predecessorId) || !known.has(successorId)) return 'not_found';

  // Onto itself, an ancestor, or a descendant. A parent already spans its
  // children, so asking it to wait for one is asking it to start after itself.
  // Proof: this branch deleted and exactly the three `ancestor` tests failed —
  // onto itself, onto its parent, onto its child.
  const parentOf = parentIndexOf(rows);
  if (
    isWithin(parentOf, predecessorId, successorId) ||
    isWithin(parentOf, successorId, predecessorId)
  ) {
    return 'ancestor';
  }

  // Asked of the graph the schedule will actually build, not of the edges as
  // written. The first version walked the written edges with its own tree-aware
  // reachability, and it was subtly wrong in both directions — an edge whose
  // *expansion* closed a cycle was accepted, and every later read of the project
  // then threw. Both reviewers found it independently, with different examples.
  //
  // Expanding the proposed edge and asking whether the result can be ordered is
  // the same question, asked of the same thing, by the same code. There is no
  // second implementation left to disagree.
  //
  // Proof: this line deleted and every cycle test failed, including the two the
  // old hand-rolled search let through.
  const proposed = { id: 'proposed', projectId: '', predecessorId, successorId };
  if (hasCycle(indexTree(rows), [...existing, proposed])) return 'cycle';

  return null;
}
