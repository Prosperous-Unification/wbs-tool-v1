import { expect } from 'bun:test';

import type { CaseRegistration } from '../case-manifest';
import { type OpenCase, storeCase } from './store-case';

/** The shared project/team-capacity cases for keyed writes, clearing and refusals. */
export function capacityRegistrations(open: OpenCase<'capacity'>): readonly CaseRegistration[] {
  return [
    storeCase(
      'capacity',
      'capacity.set:project-team-key',
      open,
      async ({ port, readers, seed }) => {
        const projectsBefore = structuredClone(
          await Promise.all(
            seed.projectIds.map((projectId) => readers.projects.findById(projectId)),
          ),
        );
        const teamsBefore = structuredClone(await readers.directory.listTeams());
        expect(projectsBefore.map((project) => project?.id)).toEqual([...seed.projectIds]);
        expect(teamsBefore.map(({ id }) => id).sort()).toEqual([...seed.teamIds]);

        expect(await port.set(seed.projectIds[0], seed.teamIds[0], 2, seed.stamps[0])).toEqual({
          ok: true,
        });
        expect(await port.set(seed.projectIds[1], seed.teamIds[0], 5, seed.stamps[1])).toEqual({
          ok: true,
        });
        expect(await port.set(seed.projectIds[0], seed.teamIds[1], 9, seed.stamps[0])).toEqual({
          ok: true,
        });

        const observed = {
          slotsA: await port.slotsFor(seed.projectIds[0]),
          listA: await port.listFor(seed.projectIds[0]),
          slotsB: await port.slotsFor(seed.projectIds[1]),
          listB: await port.listFor(seed.projectIds[1]),
        };
        // Proof: both source faults removed the project half of the key; the
        // complete observation failed with A's `team-a => 5` instead of 2 and B empty.
        expect(observed).toEqual({
          slotsA: new Map([
            [seed.teamIds[0], 2],
            [seed.teamIds[1], 9],
          ]),
          listA: [
            { serviceTeamId: seed.teamIds[0], size: 2 },
            { serviceTeamId: seed.teamIds[1], size: 9 },
          ],
          slotsB: new Map([[seed.teamIds[0], 5]]),
          listB: [{ serviceTeamId: seed.teamIds[0], size: 5 }],
        });
        expect(
          await Promise.all(
            seed.projectIds.map((projectId) => readers.projects.findById(projectId)),
          ),
        ).toEqual(projectsBefore);
        expect(await readers.directory.listTeams()).toEqual(teamsBefore);
      },
    ),
    storeCase('capacity', 'capacity.set:clear', open, async ({ port, readers, seed }) => {
      const projectsBefore = structuredClone(
        await Promise.all(seed.projectIds.map((projectId) => readers.projects.findById(projectId))),
      );
      const teamsBefore = structuredClone(await readers.directory.listTeams());
      expect(projectsBefore.map((project) => project?.id)).toEqual([...seed.projectIds]);
      expect(teamsBefore.map(({ id }) => id).sort()).toEqual([...seed.teamIds]);

      await port.set(seed.projectIds[0], seed.teamIds[0], 2, seed.stamps[0]);
      await port.set(seed.projectIds[0], seed.teamIds[1], 9, seed.stamps[0]);
      await port.set(seed.projectIds[1], seed.teamIds[0], 5, seed.stamps[1]);
      expect(await port.set(seed.projectIds[0], seed.teamIds[0], null, seed.stamps[1])).toEqual({
        ok: true,
      });

      const cleared = await port.slotsFor(seed.projectIds[0]);
      const observed = {
        hasClearedKey: cleared.has(seed.teamIds[0]),
        slotsA: cleared,
        listA: await port.listFor(seed.projectIds[0]),
        slotsB: await port.slotsFor(seed.projectIds[1]),
        listB: await port.listFor(seed.projectIds[1]),
      };
      // Proof: both source faults stored zero on the real write path; this
      // failed on `Expected: false · Received: true` for the cleared key.
      expect(observed).toEqual({
        hasClearedKey: false,
        slotsA: new Map([[seed.teamIds[1], 9]]),
        listA: [{ serviceTeamId: seed.teamIds[1], size: 9 }],
        slotsB: new Map([[seed.teamIds[0], 5]]),
        listB: [{ serviceTeamId: seed.teamIds[0], size: 5 }],
      });
      expect(
        await Promise.all(seed.projectIds.map((projectId) => readers.projects.findById(projectId))),
      ).toEqual(projectsBefore);
      expect(await readers.directory.listTeams()).toEqual(teamsBefore);
    }),
    storeCase(
      'capacity',
      'capacity.set:missing-reference',
      open,
      async ({ port, readers, seed }) => {
        const projectsBefore = structuredClone(
          await Promise.all(
            seed.projectIds.map((projectId) => readers.projects.findById(projectId)),
          ),
        );
        const teamsBefore = structuredClone(await readers.directory.listTeams());
        expect(projectsBefore.map((project) => project?.id)).toEqual([...seed.projectIds]);
        expect(teamsBefore.map(({ id }) => id).sort()).toEqual([...seed.teamIds]);

        const missingProject = await port.set(
          'project-missing',
          seed.teamIds[0],
          3,
          seed.stamps[0],
        );
        const missingTeam = await port.set(seed.projectIds[0], 'team-missing', 4, seed.stamps[0]);
        const observed = {
          missingProject,
          missingTeam,
          missingProjectRows: await port.listFor('project-missing'),
          projectA: await port.listFor(seed.projectIds[0]),
          projectB: await port.listFor(seed.projectIds[1]),
        };
        // Proof: SQLite's fault routed both requests to held references, returning
        // true and leaving project A's row; memory's bypass returned true and left
        // rows under both missing keys. The complete outcome/state object differed.
        expect(observed).toEqual({
          missingProject: { ok: false, reason: 'not_found' },
          missingTeam: { ok: false, reason: 'not_found' },
          missingProjectRows: [],
          projectA: [],
          projectB: [],
        });
        expect(
          await Promise.all(
            seed.projectIds.map((projectId) => readers.projects.findById(projectId)),
          ),
        ).toEqual(projectsBefore);
        expect(await readers.directory.listTeams()).toEqual(teamsBefore);
      },
    ),
  ];
}
