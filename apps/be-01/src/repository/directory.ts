import { and, asc, eq, inArray } from 'drizzle-orm';
import type { SQLiteBunDatabase } from 'drizzle-orm/bun-sqlite';

import { auditOnCreate, auditOnUpdate } from './audit';
import { isUniqueViolation, UNIQUE_INDEXES } from './constraint';
import type { Gate } from './gate';
import type {
  AssignmentWritten,
  DirectoryRemoved,
  DirectoryStore,
  DirectoryUsageRows,
  ExternalRef,
  ExternalSystem,
  PersonAdded,
  PersonInsert,
  PersonPatch,
  PersonWithTeams,
  PersonWritten,
  Service,
  ServiceTeam,
  ServiceTeamWritten,
  ServiceWritten,
  Tag,
  TagWritten,
  TeamPatch,
  TeamWithServices,
  WorkItemType,
  WorkItemTypeWritten,
  WriteStamp,
} from './index';
import { bumpWorkItems } from './revision';
import {
  assignment,
  externalSystem,
  person,
  personTeam,
  project,
  projectTeamCapacity,
  service,
  serviceTeam,
  step,
  tag,
  teamService,
  workItem,
  workItemExternalRef,
  workItemService,
  workItemTag,
  workItemTeam,
  workItemType,
  workItemWorkItemType,
} from './schema';
import { writingStep } from './step-reference';
import { WORK_ITEM_COLUMNS } from './work-item';

/** Nothing points at it: the empty usage, with both halves present as the spec requires. */
const NOTHING_POINTS_AT_IT: DirectoryUsageRows = {
  workItems: [],
  projects: [],
  assignments: [],
  steps: [],
  people: [],
  members: [],
  capacityOf: new Map(),
};

/** A reader that is either the connection or an open transaction — see {@link usageRowsIn}. */
type Reader = Pick<SQLiteBunDatabase, 'select'>;

/**
 * Everything the refusal needs about the projects `projectIds` names, plus the
 * `members` the caller worked out.
 *
 * Takes the reader so the refusal can read it inside the transaction that
 * refused — the same shape `StepRepository`'s `assignmentsIn` takes, and for
 * the same reason.
 */
function usageRowsIn(
  reader: Reader,
  projectIds: readonly string[],
  members: readonly { id: string; name: string }[],
  /**
   * The team being removed, or null for a person's usage. Read here rather than
   * handed in as a number, because what the confirmation needs is one number
   * **per project** — see {@link DirectoryUsageRows.capacityOf}.
   */
  teamId: string | null = null,
): DirectoryUsageRows {
  // `inArray` with an empty list becomes `IN ()`, which SQLite refuses — and a
  // removal touching no project has no tree to number.
  if (projectIds.length === 0) return { ...NOTHING_POINTS_AT_IT, members };
  const ids = [...projectIds];
  // The rows and the teams they are joined to, because the usage is computed
  // through `effectiveTeamsOf` — the join is the read since `team-sets`, and
  // rows handed over without their sets would report no effect at all.
  // Named rather than bare, which is this folder's rule and is argued at
  // `DirectoryRepository`'s own doc: a bare `select()` reads every column
  // drizzle knows about, and these rows are folded into the usage preview a
  // person is shown before consenting to a removal.
  //
  // **Ordered by `work_item.id`, and the order is a promise rather than a
  // property of the query plan** — the same contract `WorkItemRepository.
  // listByProject` states and ADR 0016 argues, applied to the one select in
  // this function that was missing it while the five below all order
  // explicitly. This is a preview a person reads before consenting to a
  // removal, so two reads of unchanged data returning two different orders is
  // a defect in what they are shown, not a cosmetic one.
  //
  // It was latent until an index made it visible: `work_item_project_id_id`
  // — `(project_id, id)`, added with that contract — can serve this
  // `WHERE project_id IN (…)` on its own, and an index read comes back in key
  // order where the table scan it replaced came back in rowid order, i.e. in
  // insertion order. CI run 34020910596 at `44463938` failed on exactly that
  // flip (`work-item-type.db.test.ts:265`, the two ids swapped into ascending
  // id order) at bytes whose only change was merging the index in.
  const rows = reader
    .select(WORK_ITEM_COLUMNS)
    .from(workItem)
    .where(inArray(workItem.projectId, ids))
    .orderBy(asc(workItem.id))
    .all();
  const joined = reader
    .select({ workItemId: workItemTeam.workItemId, teamId: workItemTeam.teamId })
    .from(workItemTeam)
    .innerJoin(workItem, eq(workItemTeam.workItemId, workItem.id))
    .where(inArray(workItem.projectId, ids))
    .orderBy(asc(workItemTeam.teamId))
    .all();
  const tagged = reader
    .select({ workItemId: workItemTag.workItemId, tagId: workItemTag.tagId })
    .from(workItemTag)
    .innerJoin(workItem, eq(workItemTag.workItemId, workItem.id))
    .where(inArray(workItem.projectId, ids))
    .orderBy(asc(workItemTag.tagId))
    .all();
  // And the services, for the same reason one line down: `directoryUsageOfService`
  // reads the set off the row it is handed, so a row arriving without one would
  // report a removal that touches nothing.
  const serviced = reader
    .select({ workItemId: workItemService.workItemId, serviceId: workItemService.serviceId })
    .from(workItemService)
    .innerJoin(workItem, eq(workItemService.workItemId, workItem.id))
    .where(inArray(workItem.projectId, ids))
    .orderBy(asc(workItemService.serviceId))
    .all();
  const teamsOf = new Map<string, string[]>();
  for (const each of joined) {
    teamsOf.set(each.workItemId, [...(teamsOf.get(each.workItemId) ?? []), each.teamId]);
  }
  // Read in the same transaction for the reason every other read here is: a
  // removal's confirmation must count what is there now. Both dimensions come
  // back on the row because `DirectoryUsageRows` is what both usage functions
  // read — `directoryUsageOfTag` asks the same question of the other one.
  const tagsOf = new Map<string, string[]>();
  for (const each of tagged) {
    tagsOf.set(each.workItemId, [...(tagsOf.get(each.workItemId) ?? []), each.tagId]);
  }
  const servicesOf = new Map<string, string[]>();
  for (const each of serviced) {
    servicesOf.set(each.workItemId, [...(servicesOf.get(each.workItemId) ?? []), each.serviceId]);
  }
  // And the types, for the same reason as the three above: `LabelledWorkItem`
  // carries four dimensions and a row handed over without one would report a
  // removal that touches nothing. This one needs no walk on the way out — a
  // type does not inherit, so what the row states is what it has.
  const typed = reader
    .select({ workItemId: workItemWorkItemType.workItemId, typeId: workItemWorkItemType.typeId })
    .from(workItemWorkItemType)
    .innerJoin(workItem, eq(workItemWorkItemType.workItemId, workItem.id))
    .where(inArray(workItem.projectId, ids))
    .orderBy(asc(workItemWorkItemType.typeId))
    .all();
  const typesOf = new Map<string, string[]>();
  for (const each of typed) {
    typesOf.set(each.workItemId, [...(typesOf.get(each.workItemId) ?? []), each.typeId]);
  }
  // The refs, read in the same transaction as the three label dimensions and
  // for the same reason: `LabelledWorkItem` carries them, and a row handed over
  // without its refs would report a removal that touches nothing. Ordered by
  // `position` so the list reads as it was built.
  const referenced = reader
    .select({
      id: workItemExternalRef.id,
      workItemId: workItemExternalRef.workItemId,
      systemId: workItemExternalRef.systemId,
      url: workItemExternalRef.url,
      name: workItemExternalRef.name,
    })
    .from(workItemExternalRef)
    .innerJoin(workItem, eq(workItemExternalRef.workItemId, workItem.id))
    .where(inArray(workItem.projectId, ids))
    .orderBy(asc(workItemExternalRef.position))
    .all();
  const refsOf = new Map<string, ExternalRef[]>();
  for (const each of referenced) {
    refsOf.set(each.workItemId, [
      ...(refsOf.get(each.workItemId) ?? []),
      { id: each.id, systemId: each.systemId, url: each.url, name: each.name },
    ]);
  }
  const workItems = rows.map((row) => ({
    ...row,
    teamIds: teamsOf.get(row.id) ?? [],
    tagIds: tagsOf.get(row.id) ?? [],
    serviceIds: servicesOf.get(row.id) ?? [],
    typeIds: typesOf.get(row.id) ?? [],
    externalRefs: refsOf.get(row.id) ?? [],
  }));
  const projects = reader
    .select({ id: project.id, name: project.name })
    .from(project)
    .where(inArray(project.id, ids))
    .all();
  const assignments = reader
    .select({
      workItemId: assignment.workItemId,
      stepId: assignment.stepId,
      personId: assignment.personId,
    })
    .from(assignment)
    .innerJoin(workItem, eq(assignment.workItemId, workItem.id))
    .where(inArray(workItem.projectId, ids))
    .all();
  const steps = reader
    .select({ id: step.id, name: step.name })
    .from(step)
    .where(inArray(step.projectId, ids))
    .all();
  const named = [...new Set(assignments.map((each) => each.personId))];
  const people =
    named.length === 0
      ? []
      : reader
          .select({ id: person.id, name: person.name, kind: person.kind })
          .from(person)
          .where(inArray(person.id, named))
          .all();
  // Read in the same transaction as the rows above, so the numbers the
  // confirmation prints are the numbers the removal is about to release. A second
  // read afterwards would answer for a deployment that had moved on.
  const stated =
    teamId === null
      ? []
      : reader
          .select({
            projectId: projectTeamCapacity.projectId,
            size: projectTeamCapacity.size,
          })
          .from(projectTeamCapacity)
          .where(
            and(
              eq(projectTeamCapacity.serviceTeamId, teamId),
              inArray(projectTeamCapacity.projectId, ids),
            ),
          )
          .all();
  return {
    workItems,
    projects,
    assignments,
    steps,
    people,
    members,
    capacityOf: new Map(stated.map((row) => [row.projectId, row.size])),
  };
}

