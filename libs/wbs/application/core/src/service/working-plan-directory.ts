import type { DirectoryStore } from '../ports/directory-store';

/**
 * Builds the directory part of a batch-owned working plan.
 *
 * Reads stay delegated because the directory is global rather than owned by
 * one project. A successful global entry or membership write reloads every
 * collection this working plan has already retained; a modeled refusal reloads
 * nothing. Assignment is the exception: it belongs to one work item, so only
 * that identity refreshes and the global full-reader barrier is not crossed.
 * Source and refresh failures escape so the admitted unit of work rolls back.
 */
export function createWorkingPlanDirectory(
  source: () => DirectoryStore,
  assertOpen: () => void,
  reloadPlan: () => Promise<void>,
  refreshRows: (ids: readonly string[]) => Promise<void>,
): DirectoryStore {
  const afterWrite =
    <Arguments extends readonly unknown[], Value>(
      write: (...parameters: Arguments) => Promise<Value>,
      succeeded: (written: Value) => boolean,
    ): ((...parameters: Arguments) => Promise<Value>) =>
    async (...parameters) => {
      assertOpen();
      const written = await write(...parameters);
      if (succeeded(written)) await reloadPlan();
      return written;
    };
  const always = (): boolean => true;
  const ok = (written: { ok: boolean }): boolean => written.ok;

  return {
    listTags: () => source().listTags(),
    addTag: afterWrite((...parameters) => source().addTag(...parameters), always),
    renameTag: afterWrite((...parameters) => source().renameTag(...parameters), ok),
    usageOfTag: (tagId) => source().usageOfTag(tagId),
    removeTag: afterWrite((...parameters) => source().removeTag(...parameters), ok),
    listWorkItemTypes: () => source().listWorkItemTypes(),
    addWorkItemType: afterWrite((...parameters) => source().addWorkItemType(...parameters), always),
    renameWorkItemType: afterWrite(
      (...parameters) => source().renameWorkItemType(...parameters),
      ok,
    ),
    usageOfWorkItemType: (typeId) => source().usageOfWorkItemType(typeId),
    removeWorkItemType: afterWrite(
      (...parameters) => source().removeWorkItemType(...parameters),
      ok,
    ),
    listExternalSystems: () => source().listExternalSystems(),
    addExternalSystem: afterWrite(
      (...parameters) => source().addExternalSystem(...parameters),
      always,
    ),
    listServices: () => source().listServices(),
    addService: afterWrite((...parameters) => source().addService(...parameters), always),
    renameService: afterWrite((...parameters) => source().renameService(...parameters), ok),
    usageOfService: (serviceId) => source().usageOfService(serviceId),
    removeService: afterWrite((...parameters) => source().removeService(...parameters), ok),
    listTeams: () => source().listTeams(),
    addTeam: afterWrite((...parameters) => source().addTeam(...parameters), always),
    patchTeam: afterWrite((...parameters) => source().patchTeam(...parameters), ok),
    listPeople: () => source().listPeople(),
    addPerson: afterWrite((...parameters) => source().addPerson(...parameters), ok),
    patchPerson: afterWrite((...parameters) => source().patchPerson(...parameters), ok),
    usageOfPerson: (personId) => source().usageOfPerson(personId),
    usageOfTeam: (teamId) => source().usageOfTeam(teamId),
    removePerson: afterWrite((...parameters) => source().removePerson(...parameters), ok),
    removeTeam: afterWrite((...parameters) => source().removeTeam(...parameters), ok),
    assignmentsInProject: (projectId) => source().assignmentsInProject(projectId),
    assignmentsFor: (workItemId) => source().assignmentsFor(workItemId),
    assignmentsOf: (workItemIds) => source().assignmentsOf(workItemIds),
    assign: async (...parameters) => {
      assertOpen();
      const written = await source().assign(...parameters);
      if (written.ok) await refreshRows([parameters[0]]);
      return written;
    },
  };
}
