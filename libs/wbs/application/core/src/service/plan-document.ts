import {
  type PlanDocument,
  planDocumentHeaderRequest,
  type PlanDocumentRequest,
  planDocumentRequest,
  validateSchema,
  type WorkItemTree,
} from '@wbs/contracts';

import type { Clock } from '../ports/clock';
import type { DirectoryStore, PersonWithTeams, TeamWithServices } from '../ports/directory-store';
import type { Project } from '../ports/project-store';
import type { ExternalSystem, Service, Tag, WorkItemType } from '../ports/work-item-store';
import type { CalendarMarkerListOutcome } from './calendar-marker.service';

type PlanDirectory = Pick<
  DirectoryStore,
  | 'listTeams'
  | 'listPeople'
  | 'listTags'
  | 'listServices'
  | 'listWorkItemTypes'
  | 'listExternalSystems'
>;

export interface PlanDocumentServiceOptions {
  directory: PlanDirectory;
  markers: {
    list(projectId: string): Promise<CalendarMarkerListOutcome>;
  };
  clock: Pick<Clock, 'now'>;
}

/**
 * Constructs the versioned archival document around the established project
 * tree projection.
 *
 * @throws when a file-local reference has no directory row. An unnamed default
 * would make the exported document impossible to restore faithfully.
 */
export class PlanDocumentService {
  constructor(private readonly options: PlanDocumentServiceOptions) {}

  async export(project: Project, tree: WorkItemTree): Promise<PlanDocument> {
    const [teams, people, tags, services, types, externalSystems, markerRead] = await Promise.all([
      this.options.directory.listTeams(),
      this.options.directory.listPeople(),
      this.options.directory.listTags(),
      this.options.directory.listServices(),
      this.options.directory.listWorkItemTypes(),
      this.options.directory.listExternalSystems(),
      this.options.markers.list(project.id),
    ]);
    if (!markerRead.ok) throw new Error(`project "${project.id}" disappeared during export`);
    const closure = referencedDirectory(tree, {
      teams,
      people,
      tags,
      services,
      types,
      externalSystems,
    });
    return {
      project,
      ...tree,
      document: {
        format: 'wbs-plan',
        version: 1,
        exportedAt: new Date(this.options.clock.now()).toISOString(),
      },
      settings: {
        name: project.name,
        restricted: project.restricted,
        estimateMethod: project.estimateMethod,
        depReach: project.depReach,
        pertWeights: project.pertWeights,
        // Proof: dropping estimateRounding made the mounted JSON export return
        // 500 instead of 200 before its unchanged project/workItems controls.
        estimateRounding: project.estimateRounding,
        startDate: project.startDate,
        solutionRef: project.solutionRef,
        optimizationEnabled: project.optimizationEnabled,
        scheduleEngine: project.scheduleEngine,
        scheduleObjective: project.scheduleObjective,
      },
      capacity: tree.teamCapacities.map(({ serviceTeamId, size }) => ({
        teamId: serviceTeamId,
        size,
      })),
      calendarMarkers: markerRead.value.map(({ id, date, name, color }) => ({
        id,
        date,
        name,
        color,
      })),
      directory: closure,
    };
  }
}

export type PlanDocumentClassification =
  | { ok: true; value: PlanDocumentRequest }
  | { ok: false; code: 'invalid_body' | 'unsupported_version'; path: string };

/**
 * Projects an archival payload to writable version-1 fields. Header validation
 * runs first so an unsupported version never gets interpreted as version 1.
 */
export async function classifyPlanDocument(input: unknown): Promise<PlanDocumentClassification> {
  const header = await validateSchema(planDocumentHeaderRequest, input);
  if (header.issues !== undefined) {
    return { ok: false, code: 'invalid_body', path: pathOf(header.issues[0]?.path) };
  }
  // Proof: moving this after version-1 validation made the mounted future-file
  // response invalid_body/workItems[3].priority instead of
  // unsupported_version/document.version.
  if (header.value.document.version !== 1) {
    return { ok: false, code: 'unsupported_version', path: 'document.version' };
  }
  const checked = await validateSchema(planDocumentRequest, input);
  return checked.issues === undefined
    ? { ok: true, value: checked.value }
    : { ok: false, code: 'invalid_body', path: pathOf(checked.issues[0]?.path) };
}

