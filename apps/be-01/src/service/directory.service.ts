import type {
  DirectoryStore,
  Person,
  PersonKind,
  PersonPatch,
  PersonWithTeams,
  Service,
  ServiceTeam,
  Tag,
  TeamPatch,
  TeamWithServices,
  TouchedProjects,
} from '../repository';
// The constant from `schema.ts`, not from `repository/index.ts`: that module is
// type-only on purpose, and a value re-export there would pull drizzle into
// everything importing a store interface. `work-item.service.ts` takes
// `MEASURE_METRICS` the same way.
import { PERSON_KINDS } from '../repository/schema';
import type { Broadcaster } from './broadcast';
import {
  type DirectoryUsage,
  directoryUsageOfPerson,
  directoryUsageOfService,
  directoryUsageOfTag,
  directoryUsageOfTeam,
} from './directory-usage';

export interface DirectoryServiceOptions {
  directory: DirectoryStore;
  /**
   * Required, like the role service's. A directory service built without one
   * would rename somebody assigned across three plans and tell none of them —
   * every other client would keep drawing the old name until somebody
   * reloaded.
   */
  broadcast: Broadcaster;
  newId?: () => string;
}

/**
 * Why a directory write was refused. Every one is a state of the directory or
 * of the request, never a fault: the controller turns each into a 4xx.
 *
 * `nothing_to_change` is a patch naming neither a name nor memberships, and
 * neither a name nor owned services on a team. Accepting it as a no-op would
 * answer 200 to a request that was almost certainly a client bug, and leave
 * nothing on the wire to notice it by.
 *
 * `unknown_service` is an ownership map naming a service the directory does not
 * hold — `unknown_team`'s twin, one dimension over.
 */
export type DirectoryRefusal =
  | 'invalid_kind'
  | 'name_required'
  | 'not_found'
  | 'nothing_to_change'
  | 'unknown_service'
  | 'unknown_team';

/**
 * Whether a caller named one of the things a person can be.
 *
 * A narrowing function rather than an inline `includes`, for
 * `work-item.service.ts`' `holdsMetric` reason: the value arrives from a JSON
 * body, so it is genuinely `string` no matter what the route's schema says, and
 * checking it here — beside the write, once — is what keeps the closed set in
 * one place. A copy in the controller would be two lists that must agree.
 */
function holdsKind(kind: string): kind is PersonKind {
  return (PERSON_KINDS as readonly string[]).includes(kind);
}

/**
 * {@link PersonPatch} as it arrives from outside, where `kind` is a `string`.
 *
 * The store's `kind` is a {@link PersonKind} because by then it has been
 * checked; the service's is not, for the reason `setMeasure`'s `metric`
 * parameter is a `string` — a narrower type here would force the controller to
 * cast, and a cast at the route makes `invalid_kind` unreachable through the
 * API that refusal exists for. {@link holdsKind} is what turns one into the
 * other.
 */
export type PersonPatchInput = Omit<PersonPatch, 'kind'> & { kind?: string };

/**
 * What a directory write answered.
 *
 * The `taken` arm carries the **surviving** name — the one the row that already
 * holds it keeps. A bare `taken` would leave a caller who asked for a trimmed
 * name unable to say which of the two spellings is now on screen.
 */
export type DirectoryOutcome<T> =
  | { ok: true; result: T }
  | { ok: false; reason: DirectoryRefusal }
  | { ok: false; reason: 'taken'; name: string };

/**
 * How a removal answered.
 *
 * `in_use` carries the **directory usage** rather than a count, because the
 * next request is the same one with `cascade`, and the person confirming has to
 * know what they are agreeing to.
 */
export type RemoveDirectoryOutcome =
  | { ok: true }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'in_use'; usage: DirectoryUsage };

