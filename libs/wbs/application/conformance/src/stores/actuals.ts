import type { StoredActual } from '@wbs/core';
import { expect } from 'bun:test';

import type { CaseRegistration } from '../case-manifest';
import { TARGETED_ORDER_WORK_ITEM_IDS } from '../source-declaration';
import { type OpenCase, storeCase } from './store-case';

function byKey(actuals: StoredActual[]): StoredActual[] {
  return actuals.toSorted((left, right) =>
    `${left.workItemId}\u0000${left.stepId}`.localeCompare(
      `${right.workItemId}\u0000${right.stepId}`,
    ),
  );
}

/** Shared actual-store cases observed only through complete public reads. */
export function actualRegistrations(open: OpenCase<'actuals'>): readonly CaseRegistration[] {
  return [
    storeCase('actuals', 'actuals.listPlacements:source-order', open, async ({ port, seed }) => {
      const [firstId, secondId] = seed.workItemIds[0];
      const stepId = seed.stepIds[0][0];
      await port.set({ workItemId: secondId, stepId, days: 2, recordedAt: 1 }, seed.stamps[0]);
      await port.set({ workItemId: firstId, stepId, days: 1, recordedAt: 1 }, seed.stamps[0]);
      await port.set(
        { workItemId: seed.workItemIds[1][0], stepId: seed.stepIds[1][0], days: 3, recordedAt: 1 },
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
    storeCase('actuals', 'actuals.listByWorkItems:scope-order', open, async ({ port, seed }) => {
      const targetId = seed.workItemIds[0][0];
      const [firstStep, secondStep] = seed.stepIds[0];
      await port.set(
        { workItemId: targetId, stepId: secondStep, days: 2, recordedAt: 2 },
        seed.stamps[0],
      );
      await port.set(
        { workItemId: targetId, stepId: firstStep, days: 1, recordedAt: 1 },
        seed.stamps[0],
      );
      const foreignId = seed.workItemIds[1][0];
      await port.set(
        { workItemId: foreignId, stepId: seed.stepIds[1][0], days: 3, recordedAt: 3 },
        seed.stamps[1],
      );
      for (const [index, workItemId] of TARGETED_ORDER_WORK_ITEM_IDS.entries()) {
        await port.set(
          { workItemId, stepId: firstStep, days: index + 1, recordedAt: index + 1 },
          seed.stamps[0],
        );
      }
      const complete = await port.listByProject(seed.projectIds[0]);
      expect(
        (await port.listByWorkItems(seed.projectIds[0], [targetId])).map(({ stepId }) => stepId),
      ).toEqual([firstStep, secondStep]);
      const foreign = await port.listByWorkItems(seed.projectIds[0], [foreignId]);
      // Proof: validating ownership before project filtering made the memory
      // adapter throw for this valid project-B actual instead of returning [].
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
    storeCase('actuals', 'actuals.set:replace', open, async ({ port, readers, seed }) => {
      const [firstId, secondId] = seed.workItemIds[0];
      const [devId, qaId] = seed.stepIds[0];
      await port.set(
        { workItemId: firstId, stepId: devId, days: 2, recordedAt: 101 },
        seed.stamps[0],
      );
      await port.set(
        { workItemId: firstId, stepId: qaId, days: 3, recordedAt: 102 },
        seed.stamps[0],
      );
      await port.set(
        { workItemId: secondId, stepId: devId, days: 5, recordedAt: 103 },
        seed.stamps[0],
      );
      await port.set(
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          days: 8,
          recordedAt: 104,
        },
        seed.stamps[1],
      );

      expect(byKey(await readers.actuals.listByProject(seed.projectIds[0]))).toEqual([
        { workItemId: firstId, stepId: devId, days: 2, recordedAt: 101 },
        { workItemId: firstId, stepId: qaId, days: 3, recordedAt: 102 },
        { workItemId: secondId, stepId: devId, days: 5, recordedAt: 103 },
      ]);
      expect(byKey(await readers.actuals.listByProject(seed.projectIds[1]))).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          days: 8,
          recordedAt: 104,
        },
      ]);

      await port.set(
        { workItemId: firstId, stepId: devId, days: 13, recordedAt: 201 },
        seed.stamps[1],
      );

      expect(byKey(await readers.actuals.listByProject(seed.projectIds[0]))).toEqual([
        { workItemId: firstId, stepId: devId, days: 13, recordedAt: 201 },
        { workItemId: firstId, stepId: qaId, days: 3, recordedAt: 102 },
        { workItemId: secondId, stepId: devId, days: 5, recordedAt: 103 },
      ]);
      expect(byKey(await readers.actuals.listByProject(seed.projectIds[1]))).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          days: 8,
          recordedAt: 104,
        },
      ]);
    }),
    storeCase('actuals', 'actuals.remove:pair', open, async ({ port, readers, seed }) => {
      const [firstId, secondId] = seed.workItemIds[0];
      const [devId, qaId] = seed.stepIds[0];
      await port.set(
        { workItemId: firstId, stepId: devId, days: 2, recordedAt: 101 },
        seed.stamps[0],
      );
      await port.set(
        { workItemId: firstId, stepId: qaId, days: 3, recordedAt: 102 },
        seed.stamps[0],
      );
      await port.set(
        { workItemId: secondId, stepId: devId, days: 5, recordedAt: 103 },
        seed.stamps[0],
      );
      await port.set(
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          days: 8,
          recordedAt: 104,
        },
        seed.stamps[1],
      );

      expect(byKey(await readers.actuals.listByProject(seed.projectIds[0]))).toEqual([
        { workItemId: firstId, stepId: devId, days: 2, recordedAt: 101 },
        { workItemId: firstId, stepId: qaId, days: 3, recordedAt: 102 },
        { workItemId: secondId, stepId: devId, days: 5, recordedAt: 103 },
      ]);
      expect(byKey(await readers.actuals.listByProject(seed.projectIds[1]))).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          days: 8,
          recordedAt: 104,
        },
      ]);

      await port.remove(firstId, devId, seed.stamps[1]);

      expect(byKey(await readers.actuals.listByProject(seed.projectIds[0]))).toEqual([
        { workItemId: firstId, stepId: qaId, days: 3, recordedAt: 102 },
        { workItemId: secondId, stepId: devId, days: 5, recordedAt: 103 },
      ]);
      expect(byKey(await readers.actuals.listByProject(seed.projectIds[1]))).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          days: 8,
          recordedAt: 104,
        },
      ]);

      await port.remove(firstId, devId, seed.stamps[1]);

      expect(byKey(await readers.actuals.listByProject(seed.projectIds[0]))).toEqual([
        { workItemId: firstId, stepId: qaId, days: 3, recordedAt: 102 },
        { workItemId: secondId, stepId: devId, days: 5, recordedAt: 103 },
      ]);
      expect(byKey(await readers.actuals.listByProject(seed.projectIds[1]))).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          days: 8,
          recordedAt: 104,
        },
      ]);
    }),
    storeCase('actuals', 'actuals.moveAll:ownership', open, async ({ port, readers, seed }) => {
      const [sourceId, targetId] = seed.workItemIds[0];
      const [devId, qaId] = seed.stepIds[0];
      await port.set(
        { workItemId: sourceId, stepId: devId, days: 2, recordedAt: 101 },
        seed.stamps[0],
      );
      await port.set(
        { workItemId: sourceId, stepId: qaId, days: 3, recordedAt: 102 },
        seed.stamps[0],
      );
      await port.set(
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          days: 8,
          recordedAt: 104,
        },
        seed.stamps[1],
      );

      expect(byKey(await readers.actuals.listByProject(seed.projectIds[0]))).toEqual([
        { workItemId: sourceId, stepId: devId, days: 2, recordedAt: 101 },
        { workItemId: sourceId, stepId: qaId, days: 3, recordedAt: 102 },
      ]);
      expect(byKey(await readers.actuals.listByProject(seed.projectIds[1]))).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          days: 8,
          recordedAt: 104,
        },
      ]);

      await port.moveAll(sourceId, targetId, seed.stamps[1]);

      expect(byKey(await readers.actuals.listByProject(seed.projectIds[0]))).toEqual([
        { workItemId: targetId, stepId: devId, days: 2, recordedAt: 101 },
        { workItemId: targetId, stepId: qaId, days: 3, recordedAt: 102 },
      ]);
      expect(byKey(await readers.actuals.listByProject(seed.projectIds[1]))).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          days: 8,
          recordedAt: 104,
        },
      ]);
    }),
    storeCase('actuals', 'actuals.set:unknown_step', open, async ({ port, readers, seed }) => {
      await port.set(
        {
          workItemId: seed.workItemIds[0][1],
          stepId: seed.stepIds[0][1],
          days: 3,
          recordedAt: 102,
        },
        seed.stamps[0],
      );
      await port.set(
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          days: 8,
          recordedAt: 104,
        },
        seed.stamps[1],
      );

      expect(byKey(await readers.actuals.listByProject(seed.projectIds[0]))).toEqual([
        {
          workItemId: seed.workItemIds[0][1],
          stepId: seed.stepIds[0][1],
          days: 3,
          recordedAt: 102,
        },
      ]);
      expect(byKey(await readers.actuals.listByProject(seed.projectIds[1]))).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          days: 8,
          recordedAt: 104,
        },
      ]);

      const outcome = await port.set(
        {
          workItemId: seed.workItemIds[0][0],
          stepId: 'no-such-step',
          days: 13,
          recordedAt: 201,
        },
        seed.stamps[1],
      );
      const projectA = byKey(await readers.actuals.listByProject(seed.projectIds[0]));
      const projectB = byKey(await readers.actuals.listByProject(seed.projectIds[1]));

      expect({ outcome, projectA, projectB }).toEqual({
        outcome: 'unknown_step',
        projectA: [
          {
            workItemId: seed.workItemIds[0][1],
            stepId: seed.stepIds[0][1],
            days: 3,
            recordedAt: 102,
          },
        ],
        projectB: [
          {
            workItemId: seed.workItemIds[1][0],
            stepId: seed.stepIds[1][0],
            days: 8,
            recordedAt: 104,
          },
        ],
      });
    }),
  ];
}
