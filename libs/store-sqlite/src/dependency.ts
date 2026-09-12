import type { DependencyStore, StoredDependency, WriteStamp } from '@wbs/core';
import { and, eq, inArray, or } from 'drizzle-orm';

import { auditOnCreate } from './audit';
import type { Drizzle } from './db';
import type { Gate } from './gate';
import { bumpWorkItems } from './revision';
import { dependency } from './schema';

/**
 * An edge is a satellite of **both** work items it joins: the successor reads
 * it as "what I wait for" and the predecessor as "what waits for me". Every
 * write here therefore moves two revisions, in the transaction that carries the
 * edge write.
 *
 * Proof: bumped for the successor alone, `adding an edge moves both endpoints`
 * in `service/revision.test.ts` fails on the predecessor; watched 2026-08-07.
 */
export class DependencyRepository implements DependencyStore {
  constructor(
    private readonly db: Drizzle,
    private readonly gate: Gate,
  ) {}

  async listByProject(projectId: string): Promise<StoredDependency[]> {
    // Projected rather than `select()`, and every read that crosses this
    // boundary is: the audit columns are recorded, not published, so a bare
    // select would put three fields nobody asked for into the store's answer and
    // from there into the HTTP payload. The declared return type is what checks
    // the list is complete — drop a column and `tsc` says so.
    return this.db
      .select({
        id: dependency.id,
        projectId: dependency.projectId,
        predecessorId: dependency.predecessorId,
        successorId: dependency.successorId,
      })
      .from(dependency)
      .where(eq(dependency.projectId, projectId));
  }

  /**
   * `onConflictDoNothing` on the unique pair rather than a read-then-write.
   *
   * Two people drawing the same arrow at the same moment would both see "not
   * there" and both insert; the second would fail on the index and surface as a
   * 500 for an action that had already succeeded.
   *
   * The revisions move even when the insert did nothing, for the same reason
   * the estimate bumps are unconditional: making the bump depend on what the
   * insert did means reading what the insert did, and a spurious bump costs a
   * retry where a missing one costs a lost edit.
   */
  async add(toAdd: StoredDependency, stamp: WriteStamp): Promise<void> {
    await this.gate.enter(async () => {
      await Promise.resolve();
      this.db.transaction((tx) => {
        // `onConflictDoNothing`, so an edge that is already there keeps the stamp
        // of the act that first drew it. Re-adding a dependency is not a change to
        // it, and the audit columns say who drew the edge rather than who last
        // asked for it.
        tx.insert(dependency)
          .values({ ...toAdd, ...auditOnCreate(stamp) })
          .onConflictDoNothing()
          .run();
        bumpWorkItems(tx, [toAdd.predecessorId, toAdd.successorId], stamp);
      });
    });
  }

  async remove(predecessorId: string, successorId: string, stamp: WriteStamp): Promise<void> {
    await this.gate.enter(async () => {
      await Promise.resolve();
      this.db.transaction((tx) => {
        tx.delete(dependency)
          .where(
            and(
              eq(dependency.predecessorId, predecessorId),
              eq(dependency.successorId, successorId),
            ),
          )
          .run();
        bumpWorkItems(tx, [predecessorId, successorId], stamp);
      });
    });
  }

  /**
   * Both directions, because a work item being deleted is neither a predecessor
   * nor a successor any more. The foreign keys would refuse the delete otherwise,
   * which is the point: an edge to a row that is gone is not a thing to keep.
   *
   * The **surviving** ends are bumped and the doomed ones are not. This is the
   * one place the edges have to be read before they are written: which work
   * items lose an edge is not knowable from the argument, and it is the *set of
   * rows* being read, never the counter — the counter is still `revision + 1`
   * in SQL, inside the same transaction as the delete. The caller is on its way
   * to deleting these rows, so bumping one of them would move a counter onto a
   * row about to stop existing.
   *
   * **The whole doomed set at once, in one transaction.** A subtree delete used
   * to call this once per row, which cost a transaction, a read and a write for
   * each — and got the survivor rule wrong: an edge between two doomed rows
   * bumped the far end, because a single-id call cannot tell a doomed sibling
   * from a survivor. Reading the set is what makes that answerable.
   *
   * Proof: `takes a subtree's edges in one transaction and bumps only the
   * survivors`, with the per-row loop restored, watched failing on
   * `Expected length: 3` · `Received length: 6`; and with that assertion
   * silenced, on `Expected: 0` · `Received: 1` at `moved(b)` — the doomed
   * sibling bumped on its way out (2026-09-02).
   */
  async removeAllFor(workItemIds: readonly string[], stamp: WriteStamp): Promise<void> {
    await this.gate.enter(async () => {
      await Promise.resolve();
      if (workItemIds.length === 0) return;
      const doomed = new Set(workItemIds);
      const touchesAny = or(
        inArray(dependency.predecessorId, workItemIds),
        inArray(dependency.successorId, workItemIds),
      );
      this.db.transaction((tx) => {
        const losing = tx
          .select({ predecessorId: dependency.predecessorId, successorId: dependency.successorId })
          .from(dependency)
          .where(touchesAny)
          .all();
        tx.delete(dependency).where(touchesAny).run();
        bumpWorkItems(
          tx,
          losing
            .flatMap((edge) => [edge.predecessorId, edge.successorId])
            .filter((id) => !doomed.has(id)),
          stamp,
        );
      });
    });
  }
}
