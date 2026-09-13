import type { StoredProgress } from '@wbs/core';
import { expect } from 'bun:test';

import type { CaseRegistration } from '../case-manifest';
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