/** The projects holding a work item this removal would touch, with no duplicates. */
function projectsOf(rows: readonly { projectId: string }[]): string[] {
  return [...new Set(rows.map((each) => each.projectId))];
}

/**
 * The global directory: teams, people, who belongs to which, and who is doing
 * what.
 *
 * One repository rather than three because the three are read together on
 * every request that needs any of them — a picker offers people grouped by
 * team, and splitting them would mean three round trips to answer one
 * question.
 *
 * Both `addTeam` and `addPerson` are idempotent **by name**, at the database
 * rather than by asking first: this list is typed into by everybody, two
 * people adding `Platform` at the same moment both pass a check-then-insert,
 * and only a constraint stops the second one.
 */
export class DirectoryRepository implements DirectoryStore {
  constructor(
    private readonly db: SQLiteBunDatabase,
    private readonly gate: Gate,
  ) {}

  /**
   * Every team, by name.
   *
   * **The projection is written out**, and that is the point of it: a bare
   * `select()` reads every column drizzle knows about, so the retired
   * `service_team.size` used to travel from here into `/api/teams` without the
   * string `serviceTeam.size` appearing anywhere for a grep to find. Naming the
   * two columns is what makes `verify.md`'s grep for readers of that column
   * decisive — `capacity-per-project` D4, and this file is the one place the
   * column could still have been read by accident.
   *
   * Every other read of this table below is projected for the same reason.
   */
  async listTeams(): Promise<TeamWithServices[]> {
    const teams = await this.db
      .select({ id: serviceTeam.id, name: serviceTeam.name })
      .from(serviceTeam)
      .orderBy(asc(serviceTeam.name));
    // Two queries rather than a join, exactly as `listPeople` reads
    // memberships: a join would repeat each team's row once per service it
    // owns, and the caller would have to fold them back. The map is
    // directory-sized on both axes.
    const owned = await this.db
      .select({ teamId: teamService.teamId, serviceId: teamService.serviceId })
      .from(teamService)
      .orderBy(asc(teamService.serviceId));
    const servicesOf = new Map<string, string[]>();
    for (const row of owned) {
      servicesOf.set(row.teamId, [...(servicesOf.get(row.teamId) ?? []), row.serviceId]);
    }
    // A team owning nothing is the empty array rather than an absent field: the
    // signal reads "no team here owns this service", and an undefined would
    // make that sentence depend on which teams happened to have rows.
    return teams.map((each) => ({ ...each, serviceIds: servicesOf.get(each.id) ?? [] }));
  }

  async addTeam(toAdd: ServiceTeam, stamp: WriteStamp): Promise<ServiceTeam> {
    return await this.gate.enter(async () => {
      await this.db
        .insert(serviceTeam)
        .values({ ...toAdd, ...auditOnCreate(stamp) })
        .onConflictDoNothing();
      // The row that is there now, which is the earlier one when two arrived at
      // once. Returning `toAdd` would hand back an id nothing holds.
      const rows = await this.db
        .select({ id: serviceTeam.id, name: serviceTeam.name })
        .from(serviceTeam)
        .where(eq(serviceTeam.name, toAdd.name))
        .limit(1);
      const found = rows.at(0);
      if (found === undefined) throw new Error(`team vanished after insert: ${toAdd.name}`);
      return found;
    });
  }

  /** Every tag in the global directory, by name — {@link DirectoryStore.listTeams}' shape. */
  async listTags(): Promise<Tag[]> {
    return this.db.select({ id: tag.id, name: tag.name }).from(tag).orderBy(asc(tag.name));
  }

