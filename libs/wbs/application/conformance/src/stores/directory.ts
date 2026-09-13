import type { Assignment, DirectoryStore, TeamWithServices } from '@wbs/core';
import { expect } from 'bun:test';

import type { CaseRegistration } from '../case-manifest';
import { type OpenCase, storeCase } from './store-case';

function byAssignment(assignments: Assignment[]): Assignment[] {
  return assignments.toSorted((left, right) =>
    [left.workItemId, left.stepId, left.personId]
      .join('\u0000')
      .localeCompare([right.workItemId, right.stepId, right.personId].join('\u0000')),
  );
}

function byPerson(people: { id: string; name: string }[]): { id: string; name: string }[] {
  return people.toSorted((left, right) => left.id.localeCompare(right.id));
}

function byTeam(teams: TeamWithServices[]): TeamWithServices[] {
  return teams
    .map((team) => ({ ...team, serviceIds: team.serviceIds.toSorted() }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

function assignment(workItemId: string, stepId: string, personId: string): Assignment {
  return { workItemId, stepId, personId };
}

async function assignmentState(
  directory: DirectoryStore,
  workItemIds: readonly [string, string, string],
  projectIds: readonly [string, string],
) {
  const [firstItemId, secondItemId, otherProjectItemId] = workItemIds;
  const [firstProjectId, otherProjectId] = projectIds;
  const [first, second, otherProject, selected, subset, firstProject, projectB] = await Promise.all(
    [
      directory.assignmentsFor(firstItemId),
      directory.assignmentsFor(secondItemId),
      directory.assignmentsFor(otherProjectItemId),
      directory.assignmentsOf(workItemIds),
      directory.assignmentsOf([firstItemId, secondItemId]),
      directory.assignmentsInProject(firstProjectId),
      directory.assignmentsInProject(otherProjectId),
    ],
  );
  return {
    forItems: [
      { workItemId: firstItemId, assignments: byAssignment(first) },
      { workItemId: secondItemId, assignments: byAssignment(second) },
      { workItemId: otherProjectItemId, assignments: byAssignment(otherProject) },
    ],
    ofItems: byAssignment(selected),
    ofSubset: byAssignment(subset),
    inProjects: [
      {
        projectId: firstProjectId,
        assignments: byAssignment(firstProject.assignments),
        people: byPerson(firstProject.people),
      },
      {
        projectId: otherProjectId,
        assignments: byAssignment(projectB.assignments),
        people: byPerson(projectB.people),
      },
    ],
  };
}

/** The original shared directory cases, retaining their stable case IDs. */
export function directoryRegistrations(open: OpenCase<'directory'>): readonly CaseRegistration[] {
  return [
    storeCase('directory', 'directory.addTag', open, async ({ port, seed }) => {
      await port.addTag({ id: 'tag-urgent', name: 'urgent' }, seed.stamps[0]);
      expect((await port.listTags()).map(({ name }) => name)).toContain('urgent');
    }),
    storeCase('directory', 'directory.assign:unknown_person', open, async ({ port, seed }) => {
      const workItemId = seed.workItemIds[0][0];
      const assigned = await port.assign(
        workItemId,
        seed.stepIds[0][0],
        'nobody-by-that-id',
        seed.stamps[0],
      );
      expect(assigned).toEqual({ ok: false, reason: 'unknown_person' });
      expect(await port.assignmentsFor(workItemId)).toEqual([]);
    }),
    storeCase('directory', 'directory.assign:scope-replace-clear', open, async ({ port, seed }) => {
      const [firstItemId, secondItemId] = seed.workItemIds[0];
      const otherProjectItemId = seed.workItemIds[1][0];
      const [firstStepId, secondStepId] = seed.stepIds[0];
      const otherProjectStepId = seed.stepIds[1][0];
      const [firstPersonId, secondPersonId] = seed.personIds;
      const sameItem = assignment(firstItemId, secondStepId, firstPersonId);
      const sameStep = assignment(secondItemId, firstStepId, firstPersonId);
      const otherProject = assignment(otherProjectItemId, otherProjectStepId, secondPersonId);
      const targetFor = (personId: string): Assignment =>
        assignment(firstItemId, firstStepId, personId);
      const expectedState = (personId: string | null) => {
        const projectA = [sameItem, sameStep];
        if (personId !== null) projectA.push(targetFor(personId));
        const firstItem = [sameItem];
        if (personId !== null) firstItem.push(targetFor(personId));
        return {
          forItems: [
            { workItemId: firstItemId, assignments: byAssignment(firstItem) },
            { workItemId: secondItemId, assignments: [sameStep] },
            { workItemId: otherProjectItemId, assignments: [otherProject] },
          ],
          ofItems: byAssignment([...projectA, otherProject]),
          // Proof: ignored-subset faults return the complete project-B row as
          // an extra record here while every seeded assignment remains stored.
          ofSubset: byAssignment(projectA),
          inProjects: [
            {
              projectId: seed.projectIds[0],
              assignments: byAssignment(projectA),
              people: byPerson([
                { id: firstPersonId, name: 'Person 1' },
                ...(personId === secondPersonId ? [{ id: secondPersonId, name: 'Person 2' }] : []),
              ]),
            },
            {
              projectId: seed.projectIds[1],
              assignments: [otherProject],
              people: [{ id: secondPersonId, name: 'Person 2' }],
            },
          ],
        };
      };

      expect(await port.assign(secondItemId, firstStepId, firstPersonId, seed.stamps[0])).toEqual({
        ok: true,
      });
      expect(await port.assign(firstItemId, secondStepId, firstPersonId, seed.stamps[0])).toEqual({
        ok: true,
      });
      expect(
        await port.assign(otherProjectItemId, otherProjectStepId, secondPersonId, seed.stamps[1]),
      ).toEqual({ ok: true });
      expect(await port.assign(firstItemId, firstStepId, firstPersonId, seed.stamps[0])).toEqual({
        ok: true,
      });
      expect(
        await assignmentState(
          port,
          [firstItemId, secondItemId, otherProjectItemId],
          seed.projectIds,
        ),
      ).toEqual(expectedState(firstPersonId));

      expect(await port.assign(firstItemId, firstStepId, secondPersonId, seed.stamps[1])).toEqual({
        ok: true,
      });
      // Proof: broad-replacement faults on both real sources remove the
      // complete same-step survivor from every public assignment view here.
      expect(
        await assignmentState(
          port,
          [firstItemId, secondItemId, otherProjectItemId],
          seed.projectIds,
        ),
      ).toEqual(expectedState(secondPersonId));

      expect(await port.assign(firstItemId, firstStepId, null, seed.stamps[1])).toEqual({
        ok: true,
      });
      expect(
        await assignmentState(
          port,
          [firstItemId, secondItemId, otherProjectItemId],
          seed.projectIds,
        ),
      ).toEqual(expectedState(null));
    }),
    storeCase('directory', 'directory.patchTeam:atomic-refusal', open, async ({ port, seed }) => {
      const [targetTeamId, otherTeamId] = seed.teamIds;
      const ownedServiceId = seed.serviceIds[0];
      const otherService = { id: 'directory-service-sentinel', name: 'Directory sentinel' };
      const originalTeams = byTeam([
        { id: targetTeamId, name: 'Directory original', serviceIds: [ownedServiceId] },
        { id: otherTeamId, name: 'Team 2', serviceIds: [otherService.id] },
      ]);
      await port.addService(structuredClone(otherService), seed.stamps[0]);
      expect(
        await port.patchTeam(
          targetTeamId,
          { name: 'Directory original', serviceIds: [ownedServiceId] },
          seed.stamps[0],
        ),
      ).toEqual({
        ok: true,
        team: originalTeams[0],
        projectIds: [],
      });
      expect(
        await port.patchTeam(otherTeamId, { serviceIds: [otherService.id] }, seed.stamps[0]),
      ).toEqual({
        ok: true,
        team: originalTeams[1],
        projectIds: [],
      });
      expect(byTeam(await port.listTeams())).toEqual(originalTeams);
      expect((await port.listServices()).toSorted((a, b) => a.id.localeCompare(b.id))).toEqual(
        [{ id: ownedServiceId, name: 'Service 1' }, otherService].toSorted((a, b) =>
          a.id.localeCompare(b.id),
        ),
      );

      expect(
        await port.patchTeam(
          targetTeamId,
          { name: 'Directory escaped', serviceIds: ['directory-unknown-service'] },
          seed.stamps[1],
        ),
      ).toEqual({ ok: false, reason: 'unknown_service' });
      // Proof: early-rename faults on both real sources retain the complete
      // owned set but expose Directory escaped as the received target name.
      expect(byTeam(await port.listTeams())).toEqual(originalTeams);
      expect((await port.listServices()).toSorted((a, b) => a.id.localeCompare(b.id))).toEqual(
        [{ id: ownedServiceId, name: 'Service 1' }, otherService].toSorted((a, b) =>
          a.id.localeCompare(b.id),
        ),
      );
    }),
  ];
}
