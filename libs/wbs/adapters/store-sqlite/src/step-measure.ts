import type { MeasureStore, StepWriteOutcome, StoredMeasure, WriteStamp } from '@wbs/core';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';

import { auditOnCreate, auditOnUpdate } from './audit';
import { rowsChanged } from './changes';
import type { Gate } from './gate';
import { bumpWorkItems } from './revision';
import { type MeasureMetric, step, stepMeasure, workItem } from './schema';
import { writingStep } from './step-reference';

/**
 * A measure is a **satellite** of the work item it is for, exactly as an
 * estimate and an actual are: it has no identity anyone holds and is only ever
 * read through that work item. So every write here moves that work item's
 * revision, inside the same transaction as the measure write — see
 * `work_item.revision` in `schema.ts`.
 *
 * Deliberately shaped as a copy of {@link ActualRepository} rather than as a
 * third design, for the reason that class gives for being a copy of
 * `EstimateRepository`: the tables share a grain and every structural rule about
 * where rows may live, and the failure this shape prevents is the one where
 * estimates and actuals follow a subtree and measures quietly do not.
 *
 * **What is different, and it is only the key.** `step_measure`'s primary key
 * carries a third column, so `metric` is a parameter of every method that names
 * one row — {@link remove} — and a field of the record on {@link set}. It is
 * deliberately **absent** from the two methods that do not name a row:
 * {@link listByProject} hands back every metric because the roll-up folds all
 * three from one read and a payload built from three queries could show three
 * different instants of the same plan, and {@link moveAll} moves every metric
 * because a leaf gaining its first child stops holding figures of **any** unit.
 * `design.md` D1's "every read path takes the metric as a parameter" is about
 * the fold — `rollUpMeasures(metric)`, task 5.1 — not about the list underneath
 * it, which carries the metric on each row instead.
 */
export class StepMeasureRepository implements MeasureStore {
  constructor(
    private readonly db: SQLiteBunDatabase,
    private readonly gate: Gate,
  ) {}

  /**
   * Every measure in the project, **in step order** within each work item and in
   * metric order within each pair.
   *
   * Ordered for `ActualRepository.listByProject`'s reasons — floating-point
   * addition is not associative, so the order decides the last bit of a parent's
   * roll-up, and two reads of an unchanged plan must not disagree about the
   * order of a row's steps on screen — plus one this table is the first to need:
   * a pair may hold three rows, so the steps alone are not a total order.
   * `metric` breaks that tie by its stored text, which is arbitrary but fixed.
   */
  async listByProject(projectId: string): Promise<StoredMeasure[]> {
    await Promise.resolve();
    return (
      this.db
        .select({
          workItemId: stepMeasure.workItemId,
          stepId: stepMeasure.stepId,
          metric: stepMeasure.metric,
          value: stepMeasure.value,
          recordedAt: stepMeasure.recordedAt,
        })
        .from(stepMeasure)
        // Inner rather than left: `step_measure.step_id` is a foreign key, so a
        // measure whose step is gone cannot exist — `StepRepository.remove`
        // deletes them in the same transaction as the step (task 6.3).
        .innerJoin(step, eq(stepMeasure.stepId, step.id))
        // And the work item, so the project is asked for in the statement that
        // reads the rows. This was two queries until 2026-09-02 — every work item
        // id, then `IN (…)` over the lot — which put one bound parameter per row
        // into the read, four times over per plan read. Inner again, and for the
        // same reason: `workItemId` is a foreign key.
        .innerJoin(workItem, eq(stepMeasure.workItemId, workItem.id))
        .where(eq(workItem.projectId, projectId))
        .orderBy(stepMeasure.workItemId, step.position, stepMeasure.stepId, stepMeasure.metric)
    );
  }

  async listByWorkItems(projectId: string, ids: readonly string[]): Promise<StoredMeasure[]> {
    if (ids.length === 0) return [];
    await Promise.resolve();
    const rows = await this.db
      .select({
        workItemId: stepMeasure.workItemId,
        stepId: stepMeasure.stepId,
        metric: stepMeasure.metric,
        value: stepMeasure.value,
        recordedAt: stepMeasure.recordedAt,
        workItemProjectId: workItem.projectId,
        stepProjectId: step.projectId,
        stepPosition: step.position,
      })
      .from(stepMeasure)
      .leftJoin(step, eq(stepMeasure.stepId, step.id))
      .leftJoin(workItem, eq(stepMeasure.workItemId, workItem.id))
      .where(
        and(
          inArray(stepMeasure.workItemId, [...ids]),
          or(eq(workItem.projectId, projectId), isNull(workItem.projectId)),
        ),
      )
      .orderBy(stepMeasure.workItemId, step.position, stepMeasure.stepId, stepMeasure.metric);
    if (rows.some(({ workItemProjectId }) => workItemProjectId === null)) {
      throw new Error('targeted measure has an invalid work-item reference');
    }
    const admitted = rows.filter(({ workItemProjectId }) => workItemProjectId === projectId);
    for (const row of admitted) {
      if (row.stepProjectId !== projectId || row.stepPosition === null) {
        throw new Error(`measure ${row.workItemId}/${row.stepId} has an invalid step reference`);
      }
      if (!isMeasureMetric(row.metric)) {
        throw new Error(`measure ${row.workItemId}/${row.stepId} has an invalid metric`);
      }
      if (typeof row.value !== 'number' || !Number.isFinite(row.value) || row.value < 0) {
        throw new Error(`measure ${row.workItemId}/${row.stepId} has an invalid value`);
      }
      if (typeof row.recordedAt !== 'number' || !Number.isFinite(row.recordedAt)) {
        throw new Error(`measure ${row.workItemId}/${row.stepId} has an invalid recorded time`);
      }
    }
    return admitted.map(({ workItemId, stepId, metric, value, recordedAt }) => ({
      workItemId,
      stepId,
      metric,
      value,
      recordedAt,
    }));
  }