  /**
   * Adds a tag, idempotently **by name**, and answers the row that is there.
   *
   * `addTeam`'s shape and `addTeam`'s argument: this list is typed into by
   * everybody, two people adding `regulatory` at the same moment both pass a
   * check-then-insert, and only the unique index stops the second one. What
   * comes back is the row the table holds — the *earlier* one when two arrived
   * at once — because returning `toAdd` would hand a caller an id nothing has.
   *
   * The projection is written out for `listTeams`' reason: a bare `select()`
   * would carry whatever columns this table grows, and a tag is deliberately
   * two of them.
   */
  async addTag(toAdd: Tag, stamp: WriteStamp): Promise<Tag> {
    return await this.gate.enter(async () => {
      await this.db
        .insert(tag)
        .values({ ...toAdd, ...auditOnCreate(stamp) })
        .onConflictDoNothing();
      const rows = await this.db
        .select({ id: tag.id, name: tag.name })
        .from(tag)
        .where(eq(tag.name, toAdd.name))
        .limit(1);
      const found = rows.at(0);
      if (found === undefined) throw new Error(`tag vanished after insert: ${toAdd.name}`);
      return found;
    });
  }

  /** Every service in the global directory, by name — {@link DirectoryStore.listTeams}' shape. */
  async listServices(): Promise<Service[]> {
    return this.db
      .select({ id: service.id, name: service.name })
      .from(service)
      .orderBy(asc(service.name));
  }

  /**
   * Adds a service, idempotently **by name**, and answers the row that is there
   * — {@link DirectoryRepository.addTag}'s shape and every one of its reasons.
   */
  async addService(toAdd: Service, stamp: WriteStamp): Promise<Service> {
    return await this.gate.enter(async () => {
      await this.db
        .insert(service)
        .values({ ...toAdd, ...auditOnCreate(stamp) })
        .onConflictDoNothing();
      const rows = await this.db
        .select({ id: service.id, name: service.name })
        .from(service)
        .where(eq(service.name, toAdd.name))
        .limit(1);
      const found = rows.at(0);
      if (found === undefined) throw new Error(`service vanished after insert: ${toAdd.name}`);
      return found;
    });
  }

  /**
   * Renames one team and replaces the services it owns, or reports the name
   * being held, the row being gone, or a service that is not there.
   *
   * A refused patch writes nothing. The team carries no revision of its own —
   * it is global rather than a satellite of any project — so what tells an open
   * project about the new name is the event the service publishes after this
   * commits, not a counter moved here. **The ownership map moves no revision
   * either, and that is the rule rather than an omission:** it labels no work
   * item and the scheduler never reads it, so a plan rendered a second ago is
   * still correct.
   *
   * **The services are validated before anything is written, inside the same
   * transaction** — `patchPerson`'s rule and its reason: returning from a
   * drizzle transaction callback *commits* it, so a refusal decided after the
   * name had been set would answer `unknown_service` and leave the rename in the
   * database. The ids are deduplicated here rather than trusted from the
   * caller, because the primary key would turn a client naming a service twice
   * into a 500 for a patch that means exactly what it says.
   *
   * Proof: with the `teamName` unique-violation branch removed, `refuses a name
   * another team holds, naming the survivor` fails with the raw
   * `SQLITE_CONSTRAINT_UNIQUE` instead of a refusal — the 500 this translation
   * exists to prevent. With the empty-`returning` branch reporting success,
   * `refuses a team that is not there` answers `ok` about a row nothing holds.
   * Both watched 2026-08-09.
   */
  async patchTeam(
    teamId: string,
    patch: TeamPatch,
    stamp: WriteStamp,
  ): Promise<ServiceTeamWritten> {
    return await this.gate.enter(async () => {
      await Promise.resolve();
      const wanted = patch.serviceIds === undefined ? null : [...new Set(patch.serviceIds)];
      try {
        return this.db.transaction((tx) => {
          const held = tx
            .select({ id: serviceTeam.id, name: serviceTeam.name })
            .from(serviceTeam)
            .where(eq(serviceTeam.id, teamId))
            .all();
          const team = held.at(0);
          if (team === undefined) return { ok: false, reason: 'not_found' };
          if (wanted !== null && wanted.length > 0) {
            const found = tx
              .select({ id: service.id })
              .from(service)
              .where(inArray(service.id, wanted))
              .all();
            if (found.length !== wanted.length) return { ok: false, reason: 'unknown_service' };
          }
          if (patch.name !== undefined) {
            tx.update(serviceTeam)
              .set({ name: patch.name, ...auditOnUpdate(stamp) })
              .where(eq(serviceTeam.id, teamId))
              .run();
          }
          if (wanted !== null) {
            // Whole-set semantics: the rows that were there go, whichever they
            // were. Deleting and re-inserting rather than diffing because the map
            // has no payload beyond the pair — there is nothing in a surviving row
            // worth keeping.
            tx.delete(teamService).where(eq(teamService.teamId, teamId)).run();
            if (wanted.length > 0) {
              tx.insert(teamService)
                .values(wanted.map((serviceId) => ({ teamId, serviceId, ...auditOnCreate(stamp) })))
                .run();
            }
          }
          const rows = tx
            .select({ id: serviceTeam.id, name: serviceTeam.name })
            .from(serviceTeam)
            .where(eq(serviceTeam.id, teamId))
            .all();
          const patched = rows.at(0);
          if (patched === undefined) throw new Error(`team vanished mid-patch: ${teamId}`);
          const serviceIds = tx
            .select({ serviceId: teamService.serviceId })
            .from(teamService)
            .where(eq(teamService.teamId, teamId))
            .orderBy(asc(teamService.serviceId))
            .all();
          // Read here rather than afterwards: these are the very rows the patch
          // is about, and a second read would answer for a directory that had
          // already moved on.
          return {
            ok: true,
            team: { ...patched, serviceIds: serviceIds.map((row) => row.serviceId) },
            projectIds: this.projectsLabelled(tx, teamId),
          };
        });
      } catch (err) {
        if (isUniqueViolation(err, UNIQUE_INDEXES.teamName)) return { ok: false, reason: 'taken' };
        throw err;
      }
    });
  }

  /**
   * Renames one tag, or reports the name being held or the row being gone —
   * {@link DirectoryRepository.renameTeam}'s shape exactly.
   *
   * A refused rename writes nothing. The tag carries no revision of its own, so
   * what tells an open project about the new name is the event the service
   * publishes after this commits; the **work items** are not bumped, and that is
   * deliberate — a rename changes what a label is called, not which rows carry
   * it, so no journal entry is made stale by it.
   */
  async renameTag(tagId: string, name: string, stamp: WriteStamp): Promise<TagWritten> {
    return await this.gate.enter(async () => {
      await Promise.resolve();
      try {
        return this.db.transaction((tx) => {
          const rows = tx
            .update(tag)
            .set({ name, ...auditOnUpdate(stamp) })
            .where(eq(tag.id, tagId))
            .returning({ id: tag.id, name: tag.name })
            .all();
          const renamed = rows.at(0);
          if (renamed === undefined) return { ok: false, reason: 'not_found' };
          return { ok: true, tag: renamed, projectIds: this.projectsTagged(tx, tagId) };
        });
      } catch (err) {
        if (isUniqueViolation(err, UNIQUE_INDEXES.tagName)) return { ok: false, reason: 'taken' };
        throw err;
      }
    });
  }

