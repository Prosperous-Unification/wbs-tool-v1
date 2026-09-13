import { expect } from 'bun:test';

import type { CaseRegistration } from '../case-manifest';
import { type OpenCase, storeCase } from './store-case';

const DAYS = { optimistic: 1, realistic: 2, pessimistic: 3 } as const;

/** The original shared estimate cases, retaining their stable case IDs. */
export function estimateRegistrations(open: OpenCase<'estimates'>): readonly CaseRegistration[] {
  return [
    storeCase('estimates', 'estimates.set', open, async ({ port, seed }) => {
      const workItemId = seed.workItemIds[0][0];
      const stepId = seed.stepIds[0][0];
      expect(await port.set({ workItemId, stepId, ...DAYS }, seed.stamps[0])).toBe('written');
      const held = await port.listByProject(seed.projectIds[0]);
      expect(held.map((estimate) => estimate.workItemId)).toEqual([workItemId]);
      // Proof: `reinjects the existing add, rename, estimate, remove, range, and prune faults`
      // ran `break:estimates.set`; this failed on `Expected: 2 · Received: 3`.
      expect(held.at(0)?.realistic).toBe(2);
    }),
    storeCase('estimates', 'estimates.set:replace', open, async ({ port, seed }) => {
      const workItemId = seed.workItemIds[0][0];
      const stepId = seed.stepIds[0][0];
      await port.set({ workItemId, stepId, ...DAYS }, seed.stamps[0]);
      await port.set(
        { workItemId, stepId, optimistic: 5, realistic: 6, pessimistic: 7 },
        seed.stamps[1],
      );
      const held = await port.listByProject(seed.projectIds[0]);
      expect(held).toHaveLength(1);
      expect(held.at(0)?.realistic).toBe(6);
    }),
    storeCase('estimates', 'estimates.set:unknown_step', open, async ({ port, seed }) => {
      expect(
        await port.set(
          { workItemId: seed.workItemIds[0][0], stepId: 'no-such-step', ...DAYS },
          seed.stamps[0],
        ),
      ).toBe('unknown_step');
    }),
    storeCase('estimates', 'estimates.remove', open, async ({ port, seed }) => {
      const stepId = seed.stepIds[0][0];
      const kept = seed.workItemIds[0][0];
      const removed = seed.workItemIds[0][1];
      await port.set({ workItemId: kept, stepId, ...DAYS }, seed.stamps[0]);
      await port.set({ workItemId: removed, stepId, ...DAYS }, seed.stamps[0]);
      await port.remove(removed, stepId, seed.stamps[1]);
      const held = await port.listByProject(seed.projectIds[0]);
      // Proof: `reinjects the existing add, rename, estimate, remove, range, and prune faults`
      // ran `break:estimates.remove`; this failed with the received IDs containing
      // the extra `work-a-two`.
      expect(held.map((estimate) => estimate.workItemId)).toEqual([kept]);
    }),
    storeCase('estimates', 'estimates.moveAll:ownership', open, async ({ port, readers, seed }) => {
      const [sourceId, targetId] = seed.workItemIds[0];
      const [devId, qaId] = seed.stepIds[0];
      await port.set(
        { workItemId: sourceId, stepId: devId, optimistic: 1, realistic: 2, pessimistic: 4 },
        seed.stamps[0],
      );
      await port.set(
        { workItemId: sourceId, stepId: qaId, optimistic: 3, realistic: 5, pessimistic: 8 },
        seed.stamps[0],
      );
      await port.set(
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          optimistic: 13,
          realistic: 21,
          pessimistic: 34,
        },
        seed.stamps[1],
      );

      expect(await readers.estimates.listByProject(seed.projectIds[0])).toEqual([
        { workItemId: sourceId, stepId: devId, optimistic: 1, realistic: 2, pessimistic: 4 },
        { workItemId: sourceId, stepId: qaId, optimistic: 3, realistic: 5, pessimistic: 8 },
      ]);
      expect(await readers.estimates.listByProject(seed.projectIds[1])).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          optimistic: 13,
          realistic: 21,
          pessimistic: 34,
        },
      ]);

      await port.moveAll(sourceId, targetId, seed.stamps[1]);

      expect(await readers.estimates.listByProject(seed.projectIds[0])).toEqual([
        { workItemId: targetId, stepId: devId, optimistic: 1, realistic: 2, pessimistic: 4 },
        { workItemId: targetId, stepId: qaId, optimistic: 3, realistic: 5, pessimistic: 8 },
      ]);
      expect(await readers.estimates.listByProject(seed.projectIds[1])).toEqual([
        {
          workItemId: seed.workItemIds[1][0],
          stepId: seed.stepIds[1][0],
          optimistic: 13,
          realistic: 21,
          pessimistic: 34,
        },
      ]);
    }),
  ];
}
