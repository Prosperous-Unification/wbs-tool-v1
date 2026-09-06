import { callerGuard } from '../http/caller';
import { ok, type Route } from '../http/route';
import type { AuthService } from '../service/auth.service';
import type { DirectoryService } from '../service/directory.service';

/**
 * Teams and people: global, readable and writable by any authenticated
 * account.
 *
 * Not gated by project write access, because the directory belongs to no
 * project — Dany, 2026-08-06: "the list is global for all projects, anyone can
 * add one". Gating it on a project would mean a reader who may not edit
 * project A could not name a team while working in project B.
 *
 * Adding is idempotent by name, so the picker's "type it if it is not in the
 * list" cannot make two `Platform`s.
 *
 * Every route here is a bare read behind {@link callerGuard} — the six of them
 * carried thirty lines of identical 401 block until 2026-09-02.
 */
export function directoryRoutes(auth: AuthService, directory: DirectoryService): Route[] {
  const guard = callerGuard(auth);
  const read = (path: string, body: () => Promise<unknown>): Route => ({
    method: 'GET',
    path: `/api${path}`,
    handler: guard('signed-in', async () => ok(await body())),
  });
  return [
    read('/teams', async () => ({ teams: await directory.listTeams() })),
    read('/people', async () => ({ people: await directory.listPeople() })),
    read('/tags', async () => ({ tags: await directory.listTags() })),
    read('/services', async () => ({ services: await directory.listServices() })),
    read('/work-item-types', async () => ({ workItemTypes: await directory.listWorkItemTypes() })),
    read('/external-systems', async () => ({
      externalSystems: await directory.listExternalSystems(),
    })),
  ];
}