  /**
   * Renames one service — {@link DirectoryRepository.renameTag}'s shape exactly,
   * including what it deliberately does **not** do.
   *
   * The work items are not bumped. A rename changes what a service is called,
   * not which rows deliver it, so no journal entry is made stale by it and no
   * undo has to refuse afterwards. What tells an open plan about the new name is
   * the event the service publishes once this commits.
   */
  async renameService(serviceId: string, name: string, stamp: WriteStamp): Promise<ServiceWritten> {
    return await this.gate.enter(async () => {
      await Promise.resolve();
      try {
        return this.db.transaction((tx) => {
          const rows = tx
            .update(service)
            .set({ name, ...auditOnUpdate(stamp) })
            .where(eq(service.id, serviceId))
            .returning({ id: service.id, name: service.name })
            .all();
          const renamed = rows.at(0);
          if (renamed === undefined) return { ok: false, reason: 'not_found' };
          return { ok: true, service: renamed, projectIds: this.projectsServiced(tx, serviceId) };
        });
      } catch (err) {
        if (isUniqueViolation(err, UNIQUE_INDEXES.serviceName))
          return { ok: false, reason: 'taken' };
        throw err;
      }
    });
  }

  async listPeople(): Promise<PersonWithTeams[]> {
    // Projected, as every read that crosses this boundary is: the audit columns
    // are recorded and not published, and a bare `select()` would put three
    // fields nobody asked for into `Person` and from there into the payload.
    const people = await this.db
      .select({ id: person.id, name: person.name, kind: person.kind })
      .from(person)
      .orderBy(asc(person.name));
    const memberships = await this.db
      .select({ personId: personTeam.personId, serviceTeamId: personTeam.serviceTeamId })
      .from(personTeam);
    const teamsOf = new Map<string, string[]>();
    for (const row of memberships) {
      teamsOf.set(row.personId, [...(teamsOf.get(row.personId) ?? []), row.serviceTeamId]);
    }
    // A person with no memberships is a free agent, and that is the empty
    // array rather than a magic team id — see `personTeam`'s note.
    return people.map((each) => ({ ...each, teamIds: teamsOf.get(each.id) ?? [] }));
  }

  /**
   * Adds a person and their memberships in **one** transaction, with the teams
   * read inside it.
   *
   * Still idempotent by name — two people typing `Kat` at the same moment must
   * not make two of her — but the memberships no longer ride behind the insert
   * on their own: `person_team.service_team_id` is a foreign key, so a team
   * removed while somebody had the picker open used to reach it and answer 500.
   *
   * Proof: with the `unknown_team` read removed, `refuses the whole create when
   * a teamId names a team that has been removed` fails on a 500 whose body is
   * not even JSON — the raw constraint failure this replaces; watched
   * 2026-08-09.
   */
  async addPerson(
    toAdd: PersonInsert,
    teamIds: readonly string[],
    stamp: WriteStamp,
  ): Promise<PersonAdded> {
    return await this.gate.enter(async () => {
      await Promise.resolve();
      const wanted = [...new Set(teamIds)];
      return this.db.transaction((tx) => {
        if (wanted.length > 0) {
          const held = tx
            .select({ id: serviceTeam.id })
            .from(serviceTeam)
            .where(inArray(serviceTeam.id, wanted))
            .all();
          if (held.length !== wanted.length) return { ok: false, reason: 'unknown_team' };
        }
        tx.insert(person)
          .values({ ...toAdd, ...auditOnCreate(stamp) })
          .onConflictDoNothing()
          .run();
        // The row that is there now, which is the earlier one when two arrived at
        // once. Returning `toAdd` would hand back an id nothing holds.
        const rows = tx
          .select({ id: person.id, name: person.name, kind: person.kind })
          .from(person)
          .where(eq(person.name, toAdd.name))
          .all();
        const found = rows.at(0);
        if (found === undefined) throw new Error(`person vanished after insert: ${toAdd.name}`);
        if (wanted.length > 0) {
          tx.insert(personTeam)
            .values(
              wanted.map((serviceTeamId) => ({
                personId: found.id,
                serviceTeamId,
                ...auditOnCreate(stamp),
              })),
            )
            .onConflictDoNothing()
            .run();
        }
        return { ok: true, person: found };
      });
    });
  }

  /**
   * Renames a person, marks them a person or an agent, and replaces their
   * memberships, in one transaction.
   *
   * **The teams are validated before anything is written, inside the same
   * transaction.** Returning from a drizzle transaction callback *commits* it,
   * so a refusal decided after the name had been set would answer
   * `unknown_team` and leave the rename in the database — the half-applied
   * state the spec says is not observable. Validating first is what makes the
   * refusal write nothing without needing a rollback.
   *
   * The ids are deduplicated here rather than trusted from the caller: the
   * primary key would refuse the second copy, turning a client sending a team
   * twice into a 500 for a patch that means exactly what it says.
   *
   * Proof: with the team validation moved below the name update, `refuses the
   * whole patch for a team that is not there, rename included` fails — `Katrin`
   * survived a patch that answered `unknown_team`. With the present-person
   * guard removed, `refuses a name of whitespace alone, and a person that is
   * not there` answers `ok` for an id nothing holds — a patch of no rows
   * reporting a person. With the
   * `personName` unique-violation branch removed, `refuses a name another person
   * holds, naming the survivor` fails with the raw `SQLITE_CONSTRAINT_UNIQUE`.
   * All watched 2026-08-09.
   */
  async patchPerson(
    personId: string,
    patch: PersonPatch,
    stamp: WriteStamp,
  ): Promise<PersonWritten> {
    return await this.gate.enter(async () => {
      await Promise.resolve();
      const wanted = patch.teamIds === undefined ? null : [...new Set(patch.teamIds)];
      try {
        return this.db.transaction((tx) => {
          const held = tx
            .select({ id: person.id })
            .from(person)
            .where(eq(person.id, personId))
            .all();
          if (held.length === 0) return { ok: false, reason: 'not_found' };
          if (wanted !== null && wanted.length > 0) {
            const found = tx
              .select({ id: serviceTeam.id })
              .from(serviceTeam)
              .where(inArray(serviceTeam.id, wanted))
              .all();
            if (found.length !== wanted.length) return { ok: false, reason: 'unknown_team' };
          }
          // One `set`, not one per field: two updates would be two revisions of
          // the same row for a patch the caller sent as one thing, and the second
          // would have to be skipped when only the first field was named anyway.
          const columns = {
            ...(patch.name === undefined ? {} : { name: patch.name }),
            ...(patch.kind === undefined ? {} : { kind: patch.kind }),
          };
          if (Object.keys(columns).length > 0) {
            // The stamp rides inside the guard, not outside it: this row's
            // `updated_at` moves when this row's own columns move, and a patch
            // that only re-drew the team map wrote nothing here to date.
            tx.update(person)
              .set({ ...columns, ...auditOnUpdate(stamp) })
              .where(eq(person.id, personId))
              .run();
          }
          if (wanted !== null) {
            tx.delete(personTeam).where(eq(personTeam.personId, personId)).run();
            if (wanted.length > 0) {
              tx.insert(personTeam)
                .values(
                  wanted.map((serviceTeamId) => ({
                    personId,
                    serviceTeamId,
                    ...auditOnCreate(stamp),
                  })),
                )
                .run();
            }
          }
          const rows = tx
            .select({ id: person.id, name: person.name, kind: person.kind })
            .from(person)
            .where(eq(person.id, personId))
            .all();
          const patched = rows.at(0);
          if (patched === undefined) throw new Error(`person vanished mid-patch: ${personId}`);
          const teamIds = tx
            .select({ serviceTeamId: personTeam.serviceTeamId })
            .from(personTeam)
            .where(eq(personTeam.personId, personId))
            .all();
          return {
            ok: true,
            person: { ...patched, teamIds: teamIds.map((row) => row.serviceTeamId) },
            projectIds: this.projectsAssigning(tx, personId),
          };
        });
      } catch (err) {
        if (isUniqueViolation(err, UNIQUE_INDEXES.personName))
          return { ok: false, reason: 'taken' };
        throw err;
      }
    });
  }

