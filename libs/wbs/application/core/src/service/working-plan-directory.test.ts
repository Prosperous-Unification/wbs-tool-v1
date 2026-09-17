/* eslint-disable @typescript-eslint/require-await -- DirectoryStore doubles preserve its async contract while returning literal branch outcomes. */
import { openMemorySource } from '@wbs/store-memory';
import { describe, expect, it } from 'bun:test';

import type { DirectoryStore } from '../ports/directory-store';
import type { WriteStamp } from '../ports/write-stamp';
import { createWorkingPlanDirectory } from './working-plan-directory';

const STAMP: WriteStamp = { at: 1, by: 'directory-wrapper-owner' };

describe('working plan global directory barrier', () => {
  it('delegates every directory read on every call', async () => {
    const source = openMemorySource();
    const calls: string[] = [];
    try {
      const delegated: DirectoryStore = {
        ...source.stores.directory,
        listTags: async () => {
          calls.push('listTags');
          return [];
        },
        usageOfTag: async () => {
          calls.push('usageOfTag');
          return source.stores.directory.usageOfTag('tag');
        },
        listWorkItemTypes: async () => {
          calls.push('listWorkItemTypes');
          return [];
        },
        usageOfWorkItemType: async () => {
          calls.push('usageOfWorkItemType');
          return source.stores.directory.usageOfWorkItemType('type');
        },
        listExternalSystems: async () => {
          calls.push('listExternalSystems');
          return [];
        },
        listServices: async () => {
          calls.push('listServices');
          return [];
        },
        usageOfService: async () => {
          calls.push('usageOfService');
          return source.stores.directory.usageOfService('service');
        },
        listTeams: async () => {
          calls.push('listTeams');
          return [];
        },
        listPeople: async () => {
          calls.push('listPeople');
          return [];
        },
        usageOfPerson: async () => {
          calls.push('usageOfPerson');
          return source.stores.directory.usageOfPerson('person');
        },
        usageOfTeam: async () => {
          calls.push('usageOfTeam');
          return source.stores.directory.usageOfTeam('team');
        },
        assignmentsInProject: async () => {
          calls.push('assignmentsInProject');
          return { assignments: [], people: [] };
        },
        assignmentsFor: async () => {
          calls.push('assignmentsFor');
          return [];
        },
        assignmentsOf: async () => {
          calls.push('assignmentsOf');
          return [];
        },
      };
      const directory = createWorkingPlanDirectory(
        () => delegated,
        () => undefined,
        async () => undefined,
        async () => undefined,
      );

      await directory.listTags();
      await directory.usageOfTag('tag');
      await directory.listWorkItemTypes();
      await directory.usageOfWorkItemType('type');
      await directory.listExternalSystems();
      await directory.listServices();
      await directory.usageOfService('service');
      await directory.listTeams();
      await directory.listPeople();
      await directory.usageOfPerson('person');
      await directory.usageOfTeam('team');
      await directory.assignmentsInProject('project');
      await directory.assignmentsFor('row');
      await directory.assignmentsOf(['row']);
      await directory.listTags();

      expect(calls).toEqual([
        'listTags',
        'usageOfTag',
        'listWorkItemTypes',
        'usageOfWorkItemType',
        'listExternalSystems',
        'listServices',
        'usageOfService',
        'listTeams',
        'listPeople',
        'usageOfPerson',
        'usageOfTeam',
        'assignmentsInProject',
        'assignmentsFor',
        'assignmentsOf',
        'listTags',
      ]);
    } finally {
      await source.close();
    }
  });

  it('reloads after every successful global entry or membership mutation', async () => {
    const source = openMemorySource();
    let reloads = 0;
    try {
      const successful: DirectoryStore = {
        ...source.stores.directory,
        addTag: async (tag) => tag,
        renameTag: async (id, name) => ({ ok: true, tag: { id, name }, projectIds: [] }),
        removeTag: async () => ({ ok: true, removal: { workItemIds: [], projectIds: [] } }),
        addWorkItemType: async (workItemType) => workItemType,
        renameWorkItemType: async (id, name) => ({
          ok: true,
          workItemType: { id, name },
          projectIds: [],
        }),
        removeWorkItemType: async () => ({
          ok: true,
          removal: { workItemIds: [], projectIds: [] },
        }),
        addExternalSystem: async (system) => system,
        addService: async (service) => service,
        renameService: async (id, name) => ({
          ok: true,
          service: { id, name },
          projectIds: [],
        }),
        removeService: async () => ({ ok: true, removal: { workItemIds: [], projectIds: [] } }),
        addTeam: async (team) => team,
        patchTeam: async (id) => ({
          ok: true,
          team: { id, name: 'Patched team', serviceIds: [] },
          projectIds: [],
        }),
        addPerson: async (person) => ({
          ok: true,
          person: { ...person, kind: person.kind ?? 'person' },
        }),
        patchPerson: async (id) => ({
          ok: true,
          person: { id, name: 'Patched person', kind: 'person', teamIds: [] },
          projectIds: [],
        }),
        removePerson: async () => ({ ok: true, removal: { workItemIds: [], projectIds: [] } }),
        removeTeam: async () => ({ ok: true, removal: { workItemIds: [], projectIds: [] } }),
      };
      const directory = createWorkingPlanDirectory(
        () => successful,
        () => undefined,
        async () => {
          reloads += 1;
        },
        async () => undefined,
      );
      const writes = [
        () => directory.addTag({ id: 'tag', name: 'Tag' }, STAMP),
        () => directory.renameTag('tag', 'Renamed tag', STAMP),
        () => directory.removeTag('tag', true, STAMP),
        () => directory.addWorkItemType({ id: 'type', name: 'Type' }, STAMP),
        () => directory.renameWorkItemType('type', 'Renamed type', STAMP),
        () => directory.removeWorkItemType('type', true, STAMP),
        () => directory.addExternalSystem({ id: 'system', name: 'System' }, STAMP),
        () => directory.addService({ id: 'service', name: 'Service' }, STAMP),
        () => directory.renameService('service', 'Renamed service', STAMP),
        () => directory.removeService('service', true, STAMP),
        () => directory.addTeam({ id: 'team', name: 'Team' }, STAMP),
        () => directory.patchTeam('team', { serviceIds: [] }, STAMP),
        () => directory.addPerson({ id: 'person', name: 'Person' }, [], STAMP),
        () => directory.patchPerson('person', { teamIds: [] }, STAMP),
        () => directory.removePerson('person', true, STAMP),
        () => directory.removeTeam('team', true, STAMP),
      ];

      for (const [index, write] of writes.entries()) {
        await write();
        expect(reloads).toBe(index + 1);
      }
    } finally {
      await source.close();
    }
  });

  it('does not reload after any modeled global refusal or a thrown write', async () => {
    const source = openMemorySource();
    let reloads = 0;
    try {
      const refused: DirectoryStore = {
        ...source.stores.directory,
        renameTag: async () => ({ ok: false, reason: 'not_found' }),
        removeTag: async () => ({ ok: false, reason: 'not_found' }),
        renameWorkItemType: async () => ({ ok: false, reason: 'taken' }),
        removeWorkItemType: async () => ({ ok: false, reason: 'not_found' }),
        renameService: async () => ({ ok: false, reason: 'taken' }),
        removeService: async () => ({ ok: false, reason: 'not_found' }),
        patchTeam: async () => ({ ok: false, reason: 'unknown_service' }),
        addPerson: async () => ({ ok: false, reason: 'unknown_team' }),
        patchPerson: async () => ({ ok: false, reason: 'unknown_team' }),
        removePerson: async () => ({ ok: false, reason: 'not_found' }),
        removeTeam: async () => ({ ok: false, reason: 'not_found' }),
      };
      const directory = createWorkingPlanDirectory(
        () => refused,
        () => undefined,
        async () => {
          reloads += 1;
        },
        async () => undefined,
      );
      const writes = [
        () => directory.renameTag('tag', 'Tag', STAMP),
        () => directory.removeTag('tag', false, STAMP),
        () => directory.renameWorkItemType('type', 'Type', STAMP),
        () => directory.removeWorkItemType('type', false, STAMP),
        () => directory.renameService('service', 'Service', STAMP),
        () => directory.removeService('service', false, STAMP),
        () => directory.patchTeam('team', { serviceIds: ['missing'] }, STAMP),
        () => directory.addPerson({ id: 'person', name: 'Person' }, ['missing'], STAMP),
        () => directory.patchPerson('person', { teamIds: ['missing'] }, STAMP),
        () => directory.removePerson('person', false, STAMP),
        () => directory.removeTeam('team', false, STAMP),
      ];
      for (const write of writes) await write();
      expect(reloads).toBe(0);

      const throwing: DirectoryStore = {
        ...refused,
        removeTeam: async () => {
          throw new Error('injected directory write failure');
        },
      };
      const throwingDirectory = createWorkingPlanDirectory(
        () => throwing,
        () => undefined,
        async () => {
          reloads += 1;
        },
        async () => undefined,
      );
      expect(throwingDirectory.removeTeam('team', true, STAMP)).rejects.toThrow(
        'injected directory write failure',
      );
      expect(reloads).toBe(0);
    } finally {
      await source.close();
    }
  });
});

