import type { WriteStamp } from '@wbs/core';
import { eq, inArray, type SQL, sql } from 'drizzle-orm';

import { auditOnUpdate } from './audit';
import type { Drizzle } from './db';
import { project, workItem } from './schema';

/**
 * Whatever can issue an `UPDATE` — the process connection or a transaction
 * opened on it.
 *
 * Structural rather than the drizzle transaction type, because the bump has to
 * be issuable from both: a write that spans tables (an estimate, a dependency)
 * bumps inside the transaction that carries it, and a write that is already one
 * statement bumps in its own `SET` without opening one.
 */
export type RevisionWriter = Pick<Drizzle, 'update'>;

/**
 * `revision = revision + 1` for a work item, as an expression to drop into the
 * `SET` of a statement that is already writing that row.
 *
 * Arithmetic in the database rather than a number this process worked out: two
 * writers that each read 4 would each write 5, and the counter would then say
 * one change had happened where two had. A reader holding 4 would be told it
 * was current against data that had moved twice — the precise failure the
 * column exists to catch.
 */
export const bumpedWorkItem = sql`${workItem.revision} + 1`;

/** The same expression for a project row. */
export const bumpedProject = sql`${project.revision} + 1`;

/**
 * `revision + 1`, but only for a row whose parent this write actually changes.
 *
 * `WorkItemStore.remove` is handed one list holding two different things: the
 * children being promoted out of the deleted parent, and the former siblings
 * the promotion respaced around them. The first kind changed a stored field of
 * its own; the second only changed `position`, which is storage detail — the
 * same rule that keeps an insertion's respacing from moving anything.
 *
 * Decided in SQL rather than by reading the row first, for the reason every
 * other bump here is: SQLite evaluates a statement's `SET` expressions against
 * the row as it was, so this compares the old parent to the new one without
 * that comparison ever passing through this process. `IS NOT` rather than `<>`
 * because a top-level work item's parent is NULL, and `NULL <> NULL` is NULL —
 * with `<>` the promotion of a child to the root would add NULL to the counter
 * and wipe it.
 */
export function bumpedWorkItemOnReparent(parentId: string | null): SQL {
  return sql`${workItem.revision} + (${workItem.parentId} IS NOT ${parentId})`;
}

/**
 * Moves `ids`' revisions, in one statement.
 *
 * For the satellite writes — estimates, assignments, dependencies — where the
 * row being written lives in another table and the entity whose meaning changed
 * is the work item it hangs off. Duplicates are collapsed so a caller naming an
 * item twice moves it once.
 *
 * An empty list is a no-op rather than an error: `removeAllFor` on a work item
 * nothing depends on genuinely has nothing to bump, and drizzle would otherwise
 * emit `IN ()`, which SQLite refuses.
 *
 * **Stamped, and that is a claim worth defending.** This statement writes the
 * work item's `revision` column, so by the rule the whole folder keeps —
 * `updated_at` records what was written — it moves the row's update clock even
 * though the thing the reader edited was an estimate in another table. That is
 * the answer a reader wants from "when did this work item last change": a plan
 * whose figures moved yesterday did change yesterday. `audit.test.ts` found this
 * statement unstamped and is what will notice if it stops being.
 */
export function bumpWorkItems(
  writer: RevisionWriter,
  ids: readonly string[],
  stamp: WriteStamp,
): void {
  const distinct = [...new Set(ids)];
  if (distinct.length === 0) return;
  writer
    .update(workItem)
    .set({ revision: bumpedWorkItem, ...auditOnUpdate(stamp) })
    .where(inArray(workItem.id, distinct))
    .run();
}

/** The same, for one project — its own fields and its steps. */
export function bumpProject(writer: RevisionWriter, id: string, stamp: WriteStamp): void {
  writer
    .update(project)
    .set({ revision: bumpedProject, ...auditOnUpdate(stamp) })
    .where(eq(project.id, id))
    .run();
}
