import type { WriteStamp } from './write-stamp';

/** A finish-to-start edge as it is stored: either end may be a parent. */
export interface StoredDependency {
  id: string;
  projectId: string;
  predecessorId: string;
  successorId: string;
}

export interface DependencyStore {
  listByProject(projectId: string): Promise<StoredDependency[]>;
  /**
   * Writes the edge, or does nothing if it is already there.
   *
   * Idempotent at the database through the unique pair rather than by asking
   * first: two clients drawing the same arrow at once would both see "not there"
   * and both insert.
   */
  add(dependency: StoredDependency, stamp: WriteStamp): Promise<void>;
  remove(predecessorId: string, successorId: string, stamp: WriteStamp): Promise<void>;
  /**
   * Every edge touching any of these work items, so deleting the rows can take
   * them along.
   *
   * Takes the whole doomed set rather than one id at a time. A subtree delete
   * knows every row it is about to remove, and calling this once per row cost
   * one transaction, one read and one write **each** — and bumped rows that
   * were themselves on the way out, because from inside a single-id call a
   * doomed sibling is indistinguishable from a survivor.
   */
  removeAllFor(workItemIds: readonly string[], stamp: WriteStamp): Promise<void>;
}