  async listPlacements(projectId: string, ids: readonly string[]) {
    if (ids.length === 0) return [];
    const afterId = sql<string | null>`(
      SELECT predecessor.work_item_id FROM step_measure AS predecessor
      WHERE predecessor.work_item_id < ${stepMeasure.workItemId}
        AND EXISTS (
          SELECT 1 FROM work_item AS predecessor_owner
          WHERE predecessor_owner.id = predecessor.work_item_id
            AND predecessor_owner.project_id = ${projectId}
        )
      ORDER BY predecessor.work_item_id DESC LIMIT 1
    )`;
    return this.db
      .selectDistinct({ id: stepMeasure.workItemId, afterId })
      .from(stepMeasure)
      .innerJoin(workItem, eq(stepMeasure.workItemId, workItem.id))
      .where(and(eq(workItem.projectId, projectId), inArray(stepMeasure.workItemId, [...ids])))
      .orderBy(asc(stepMeasure.workItemId));
  }

  /**
   * Writes one work item's figure in one metric for one step, replacing any
   * earlier one **in that metric only**.
   *
   * The conflict target is all three key columns, which is the whole of D1's
   * absence rule expressed in one line: correcting a pair's token estimate
   * leaves the hours somebody recorded beside it exactly where they were.
   *
   * `recordedAt` is replaced with the new write's own stamp rather than kept
   * from the row being overwritten, for `ActualRepository.set`'s reason: the
   * column says when this number was typed, and a corrected figure was typed
   * today.
   */
  async set(toSet: StoredMeasure, stamp: WriteStamp): Promise<StepWriteOutcome> {
    return await writingStep(this.db, toSet.stepId, async () => {
      await this.gate.enter(async () => {
        await Promise.resolve();
        this.db.transaction((tx) => {
          tx.insert(stepMeasure)
            .values({ ...toSet, ...auditOnCreate(stamp) })
            .onConflictDoUpdate({
              target: [stepMeasure.workItemId, stepMeasure.stepId, stepMeasure.metric],
              set: { value: toSet.value, recordedAt: toSet.recordedAt, ...auditOnUpdate(stamp) },
            })
            .run();
          bumpWorkItems(tx, [toSet.workItemId], stamp);
        });
      });
    });
  }

  async remove(
    workItemId: string,
    stepId: string,
    metric: MeasureMetric,
    stamp: WriteStamp,
  ): Promise<void> {
    await this.gate.enter(async () => {
      // All three parts of the key, not one or two: the primary key is (work
      // item, step, metric). Narrowing to the step would clear it across the whole
      // database, and narrowing to the pair would take the hours away with the
      // tokens. `step-measure.test.ts` keeps a survivor for each of the three so
      // none of those three mistakes can pass — the guard `actual.test.ts` keeps
      // for its two halves, with the third the discriminator adds.
      await Promise.resolve();
      this.db.transaction((tx) => {
        tx.delete(stepMeasure)
          .where(
            and(
              eq(stepMeasure.workItemId, workItemId),
              eq(stepMeasure.stepId, stepId),
              eq(stepMeasure.metric, metric),
            ),
          )
          .run();
        bumpWorkItems(tx, [workItemId], stamp);
      });
    });
  }

  /**
   * Both work items move when anything moved, for `ActualRepository.moveAll`'s
   * reason: one lost every measure it held and the other gained them, and a
   * reader of either sees different figures afterwards.
   *
   * **The bump is conditional**, the shape `actual-days` 2.2 established and for
   * a reason that is stronger here than there. This runs on **every** create
   * that gives a leaf its first child, beside the estimate and actual moves, and
   * a plan holding measures is rarer still than one holding actuals: an
   * unconditional bump would move two revisions on a write that touched no row
   * of this table, and every reader's precondition on that parent would go stale
   * for a change that did not happen.
   *
   * Not a read-then-write: `changes()` reports what the statement in this
   * transaction just did, so a row written by somebody else a moment earlier is
   * inside the `UPDATE` and inside the count.
   */
  async moveAll(fromWorkItemId: string, toWorkItemId: string, stamp: WriteStamp): Promise<void> {
    await this.gate.enter(async () => {
      await Promise.resolve();
      this.db.transaction((tx) => {
        tx.update(stepMeasure)
          .set({ workItemId: toWorkItemId, ...auditOnUpdate(stamp) })
          .where(eq(stepMeasure.workItemId, fromWorkItemId))
          .run();
        if (rowsChanged(tx, 'moving measures') === 0) return;
        bumpWorkItems(tx, [fromWorkItemId, toWorkItemId], stamp);
      });
    });
  }
}

function isMeasureMetric(metric: unknown): metric is MeasureMetric {
  return metric === 'token_estimate' || metric === 'token_actual' || metric === 'hours_actual';
}
