import type {
  Assignment,
  DirectoryStore,
  DirectoryUsageRows,
  Person,
  PersonAdded,
  PersonWithTeams,
  Service,
  ServiceTeam,
  Tag,
} from '../repository';
import type { Broadcaster } from '../service/broadcast';
import { DirectoryService } from '../service/directory.service';
import { recordingBroadcaster } from './broadcast-fixture';

/** The empty usage, both halves present — what this fixture can honestly say. */
const NOTHING_POINTS_AT_IT: DirectoryUsageRows = {
  workItems: [],
  projects: [],
  assignments: [],
  roles: [],
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
 * work item holds at most one assignee per role.
 */
export function inMemoryDirectory(): DirectoryStore {
  const teams = new Map<string, ServiceTeam>();
  const tags = new Map<string, Tag>();
  const services = new Map<string, Service>();
  const people = new Map<string, Person>();
  const memberships = new Map<string, Set<string>>();
  /** The ownership map, by team — `memberships`' shape, one dimension over. */
  const owned = new Map<string, Set<string>>();
  const assignments = new Map<string, Assignment>();
  const key = (workItemId: string, roleId: string) => `${workItemId}::${roleId}`;

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
    addTag(toAdd) {
      const already = [...tags.values()].find((each) => each.name === toAdd.name);
      if (already !== undefined) return Promise.resolve(already);
      tags.set(toAdd.id, toAdd);
      return Promise.resolve(toAdd);
    },
    renameTag(tagId, name) {
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
        roles: [],
        people: [],
        members: [],
        capacityOf: new Map<string, number>(),
      }),
    removeTag(tagId) {
      const found = tags.get(tagId);
      if (found === undefined) return Promise.resolve({ ok: false, reason: 'not_found' });
      tags.delete(tagId);
      return Promise.resolve({ ok: true, removal: { workItemIds: [], projectIds: [] } });
    },
    listServices: () =>
      Promise.resolve([...services.values()].sort((a, b) => a.name.localeCompare(b.name))),
    // Idempotent by name, as the repository is at its unique index — `addTag`'s
    // rule and its reason.
    addService(toAdd) {
      const already = [...services.values()].find((each) => each.name === toAdd.name);
      if (already !== undefined) return Promise.resolve(already);
      services.set(toAdd.id, toAdd);
      return Promise.resolve(toAdd);
    },
    renameService(serviceId, name) {
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
    removeService(serviceId) {
      if (!services.has(serviceId)) return Promise.resolve({ ok: false, reason: 'not_found' });
      services.delete(serviceId);
      return Promise.resolve({ ok: true, removal: { workItemIds: [], projectIds: [] } });
    },
    addTeam(team) {
      const already = [...teams.values()].find((each) => each.name === team.name);
      if (already !== undefined) return Promise.resolve(already);
      teams.set(team.id, team);
      return Promise.resolve(team);
    },
    patchTeam(teamId, patch) {
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
          .map(
            (each): PersonWithTeams => ({
              ...each,
              teamIds: [...(memberships.get(each.id) ?? [])],
            }),
          ),
      ),
    addPerson(toAdd, teamIds) {
      // The teams are checked before anything is written, as production checks
      // them inside the create's own transaction: `person_team` has a foreign
      // key, so a fixture that wrote a dead membership would be laxer than the
      // schema it stands for.
      if (teamIds.some((each) => !teams.has(each))) {
        return Promise.resolve({ ok: false, reason: 'unknown_team' });
      }
      const already = [...people.values()].find((each) => each.name === toAdd.name);
      const kept = already ?? toAdd;
      if (already === undefined) people.set(toAdd.id, toAdd);
      if (teamIds.length > 0) {
        memberships.set(kept.id, new Set([...(memberships.get(kept.id) ?? []), ...teamIds]));
      }
      return Promise.resolve({ ok: true, person: kept });
    },
    patchPerson(personId, patch) {
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
    // `role-fixture.ts` makes for the same reason.
    usageOfPerson: () => Promise.resolve(NOTHING_POINTS_AT_IT),
    usageOfTeam: (teamId) =>
      Promise.resolve({
        ...NOTHING_POINTS_AT_IT,
        members: [...people.values()].filter((each) => memberships.get(each.id)?.has(teamId)),
      }),
    removePerson(personId) {
      if (!people.has(personId)) return Promise.resolve({ ok: false, reason: 'not_found' });
      const held = [...assignments.values()].filter((each) => each.personId === personId);
      for (const each of held) assignments.delete(key(each.workItemId, each.roleId));
      memberships.delete(personId);
      people.delete(personId);
      return Promise.resolve({
        ok: true,
        removal: { workItemIds: held.map((each) => each.workItemId), projectIds: [] },
      });
    },
    removeTeam(teamId) {
      if (!teams.has(teamId)) return Promise.resolve({ ok: false, reason: 'not_found' });
      for (const held of memberships.values()) held.delete(teamId);
      teams.delete(teamId);
      return Promise.resolve({ ok: true, removal: { workItemIds: [], projectIds: [] } });
    },
    assignmentsOf(workItemIds) {
      const wanted = new Set(workItemIds);
      return Promise.resolve([...assignments.values()].filter((a) => wanted.has(a.workItemId)));
    },
    assign(workItemId, roleId, personId) {
      // The person is checked here because production checks it inside the
      // write's own transaction: a fixture that wrote an assignment naming
      // nobody would let a caller's `unknown_person` branch pass untested.
      if (personId !== null && !people.has(personId)) {
        return Promise.resolve({ ok: false, reason: 'unknown_person' });
      }
      if (personId === null) assignments.delete(key(workItemId, roleId));
      else assignments.set(key(workItemId, roleId), { workItemId, roleId, personId });
      return Promise.resolve({ ok: true });
    },
  };
}

/** A DirectoryService over the in-memory store, for tests that only need `buildApp` to construct. */
export function testDirectoryService(
  directory: DirectoryStore = inMemoryDirectory(),
  broadcast: Broadcaster = recordingBroadcaster(),
) {
  return new DirectoryService({ directory, broadcast });
}

/**
 * The person a create made, or a throw.
 *
 * For test setup only: a fixture whose own `addPerson` was refused has not
 * produced a test result, and carrying on would assert against a directory
 * that is missing the row the test is about.
 */
export async function personAdded(added: Promise<PersonAdded>): Promise<Person> {
  const written = await added;
  if (!written.ok) throw new Error(`the fixture person was refused: ${written.reason}`);
  return written.person;
}
