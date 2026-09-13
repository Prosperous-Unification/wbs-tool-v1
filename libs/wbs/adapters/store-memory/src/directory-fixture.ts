import type {
  Assignment,
  DirectoryStore,
  DirectoryUsageRows,
  Person,
  PersonWithTeams,
  Service,
  ServiceTeam,
  Tag,
  WorkItemType,
} from '@wbs/core';

/** The empty usage, both halves present — what this fixture can honestly say. */
const NOTHING_POINTS_AT_IT: DirectoryUsageRows = {
  workItems: [],
  projects: [],
  assignments: [],
  steps: [],
  people: [],
  members: [],
  capacityOf: new Map(),
};

/**
 * A DirectoryStore backed by Maps, for tests that do not need SQLite.
 *
 * It keeps the guarantees the real schema enforces, because a fixture laxer
 * than production lets a test pass against behaviour that does not exist:
 * names are unique, adding an existing name returns the existing row, and one
 * work item holds at most one assignee per step.
 */
/**
 * The store it is handed, with some of its methods answered by `overrides`.
 *
 * A `Proxy` rather than an object written out method by method:
 * `DirectoryRepository`'s methods live on its prototype, so `{ ...store }`
 * copies its connection and none of them — and the two hand-written copies this
 * replaces named 13 and 6 of the interface's 27 methods, which compiled nowhere
 * until 2026-09-02. A proxy also picks up the next method the interface grows.
 */
export function directoryWith(
  base: DirectoryStore,
  overrides: Partial<DirectoryStore>,
): DirectoryStore {
  return new Proxy(base, {
    get(target, key) {
      const override = overrides[key as keyof DirectoryStore];
      if (override !== undefined) return override;
      const held: unknown = Reflect.get(target, key);
      if (typeof held !== 'function') return held;
      // Bound to the store itself: an unbound prototype method called through
      // the proxy would run with `this` as the proxy and re-enter this trap.
      // The cast is the boundary a `Proxy` trap is: its key is a `string |
      // symbol` and what stands behind it is only knowable at runtime.
      return (held as (...args: readonly unknown[]) => unknown).bind(target);
    },
  });
}

export interface MemoryDirectoryTables {
  readonly teams: Map<string, ServiceTeam>;
  readonly tags: Map<string, Tag>;
  readonly services: Map<string, Service>;
  readonly workItemTypes: Map<string, WorkItemType>;
  readonly people: Map<string, Person>;
  readonly memberships: Map<string, Set<string>>;
  readonly owned: Map<string, Set<string>>;
  readonly assignments: Map<string, Assignment>;
}

export function memoryDirectoryTables(): MemoryDirectoryTables {
  return {
    teams: new Map(),
    tags: new Map(),
    services: new Map(),
    workItemTypes: new Map(),
    people: new Map(),
    memberships: new Map(),
    owned: new Map(),
    assignments: new Map(),
  };
}

