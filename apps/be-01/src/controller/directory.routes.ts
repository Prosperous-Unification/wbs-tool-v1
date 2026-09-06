import {
  listExternalSystems,
  listPeople,
  listServices,
  listTags,
  listTeams,
  listWorkItemTypes,
} from '@wbs/contracts';

import { bind } from '../http/endpoint';
import type { DirectoryService } from '../service/directory.service';

/**
 * Reads the global directory without project access restrictions. Identity and
 * structural admission belong to the mounted declarations; service failures
 * propagate so an unavailable directory cannot appear empty.
 * Proof: catching listTeams as [] returned200 instead of500 in the mounted
 * damaged-directory case. Removing the external-systems binding returned404
 * instead of401 in the mounted identity/query case (directory.controller.db.test.ts).
 */
export function directoryRoutes(directory: DirectoryService) {
  return [
    bind(listTeams, async () => ({
      ok: true,
      status: 200,
      body: { teams: await directory.listTeams() },
    })),
    bind(listPeople, async () => ({
      ok: true,
      status: 200,
      body: { people: await directory.listPeople() },
    })),
    bind(listTags, async () => ({
      ok: true,
      status: 200,
      body: { tags: await directory.listTags() },
    })),
    bind(listServices, async () => ({
      ok: true,
      status: 200,
      body: { services: await directory.listServices() },
    })),
    bind(listWorkItemTypes, async () => ({
      ok: true,
      status: 200,
      body: { workItemTypes: await directory.listWorkItemTypes() },
    })),
    bind(listExternalSystems, async () => ({
      ok: true,
      status: 200,
      body: { externalSystems: await directory.listExternalSystems() },
    })),
  ] as const;
}