describe('working plan assignment boundary', () => {
  it('refreshes only the successful target and never uses the global barrier', async () => {
    const source = openMemorySource();
    let reloads = 0;
    const refreshed: string[][] = [];
    try {
      const directory = createWorkingPlanDirectory(
        () => ({ ...source.stores.directory, assign: async () => ({ ok: true }) }),
        () => undefined,
        async () => {
          reloads += 1;
        },
        async (ids) => {
          refreshed.push([...ids]);
        },
      );

      expect(await directory.assign('affected-row', 'step', 'person', STAMP)).toEqual({ ok: true });
      expect(refreshed).toEqual([['affected-row']]);
      expect(reloads).toBe(0);
    } finally {
      await source.close();
    }
  });

  it('does not advance after either assignment refusal or a thrown assignment', async () => {
    const source = openMemorySource();
    const refreshed: string[][] = [];
    try {
      let assignment: ReturnType<DirectoryStore['assign']> = Promise.resolve({
        ok: false,
        reason: 'unknown_person',
      });
      const directory = createWorkingPlanDirectory(
        () => ({ ...source.stores.directory, assign: () => assignment }),
        () => undefined,
        async () => undefined,
        async (ids) => {
          refreshed.push([...ids]);
        },
      );

      expect(await directory.assign('row', 'step', 'missing', STAMP)).toEqual({
        ok: false,
        reason: 'unknown_person',
      });
      assignment = Promise.resolve({ ok: false, reason: 'unknown_step' });
      expect(await directory.assign('row', 'missing-step', null, STAMP)).toEqual({
        ok: false,
        reason: 'unknown_step',
      });
      assignment = Promise.reject(new Error('injected assignment failure'));
      expect(directory.assign('row', 'step', null, STAMP)).rejects.toThrow(
        'injected assignment failure',
      );
      expect(refreshed).toEqual([]);
    } finally {
      await source.close();
    }
  });
});