export function inMemoryDirectory(
  readProject?: (projectId: string) => Promise<readonly { id: string }[]>,
  tables: MemoryDirectoryTables = memoryDirectoryTables(),
): DirectoryStore {
  const { teams, tags, services, workItemTypes, people, memberships, owned, assignments } = tables;
  /** The ownership map, by team — `memberships`' shape, one dimension over. */
  const key = (workItemId: string, stepId: string) => `${workItemId}::${stepId}`;
  /**
   * Every stamp this store was handed, in call order, so a service test can
   * assert who wrote and when without a database to read audit columns from.
   */

  return {
    listTeams: () =>
      Promise.resolve(
        [...teams.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((each) => ({ ...each, serviceIds: [...(owned.get(each.id) ?? [])].sort() })),
      ),
    listTags: () =>
      Promise.resolve([...tags.values()].sort((a, b) => a.name.localeCompare(b.name))),
    // Idempotent by name, as the repository is at its unique index. The
    // dimension has no cascade here and cannot: an in-memory store models no
    // foreign keys, which is exactly why the tag write path's own tests run
    // against real SQLite instead of this.
    addTag(toAdd, _stamp) {
      const already = [...tags.values()].find((each) => each.name === toAdd.name);
      if (already !== undefined) return Promise.resolve(already);
      tags.set(toAdd.id, toAdd);
      return Promise.resolve(toAdd);
    },
    renameTag(tagId, name, _stamp) {
      const found = tags.get(tagId);
      if (found === undefined) return Promise.resolve({ ok: false, reason: 'not_found' });
      // The unique index, modelled, for `renameTeam`'s reason: a fixture that
      // let two `regulatory` tags exist would let a caller's `taken` branch pass
      // untested.
      const held = [...tags.values()].some((each) => each.name === name && each.id !== tagId);
      if (held) return Promise.resolve({ ok: false, reason: 'taken' });
      const renamed = { id: tagId, name };
      tags.set(tagId, renamed);
      return Promise.resolve({ ok: true, tag: renamed, projectIds: [] });
    },
    // The usage and the removal are **not** modelled here beyond the shape.
    // This store has no work items and no foreign keys, so the counting that
    // decides a removal and the cascade that performs it cannot exist in it —
    // which is exactly why the tag directory's own tests run against real
    // SQLite. A fixture answering "nothing points at it" would let a caller's
    // `in_use` branch pass untested, so it answers the empty usage and says so.
    usageOfTag: () =>
      Promise.resolve({
        workItems: [],
        projects: [],
        assignments: [],
        steps: [],
        people: [],
        members: [],
        capacityOf: new Map<string, number>(),
      }),
    // Seeded, as the migration seeds the real table: `systemOfUrl` can answer
    // these names, so a fake that answered an empty list would let a ref write
    // fail here for a reason the real store does not have.
    listExternalSystems: () =>
      Promise.resolve([
        { id: 'sys-jira-issue', name: 'jira-issue' },
        { id: 'sys-github-pr', name: 'github-pr' },
        { id: 'sys-github-issue', name: 'github-issue' },
        { id: 'sys-confluence-page', name: 'confluence-page' },
        { id: 'sys-slack-message', name: 'slack-message' },
      ]),
    removeTag(tagId, _cascade, _stamp) {
      const found = tags.get(tagId);
      if (found === undefined) return Promise.resolve({ ok: false, reason: 'not_found' });
      tags.delete(tagId);
      return Promise.resolve({ ok: true, removal: { workItemIds: [], projectIds: [] } });
    },
    listWorkItemTypes: () =>
      Promise.resolve([...workItemTypes.values()].sort((a, b) => a.name.localeCompare(b.name))),
    // `addTag`'s shape and its caveat: idempotent by name as the repository is at
    // its unique index, with no cascade, because an in-memory store models no
    // foreign keys. The type write path's own tests run against real SQLite.
    addWorkItemType(toAdd, _stamp) {
      const already = [...workItemTypes.values()].find((each) => each.name === toAdd.name);
      if (already !== undefined) return Promise.resolve(already);
      workItemTypes.set(toAdd.id, toAdd);
      return Promise.resolve(toAdd);
    },
    renameWorkItemType(typeId, name, _stamp) {
      const found = workItemTypes.get(typeId);
      if (found === undefined) return Promise.resolve({ ok: false, reason: 'not_found' });
      // The unique index, modelled, for `renameTag`'s reason: a fixture that let
      // two `Bug` types exist would let a caller's `taken` branch pass untested.
      const held = [...workItemTypes.values()].some(
        (each) => each.name === name && each.id !== typeId,
      );
      if (held) return Promise.resolve({ ok: false, reason: 'taken' });
      const renamed = { id: typeId, name };
      workItemTypes.set(typeId, renamed);
      return Promise.resolve({ ok: true, workItemType: renamed, projectIds: [] });
    },
    // Not modelled beyond the shape, for `usageOfTag`'s reason exactly: no work
    // items and no foreign keys here, so the counting that decides a removal
    // cannot exist in this store.
    usageOfWorkItemType: () =>
      Promise.resolve({
        workItems: [],
        projects: [],
        assignments: [],
        steps: [],
        people: [],
        members: [],
        capacityOf: new Map<string, number>(),
      }),
    removeWorkItemType(typeId, _cascade, _stamp) {
      const found = workItemTypes.get(typeId);
      if (found === undefined) return Promise.resolve({ ok: false, reason: 'not_found' });
      workItemTypes.delete(typeId);
      return Promise.resolve({ ok: true, removal: { workItemIds: [], projectIds: [] } });
    },
    listServices: () =>
      Promise.resolve([...services.values()].sort((a, b) => a.name.localeCompare(b.name))),
    // Idempotent by name, as the repository is at its unique index — `addTag`'s
    // rule and its reason.
    addService(toAdd, _stamp) {
      const already = [...services.values()].find((each) => each.name === toAdd.name);
      if (already !== undefined) return Promise.resolve(already);
      services.set(toAdd.id, toAdd);
      return Promise.resolve(toAdd);
    },
    renameService(serviceId, name, _stamp) {
      const found = services.get(serviceId);
      if (found === undefined) return Promise.resolve({ ok: false, reason: 'not_found' });
      const held = [...services.values()].some(
        (each) => each.name === name && each.id !== serviceId,
      );
      if (held) return Promise.resolve({ ok: false, reason: 'taken' });
      const renamed = { id: serviceId, name };
      services.set(serviceId, renamed);
      return Promise.resolve({ ok: true, service: renamed, projectIds: [] });
    },
    // Not modelled beyond the shape, for `usageOfTag`'s reason: this store holds
    // no work items and no foreign keys, so neither the count that decides a
    // removal nor the `ON DELETE SET NULL` that performs it can exist in it.
    // Every behavioural claim about removing a service is asserted against real
    // SQLite in `service/directory.service.test.ts`.
    usageOfService: () => Promise.resolve(NOTHING_POINTS_AT_IT),
    removeService(serviceId, _cascade, _stamp) {
      if (!services.has(serviceId)) return Promise.resolve({ ok: false, reason: 'not_found' });
      services.delete(serviceId);
      return Promise.resolve({ ok: true, removal: { workItemIds: [], projectIds: [] } });
    },
    addTeam(team, _stamp) {
      const already = [...teams.values()].find((each) => each.name === team.name);
      if (already !== undefined) return Promise.resolve(already);
      teams.set(team.id, team);
      return Promise.resolve(team);
    },
    patchTeam(teamId, patch, _stamp) {
      const found = teams.get(teamId);
      if (found === undefined) return Promise.resolve({ ok: false, reason: 'not_found' });
      // The unique index, modelled: a fixture that let two `Platform`s exist
      // would let a caller's `taken` branch pass untested.
      const held =
        patch.name !== undefined &&
        [...teams.values()].some((each) => each.name === patch.name && each.id !== teamId);
      if (held) return Promise.resolve({ ok: false, reason: 'taken' });
      // The foreign key, modelled, for the same reason: a fixture that accepted
      // an ownership row about a service nothing holds would let a caller's
      // `unknown_service` branch — and the 404 above it — pass untested. This is
      // the strictness `unknown_team` already has one dimension over.
      if (patch.serviceIds !== undefined) {
        const unknown = patch.serviceIds.some((each) => !services.has(each));
        if (unknown) return Promise.resolve({ ok: false, reason: 'unknown_service' });
      }
      const renamed = patch.name === undefined ? found : { ...found, name: patch.name };
      teams.set(teamId, renamed);
      // Whole-set replacement, exactly as the repository writes it: absent
      // leaves the map alone, empty clears it.
      if (patch.serviceIds !== undefined) owned.set(teamId, new Set(patch.serviceIds));
      // No project here to touch: these Maps hold no work items, so the
      // fixture can only ever honestly report the empty set.
      return Promise.resolve({
        ok: true,
        team: { ...renamed, serviceIds: [...(owned.get(teamId) ?? [])].sort() },
        projectIds: [],
      });
    },
    listPeople: () =>
      Promise.resolve(
        [...people.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((each): PersonWithTeams => ({
            ...each,
            teamIds: [...(memberships.get(each.id) ?? [])],
          })),
      ),
    addPerson(toAdd, teamIds, _stamp) {
      // The teams are checked before anything is written, as production checks
      // them inside the create's own transaction: `person_team` has a foreign
      // key, so a fixture that wrote a dead membership would be laxer than the
      // schema it stands for.
      if (teamIds.some((each) => !teams.has(each))) {
        return Promise.resolve({ ok: false, reason: 'unknown_team' });
      }
      // The column's `DEFAULT 'person'` applied here rather than left off, because
      // the fixture stands for the table: SQLite cannot hold a person without a
      // kind, so a fixture that stored `toAdd` unchanged would hand every reader
      // above it a row shape the database never produces.
      const stored: Person = { ...toAdd, kind: toAdd.kind ?? 'person' };
      const already = [...people.values()].find((each) => each.name === toAdd.name);
      const kept = already ?? stored;
      if (already === undefined) people.set(stored.id, stored);
      if (teamIds.length > 0) {
        memberships.set(kept.id, new Set([...(memberships.get(kept.id) ?? []), ...teamIds]));
      }
      return Promise.resolve({ ok: true, person: kept });
    },
    patchPerson(personId, patch, _stamp) {
      const found = people.get(personId);
      if (found === undefined) return Promise.resolve({ ok: false, reason: 'not_found' });
      const wanted = patch.teamIds === undefined ? null : [...new Set(patch.teamIds)];
      // Validated before either write, as production is: a fixture that wrote
      // the name first would let a half-applied patch pass here and fail there.
      if (wanted?.some((each) => !teams.has(each)) === true) {
        return Promise.resolve({ ok: false, reason: 'unknown_team' });
      }
      if (patch.name !== undefined) {
        const held = [...people.values()].some(
          (each) => each.name === patch.name && each.id !== personId,
        );
        if (held) return Promise.resolve({ ok: false, reason: 'taken' });
        people.set(personId, { ...found, name: patch.name });
      }
      // After the rename and off the row as it stands, so a patch carrying both
      // does not lose one: `found` is the row from before the line above.
      if (patch.kind !== undefined) {
        const current = people.get(personId) ?? found;
        people.set(personId, { ...current, kind: patch.kind });
      }
      if (wanted !== null) memberships.set(personId, new Set(wanted));
      const patched = people.get(personId);
      if (patched === undefined) throw new Error(`person vanished mid-patch: ${personId}`);
      return Promise.resolve({
        ok: true,
        person: { ...patched, teamIds: [...(memberships.get(personId) ?? [])] },
        projectIds: [],
      });
    },
    // The four removal methods model only what an array can: a person or team
    // this fixture holds, and the rows it holds about them. **Nothing here
    // models the usage a refusal names** — that needs a project, its tree and
    // the numbers derived from it, none of which exist in these Maps. A fixture
    // answering them would be a second implementation of the rule under test,
    // so every behavioural claim about a removal is asserted against real
    // SQLite in `service/directory.service.test.ts`, the same call
    // `step-fixture.ts` makes for the same reason. That is also why every
    // removal here names `cascade` and never reads it: with no usage to find,
    // there is nothing for it to decide about.
    usageOfPerson: () => Promise.resolve(NOTHING_POINTS_AT_IT),
    usageOfTeam: (teamId) =>
      Promise.resolve({
        ...NOTHING_POINTS_AT_IT,
        members: [...people.values()].filter((each) => memberships.get(each.id)?.has(teamId)),
      }),
    removePerson(personId, _cascade, _stamp) {
      if (!people.has(personId)) return Promise.resolve({ ok: false, reason: 'not_found' });
      const held = [...assignments.values()].filter((each) => each.personId === personId);
      for (const each of held) assignments.delete(key(each.workItemId, each.stepId));
      memberships.delete(personId);
      people.delete(personId);
      return Promise.resolve({
        ok: true,
        removal: { workItemIds: held.map((each) => each.workItemId), projectIds: [] },
      });
    },
    removeTeam(teamId, _cascade, _stamp) {
      if (!teams.has(teamId)) return Promise.resolve({ ok: false, reason: 'not_found' });
      for (const held of memberships.values()) held.delete(teamId);
      teams.delete(teamId);
      return Promise.resolve({ ok: true, removal: { workItemIds: [], projectIds: [] } });
    },
    // Proof: removing the project filter made `names only the people assigned
    // in the requested project` receive grace alongside the requested ada.
    async assignmentsInProject(projectId) {
      if (readProject === undefined)
        throw new Error('project assignment reads require a work-item store');
      const wanted = new Set((await readProject(projectId)).map((row) => row.id));
      const assigned = [...assignments.values()].filter((each) => wanted.has(each.workItemId));
      const named = [...new Set(assigned.map((each) => each.personId))].map((id) => {
        const found = people.get(id);
        if (found === undefined) throw new Error(`assignment names absent person ${id}`);
        return { id, name: found.name };
      });
      return {
        assignments: assigned,
        people: named.sort((left, right) => left.name.localeCompare(right.name)),
      };
    },
    assignmentsFor(workItemId) {
      return Promise.resolve(
        [...assignments.values()].filter((each) => each.workItemId === workItemId),
      );
    },
    assignmentsOf(workItemIds) {
      const wanted = new Set(workItemIds);
      return Promise.resolve([...assignments.values()].filter((a) => wanted.has(a.workItemId)));
    },
    assign(workItemId, stepId, personId, _stamp) {
      // The person is checked here because production checks it inside the
      // write's own transaction: a fixture that wrote an assignment naming
      // nobody would let a caller's `unknown_person` branch pass untested.
      if (personId !== null && !people.has(personId)) {
        return Promise.resolve({ ok: false, reason: 'unknown_person' });
      }
      if (personId === null) assignments.delete(key(workItemId, stepId));
      else assignments.set(key(workItemId, stepId), { workItemId, stepId, personId });
      return Promise.resolve({ ok: true });
    },
  };
}
