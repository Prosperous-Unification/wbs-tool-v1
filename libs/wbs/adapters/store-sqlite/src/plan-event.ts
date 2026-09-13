import type { PlanEvent, PlanEventFilter, PlanEventStore } from '@wbs/core';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';

import { rowsChanged } from './changes';
import type { Drizzle } from './db';
import type { Gate } from './gate';
import { planEvent, type PlanEventRow } from './schema';

/**
 * The plan's history: reading it, and taking the old end off.
 *
 * **There is no `append` here on purpose.** A history row is written by
 * {@link CommandJournalRepository.append}, inside the transaction that appends
 * the undo entry, because the two record one act and a separate call could fail
 * on its own. An `append` on this class would be that second write path, and it
 * would look entirely reasonable to whoever added the next journalled command.
 *
 * `plan_event` in `schema.ts` says what this table is and is not; `PlanEventStore`
 * in `index.ts` says what a caller may ask of it.
 */
export class PlanEventRepository implements PlanEventStore {
  constructor(
    private readonly db: Drizzle,
    private readonly gate: Gate,
  ) {}

  /**
   * One project's history, newest first, narrowed by `filter`.
   *
   * Newest first because that is what a reader wants first and because the
   * `(project_id, created_at)` index serves it directly. `id` breaks a tie: two
   * commands inside one millisecond are ordered arbitrarily by `created_at`
   * alone, and an arbitrary order means two reads of an unchanged plan can
   * disagree.
   *
   * A `kinds` list that names nothing is no filter at all — see
   * {@link PlanEventFilter}. Written as a length check rather than handed to
   * `inArray` empty, which is SQL for "no row" and the opposite reading.
   *
   * Proof: the length check replaced by an unconditional `inArray`, and **every
   * case in `plan-event.test.ts` fails** — 0 pass, 7 fail — because the default
   * `kinds` is the empty list and drizzle renders that as a condition no row
   * satisfies. The reading this line refuses is not "a narrower answer"; it is
   * "the plan has no history". Watched 2026-08-17.
   */
  async listFor(projectId: string, filter: PlanEventFilter): Promise<PlanEvent[]> {
    const kinds = filter.kinds ?? [];
    const rows = await this.db
      .select()
      .from(planEvent)
      .where(
        and(
          eq(planEvent.projectId, projectId),
          filter.workItemId === undefined ? undefined : eq(planEvent.workItemId, filter.workItemId),
          kinds.length === 0 ? undefined : inArray(planEvent.kind, [...kinds]),
        ),
      )
      .orderBy(desc(planEvent.createdAt), desc(planEvent.id));
    return rows.map(asEvent);
  }

  /**
   * Deletes every event recorded before `cutoff`, and answers how many went.
   *
   * `changes()` rather than a count read before and after, exactly as
   * `DrizzleEventLogStore.pruneBeyond` argues: two full scans is the expensive
   * way to ask and the wrong one, because the other deployment colour writes to
   * this same file and a concurrent insert between them lands in the difference
   * and reports as a deletion.
   *
   * No row back from `SELECT changes()` throws rather than reading as zero —
   * see {@link rowsChanged}. A sweep that deleted a year of history and
   * reported none is the shape of failure a retention timer must not be able to
   * have.
   */
  async pruneOlderThan(cutoff: number): Promise<number> {
    return await this.gate.enter(async () => {
      await Promise.resolve();
      // **One transaction over the delete and its count**, which is the whole
      // point of the pairing: `changes()` answers about the last statement this
      // connection ran, and this method used to `await` between the two. Nothing
      // else in be-01 writes without the write lock — but the retention sweep
      // does not hold it, so a plan command landing in that window would have
      // handed its own row count to the sweep's log line. The four satellite
      // stores already did it this way; these two did not.
      return this.db.transaction((tx) => {
        tx.delete(planEvent).where(lt(planEvent.createdAt, cutoff)).run();
        return rowsChanged(tx, 'deleting from plan_event');
      });
    });
  }
}

/**
 * A stored row as a reader gets it: the two command columns parsed.
 *
 * `JSON.parse` throws on text that is not JSON, which is the right answer for a
 * column this process wrote — malformed trusted data is R5's "unknown is not
 * OK", not a condition to model. The same call `asEntry` makes in
 * `command-journal.ts`, and for the same reason it hands back `unknown`.
 */
function asEvent(row: PlanEventRow): PlanEvent {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    kind: row.kind,
    label: row.label,
    workItemId: row.workItemId,
    stepId: row.stepId,
    before: JSON.parse(row.before),
    after: JSON.parse(row.after),
    createdAt: row.createdAt,
  };
}
