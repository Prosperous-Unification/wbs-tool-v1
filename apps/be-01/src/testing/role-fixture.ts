import type { ProjectStore, Role, RoleRemoved, RoleStore, RoleUsageRows } from '../repository';
import { ROLE_POSITION_STEP } from '../repository';
import { RoleService } from '../service/role.service';
import { recordingBroadcaster } from './broadcast-fixture';
import { inMemoryProjects } from './project-fixture';

/**
 * A RoleStore backed by an array, for tests that only need `buildApp` to be
 * constructible.
 *
 * It keeps the one rule a caller branches on — a name a project already holds
 * is refused — because a fixture laxer than production lets a test pass against
 * behaviour that does not exist.
 *
 * **What it deliberately does not model** is everything the removal is: the
 * revisions, and the fact that the deletes and the bumps are one transaction.
 * An array has no statement to put them in, so claiming them here would be a
 * second implementation of the rule under test. `remove` therefore reports what
 * it took and nothing else, and every behavioural claim about a removal is
 * asserted against real SQLite in `repository/role.test.ts` and
 * `service/role.service.test.ts` — the same call `subtree-fixture.ts` makes,
 * for the same reason.
 */
export function inMemoryRoles(seed: readonly Role[] = []): RoleStore & {
  readonly rows: Role[];
} {
  const rows: Role[] = [...seed];
  return {
    rows,
    listByProject(projectId) {
      // Sorted, because production is: without the `ORDER BY` SQLite answers
      // this from the name index, and a fixture that happened to return
      // insertion order would let a test pass against an order production does
      // not produce.
      return Promise.resolve(
        rows
          .filter((each) => each.projectId === projectId)
          .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1)),
      );
    },
    findById(roleId) {
      return Promise.resolve(rows.find((each) => each.id === roleId) ?? null);
    },
    add(toAdd) {
      const held = rows.filter((each) => each.projectId === toAdd.projectId);
      if (held.some((each) => each.name === toAdd.name)) {
        return Promise.resolve({ ok: false, reason: 'taken' });
      }
      const written: Role = {
        ...toAdd,
        position: Math.max(0, ...held.map((each) => each.position)) + ROLE_POSITION_STEP,
      };
      rows.push(written);
      return Promise.resolve({ ok: true, role: written });
    },
    rename(roleId, name) {
      const found = rows.find((each) => each.id === roleId);
      if (found === undefined) return Promise.resolve({ ok: false, reason: 'not_found' });
      const taken = rows.some(
        (each) => each.projectId === found.projectId && each.name === name && each.id !== roleId,
      );
      if (taken) return Promise.resolve({ ok: false, reason: 'taken' });
      found.name = name;
      return Promise.resolve({ ok: true, role: found });
    },
    usageOf(): Promise<RoleUsageRows> {
      // Nothing points at a role here: this fixture holds no estimates, no
      // actuals, no stated progress, no figures and no assignments to point
      // with.
      return Promise.resolve({
        estimates: 0,
        actuals: 0,
        progress: 0,
        measures: 0,
        assignments: [],
      });
    },
    remove(projectId, roleId): Promise<RoleRemoved> {
      const found = rows.findIndex((each) => each.id === roleId && each.projectId === projectId);
      // The one thing this can model of the real removal: a role that is not
      // this project's, or is already gone, is `not_found` and writes nothing.
      // The refusal-when-used branch is unreachable here because nothing can
      // point at a role in an array with no estimates in it.
      if (found < 0) return Promise.resolve({ ok: false, reason: 'not_found' });
      rows.splice(found, 1);
      return Promise.resolve({
        ok: true,
        removal: {
          estimates: 0,
          actuals: 0,
          progress: 0,
          measures: 0,
          assignments: 0,
          workItemIds: [],
        },
      });
    },
  };
}

/** A RoleService over the in-memory stores, for tests that only need `buildApp` to construct. */
export function testRoleService(
  projects: ProjectStore = inMemoryProjects(),
  roles: RoleStore = inMemoryRoles(),
): RoleService {
  return new RoleService({ projects, roles, broadcast: recordingBroadcaster() });
}