  /**
   * The projects a person's assignments reach into, read for the refusal that
   * names them.
   *
   * A **fast path**, never the authority: see {@link DirectoryStore.usageOfPerson}.
   * `members` is empty by construction — a person's own memberships name nobody
   * else, so a removal that would drop only them has nothing to warn about.
   */
  async usageOfPerson(personId: string): Promise<DirectoryUsageRows> {
    await Promise.resolve();
    return usageRowsIn(this.db, this.projectsAssigning(this.db, personId), []);
  }

  /**
   * What points at one tag right now — a **fast path** for the confirmation,
   * never the authority for it. {@link DirectoryRepository.removeTag} decides.
   *
   * No `teamId` argument and so no capacity read: a tag has no pool, so
   * `capacityOf` stays empty and `directoryUsageOfTag` has nothing to release.
   * That the parameter is simply absent is the model rule in the signature.
   */
  async usageOfTag(tagId: string): Promise<DirectoryUsageRows> {
    await Promise.resolve();
    return usageRowsIn(this.db, this.projectsTagged(this.db, tagId), []);
  }

  /**
   * Counts, decides and deletes in **one** transaction — `removeTeam`'s shape
   * and `removeTeam`'s argument: the count *is* the decision, so a labelling
   * written between an unconfirmed caller's own count and this statement
   * refuses the removal rather than being deleted by it.
   *
   * **Two statements shorter than the team's**, and both absences are the
   * design. There is no `UPDATE … SET tagId = null`, because there is no column
   * — the labelling is rows in `work_item_tag` and the foreign key's cascade
   * takes them when the `tag` row goes. And there is no membership table to
   * clear: nobody belongs to a tag.
   *
   * The work items are still bumped, and that is not optional: their tag sets
   * changed, so a journal entry holding the old revision must not undo against
   * a plan whose labelling has moved under it. The cascade does not move a
   * revision, so this does it explicitly.
   *
   * Proof: `bumpWorkItems` removed and `moves the revision of every row that
   * lost a tag` fails on the row coming back at the revision it had — a stale
   * undo that this repo has already shipped once, for people. Watched
   * 2026-08-20.
   */
  async removeTag(tagId: string, cascade: boolean, stamp: WriteStamp): Promise<DirectoryRemoved> {
    return await this.gate.enter(async () => {
      await Promise.resolve();
      return this.db.transaction((tx) => {
        const labelled = tx
          .select({ id: workItem.id, projectId: workItem.projectId })
          .from(workItemTag)
          .innerJoin(workItem, eq(workItemTag.workItemId, workItem.id))
          .where(eq(workItemTag.tagId, tagId))
          .all();
        if (!cascade && labelled.length > 0) {
          return {
            ok: false,
            reason: 'in_use',
            usage: usageRowsIn(tx, projectsOf(labelled), []),
          };
        }
        bumpWorkItems(
          tx,
          labelled.map((each) => each.id),
          stamp,
        );
        // The `work_item_tag` rows are **not** deleted here: `tag_id` cascades,
        // which is the one place this dimension deliberately differs from
        // `step_progress`. See the migration for why a label may be taken by the
        // database where a statement about somebody's work may not.
        const removed = tx.delete(tag).where(eq(tag.id, tagId)).returning({ id: tag.id }).all();
        if (removed.length === 0) return { ok: false, reason: 'not_found' };
        return {
          ok: true,
          removal: {
            workItemIds: labelled.map((each) => each.id),
            projectIds: projectsOf(labelled),
          },
        };
      });
    });
  }

  /** Every external system in the global directory, by name. */
  async listExternalSystems(): Promise<ExternalSystem[]> {
    return this.db
      .select({ id: externalSystem.id, name: externalSystem.name })
      .from(externalSystem)
      .orderBy(asc(externalSystem.name));
  }

  /**
   * Every work item type in the global directory, by name —
   * {@link DirectoryRepository.listTags}' shape.
   */
  async listWorkItemTypes(): Promise<WorkItemType[]> {
    return this.db
      .select({ id: workItemType.id, name: workItemType.name })
      .from(workItemType)
      .orderBy(asc(workItemType.name));
  }

  /**
   * Adds a work item type, idempotently **by name**, answering the row that is
   * there — {@link DirectoryRepository.addTag}'s shape and every one of its
   * reasons, including returning the *earlier* row when two callers raced.
   */
  async addWorkItemType(toAdd: WorkItemType, stamp: WriteStamp): Promise<WorkItemType> {
    return await this.gate.enter(async () => {
      await this.db
        .insert(workItemType)
        .values({ ...toAdd, ...auditOnCreate(stamp) })
        .onConflictDoNothing();
      const rows = await this.db
        .select({ id: workItemType.id, name: workItemType.name })
        .from(workItemType)
        .where(eq(workItemType.name, toAdd.name))
        .limit(1);
      const found = rows.at(0);
      if (found === undefined)
        throw new Error(`work item type vanished after insert: ${toAdd.name}`);
      return found;
    });
  }

