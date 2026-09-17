import type { StoredProgress } from '@wbs/core';
import { expect } from 'bun:test';

import type { CaseRegistration } from '../case-manifest';
import { TARGETED_ORDER_WORK_ITEM_IDS } from '../source-declaration';
import { type OpenCase, storeCase } from './store-case';

/** A progress-only third step that keeps move-source rows and the target sentinel disjoint. */
export const PROGRESS_SENTINEL_STEP_ID = 'step-a-review';

function byKey(progress: StoredProgress[]): StoredProgress[] {
  return progress.toSorted((left, right) =>
    `${left.workItemId}\u0000${left.stepId}`.localeCompare(
      `${right.workItemId}\u0000${right.stepId}`,
    ),
  );
}

/** Shared progress-store cases observed only through complete public reads. */
export function progressRegistrations(open: OpenCase<'progress'>): readonly CaseRegistration[] {
  return [
    storeCase('progress', 'progress.listPlacements:source-order', open, async ({ port, seed }) => {
      const [firstId, secondId] = seed.workItemIds[0];
      const stepId = seed.stepIds[0][0];
      await port.set({ workItemId: secondId, stepId, state: 'done', statedAt: 1 }, seed.stamps[0]);
      await port.set(
        { workItemId: firstId, stepId, state: 'in_progress', statedAt: 1 },
        seed.stamps[0],
      );
      await port.set(
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          state: 'done',
          statedAt: 1,
        },
        seed.stamps[1],
      );
      const groups = [
        ...new Set(
          (await port.listByProject(seed.projectIds[0])).map(({ workItemId }) => workItemId),
        ),
      ];
      expect(await port.listPlacements(seed.projectIds[0], [secondId, 'missing', firstId])).toEqual(
        groups.map((id, index) => ({ id, afterId: index === 0 ? null : groups[index - 1] })),
      );
      expect(await port.listPlacements(seed.projectIds[0], [seed.workItemIds[1][0]])).toEqual([]);
      expect(await port.listPlacements(seed.projectIds[0], [])).toEqual([]);
    }),
    storeCase('progress', 'progress.listByWorkItems:scope-order', open, async ({ port, seed }) => {
      const targetId = seed.workItemIds[0][0];
      const [firstStep, secondStep] = seed.stepIds[0];
      await port.set(
        { workItemId: targetId, stepId: secondStep, state: 'done', statedAt: 2 },
        seed.stamps[0],
      );
      await port.set(
        { workItemId: targetId, stepId: firstStep, state: 'in_progress', statedAt: 1 },
        seed.stamps[0],
      );
      const foreignId = seed.workItemIds[1][0];
      await port.set(
        { workItemId: foreignId, stepId: seed.stepIds[1][0], state: 'done', statedAt: 3 },
        seed.stamps[1],
      );
      for (const [index, workItemId] of TARGETED_ORDER_WORK_ITEM_IDS.entries()) {
        await port.set(
          { workItemId, stepId: firstStep, state: 'in_progress', statedAt: index + 1 },
          seed.stamps[0],
        );
      }
      const complete = await port.listByProject(seed.projectIds[0]);
      expect(
        (await port.listByWorkItems(seed.projectIds[0], [targetId])).map(({ stepId }) => stepId),
      ).toEqual([firstStep, secondStep]);
      const foreign = await port.listByWorkItems(seed.projectIds[0], [foreignId]);
      // Proof: validating ownership before project filtering made the memory
      // adapter throw for this valid project-B progress row instead of returning [].
      expect(foreign).toEqual(complete.filter(({ workItemId }) => workItemId === foreignId));
      expect(foreign).toEqual([]);
      const mixedCase = await port.listByWorkItems(
        seed.projectIds[0],
        TARGETED_ORDER_WORK_ITEM_IDS,
      );
      // Proof: SQLite's old localeCompare post-sort returned work-a before
      // work-A, disagreeing with the full reader's BINARY order.
      expect(mixedCase).toEqual(
        complete.filter(({ workItemId }) =>
          TARGETED_ORDER_WORK_ITEM_IDS.some((id) => id === workItemId),
        ),
      );
      expect(await port.listByWorkItems(seed.projectIds[0], [])).toEqual([]);
    }),
    storeCase('progress', 'progress.set:replace', open, async ({ port, readers, seed }) => {
      const [firstId, secondId] = seed.workItemIds[0];
      const [devId, qaId] = seed.stepIds[0];
      await port.set(
        { workItemId: firstId, stepId: devId, state: 'in_progress', statedAt: 101 },
        seed.stamps[0],
      );
      await port.set(
        { workItemId: firstId, stepId: qaId, state: 'done', statedAt: 102 },
        seed.stamps[0],
      );
      await port.set(
        { workItemId: secondId, stepId: devId, state: 'in_progress', statedAt: 103 },
        seed.stamps[0],
      );
      await port.set(
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          state: 'done',
          statedAt: 104,
        },
        seed.stamps[1],
      );

      expect(byKey(await readers.progress.listByProject(seed.projectIds[0]))).toEqual([
        { workItemId: firstId, stepId: devId, state: 'in_progress', statedAt: 101 },
        { workItemId: firstId, stepId: qaId, state: 'done', statedAt: 102 },
        { workItemId: secondId, stepId: devId, state: 'in_progress', statedAt: 103 },
      ]);
      expect(byKey(await readers.progress.listByProject(seed.projectIds[1]))).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          state: 'done',
          statedAt: 104,
        },
      ]);

      await port.set(
        { workItemId: firstId, stepId: devId, state: 'done', statedAt: 201 },
        seed.stamps[1],
      );

      expect(byKey(await readers.progress.listByProject(seed.projectIds[0]))).toEqual([
        { workItemId: firstId, stepId: devId, state: 'done', statedAt: 201 },
        { workItemId: firstId, stepId: qaId, state: 'done', statedAt: 102 },
        { workItemId: secondId, stepId: devId, state: 'in_progress', statedAt: 103 },
      ]);
      expect(byKey(await readers.progress.listByProject(seed.projectIds[1]))).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          state: 'done',
          statedAt: 104,
        },
      ]);
    }),
    storeCase('progress', 'progress.remove:absence', open, async ({ port, readers, seed }) => {
      const [firstId, secondId] = seed.workItemIds[0];
      const [devId, qaId] = seed.stepIds[0];
      await port.set(
        { workItemId: firstId, stepId: devId, state: 'done', statedAt: 101 },
        seed.stamps[0],
      );
      await port.set(
        { workItemId: firstId, stepId: qaId, state: 'in_progress', statedAt: 102 },
        seed.stamps[0],
      );
      await port.set(
        { workItemId: secondId, stepId: devId, state: 'done', statedAt: 103 },
        seed.stamps[0],
      );
      await port.set(
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          state: 'in_progress',
          statedAt: 104,
        },
        seed.stamps[1],
      );

      expect(byKey(await readers.progress.listByProject(seed.projectIds[0]))).toEqual([
        { workItemId: firstId, stepId: devId, state: 'done', statedAt: 101 },
        { workItemId: firstId, stepId: qaId, state: 'in_progress', statedAt: 102 },
        { workItemId: secondId, stepId: devId, state: 'done', statedAt: 103 },
      ]);
      expect(byKey(await readers.progress.listByProject(seed.projectIds[1]))).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          state: 'in_progress',
          statedAt: 104,
        },
      ]);

      await port.remove(firstId, devId, seed.stamps[1]);

      expect(byKey(await readers.progress.listByProject(seed.projectIds[0]))).toEqual([
        { workItemId: firstId, stepId: qaId, state: 'in_progress', statedAt: 102 },
        { workItemId: secondId, stepId: devId, state: 'done', statedAt: 103 },
      ]);
      expect(byKey(await readers.progress.listByProject(seed.projectIds[1]))).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          state: 'in_progress',
          statedAt: 104,
        },
      ]);

      await port.remove(firstId, devId, seed.stamps[1]);

      expect(byKey(await readers.progress.listByProject(seed.projectIds[0]))).toEqual([
        { workItemId: firstId, stepId: qaId, state: 'in_progress', statedAt: 102 },
        { workItemId: secondId, stepId: devId, state: 'done', statedAt: 103 },
      ]);
      expect(byKey(await readers.progress.listByProject(seed.projectIds[1]))).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          state: 'in_progress',
          statedAt: 104,
        },
      ]);
    }),
    storeCase('progress', 'progress.moveAll:ownership', open, async ({ port, readers, seed }) => {
      const [sourceId, targetId] = seed.workItemIds[0];
      const [devId, qaId] = seed.stepIds[0];
      await port.set(
        { workItemId: sourceId, stepId: devId, state: 'done', statedAt: 101 },
        seed.stamps[0],
      );
      await port.set(
        { workItemId: sourceId, stepId: qaId, state: 'in_progress', statedAt: 102 },
        seed.stamps[0],
      );
      await port.set(
        {
          workItemId: targetId,
          stepId: PROGRESS_SENTINEL_STEP_ID,
          state: 'done',
          statedAt: 103,
        },
        seed.stamps[0],
      );
      await port.set(
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          state: 'done',
          statedAt: 104,
        },
        seed.stamps[1],
      );

      expect(byKey(await readers.progress.listByProject(seed.projectIds[0]))).toEqual([
        { workItemId: sourceId, stepId: devId, state: 'done', statedAt: 101 },
        { workItemId: sourceId, stepId: qaId, state: 'in_progress', statedAt: 102 },
        {
          workItemId: targetId,
          stepId: PROGRESS_SENTINEL_STEP_ID,
          state: 'done',
          statedAt: 103,
        },
      ]);
      expect(byKey(await readers.progress.listByProject(seed.projectIds[1]))).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          state: 'done',
          statedAt: 104,
        },
      ]);

      await port.moveAll(sourceId, targetId, seed.stamps[1]);

      expect(byKey(await readers.progress.listByProject(seed.projectIds[0]))).toEqual([
        { workItemId: targetId, stepId: devId, state: 'done', statedAt: 101 },
        { workItemId: targetId, stepId: qaId, state: 'in_progress', statedAt: 102 },
        {
          workItemId: targetId,
          stepId: PROGRESS_SENTINEL_STEP_ID,
          state: 'done',
          statedAt: 103,
        },
      ]);
      expect(byKey(await readers.progress.listByProject(seed.projectIds[1]))).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          state: 'done',
          statedAt: 104,
        },
      ]);
    }),
    storeCase('progress', 'progress.set:unknown_step', open, async ({ port, readers, seed }) => {
      await port.set(
        {
          workItemId: seed.workItemIds[0][1],
          stepId: seed.stepIds[0][1],
          state: 'in_progress',
          statedAt: 102,
        },
        seed.stamps[0],
      );
      await port.set(
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          state: 'done',
          statedAt: 104,
        },
        seed.stamps[1],
      );

      expect(byKey(await readers.progress.listByProject(seed.projectIds[0]))).toEqual([
        {
          workItemId: seed.workItemIds[0][1],
          stepId: seed.stepIds[0][1],
          state: 'in_progress',
          statedAt: 102,
        },
      ]);
      expect(byKey(await readers.progress.listByProject(seed.projectIds[1]))).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          state: 'done',
          statedAt: 104,
        },
      ]);

      const outcome = await port.set(
        {
          workItemId: seed.workItemIds[0][0],
          stepId: 'no-such-step',
          state: 'done',
          statedAt: 201,
        },
        seed.stamps[1],
      );
      const projectA = byKey(await readers.progress.listByProject(seed.projectIds[0]));
      const projectB = byKey(await readers.progress.listByProject(seed.projectIds[1]));

      expect({ outcome, projectA, projectB }).toEqual({
        outcome: 'unknown_step',
        projectA: [
          {
            workItemId: seed.workItemIds[0][1],
            stepId: seed.stepIds[0][1],
            state: 'in_progress',
            statedAt: 102,
          },
        ],
        projectB: [
          {
            workItemId: seed.workItemIds[1][0],
            stepId: seed.stepIds[1][0],
            state: 'done',
            statedAt: 104,
          },
        ],
      });
    }),
  ];
}
