import type { Project, ProjectStore, ProjectWithAccess, Step, UserStore } from '@wbs/core';
import { DEFAULT_ESTIMATE_RULE } from '@wbs/domain';

import { inMemoryUsers } from './auth-fixture';

/**
 * A `Project` row carrying every field the schema requires.
 *
 * Twenty-one suites wrote this literal by hand — the same "Rewire the shed",
 * copied — and fifteen of the copies were missing `depReach` and `solutionRef`,
 * added to {@link Project} long after the copies were made. Nothing said so: no
 * `typecheck` target in this repository compiled a test file until 2026-09-02.
 *
 * The defaults are {@link ProjectService.create}'s own, `DEFAULT_ESTIMATE_RULE`
 * included, so a fixture row and a row production writes are the same
 * arithmetic — a fixture that chose its own weights would let an estimate test
 * pass against a project no `create` can produce.
 */
export function projectRow(overrides: Partial<Project> = {}): Project {
  return {
    id: crypto.randomUUID(),
    name: 'Rewire the shed',
    ownerId: 'owner',
    restricted: false,
    estimateMethod: 'pert',
    depReach: 'whole-item',
    pertWeights: DEFAULT_ESTIMATE_RULE.pertWeights,
    estimateRounding: DEFAULT_ESTIMATE_RULE.rounding,
    startDate: null,
    solutionRef: null,
    revision: 0,
    createdAt: 1,
    // The three settings the migration defaults, stated for the same reason the
    // estimate rule is: a fixture that left them out would be a `Project` no
    // read can produce (tasks.md 3b.2).
    optimizationEnabled: false,
    scheduleEngine: 'fast',
    scheduleObjective: 'pri',
    ...overrides,
  };
}

/**
 * A ProjectStore backed by Maps, for controller and service tests that do not
 * need SQLite.
 *
 * It keeps the guarantees the real schema enforces, because a fixture that is
 * laxer than production lets a test pass against behaviour that does not exist:
 * step names are unique within a project, `list` returns newest first, and
 * `update` refuses an id it does not hold rather than inventing a row.
 *
 * `owners` is the store the listing resolves each project's owner name through,
 * and it has to be **the same one the test registers its accounts in** — pass
 * `inMemoryUsers()`'s value to both this and `testAuthService`. Left to its own
 * empty default, `listFor` throws on the first project it lists, which is
 * production's behaviour for an owner id naming no account and not an accident
 * to work around.
 */
export interface MemoryProjectTables {
  readonly projects: Map<string, Project>;
  readonly steps: Map<string, Step[]>;
  readonly opened: Map<string, number>;
}

export function memoryProjectTables(): MemoryProjectTables {
  return { projects: new Map(), steps: new Map(), opened: new Map() };
}

export function inMemoryProjects(
  owners: UserStore = inMemoryUsers(),
  tables: MemoryProjectTables = memoryProjectTables(),
): ProjectStore {
  const { projects, steps, opened } = tables;
  /** One moment per `userId::projectId`, exactly as the primary key holds it. */
  /**
   * Every stamp this store was handed, in call order, so a service test can
   * assert who wrote and when without a database to read audit columns from.
   */

  return {
    create(project, starting, _stamp) {
      const names = new Set(starting.map((r) => r.name));
      if (names.size !== starting.length) {
        return Promise.reject(new Error(`duplicate step name in ${project.id}`));
      }
      // The settings the caller left out, filled the way `ProjectRepository`
      // fills them from the column defaults. A fixture that stored the input
      // whole would answer `undefined` where production answers `false`.
      const written = {
        ...project,
        optimizationEnabled: project.optimizationEnabled ?? false,
        scheduleEngine: project.scheduleEngine ?? 'fast',
        scheduleObjective: project.scheduleObjective ?? 'pri',
      } satisfies Project;
      projects.set(written.id, written);
      steps.set(written.id, [...starting]);
      return Promise.resolve(written);
    },
    findById(id) {
      const found = projects.get(id);
      return Promise.resolve(found === undefined ? null : structuredClone(found));
    },
    findBySolutionSlug(slug) {
      for (const project of projects.values()) {
        if (project.solutionRef?.slug === slug) return Promise.resolve(project);
      }
      return Promise.resolve(null);
    },
    list() {
      return Promise.resolve(
        [...projects.values()]
          .map((project) => structuredClone(project))
          .sort((a, b) => b.createdAt - a.createdAt),
      );
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
    recordOpen(projectId, stamp) {
      // Both halves of the key come off the stamp: the account that opened the
      // project is the acting user, and the instant it opened is the act's.
      opened.set(`${stamp.by}::${projectId}`, stamp.at);
      return Promise.resolve();
    },
    update(id, patch, _stamp) {
      const existing = projects.get(id);
      if (existing === undefined) return Promise.resolve(null);
      const updated: Project = {
        ...existing,
        name: patch.name ?? existing.name,
        restricted: patch.restricted ?? existing.restricted,
        estimateMethod: patch.estimateMethod ?? existing.estimateMethod,
        depReach: patch.depReach ?? existing.depReach,
        pertWeights: patch.pertWeights ?? existing.pertWeights,
        estimateRounding: patch.estimateRounding ?? existing.estimateRounding,
        startDate: patch.startDate === undefined ? existing.startDate : patch.startDate,
        solutionRef: patch.solutionRef === undefined ? existing.solutionRef : patch.solutionRef,
        optimizationEnabled: patch.optimizationEnabled ?? existing.optimizationEnabled,
        scheduleEngine: patch.scheduleEngine ?? existing.scheduleEngine,
        scheduleObjective: patch.scheduleObjective ?? existing.scheduleObjective,
      };
      projects.set(id, updated);
      return Promise.resolve(updated);
    },
    stepsOf(projectId) {
      // In step order, as production reads them — see `inMemorySteps` for what
      // an unordered read would let a test believe.
      return Promise.resolve(
        [...(steps.get(projectId) ?? [])]
          .map((step) => structuredClone(step))
          .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1)),
      );
    },
  };
}