  /**
   * Renames one work item type — {@link DirectoryRepository.renameTag}'s shape
   * exactly, including what it deliberately does **not** do: the work items are
   * not bumped, because a rename changes what a label is called and not which
   * rows carry it, so no journal entry is made stale by it.
   */
  async renameWorkItemType(
    typeId: string,
    name: string,
    stamp: WriteStamp,
  ): Promise<WorkItemTypeWritten> {
    return await this.gate.enter(async () => {
      await Promise.resolve();
      try {
        return this.db.transaction((tx) => {
          const rows = tx
            .update(workItemType)
            .set({ name, ...auditOnUpdate(stamp) })
            .where(eq(workItemType.id, typeId))
            .returning({ id: workItemType.id, name: workItemType.name })
            .all();
          const renamed = rows.at(0);
          if (renamed === undefined) return { ok: false, reason: 'not_found' };
          return { ok: true, workItemType: renamed, projectIds: this.projectsTyped(tx, typeId) };
        });
      } catch (err) {
        if (isUniqueViolation(err, UNIQUE_INDEXES.workItemTypeName))
          return { ok: false, reason: 'taken' };
        throw err;
      }
    });
  }

  /**
   * What points at one work item type right now — a **fast path** for the
   * confirmation, never the authority for it.
   * {@link DirectoryRepository.removeWorkItemType} decides.
   *
   * No `teamId` argument and so no capacity read, for {@link usageOfTag}'s
   * reason: a type has no pool and nothing about it is ever spent.
   */
  async usageOfWorkItemType(typeId: string): Promise<DirectoryUsageRows> {
    await Promise.resolve();
    return usageRowsIn(this.db, this.projectsTyped(this.db, typeId), []);
  }

  /**
   * Counts what carries the type, refuses an unconfirmed removal that would
   * unlabel anything, and otherwise deletes the type — all in one transaction.
   * {@link DirectoryRepository.removeTag}'s shape and its argument.
   *
   * The work items are still bumped, and that is not optional: their type sets
   * changed, so a journal entry holding the old revision must not undo against a
   * plan whose labelling has moved under it. The cascade does not move a
   * revision, so this does it explicitly.
   *
   * Proof: `bumpWorkItems` removed and `moves the revision of every row that
   * lost a type` fails on the row coming back at the revision it had — the same
   * stale undo `removeTag` carries a proof for, watched 2026-08-30.
   */
  async removeWorkItemType(
    typeId: string,
    cascade: boolean,
    stamp: WriteStamp,
  ): Promise<DirectoryRemoved> {
    return await this.gate.enter(async () => {
      await Promise.resolve();
      return this.db.transaction((tx) => {
        const labelled = tx
          .select({ id: workItem.id, projectId: workItem.projectId })
          .from(workItemWorkItemType)
          .innerJoin(workItem, eq(workItemWorkItemType.workItemId, workItem.id))
          .where(eq(workItemWorkItemType.typeId, typeId))
          .all();
        if (!cascade && labelled.length > 0) {
          return {
            ok: false,
            reason: 'in_use',
            usage: usageRowsIn(tx, projectsOf(labelled), []),
          };
        }
        bumpWorkItems(
          tx,
          labelled.map((each) => each.id),
          stamp,
        );
        // The `work_item_work_item_type` rows are **not** deleted here: `type_id`
        // cascades, for `work_item_tag`'s reason unchanged — a label may be taken
        // by the database where a statement about somebody's work may not.
        const removed = tx
          .delete(workItemType)
          .where(eq(workItemType.id, typeId))
          .returning({ id: workItemType.id })
          .all();
        if (removed.length === 0) return { ok: false, reason: 'not_found' };
        return {
          ok: true,
          removal: {
            workItemIds: labelled.map((each) => each.id),
            projectIds: projectsOf(labelled),
          },
        };
      });
    });
  }

  /**
   * What points at one service right now — a **fast path** for the
   * confirmation, never the authority for it.
   * {@link DirectoryRepository.removeService} decides.
   *
   * No `teamId` argument and so no capacity read, for {@link usageOfTag}'s
   * reason: a service has no pool. The `team_service` rows the removal will also
   * take are deliberately not read here either — losing an ownership claim about
   * a service that is going is not an effect on any plan (design.md D7).
   */
  async usageOfService(serviceId: string): Promise<DirectoryUsageRows> {
    await Promise.resolve();
    return usageRowsIn(this.db, this.projectsServiced(this.db, serviceId), []);
  }

  /**
   * Counts, decides and deletes in **one** transaction —
   * {@link DirectoryRepository.removeTag}'s shape and its argument: the count is
   * **itself** the decision, so a labelling written between an unconfirmed
   * caller's own count and this statement refuses the removal rather than being
   * deleted by it.
   *
   * There is no `UPDATE work_item SET service_id = null` here and that is the
   * design, not an omission: the column's `ON DELETE SET NULL` clears it, which
   * is the one place this dimension differs from the tag's cascade-of-rows. The
   * `team_service` rows go the same way, on their own foreign key.
   *
   * The work items **are** bumped explicitly, because neither a `SET NULL` nor a
   * cascade moves a revision, and a journal entry holding the old one must not
   * undo against a row whose service has changed under it. `removeTag`'s
   * argument, and the stale undo this repo has already shipped once for people.
   */
  async removeService(
    serviceId: string,
    cascade: boolean,
    stamp: WriteStamp,
  ): Promise<DirectoryRemoved> {
    return await this.gate.enter(async () => {
      await Promise.resolve();
      return this.db.transaction((tx) => {
        // Off the join since task 10.2, `removeTag`'s read exactly. The column is
        // not consulted: a row this release labelled has no `service_id` to find,
        // so the old read would have bumped no revision and confirmed no usage for
        // exactly the rows the removal actually empties.
        const labelled = tx
          .select({ id: workItem.id, projectId: workItem.projectId })
          .from(workItemService)
          .innerJoin(workItem, eq(workItemService.workItemId, workItem.id))
          .where(eq(workItemService.serviceId, serviceId))
          .all();
        if (!cascade && labelled.length > 0) {
          return {
            ok: false,
            reason: 'in_use',
            usage: usageRowsIn(tx, projectsOf(labelled), []),
          };
        }
        bumpWorkItems(
          tx,
          labelled.map((each) => each.id),
          stamp,
        );
        const removed = tx
          .delete(service)
          .where(eq(service.id, serviceId))
          .returning({ id: service.id })
          .all();
        if (removed.length === 0) return { ok: false, reason: 'not_found' };
        return {
          ok: true,
          removal: {
            workItemIds: labelled.map((each) => each.id),
            projectIds: projectsOf(labelled),
          },
        };
      });
    });
  }

  /** The same for a team: the projects it labels work in, the people in it, and its own row. */
  async usageOfTeam(teamId: string): Promise<DirectoryUsageRows> {
    await Promise.resolve();
    return usageRowsIn(
      this.db,
      this.projectsLabelled(this.db, teamId),
      this.membersOf(this.db, teamId),
      teamId,
    );
  }