function pathOf(path: readonly (PropertyKey | { key: PropertyKey })[] | undefined): string {
  if (path === undefined || path.length === 0) return 'body';
  let written = '';
  for (const segment of path) {
    const key = typeof segment === 'object' ? segment.key : segment;
    if (typeof key === 'number') {
      written += `[${String(key)}]`;
      continue;
    }
    const name = String(key);
    written += written.length === 0 ? name : `.${name}`;
  }
  return written;
}

interface CompleteDirectory {
  teams: TeamWithServices[];
  people: PersonWithTeams[];
  tags: Tag[];
  services: Service[];
  types: WorkItemType[];
  externalSystems: ExternalSystem[];
}

function indexed<T extends { id: string }>(kind: string, rows: readonly T[]): Map<string, T> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (byId.size !== rows.length) throw new Error(`directory has duplicate ${kind} ids`);
  return byId;
}

function requireRows<T extends { id: string }>(
  kind: string,
  ids: ReadonlySet<string>,
  rows: readonly T[],
): T[] {
  const byId = indexed(kind, rows);
  // Proof: skipping this guard made the mounted missing-tag export return 200
  // instead of 500 while its work item still named tag "tag-used".
  for (const id of ids) {
    if (!byId.has(id)) throw new Error(`${kind} "${id}" is missing from the directory`);
  }
  return rows.filter((row) => ids.has(row.id));
}

/** Computes the minimal directory graph needed to resolve every exported id. */
function referencedDirectory(tree: WorkItemTree, complete: CompleteDirectory): CompleteDirectory {
  // Proof: starting this set empty made the mounted closure test omit its exact
  // Capacity only team while the capacity entry itself remained present.
  const teamIds = new Set(tree.teamCapacities.map(({ serviceTeamId }) => serviceTeamId));
  const personIds = new Set<string>();
  const tagIds = new Set<string>();
  const serviceIds = new Set<string>();
  const typeIds = new Set<string>();
  const externalSystemIds = new Set<string>();
  for (const row of tree.workItems) {
    if (row.serviceTeamId !== null) teamIds.add(row.serviceTeamId);
    for (const id of row.teamIds) teamIds.add(id);
    if (row.serviceId !== null) serviceIds.add(row.serviceId);
    for (const id of row.serviceIds) serviceIds.add(id);
    for (const id of row.tagIds) tagIds.add(id);
    for (const id of row.typeIds) typeIds.add(id);
    for (const id of Object.values(row.assignees)) personIds.add(id);
    for (const reference of row.externalRefs) externalSystemIds.add(reference.systemId);
  }

  const people = requireRows('person', personIds, complete.people);
  // Proof: skipping memberships made the mounted closure test omit Billing
  // and its owned-service id while still exporting assigned Kat.
  for (const person of people) for (const teamId of person.teamIds) teamIds.add(teamId);
  const teams = requireRows('team', teamIds, complete.teams);
  // Proof: skipping ownership traversal made the mounted closure test return
  // services:[] instead of Billing API's exact id and name.
  for (const team of teams) for (const serviceId of team.serviceIds) serviceIds.add(serviceId);

  return {
    teams,
    people,
    // Proof: returning the unfiltered list made the mounted closure test add
    // Unrelated tag beside Release, including its exact unwanted id/name.
    tags: requireRows('tag', tagIds, complete.tags),
    services: requireRows('service', serviceIds, complete.services),
    types: requireRows('work item type', typeIds, complete.types),
    externalSystems: requireRows('external system', externalSystemIds, complete.externalSystems),
  };
}
