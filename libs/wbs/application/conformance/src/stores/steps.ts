import type { Step } from '@wbs/core';
import { expect } from 'bun:test';

import type { CaseRegistration } from '../case-manifest';
import { type OpenCase, storeCase } from './store-case';

/** The original shared step cases, retaining their stable case IDs. */
export function stepRegistrations(open: OpenCase<'steps'>): readonly CaseRegistration[] {
  return [
    storeCase('steps', 'steps.add', open, async ({ port, seed }) => {
      const projectId = seed.projectIds[0];
      const added = await port.add(
        { id: `${projectId}:step-added`, projectId, name: 'Wiring' },
        seed.stamps[0],
      );
      expect(added.ok).toBe(true);
      const names = (await port.listByProject(projectId)).map(({ name }) => name);
      // Proof: `reinjects the existing add, rename, estimate, remove, range, and prune faults`
      // ran `break:steps.add`; this failed on `Expected to contain: "Wiring" ·
      // Received: ["Dev", "QA", "faulted add"]`.
      expect(names).toContain('Wiring');
    }),
    storeCase('steps', 'steps.rename', open, async ({ port, seed }) => {
      const stepId = seed.stepIds[0][0];
      const renamed = await port.rename(stepId, 'Renamed', seed.stamps[0]);
      expect(renamed.ok).toBe(true);
      const found = (await port.listByProject(seed.projectIds[0])).find(
        (step: Step) => step.id === stepId,
      );
      // Proof: `reinjects the existing add, rename, estimate, remove, range, and prune faults`
      // ran `break:steps.rename`; this failed on `Expected: "Renamed" ·
      // Received: "faulted rename"`.
      expect(found?.name).toBe('Renamed');
    }),
    storeCase('steps', 'steps.rename:unknown', open, async ({ port, seed }) => {
      const renamed = await port.rename('no-such-step', 'Renamed', seed.stamps[0]);
      expect(renamed.ok).toBe(false);
    }),
  ];
}
