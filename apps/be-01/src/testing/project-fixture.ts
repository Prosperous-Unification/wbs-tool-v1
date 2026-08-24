import type { Project, ProjectStore, ProjectWithAccess, Role, UserStore } from '../repository';
import { ProjectService } from '../service/project.service';
import { inMemoryUsers } from './auth-fixture';

/**
 * A ProjectStore backed by Maps, for controller and service tests that do not
 * need SQLite.
 *
 * It keeps the guarantees the real schema enforces, because a fixture that is
 * laxer than production lets a test pass against behaviour that does not exist:
 * role names are unique within a project, `list` returns newest first, and
 * `update` refuses an id it does not hold rather than inventing a row.
 *
 * `owners` is the store the listing resolves each project's owner name through,
 * and it has to be **the same one the test registers its accounts in** — pass
 * `inMemoryUsers()`'s value to both this and `testAuthService`. Left to its own
 * empty default, `listFor` throws on the first project it lists, which is
 * production's behaviour for an owner id naming no account and not an accident
 * to work around.
 */
export function inMemoryProjects(owners: UserStore = inMemoryUsers()): ProjectStore {
  const projects = new Map<string, Project>();
  const roles = new Map<string, Role[]>();
  /** One moment per `userId::projectId`, exactly as the primary key holds it. */
  const opened = new Map<string, number>();

  return {
    create(project, starting) {
      const names = new Set(starting.map((r) => r.name));
      if (names.size !== starting.length) {
        return Promise.reject(new Error(`duplicate role name in ${project.id}`));
      }
      projects.set(project.id, project);
      roles.set(project.id, [...starting]);
      return Promise.resolve(project);
    },
    findById(id) {
      return Promise.resolve(projects.get(id) ?? null);
    },
    findBySolutionSlug(slug) {
      for (const project of projects.values()) {
        if (project.solutionRef?.slug === slug) return Promise.resolve(project);
      }
      return Promise.resolve(null);
    },
    list() {
      return Promise.resolve([...projects.values()].sort((a, b) => b.createdAt - a.createdAt));
    },
    async listFor(userId) {
      // Sorted the way SQLite's `ORDER BY last_opened_at DESC, created_at DESC`
      // sorts, NULLs last. A fixture ordering it any other way would let a
      // component pass against an order production does not produce.
      const withAccess: ProjectWithAccess[] = [];
      for (const project of projects.values()) {
        const owner = await owners.findById(project.ownerId);
        // The same refusal the query's LEFT JOIN produces, for the same reason:
        // a fixture that answered a blank owner here would let the controller's
        // shape test pass against a list production throws on.
        if (owner === null) {
          throw new Error(`project "${project.name}" has an owner id naming no account`);
        }
        withAccess.push({
          ...project,
          lastOpenedAt: opened.get(`${userId}::${project.id}`) ?? null,
          ownerName: owner.username,
        });
      }
      return withAccess.sort((a, b) => {
        if (a.lastOpenedAt !== b.lastOpenedAt) {
          if (a.lastOpenedAt === null) return 1;
          if (b.lastOpenedAt === null) return -1;
          return b.lastOpenedAt - a.lastOpenedAt;
        }
        return b.createdAt - a.createdAt;
      });
    },
    recordOpen(userId, projectId, at) {
      opened.set(`${userId}::${projectId}`, at);
      return Promise.resolve();
    },
    update(id, patch) {
      const existing = projects.get(id);
      if (existing === undefined) return Promise.resolve(null);
      const updated: Project = {
        ...existing,
        name: patch.name ?? existing.name,
        restricted: patch.restricted ?? existing.restricted,
        estimateMethod: patch.estimateMethod ?? existing.estimateMethod,
        startDate: patch.startDate === undefined ? existing.startDate : patch.startDate,
        solutionRef: patch.solutionRef === undefined ? existing.solutionRef : patch.solutionRef,
      };
      projects.set(id, updated);
      return Promise.resolve(updated);
    },
    rolesOf(projectId) {
      // In role order, as production reads them — see `inMemoryRoles` for what
      // an unordered read would let a test believe.
      return Promise.resolve(
        [...(roles.get(projectId) ?? [])].sort(
          (a, b) => a.position - b.position || (a.id < b.id ? -1 : 1),
        ),
      );
    },
  };
}

/** A ProjectService over the in-memory store, for tests that only need `buildApp` to construct. */
export function testProjectService(projects: ProjectStore = inMemoryProjects()): ProjectService {
  return new ProjectService({ projects });
}
