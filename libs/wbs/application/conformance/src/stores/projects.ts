import type { Project, Step } from '@wbs/core';
import { expect } from 'bun:test';

import type { CaseRegistration } from '../case-manifest';
import { type OpenCase, storeCase } from './store-case';

/** The shared project-store cases, scoped to creation, updates and access order. */
export function projectRegistrations(open: OpenCase<'projects'>): readonly CaseRegistration[] {
  return [
    storeCase('projects', 'projects.create:steps', open, async ({ port, readers, seed }) => {
      const project = {
        id: 'project-created',
        name: 'Created project',
        ownerId: seed.ownerIds[0],
        restricted: true,
        estimateMethod: 'realistic',
        depReach: 'anchor-slice',
        pertWeights: { optimistic: 2, realistic: 3, pessimistic: 4 },
        estimateRounding: 'round',
        startDate: '2026-09-12',
        solutionRef: { slug: 'created-project', url: 'https://example.test/created-project' },
        revision: 0,
        createdAt: 300,
        optimizationEnabled: true,
        scheduleEngine: 'optimized',
        scheduleObjective: 'time',
      } satisfies Project;
      const steps: Step[] = [
        { id: 'project-created-dev', projectId: project.id, name: 'Build', position: 10 },
        { id: 'project-created-qa', projectId: project.id, name: 'Verify', position: 20 },
      ];

      expect(await port.create(project, steps, { at: 300, by: seed.ownerIds[0] })).toEqual(project);
      expect(await readers.projects.findById(project.id)).toEqual(project);
      // Proof: `reinjects project step, scope, and reader-order faults` omitted
      // the starting-step write; this failed with the expected two steps and
      // `Received: []`.
      expect(await readers.projects.stepsOf(project.id)).toEqual(steps);
    }),
    storeCase('projects', 'projects.update:scope', open, async ({ port, readers, seed }) => {
      const [projectA, projectB] = await Promise.all(
        seed.projectIds.map((projectId) => readers.projects.findById(projectId)),
      );
      expect(projectA).toMatchObject({ id: seed.projectIds[0], name: 'Project 1' });
      expect(projectB).toMatchObject({ id: seed.projectIds[1], name: 'Project 2' });

      expect(
        await port.update(
          seed.projectIds[0],
          { name: 'Renamed project' },
          { at: 300, by: seed.ownerIds[0] },
        ),
      ).toMatchObject({ id: seed.projectIds[0], name: 'Renamed project' });
      expect(
        await port.update(
          'project-missing',
          { name: 'Missing project' },
          { at: 301, by: seed.ownerIds[0] },
        ),
      ).toBeNull();

      expect(await readers.projects.findById(seed.projectIds[0])).toMatchObject({
        id: seed.projectIds[0],
        name: 'Renamed project',
      });
      // Proof: the same source fault broadened the update predicate; this
      // failed on `Expected: "Project 2"; Received: "Renamed project"`.
      expect(await readers.projects.findById(seed.projectIds[1])).toEqual(projectB);
    }),
    storeCase('projects', 'projects.recordOpen:reader-order', open, async ({ port, seed }) => {
      await port.recordOpen(seed.projectIds[0], { at: 100, by: seed.ownerIds[0] });
      await port.recordOpen(seed.projectIds[1], { at: 200, by: seed.ownerIds[0] });
      await port.recordOpen(seed.projectIds[0], { at: 200, by: seed.ownerIds[1] });

      const ownerA = await port.listFor(seed.ownerIds[0]);
      const ownerB = await port.listFor(seed.ownerIds[1]);
      expect(ownerA.map(({ name }) => name)).toEqual(['Project 2', 'Project 1']);
      expect(ownerA.map(({ lastOpenedAt }) => lastOpenedAt)).toEqual([200, 100]);
      // Proof: the same source fault ignored the access user; this failed
      // with expected `Project 1, Project 2` and received
      // `Project 2, Project 1`.
      expect(ownerB.map(({ name }) => name)).toEqual(['Project 1', 'Project 2']);
      expect(ownerB.map(({ lastOpenedAt }) => lastOpenedAt)).toEqual([200, null]);
    }),
  ];
}