  /**
   * Counts, decides and deletes in **one** transaction.
   *
   * The count is inside because it *is* the decision, not a report about it —
   * the rule `StepRepository.remove` sets out at length. An assignment written
   * between an unconfirmed caller's own count and this statement refuses the
   * removal rather than being deleted by it: the usage that caller was shown
   * never mentioned it.
   *
   * The assignments are deleted **explicitly** although `assignment.person_id`
   * cascades, and the memberships although `person_team.person_id` does, so
   * that what this reports having removed is what these statements removed
   * rather than what the database did behind them.
   *
   * Proof, both watched 2026-08-09: with this transaction's own count made
   * unreachable, so that only the caller's earlier read decides, `refuses a
   * removal when an assignment lands after the count` deletes the person and
   * the assignment the caller was never shown. With `bumpWorkItems` removed,
   * `removes a person on the second, explicit call, and moves what lost a row`
   * fails on the work item's revision — a journal entry holding the old number
   * would have undone against a directory that had changed under it.
   */
  async removePerson(
    personId: string,
    cascade: boolean,
    stamp: WriteStamp,
  ): Promise<DirectoryRemoved> {
    return await this.gate.enter(async () => {
      await Promise.resolve();
      return this.db.transaction((tx) => {
        const held = tx
          .select({ workItemId: assignment.workItemId })
          .from(assignment)
          .where(eq(assignment.personId, personId))
          .all();
        if (!cascade && held.length > 0) {
          return {
            ok: false,
            reason: 'in_use',
            usage: usageRowsIn(tx, this.projectsAssigning(tx, personId), []),
          };
        }
        const projectIds = this.projectsAssigning(tx, personId);
        tx.delete(assignment).where(eq(assignment.personId, personId)).run();
        tx.delete(personTeam).where(eq(personTeam.personId, personId)).run();
        const removed = tx.delete(person).where(eq(person.id, personId)).returning().all();
        // Nothing was deleted, so there was nothing here to delete: somebody
        // else's removal committed first. This request changed nothing and must
        // move no revision — the two deletes above touched nothing for the same
        // reason.
        if (removed.length === 0) return { ok: false, reason: 'not_found' };
        const workItemIds = [...new Set(held.map((each) => each.workItemId))];
        bumpWorkItems(tx, workItemIds, stamp);
        return { ok: true, removal: { workItemIds, projectIds } };
      });
    });
  }

  /**
   * Removes a team and revises every work item losing its join membership once.
   * The legacy singleton is cleared separately, without a second revision bump.
   *
   * Proof: restoring legacy-only revision stamping made `stamps each affected
   * row once when removing team zzz` fail (revision 1, expected 2; updatedAt 1,
   * expected 42), and `refuses a rename undo after removal of a secondary team`
   * fail with `expected a refusal, got: rename “Renamed”`.
   *
   * `work_item.service_team_id` carries a foreign key with no `ON DELETE`
   * action — measured 2026-08-14, against what this comment claimed — so the
   * database refuses this delete outright while any work item still names the
   * team, and cleans up nothing. The `UPDATE` below is what makes the removal
   * possible at all; without it the team can never be deleted, which is the
   * same bug wearing the opposite hat. The join rows need no statement: they
   * cascade.
   *
   * Proof, both watched 2026-08-09: with the label update removed, `a cascade
   * nulls every label and moves those work items' revisions` fails on the
   * dangling id the test reads back off the work item — the dangle nothing else
   * would ever have reported. With this transaction's own count made
   * unreachable, `refuses a team removal when a membership or a label lands
   * after the count` takes both with it.
   */
  async removeTeam(teamId: string, cascade: boolean, stamp: WriteStamp): Promise<DirectoryRemoved> {
    return await this.gate.enter(async () => {
      await Promise.resolve();
      return this.db.transaction((tx) => {
        // Through the join, which is where a work item's teams live since
        // `team-sets`. The `UPDATE` below still nulls the column beside it, and
        // the join rows go by the cascade.
        const labelled = tx
          .select({ id: workItem.id, projectId: workItem.projectId })
          .from(workItemTeam)
          .innerJoin(workItem, eq(workItemTeam.workItemId, workItem.id))
          .where(eq(workItemTeam.teamId, teamId))
          .all();
        const members = this.membersOf(tx, teamId);
        if (!cascade && (labelled.length > 0 || members.length > 0)) {
          return {
            ok: false,
            reason: 'in_use',
            // The capacity rows are read in this same transaction as the count
            // that refused, so the numbers the confirmation names are the ones
            // that were in force when the removal was refused — see
            // {@link DirectoryUsageRows.capacityOf}. Per project since
            // `capacity-per-project`: the team row this used to read carried one
            // number for every plan, and there is no such number now.
            usage: usageRowsIn(tx, projectsOf(labelled), members, teamId),
          };
        }
        bumpWorkItems(
          tx,
          labelled.map((each) => each.id),
          stamp,
        );
        tx.update(workItem)
          .set({ serviceTeamId: null, ...auditOnUpdate(stamp) })
          .where(eq(workItem.serviceTeamId, teamId))
          .run();
        tx.delete(personTeam).where(eq(personTeam.serviceTeamId, teamId)).run();
        const removed = tx
          .delete(serviceTeam)
          .where(eq(serviceTeam.id, teamId))
          .returning({ id: serviceTeam.id })
          .all();
        if (removed.length === 0) return { ok: false, reason: 'not_found' };
        return {
          ok: true,
          removal: {
            workItemIds: labelled.map((each) => each.id),
            projectIds: projectsOf(labelled),
          },
        };
      });
    });
  }

  /** Every project holding a work item this person is assigned on. */
  private projectsAssigning(reader: Reader, personId: string): string[] {
    return projectsOf(
      reader
        .select({ projectId: workItem.projectId })
        .from(assignment)
        .innerJoin(workItem, eq(assignment.workItemId, workItem.id))
        .where(eq(assignment.personId, personId))
        .all(),
    );
  }

  /**
   * Every project holding a work item labelled with this team — **any** row,
   * leaves and parents alike.
   *
   * The "any row" is the load-bearing word, and it is what makes inheritance
   * need no widening anywhere: a leaf draws its pool from the nearest labelled
   * ancestor, `effectiveTeamOf` walks `parentId` and never leaves a project, so
   * a project with an inheriting leaf always holds the labelled ancestor and is
   * already in this list.
   *
   * Proof: narrowed to rows nothing calls a parent, and
   * `tells a project the team reaches only through inheritance` failed with
   * `[]` where one `directory_changed` was owed — a plan whose every date had
   * just moved, and nobody told. Watched 2026-08-12.
   */
  private projectsLabelled(reader: Reader, teamId: string): string[] {
    return projectsOf(
      reader
        .select({ projectId: workItem.projectId })
        .from(workItemTeam)
        .innerJoin(workItem, eq(workItemTeam.workItemId, workItem.id))
        .where(eq(workItemTeam.teamId, teamId))
        .all(),
    );
  }

  /** {@link projectsLabelled} for the other dimension: the projects holding a tagged row. */
  private projectsTagged(reader: Reader, tagId: string): string[] {
    return projectsOf(
      reader
        .select({ projectId: workItem.projectId })
        .from(workItemTag)
        .innerJoin(workItem, eq(workItemTag.workItemId, workItem.id))
        .where(eq(workItemTag.tagId, tagId))
        .all(),
    );
  }