/** The trimmed name, or null when there is nothing there to name. */
function cleanName(name: string): string | null {
  const trimmed = name.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The global directory of teams and people.
 *
 * Global on purpose, and it is the decision worth arguing with: the same teams
 * and the same people work across projects, and a list per project would be
 * the same names typed again with typos between them. The cost is that anyone
 * on this deployment can see every team and person anyone has ever added — a
 * directory, not a secret. Dany asked for exactly this ("the list is global
 * for all projects, anyone can add one").
 *
 * Adding is idempotent by name so the "type it if it is not in the list"
 * picker cannot make two `Platform`s, and neither can two people typing it at
 * the same moment.
 */
export class DirectoryService {
  private readonly newId: () => string;

  constructor(private readonly opts: DirectoryServiceOptions) {
    this.newId = opts.newId ?? (() => crypto.randomUUID());
  }

  /** Every team **with the services it owns** — the map ships whole, design D4. */
  listTeams(): Promise<TeamWithServices[]> {
    return this.opts.directory.listTeams();
  }

  /** Null for a name that is only whitespace — an unnamed team helps nobody find anything. */
  async addTeam(name: string): Promise<ServiceTeam | null> {
    const clean = cleanName(name);
    if (clean === null) return null;
    // No size, because a team no longer has one: a new team is unstated on
    // every plan, and how many of them are at work at once is said per project
    // afterwards. The retired column is left at its default `NULL` by the
    // insert, which is what `capacity-per-project` D4 leaves it as.
    return this.opts.directory.addTeam({ id: this.newId(), name: clean });
  }

  /**
   * Renames a team, replaces the services it owns, or both at once.
   *
   * Any signed-in account may, as any may create one today: there is no admin
   * concept here, and inventing one for a rename would be a different change.
   *
   * A patch naming neither is refused rather than answered as a no-op —
   * {@link DirectoryService.patchPerson}'s rule, and the same reasoning: nothing
   * sends one deliberately, so it is a client bug, and a 200 would leave nothing
   * on the wire to notice it by.
   *
   * **Only a rename is announced.** Editing the ownership map changes no row any
   * project renders: the map labels no work item, is not inherited, and the
   * scheduler never reads it (spec — "editing it SHALL move no date in any
   * plan"). An event here would send every open plan to reread a tree that is
   * exactly as it was, and would make "the map moves no date" a claim about
   * luck rather than about the code.
   */
  async patchTeam(teamId: string, patch: TeamPatch): Promise<DirectoryOutcome<TeamWithServices>> {
    if (patch.name === undefined && patch.serviceIds === undefined) {
      return { ok: false, reason: 'nothing_to_change' };
    }
    const clean = patch.name === undefined ? undefined : cleanName(patch.name);
    // Before the row is read: a team called nothing would sit in every picker
    // with no way to tell it from the next one.
    if (clean === null) return { ok: false, reason: 'name_required' };
    const written = await this.opts.directory.patchTeam(teamId, {
      ...(clean === undefined ? {} : { name: clean }),
      ...(patch.serviceIds === undefined ? {} : { serviceIds: patch.serviceIds }),
    });
    if (!written.ok) {
      // `clean` is defined on this branch — `taken` is the name index refusing,
      // and a patch that named no name cannot have reached it.
      if (written.reason === 'taken' && clean !== undefined) {
        return { ok: false, reason: 'taken', name: clean };
      }
      return {
        ok: false,
        reason: written.reason === 'unknown_service' ? 'unknown_service' : 'not_found',
      };
    }
    if (clean !== undefined) await this.announce(written.projectIds);
    return { ok: true, result: written.team };
  }

  listTags(): Promise<Tag[]> {
    return this.opts.directory.listTags();
  }

  /**
   * Adds a tag, or refuses a name that is only whitespace.
   *
   * `addTeam`'s shape, and the same absence for a different reason: a team's
   * `size` is a retired column left at its default, while a tag has no such
   * column to leave — it never had a pool to be unstated about.
   */
  async addTag(name: string): Promise<Tag | null> {
    const clean = cleanName(name);
    if (clean === null) return null;
    return this.opts.directory.addTag({ id: this.newId(), name: clean });
  }

  /** Renames a tag, keeping the name unique across the deployment — `renameTeam`'s rules. */
  async renameTag(tagId: string, name: string): Promise<DirectoryOutcome<Tag>> {
    const clean = cleanName(name);
    if (clean === null) return { ok: false, reason: 'name_required' };
    const written = await this.opts.directory.renameTag(tagId, clean);
    if (!written.ok) {
      if (written.reason === 'taken') return { ok: false, reason: 'taken', name: clean };
      return { ok: false, reason: 'not_found' };
    }
    await this.announce(written.projectIds);
    return { ok: true, result: written.tag };
  }

  /**
   * Removes a tag, refusing an unconfirmed removal that would unlabel anything.
   *
   * `removeTeam`'s shape with **one clause fewer**: there are no members to
   * count, because nobody belongs to a tag. So the refusal turns on the
   * projects alone, and a tag nothing carries is removed on the first press.
   *
   * The unconfirmed read is still only a fast path. What decides is the count
   * inside the store's own transaction, which is why a labelling written
   * between the two refuses rather than being deleted.
   */
  async removeTag(tagId: string, cascade: boolean): Promise<RemoveDirectoryOutcome> {
    if (!cascade) {
      const seen = directoryUsageOfTag(await this.opts.directory.usageOfTag(tagId), tagId);
      if (seen.projects.length > 0) return { ok: false, reason: 'in_use', usage: seen };
    }
    const removed = await this.opts.directory.removeTag(tagId, cascade);
    if (!removed.ok) {
      if (removed.reason === 'not_found') return { ok: false, reason: 'not_found' };
      return { ok: false, reason: 'in_use', usage: directoryUsageOfTag(removed.usage, tagId) };
    }
    await this.announce(removed.removal.projectIds);
    return { ok: true };
  }

  listServices(): Promise<Service[]> {
    return this.opts.directory.listServices();
  }

  /**
   * Adds a service, or refuses a name that is only whitespace.
   *
   * {@link addTag}'s shape, and the same absence for a third reason: a service
   * has no `size` to leave at a default because it never had a pool. Who has the
   * people is the team, and the two are independent dimensions (Dany,
   * 2026-08-20: _"Let service and teams be independent."_).
   */
  async addService(name: string): Promise<Service | null> {
    const clean = cleanName(name);
    if (clean === null) return null;
    return this.opts.directory.addService({ id: this.newId(), name: clean });
  }

  /** Renames a service, keeping the name unique across the deployment — {@link renameTag}'s rules. */
  async renameService(serviceId: string, name: string): Promise<DirectoryOutcome<Service>> {
    const clean = cleanName(name);
    if (clean === null) return { ok: false, reason: 'name_required' };
    const written = await this.opts.directory.renameService(serviceId, clean);
    if (!written.ok) {
      if (written.reason === 'taken') return { ok: false, reason: 'taken', name: clean };
      return { ok: false, reason: 'not_found' };
    }
    await this.announce(written.projectIds);
    return { ok: true, result: written.service };
  }

  /**
   * Removes a service, refusing an unconfirmed removal that would unlabel
   * anything — {@link removeTag}'s shape, one dimension over.
   *
   * No members to count, for the tag's reason: nobody belongs to a service. The
   * teams that **own** it are not counted either, and that is the sharper
   * absence — `team_service` rows go with the removal, but an ownership claim
   * about a service that no longer exists is not a loss anybody has to weigh
   * (design.md D7). So the refusal turns on the work items alone.
   *
   * What is announced is `directory_changed` and never `capacity_changed`: no
   * date moves, so a client re-reads the tree and the schedule it re-reads is
   * the one it already had.
   */
  async removeService(serviceId: string, cascade: boolean): Promise<RemoveDirectoryOutcome> {
    if (!cascade) {
      const seen = directoryUsageOfService(
        await this.opts.directory.usageOfService(serviceId),
        serviceId,
      );
      if (seen.projects.length > 0) return { ok: false, reason: 'in_use', usage: seen };
    }
    const removed = await this.opts.directory.removeService(serviceId, cascade);
    if (!removed.ok) {
      if (removed.reason === 'not_found') return { ok: false, reason: 'not_found' };
      return {
        ok: false,
        reason: 'in_use',
        usage: directoryUsageOfService(removed.usage, serviceId),
      };
    }
    await this.announce(removed.removal.projectIds);
    return { ok: true };
  }

  listPeople(): Promise<PersonWithTeams[]> {
    return this.opts.directory.listPeople();
  }

  /**
   * Adds a person, optionally joining them to teams.
   *
   * No teams means a **free agent**, which is the absence of memberships
   * rather than membership of a "Free agents" row: a real row could be
   * renamed, deleted, or given work of its own, and the default would then
   * mean whatever somebody last did to it.
   */
  async addPerson(name: string, teamIds: readonly string[]): Promise<DirectoryOutcome<Person>> {
    const clean = cleanName(name);
    if (clean === null) return { ok: false, reason: 'name_required' };
    const written = await this.opts.directory.addPerson({ id: this.newId(), name: clean }, teamIds);
    // The whole create, or none of it: a person made without the membership
    // that was asked for is a row somebody would have to notice was wrong.
    if (!written.ok) return { ok: false, reason: written.reason };
    return { ok: true, result: written.person };
  }

  /**
   * Renames a person, marks them a person or an agent, replaces their
   * memberships, or any of those at once.
   *
   * A patch naming none of them is refused rather than answered as a no-op:
   * nothing on this deployment sends one deliberately, so it is a client bug,
   * and a 200 would leave nothing on the wire to notice it by.
   *
   * The halves are one transaction in the store — see
   * {@link DirectoryStore.patchPerson} — so a refused patch leaves the rename
   * beside it unapplied.
   *
   * **`kind` is checked before the row is read, and refused rather than
   * ignored.** A kind outside the set is a request that is wrong, not a
   * directory that lacks something, so it is 400 and not the 404 an unknown
   * team gets. Dropping it silently would answer 200 to a caller that believes
   * it has just marked somebody an agent.
   */
  async patchPerson(
    personId: string,
    patch: PersonPatchInput,
  ): Promise<DirectoryOutcome<PersonWithTeams>> {
    if (patch.name === undefined && patch.teamIds === undefined && patch.kind === undefined) {
      return { ok: false, reason: 'nothing_to_change' };
    }
    if (patch.kind !== undefined && !holdsKind(patch.kind)) {
      return { ok: false, reason: 'invalid_kind' };
    }
    const clean = patch.name === undefined ? undefined : cleanName(patch.name);
    if (clean === null) return { ok: false, reason: 'name_required' };
    const written = await this.opts.directory.patchPerson(personId, {
      ...(clean === undefined ? {} : { name: clean }),
      ...(patch.teamIds === undefined ? {} : { teamIds: patch.teamIds }),
      ...(patch.kind === undefined ? {} : { kind: patch.kind }),
    });
    if (!written.ok) {
      // `clean` is defined on this branch — `taken` is the name index refusing,
      // and a patch that named no name cannot have reached it.
      if (written.reason === 'taken' && clean !== undefined) {
        return { ok: false, reason: 'taken', name: clean };
      }
      return {
        ok: false,
        reason: written.reason === 'unknown_team' ? 'unknown_team' : 'not_found',
      };
    }
    // Only a rename is announced. A membership edit changes no row any project
    // renders — the assumed assignee is derived from assignments, not from who
    // belongs to which team — so an event would send every open plan to reread
    // a tree that is exactly as it was.
    //
    // `kind` is silent for the same reason and not a weaker one: nothing in a
    // plan's tree draws it. It reaches the directory payload (5.4) and the card
    // that edits it (7.1), and both read the directory rather than a plan. The
    // day a badge appears beside an assignee in the tree, this becomes a rename
    // and gets announced with one.
    if (clean !== undefined) await this.announce(written.projectIds);
    return { ok: true, result: written.person };
  }

  /**
   * Removes a person, refusing the first time when an assignment holds them.
   *
   * The refusal carries the **directory usage** rather than a bare conflict:
   * the assignments are rows somebody typed, and the assumed assignees are
   * readings that would move under them. A person nobody has been assigned is
   * removed without a second call — there is nothing to warn about, and asking
   * anyway teaches people to confirm without reading. Their own memberships go
   * with them and force nothing: they name nobody else.
   *
   * `cascade` is the caller saying it has seen that usage, and it is the only
   * thing carried across the two requests. **The count that decides is the one
   * inside the delete's transaction** — the read below is a fast path that
   * answers most refusals without opening one, and an assignment written after
   * it is refused by the transaction rather than deleted by it.
   *
   * Proof, watched 2026-08-09: with the transaction's own count replaced by
   * this fast path's, `refuses a removal when an assignment lands after the
   * count` deletes the person and the assignment the caller was never shown.
   */
  async removePerson(personId: string, cascade: boolean): Promise<RemoveDirectoryOutcome> {
    if (!cascade) {
      const seen = directoryUsageOfPerson(
        await this.opts.directory.usageOfPerson(personId),
        personId,
      );
      if (seen.projects.length > 0) return { ok: false, reason: 'in_use', usage: seen };
    }
    const removed = await this.opts.directory.removePerson(personId, cascade);
    if (!removed.ok) {
      if (removed.reason === 'not_found') return { ok: false, reason: 'not_found' };
      // The transaction's own usage, not the fast path's: it is the only one
      // that was still true at the moment the deletes would have run.
      return {
        ok: false,
        reason: 'in_use',
        usage: directoryUsageOfPerson(removed.usage, personId),
      };
    }
    await this.announce(removed.removal.projectIds);
    return { ok: true };
  }

  /**
   * Removes a team, refusing the first time when a work item carries it **or a
   * person belongs to it**.
   *
   * The memberships count here where a person's own do not, because they name
   * somebody else: a confirmation showing an empty impact list while two
   * people were about to be taken out of a team is a confirmation of nothing.
   */
  async removeTeam(teamId: string, cascade: boolean): Promise<RemoveDirectoryOutcome> {
    if (!cascade) {
      const seen = directoryUsageOfTeam(await this.opts.directory.usageOfTeam(teamId), teamId);
      if (seen.projects.length > 0 || seen.members.length > 0) {
        return { ok: false, reason: 'in_use', usage: seen };
      }
    }
    const removed = await this.opts.directory.removeTeam(teamId, cascade);
    if (!removed.ok) {
      if (removed.reason === 'not_found') return { ok: false, reason: 'not_found' };
      return { ok: false, reason: 'in_use', usage: directoryUsageOfTeam(removed.usage, teamId) };
    }
    await this.announce(removed.removal.projectIds);
    return { ok: true };
  }

  /**
   * Tells every project the write touched, **after** its transaction has
   * committed.
   *
   * One event per project rather than one global one, because a project's
   * sequence is what a reconnecting client resumes from: an event outside every
   * sequence has nowhere to be replayed from and no client would ever see it
   * twice. A write touching no project announces nothing — there is nothing
   * anywhere to reread.
   *
   * After the commit, and that is the whole of it: an event published first
   * would send every listener back to read the state it was told had changed
   * and find the old one. It is `role-crud`'s timing, chosen for `role-crud`'s
   * reason — `recordEvent` opens a transaction of its own, so it cannot be
   * nested inside the write's.
   *
   * Proof: with either publish moved ahead of its write, `records the event
   * after the write, never before it` fails — the directory read from inside
   * `publish` still held `Kat`; watched 2026-08-09.
   */
  private async announce(projectIds: TouchedProjects): Promise<void> {
    for (const projectId of projectIds) {
      await this.opts.broadcast.publish(projectId, { type: 'directory_changed' });
    }
  }
}
