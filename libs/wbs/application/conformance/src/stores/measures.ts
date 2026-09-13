import type { StoredMeasure } from '@wbs/core';
import { expect } from 'bun:test';

import type { CaseRegistration } from '../case-manifest';
import { type OpenCase, storeCase } from './store-case';

function byKey(measures: StoredMeasure[]): StoredMeasure[] {
  return measures.toSorted((left, right) =>
    `${left.workItemId}\u0000${left.stepId}\u0000${left.metric}`.localeCompare(
      `${right.workItemId}\u0000${right.stepId}\u0000${right.metric}`,
    ),
  );
}

/** Shared measure-store cases observed only through complete public reads. */
export function measureRegistrations(open: OpenCase<'measures'>): readonly CaseRegistration[] {
  return [
    storeCase('measures', 'measures.set:metric-key', open, async ({ port, readers, seed }) => {
      const [firstId, secondId] = seed.workItemIds[0];
      const [devId, qaId] = seed.stepIds[0];
      await port.set(
        {
          workItemId: firstId,
          stepId: devId,
          metric: 'token_estimate',
          value: 10,
          recordedAt: 101,
        },
        seed.stamps[0],
      );
      await port.set(
        { workItemId: firstId, stepId: devId, metric: 'token_actual', value: 11, recordedAt: 102 },
        seed.stamps[0],
      );
      await port.set(
        { workItemId: firstId, stepId: devId, metric: 'hours_actual', value: 12, recordedAt: 103 },
        seed.stamps[0],
      );
      await port.set(
        { workItemId: firstId, stepId: qaId, metric: 'token_actual', value: 13, recordedAt: 104 },
        seed.stamps[0],
      );
      await port.set(
        { workItemId: secondId, stepId: devId, metric: 'token_actual', value: 14, recordedAt: 105 },
        seed.stamps[0],
      );
      await port.set(
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          metric: 'token_actual',
          value: 15,
          recordedAt: 106,
        },
        seed.stamps[1],
      );

      expect(byKey(await readers.measures.listByProject(seed.projectIds[0]))).toEqual([
        { workItemId: firstId, stepId: devId, metric: 'hours_actual', value: 12, recordedAt: 103 },
        { workItemId: firstId, stepId: devId, metric: 'token_actual', value: 11, recordedAt: 102 },
        {
          workItemId: firstId,
          stepId: devId,
          metric: 'token_estimate',
          value: 10,
          recordedAt: 101,
        },
        { workItemId: firstId, stepId: qaId, metric: 'token_actual', value: 13, recordedAt: 104 },
        { workItemId: secondId, stepId: devId, metric: 'token_actual', value: 14, recordedAt: 105 },
      ]);
      expect(byKey(await readers.measures.listByProject(seed.projectIds[1]))).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          metric: 'token_actual',
          value: 15,
          recordedAt: 106,
        },
      ]);

      await port.set(
        { workItemId: firstId, stepId: devId, metric: 'token_actual', value: 21, recordedAt: 201 },
        seed.stamps[1],
      );

      expect(byKey(await readers.measures.listByProject(seed.projectIds[0]))).toEqual([
        { workItemId: firstId, stepId: devId, metric: 'hours_actual', value: 12, recordedAt: 103 },
        { workItemId: firstId, stepId: devId, metric: 'token_actual', value: 21, recordedAt: 201 },
        {
          workItemId: firstId,
          stepId: devId,
          metric: 'token_estimate',
          value: 10,
          recordedAt: 101,
        },
        { workItemId: firstId, stepId: qaId, metric: 'token_actual', value: 13, recordedAt: 104 },
        { workItemId: secondId, stepId: devId, metric: 'token_actual', value: 14, recordedAt: 105 },
      ]);
      expect(byKey(await readers.measures.listByProject(seed.projectIds[1]))).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          metric: 'token_actual',
          value: 15,
          recordedAt: 106,
        },
      ]);
    }),
    storeCase('measures', 'measures.remove:metric-key', open, async ({ port, readers, seed }) => {
      const [firstId, secondId] = seed.workItemIds[0];
      const [devId, qaId] = seed.stepIds[0];
      const seeded: StoredMeasure[] = [
        { workItemId: firstId, stepId: devId, metric: 'hours_actual', value: 12, recordedAt: 103 },
        { workItemId: firstId, stepId: devId, metric: 'token_actual', value: 11, recordedAt: 102 },
        {
          workItemId: firstId,
          stepId: devId,
          metric: 'token_estimate',
          value: 10,
          recordedAt: 101,
        },
        { workItemId: firstId, stepId: qaId, metric: 'token_actual', value: 13, recordedAt: 104 },
        { workItemId: secondId, stepId: devId, metric: 'token_actual', value: 14, recordedAt: 105 },
      ];
      for (const measure of seeded) await port.set(measure, seed.stamps[0]);
      await port.set(
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          metric: 'token_actual',
          value: 15,
          recordedAt: 106,
        },
        seed.stamps[1],
      );

      expect(byKey(await readers.measures.listByProject(seed.projectIds[0]))).toEqual([
        { workItemId: firstId, stepId: devId, metric: 'hours_actual', value: 12, recordedAt: 103 },
        { workItemId: firstId, stepId: devId, metric: 'token_actual', value: 11, recordedAt: 102 },
        {
          workItemId: firstId,
          stepId: devId,
          metric: 'token_estimate',
          value: 10,
          recordedAt: 101,
        },
        { workItemId: firstId, stepId: qaId, metric: 'token_actual', value: 13, recordedAt: 104 },
        { workItemId: secondId, stepId: devId, metric: 'token_actual', value: 14, recordedAt: 105 },
      ]);
      expect(byKey(await readers.measures.listByProject(seed.projectIds[1]))).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          metric: 'token_actual',
          value: 15,
          recordedAt: 106,
        },
      ]);

      await port.remove(firstId, devId, 'token_actual', seed.stamps[1]);
      expect(byKey(await readers.measures.listByProject(seed.projectIds[0]))).toEqual([
        { workItemId: firstId, stepId: devId, metric: 'hours_actual', value: 12, recordedAt: 103 },
        {
          workItemId: firstId,
          stepId: devId,
          metric: 'token_estimate',
          value: 10,
          recordedAt: 101,
        },
        { workItemId: firstId, stepId: qaId, metric: 'token_actual', value: 13, recordedAt: 104 },
        { workItemId: secondId, stepId: devId, metric: 'token_actual', value: 14, recordedAt: 105 },
      ]);
      expect(byKey(await readers.measures.listByProject(seed.projectIds[1]))).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          metric: 'token_actual',
          value: 15,
          recordedAt: 106,
        },
      ]);

      await port.remove(firstId, devId, 'token_actual', seed.stamps[1]);
      expect(byKey(await readers.measures.listByProject(seed.projectIds[0]))).toEqual([
        { workItemId: firstId, stepId: devId, metric: 'hours_actual', value: 12, recordedAt: 103 },
        {
          workItemId: firstId,
          stepId: devId,
          metric: 'token_estimate',
          value: 10,
          recordedAt: 101,
        },
        { workItemId: firstId, stepId: qaId, metric: 'token_actual', value: 13, recordedAt: 104 },
        { workItemId: secondId, stepId: devId, metric: 'token_actual', value: 14, recordedAt: 105 },
      ]);
      expect(byKey(await readers.measures.listByProject(seed.projectIds[1]))).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          metric: 'token_actual',
          value: 15,
          recordedAt: 106,
        },
      ]);
    }),
    storeCase('measures', 'measures.moveAll:all-metrics', open, async ({ port, readers, seed }) => {
      const [sourceId, targetId] = seed.workItemIds[0];
      const [devId, qaId] = seed.stepIds[0];
      const sourceRows: StoredMeasure[] = [
        { workItemId: sourceId, stepId: devId, metric: 'hours_actual', value: 12, recordedAt: 103 },
        { workItemId: sourceId, stepId: devId, metric: 'token_actual', value: 11, recordedAt: 102 },
        {
          workItemId: sourceId,
          stepId: devId,
          metric: 'token_estimate',
          value: 10,
          recordedAt: 101,
        },
        {
          workItemId: sourceId,
          stepId: qaId,
          metric: 'token_estimate',
          value: 13,
          recordedAt: 104,
        },
      ];
      for (const measure of sourceRows) await port.set(measure, seed.stamps[0]);
      await port.set(
        { workItemId: targetId, stepId: qaId, metric: 'hours_actual', value: 14, recordedAt: 105 },
        seed.stamps[0],
      );
      await port.set(
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          metric: 'token_actual',
          value: 15,
          recordedAt: 106,
        },
        seed.stamps[1],
      );

      expect(byKey(await readers.measures.listByProject(seed.projectIds[0]))).toEqual([
        { workItemId: sourceId, stepId: devId, metric: 'hours_actual', value: 12, recordedAt: 103 },
        { workItemId: sourceId, stepId: devId, metric: 'token_actual', value: 11, recordedAt: 102 },
        {
          workItemId: sourceId,
          stepId: devId,
          metric: 'token_estimate',
          value: 10,
          recordedAt: 101,
        },
        {
          workItemId: sourceId,
          stepId: qaId,
          metric: 'token_estimate',
          value: 13,
          recordedAt: 104,
        },
        { workItemId: targetId, stepId: qaId, metric: 'hours_actual', value: 14, recordedAt: 105 },
      ]);
      expect(byKey(await readers.measures.listByProject(seed.projectIds[1]))).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          metric: 'token_actual',
          value: 15,
          recordedAt: 106,
        },
      ]);

      await port.moveAll(sourceId, targetId, seed.stamps[1]);

      expect(byKey(await readers.measures.listByProject(seed.projectIds[0]))).toEqual([
        { workItemId: targetId, stepId: devId, metric: 'hours_actual', value: 12, recordedAt: 103 },
        { workItemId: targetId, stepId: devId, metric: 'token_actual', value: 11, recordedAt: 102 },
        {
          workItemId: targetId,
          stepId: devId,
          metric: 'token_estimate',
          value: 10,
          recordedAt: 101,
        },
        { workItemId: targetId, stepId: qaId, metric: 'hours_actual', value: 14, recordedAt: 105 },
        {
          workItemId: targetId,
          stepId: qaId,
          metric: 'token_estimate',
          value: 13,
          recordedAt: 104,
        },
      ]);
      expect(byKey(await readers.measures.listByProject(seed.projectIds[1]))).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          metric: 'token_actual',
          value: 15,
          recordedAt: 106,
        },
      ]);
    }),
    storeCase('measures', 'measures.set:unknown_step', open, async ({ port, readers, seed }) => {
      await port.set(
        {
          workItemId: seed.workItemIds[0][1],
          stepId: seed.stepIds[0][1],
          metric: 'hours_actual',
          value: 14,
          recordedAt: 105,
        },
        seed.stamps[0],
      );
      await port.set(
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          metric: 'token_actual',
          value: 15,
          recordedAt: 106,
        },
        seed.stamps[1],
      );

      expect(byKey(await readers.measures.listByProject(seed.projectIds[0]))).toEqual([
        {
          workItemId: seed.workItemIds[0][1],
          stepId: seed.stepIds[0][1],
          metric: 'hours_actual',
          value: 14,
          recordedAt: 105,
        },
      ]);
      expect(byKey(await readers.measures.listByProject(seed.projectIds[1]))).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          metric: 'token_actual',
          value: 15,
          recordedAt: 106,
        },
      ]);

      const outcome = await port.set(
        {
          workItemId: seed.workItemIds[0][0],
          stepId: 'no-such-step',
          metric: 'token_estimate',
          value: 21,
          recordedAt: 201,
        },
        seed.stamps[1],
      );
      const projectA = byKey(await readers.measures.listByProject(seed.projectIds[0]));
      const projectB = byKey(await readers.measures.listByProject(seed.projectIds[1]));

      expect({ outcome, projectA, projectB }).toEqual({
        outcome: 'unknown_step',
        projectA: [
          {
            workItemId: seed.workItemIds[0][1],
            stepId: seed.stepIds[0][1],
            metric: 'hours_actual',
            value: 14,
            recordedAt: 105,
          },
        ],
        projectB: [
          {
            workItemId: seed.workItemIds[1][0],
            stepId: seed.stepIds[1][0],
            metric: 'token_actual',
            value: 15,
            recordedAt: 106,
          },
        ],
      });
    }),
  ];
}