  /**
   * {@link projectsTagged} for the fourth dimension: the projects holding a row
   * that carries this type, read through the join because there is no column.
   * That method line for line, and the sameness is deliberate — the two
   * dimensions are stored alike and differ only in whether a *read* walks the
   * tree, which this query does not do for either.
   */
  private projectsTyped(reader: Reader, typeId: string): string[] {
    return projectsOf(
      reader
        .select({ projectId: workItem.projectId })
        .from(workItemWorkItemType)
        .innerJoin(workItem, eq(workItemWorkItemType.workItemId, workItem.id))
        .where(eq(workItemWorkItemType.typeId, typeId))
        .all(),
    );
  }

  /**
   * {@link projectsTagged} for the third dimension: the projects holding a row
   * that names this service.
   *
   * `projectsTagged` line for line since task 10.2. The sentence that stood here
   * — "no join to read, the label is a column, so this is the only one of the
   * three that asks `work_item` alone" — was the singleton's, and reading the
   * column now would name the projects the *outgoing* release labelled and miss
   * every row this one has written.
   */
  private projectsServiced(reader: Reader, serviceId: string): string[] {
    return projectsOf(
      reader
        .select({ projectId: workItem.projectId })
        .from(workItemService)
        .innerJoin(workItem, eq(workItemService.workItemId, workItem.id))
        .where(eq(workItemService.serviceId, serviceId))
        .all(),
    );
  }

  /** The people in one team, by name, which is the order a confirmation reads them in. */
  private membersOf(reader: Reader, teamId: string): { id: string; name: string }[] {
    return reader
      .select({ id: person.id, name: person.name })
      .from(person)
      .innerJoin(personTeam, eq(personTeam.personId, person.id))
      .where(eq(personTeam.serviceTeamId, teamId))
      .orderBy(asc(person.name))
      .all();
  }

  /**
   * Joins only this project's assignments and their person names in one statement.
   * The work-item project/id index leads into the assignment and person primary keys.
   *
   * Proof: restoring the unfiltered assignment read and filtering its answer
   * afterward made `materializes only assigned project rows and names during a
   * tiny tree read` fail on 41 materialized rows, expected at most 1. Making
   * project equality unindexable with `project_id || ''` preserved the payload
   * but failed that test on `SCAN assignment`, expected no scanned tables.
   */
  async assignmentsInProject(
    projectId: string,
  ): ReturnType<DirectoryStore['assignmentsInProject']> {
    const rows = await this.db
      .select({
        workItemId: assignment.workItemId,
        stepId: assignment.stepId,
        personId: assignment.personId,
        name: person.name,
      })
      .from(workItem)
      .innerJoin(assignment, eq(assignment.workItemId, workItem.id))
      .innerJoin(person, eq(person.id, assignment.personId))
      .where(eq(workItem.projectId, projectId))
      .orderBy(asc(person.name));
    return {
      assignments: rows.map(({ workItemId, stepId, personId }) => ({
        workItemId,
        stepId,
        personId,
      })),
      people: [
        ...new Map(rows.map(({ personId, name }) => [personId, { id: personId, name }])).values(),
      ],
    };
  }

  /**
   * Reads through the leading work-item column of the assignment primary key.
   *
   * Proof: removing the predicate made `uses an indexed prior assignment read
   * during one assignment write` fail on 40 materialized rows, expected at most
   * 1. Replacing the key by `work_item_id || ''` kept the answer but failed the
   * query-plan SEARCH assertion: expected true, received false.
   */
  async assignmentsFor(workItemId: string): ReturnType<DirectoryStore['assignmentsFor']> {
    return this.db
      .select({
        workItemId: assignment.workItemId,
        stepId: assignment.stepId,
        personId: assignment.personId,
      })
      .from(assignment)
      .where(eq(assignment.workItemId, workItemId));
  }

  /** Preserves subset callers without a global scan or an unbounded parameter list. */
  async assignmentsOf(workItemIds: readonly string[]): ReturnType<DirectoryStore['assignmentsOf']> {
    const assigned: Awaited<ReturnType<DirectoryStore['assignmentsOf']>> = [];
    for (const workItemId of new Set(workItemIds)) {
      assigned.push(...(await this.assignmentsFor(workItemId)));
    }
    return assigned;
  }

  /**
   * An assignment is a satellite of the work item it is on, so setting or
   * clearing one moves that work item's revision in the same transaction.
   * The person named has none of their own: they are a directory entry rather
   * than part of any plan.
   *
   * **The person is read in this same transaction as the write.** Otherwise a
   * client holding a picker rendered before somebody was removed reaches
   * `assignment.person_id`'s foreign key and is answered a 500 for a request
   * whose only fault is being out of date. A precheck one statement earlier
   * would not do: the removal fits in the gap between the two.
   *
   * Proof: with the `unknown_person` read removed, `refuses an assignment
   * naming a person who has been removed` fails with
   * `SQLiteError: FOREIGN KEY constraint failed` — the 500 this exists to
   * prevent; watched 2026-08-09.
   */
  async assign(
    workItemId: string,
    stepId: string,
    personId: string | null,
    stamp: WriteStamp,
  ): Promise<AssignmentWritten> {
    // The step's own refusal comes back from {@link writingStep} rather than
    // from a check in front of the write: the person is read inside the
    // transaction below because a person can go between a check and a write,
    // and the step is exactly the same race. What tells the two apart
    // afterwards is which row is missing, which is what that helper re-reads
    // (D6). Collected into a variable rather than returned through the helper
    // because the helper's answer is about the **step** alone.
    let refusal: AssignmentWritten = { ok: true };
    const written = await writingStep(this.db, stepId, () =>
      this.gate.enter(async () => {
        await Promise.resolve();
        refusal = this.db.transaction((tx) => {
          if (personId !== null) {
            const held = tx
              .select({ id: person.id })
              .from(person)
              .where(eq(person.id, personId))
              .all();
            if (held.length === 0) return { ok: false, reason: 'unknown_person' } as const;
          }
          if (personId === null) {
            // `and(...)`, not `&&`: the JS operator would evaluate to the second
            // condition alone and delete every step's assignment on this work item.
            tx.delete(assignment)
              .where(and(eq(assignment.workItemId, workItemId), eq(assignment.stepId, stepId)))
              .run();
          } else {
            tx.insert(assignment)
              .values({ workItemId, stepId, personId, ...auditOnCreate(stamp) })
              // The pair is the primary key, so reassigning is an update rather
              // than a constraint violation.
              .onConflictDoUpdate({
                target: [assignment.workItemId, assignment.stepId],
                set: { personId, ...auditOnUpdate(stamp) },
              })
              .run();
          }
          bumpWorkItems(tx, [workItemId], stamp);
          return { ok: true } as const;
        });
      }),
    );
    if (written === 'unknown_step') return { ok: false, reason: 'unknown_step' };
    return refusal;
  }
}
