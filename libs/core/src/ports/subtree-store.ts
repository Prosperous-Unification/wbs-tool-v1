import type { ActualKey, StoredActual } from './actual-store';
import type { StoredDependency } from './dependency-store';
import type { Assignment } from './directory-store';
import type { StoredEstimate } from './estimate-store';
import type { MeasureKey, StoredMeasure } from './measure-store';
import type { ProgressKey, StoredProgress } from './progress-store';
import type { Reparented, Repositioned, WorkItem } from './work-item-store';
import type { WriteStamp } from './write-stamp';

/**
 * A duplicated subtree, ready to be written: every copied row and everything
 * that hangs off it, already carrying its new ids.
 *
 * It arrives as one value because it is written as one act — see
 * {@link SubtreeStore.insertSubtree}. The caller has already decided every id,
 * so nothing here is generated on the way in.
 */
export interface SubtreeCopy {
  /**
   * The copies, **parents before children**. `work_item.parent_id` references
   * `work_item.id`, so any other order is refused by the database rather than
   * silently reordered.
   */
  rows: readonly (WorkItem & { teamIds?: readonly string[] })[];
  /** Existing siblings of the copied root whose positions the placement moved. */
  respaced: readonly Repositioned[];
  /**
   * Rows already in the tree that this write moves back **under** one of
   * `rows`, with the position each had before.
   *
   * Empty for a duplication, which invents every row it writes. It is what
   * makes restoring a promoted deletion one act: the deleted parent comes back
   * and the children that were promoted out of it go back beneath it, and a
   * reader can never land between the two and see the same work twice.
   *
   * Applied after `rows`, because `parent_id` references a row that must
   * already be there.
   */
  reparented: readonly Reparented[];
  estimates: readonly StoredEstimate[];
  /**
   * The days already recorded against the rows being written.
   *
   * **Empty for a duplication, and that is a decision rather than an
   * omission.** A duplicate is work that has not been done yet: copying the
   * original's actuals would tell the plan that a fortnight nobody has worked
   * was already spent, and the copy's variance would read as finished work the
   * moment it appeared. Estimates copy because an estimate is a description of
   * work; actuals do not because an actual is a record of a week.
   *
   * Non-empty for a **restore**, which is the other caller: an undo of a delete
   * has to put back what the delete took, and the actuals went with the rows.
   */
  actuals: readonly StoredActual[];
  /**
   * Where the work on the rows being written had got to, put back with them.
   *
   * **Empty for a duplication, for {@link SubtreeCopy.actuals}' reason and one
   * of its own.** A duplicate is work that has not been done, so copying a
   * `done` would hand the plan a branch that reports itself finished the moment
   * it appears — the same lie the copied actual would tell, in a stronger
   * tense. Estimates copy because an estimate describes work; neither of these
   * does, because both are records of what happened to it.
   *
   * Non-empty for a **restore**: an undo of a delete has to put back what the
   * delete took, and the statements went with the rows.
   */
  progress: readonly StoredProgress[];
  /**
   * The tokens and hours on the rows being written, in every metric that may be
   * on them.
   *
   * **The one field here a duplication fills selectively, and the first place
   * the single discriminated table costs something.** Every other collection on
   * this interface is copied whole or not at all, because each names one kind of
   * thing; this one names three, and the copy rule's line is drawn through the
   * middle of it. `token_estimate` is a description of work and copies for
   * {@link SubtreeCopy.estimates}' reason exactly — a duplicate that carried the
   * days plan and not the token plan would be half-planned in a way the reader
   * can see. `token_actual` and `hours_actual` are records of what a particular
   * piece of work cost, and do not copy for {@link SubtreeCopy.actuals}' reason
   * exactly. See `openspec/changes/token-tracking/design.md` D1 and D8.
   *
   * Non-empty in every metric for a **restore**: an undo of a delete has to put
   * back what the delete took, and the measures went with the rows.
   */
  measures: readonly StoredMeasure[];
  assignments: readonly Assignment[];
  /** Only the edges with both ends inside the subtree, remapped to the copies. */
  dependencies: readonly StoredDependency[];
  /**
   * Estimates to take off a work item **outside** `rows`, in the same write.
   *
   * Empty for a duplication. It exists for the mirror of the rule in
   * `WorkItemService.remove`: deleting a parent's last child hands that child's
   * figures up to the parent, so putting the child back has to take them off
   * again, or the same days are counted twice — once on the restored leaf and
   * once on the parent that is no longer a leaf.
   */
  removedEstimates: readonly EstimateKey[];
  /** Actuals to take off a work item **outside** `rows`, for {@link SubtreeCopy.removedEstimates}' reason. */
  removedActuals: readonly ActualKey[];
  /** Statements to take off a work item **outside** `rows`, for {@link SubtreeCopy.removedEstimates}' reason. */
  removedProgress: readonly ProgressKey[];
  /**
   * Figures to take off a work item **outside** `rows`, for
   * {@link SubtreeCopy.removedEstimates}' reason, one key per metric.
   *
   * Keyed by the triple rather than the pair, because the row's identity is the
   * triple: the parent may hold a figure in a metric this restore is not
   * putting back, and taking the pair away wholesale would delete it.
   */
  removedMeasures: readonly MeasureKey[];
}

/** One estimate row's whole identity: the pair its primary key is. */
export interface EstimateKey {
  workItemId: string;
  stepId: string;
}

export interface SubtreeStore {
  /**
   * Writes a whole {@link SubtreeCopy} in one transaction, across all four
   * tables it touches.
   *
   * Wider than any other store here on purpose. A copy applied in pieces can
   * fail between them and leave rows that look like real work with no
   * estimates and nobody assigned — a plan that is quietly wrong rather than
   * visibly incomplete, and nothing in the tree says which rows they are.
   *
   * Throws whatever the database throws. A rejected write means **nothing**
   * was written, which `work-item.test.ts` asserts against a deliberately
   * broken foreign key rather than claiming it here.
   */
  insertSubtree(copy: SubtreeCopy, stamp: WriteStamp): Promise<void>;
}
