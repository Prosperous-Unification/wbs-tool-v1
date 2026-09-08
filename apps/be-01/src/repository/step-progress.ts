import { and, eq } from 'drizzle-orm';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';

import { auditOnCreate, auditOnUpdate } from './audit';
import { rowsChanged } from './changes';
import type { Gate } from './gate';
import type { StepProgressStore, StepWriteOutcome, StoredProgress, WriteStamp } from './index';
import { bumpWorkItems } from './revision';
import { step, stepProgress, workItem } from './schema';
import { writingStep } from './step-reference';

/**
 * A stated step is a **satellite** of the work item it is on, exactly as an
 * estimate and an actual are: it has no identity anyone holds and is only ever
 * read through that work item. So every write here moves that work item's
 * revision, inside the same transaction as the write — see `work_item.revision`
 * in `schema.ts`.
 *
 * Deliberately shaped as a copy of `ActualRepository` rather than as a second
 * design, for the reason that class gives for copying `EstimateRepository`: the
 * three tables share a key, a grain and every structural rule about where rows
 * may live, and the failure this prevents is the one where estimates and actuals
 * follow a subtree and the statement about them quietly does not.
 */
export class StepProgressRepository implements StepProgressStore {
  constructor(
    private readonly db: SQLiteBunDatabase,
    private readonly gate: Gate,
  ) {}

  /**
   * Every stated step in the project, **in step order** within each work item.
   *
   * Ordered for `ActualRepository.listByProject`'s weaker reason and not its
   * stronger one: folding states is `agree`, which is commutative and
   * idempotent, so unlike a sum of reals the order cannot change the answer.
   * What it does change is the order the steps appear in on screen, and two
   * reads of an unchanged plan must not disagree about that.
   *
   * Ordered by the step's **position**, so this hands back the order the work
   * runs in — the same order the estimates and the actuals come back in, which
   * is what lets a reader put the three lists side by side.
   */
  async listByProject(projectId: string): Promise<StoredProgress[]> {
    await Promise.resolve();
    return (
      this.db
        .select({
          workItemId: stepProgress.workItemId,
          stepId: stepProgress.stepId,
          state: stepProgress.state,
          statedAt: stepProgress.statedAt,
        })
        .from(stepProgress)
        // Inner rather than left: `step_progress.step_id` is a foreign key, so a
        // statement whose step is gone cannot exist — `StepRepository.remove`
        // deletes them in the same transaction as the step.
        .innerJoin(step, eq(stepProgress.stepId, step.id))
        // And the work item, so the project is asked for in the statement that
        // reads the rows. This was two queries until 2026-09-02 — every work item
        // id, then `IN (…)` over the lot — which put one bound parameter per row
        // into the read, four times over per plan read. Inner again, and for the
        // same reason: `workItemId` is a foreign key.
        .innerJoin(workItem, eq(stepProgress.workItemId, workItem.id))
        .where(eq(workItem.projectId, projectId))
        .orderBy(stepProgress.workItemId, step.position, stepProgress.stepId)
    );
  }

  /**
   * States one work item's step, replacing whatever it said before.
   *
   * `statedAt` is replaced with the new write's own stamp rather than kept from
   * the row being overwritten: the column says when this statement was made, and
   * a step that has just gone from in progress to done was said to be done
   * today.
   */
  async set(toSet: StoredProgress, stamp: WriteStamp): Promise<StepWriteOutcome> {
    return await writingStep(this.db, toSet.stepId, async () => {
      await this.gate.enter(async () => {
        await Promise.resolve();
        this.db.transaction((tx) => {
          tx.insert(stepProgress)
            .values({ ...toSet, ...auditOnCreate(stamp) })
            .onConflictDoUpdate({
              target: [stepProgress.workItemId, stepProgress.stepId],
              set: { state: toSet.state, statedAt: toSet.statedAt, ...auditOnUpdate(stamp) },
            })
            .run();
          bumpWorkItems(tx, [toSet.workItemId], stamp);
        });
      });
    });
  }

  async remove(workItemId: string, stepId: string, stamp: WriteStamp): Promise<void> {
    await this.gate.enter(async () => {
      // Both halves of the key, not the step alone: the composite primary key is
      // (work item, step), and narrowing to one of them would take that step's
      // state off every row in the database. `step-progress.test.ts` keeps a
      // survivor for each half so that mistake cannot pass — the same guard
      // `estimate.test.ts` and `actual.test.ts` keep.
      await Promise.resolve();
      this.db.transaction((tx) => {
        tx.delete(stepProgress)
          .where(and(eq(stepProgress.workItemId, workItemId), eq(stepProgress.stepId, stepId)))
          .run();
        bumpWorkItems(tx, [workItemId], stamp);
      });
    });
  }

  /**
   * Both work items move when anything moved, for `EstimateRepository.moveAll`'s
   * reason: one lost every statement it held and the other gained them, and a
   * reader of either sees a different state afterwards.
   *
   * **Conditional, exactly as `ActualRepository.moveAll` is and for the same
   * measurement.** This runs on every create that gives a leaf its first child,
   * beside the estimate move and the actual move, and almost every plan has no
   * stated rows at all: an unconditional bump would move two revisions on a
   * write that touched no row of this table, and every reader's precondition on
   * that parent would go stale for a change that did not happen.
   *
   * The conditional is not a read-then-write — `changes()` reports what the
   * statement in this transaction just did, so a row written by somebody else a
   * moment earlier is inside the `UPDATE` and inside the count.
   *
   * Proof: bumped unconditionally, `hands the estimate down to a first child,
   * moving both` in `service/revision.test.ts` fails with the child at revision
   * 2 where 1 is owed; watched 2026-08-18.
   */
  async moveAll(fromWorkItemId: string, toWorkItemId: string, stamp: WriteStamp): Promise<void> {
    await this.gate.enter(async () => {
      await Promise.resolve();
      this.db.transaction((tx) => {
        tx.update(stepProgress)
          .set({ workItemId: toWorkItemId, ...auditOnUpdate(stamp) })
          .where(eq(stepProgress.workItemId, fromWorkItemId))
          .run();
        if (rowsChanged(tx, 'moving stated progress') === 0) return;
        bumpWorkItems(tx, [fromWorkItemId, toWorkItemId], stamp);
      });
    });
  }
}
