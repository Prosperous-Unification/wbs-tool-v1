import type { PlanDocumentRequest } from '@wbs/contracts';

import type { Clock } from '../ports/clock';
import type { Scheduler } from '../ports/scheduler';
import type { SubtreeCopy } from '../ports/subtree-store';
import type { Scope, UnitOfWork } from '../ports/unit-of-work';
import { AnnouncementCollector, type Broadcaster } from './broadcast';
import type { DirectoryService } from './directory.service';
import {
  type ImportPreparation,
  type PreparedNamedEntry,
  type PreparedWorkItem,
  prepareImport,
} from './prepare-import';
import type { WorkItemService } from './work-item.service';

interface ImportServices {
  directory: DirectoryService;
  workItems: Pick<WorkItemService, 'announceTreeNow'>;
}

export interface ImportServiceOptions {
  clock: Clock;
  scheduler: Scheduler;
  uow: UnitOfWork;
  announcements: Broadcaster;
  batchServices: (scope: Scope, broadcast: Broadcaster) => ImportServices;
}

export interface ImportAdmission {
  ok: true;
  projectId: string;
  rows: number;
  created: {
    teams: string[];
    people: string[];
    tags: string[];
    services: string[];
    types: string[];
    externalSystems: string[];
  };
  solutionRef: 'kept' | 'left-off' | 'none';
}

/** A typed store refusal encountered after preparation and admission. */
export interface ImportSourceRefusal {
  ok: false;
  code: 'source_refused';
  path: string;
  detail: string;
}

export type ImportOutcome =
  ImportAdmission | ImportSourceRefusal | Extract<ImportPreparation, { ok: false }>;

type AdmittedImportOutcome = ImportAdmission | ImportSourceRefusal;

function existingIds(rows: readonly { id: string; name: string }[]): Map<string, string> {
  return new Map(rows.map(({ id, name }) => [name, id]));
}

function importsNewName(
  entries: ReadonlyMap<string, { name: string }>,
  held: readonly { name: string }[],
): boolean {
  const heldNames = new Set(held.map(({ name }) => name));
  return [...entries.values()].some(({ name }) => !heldNames.has(name));
}

function createdNames(
  entries: ReadonlyMap<string, { name: string }>,
  held: readonly { name: string }[],
): string[] {
  const heldNames = new Set(held.map(({ name }) => name));
  return [...entries.values()].flatMap(({ name }) => (heldNames.has(name) ? [] : [name]));
}

function resolvedId(
  idsByFileId: ReadonlyMap<string, string>,
  fileId: string,
  kind: string,
): string {
  const id = idsByFileId.get(fileId);
  if (id === undefined) throw new Error(`prepared ${kind} mapping disappeared: ${fileId}`);
  return id;
}

/**
 * Orders prepared rows for {@link SubtreeCopy.rows}' parent foreign key.
 *
 * `prepareImport` guarantees every non-null parent is in this collection and
 * the hierarchy is acyclic. Failure to make progress therefore means that
 * preparation's admitted invariant disappeared and is an internal error.
 */
function parentsFirst(rows: readonly PreparedWorkItem[]): PreparedWorkItem[] {
  const remaining = new Map(rows.map((row) => [row.fileId, row] as const));
  const ordered: PreparedWorkItem[] = [];
  while (remaining.size > 0) {
    let admittedParent = false;
    for (const [fileId, row] of remaining) {
      if (row.parentFileId !== null && remaining.has(row.parentFileId)) continue;
      ordered.push(row);
      remaining.delete(fileId);
      admittedParent = true;
    }
    if (!admittedParent) throw new Error('prepared hierarchy lost its parents-first order');
  }
  return ordered;
}

async function resolveNamed(
  entries: ReadonlyMap<string, PreparedNamedEntry>,
  existing: Map<string, string>,
  create: (name: string) => Promise<{ id: string } | null>,
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  for (const entry of entries.values()) {
    const held = existing.get(entry.name);
    if (held !== undefined) {
      resolved.set(entry.fileId, held);
      continue;
    }
    const created = await create(entry.name);
    if (created === null) throw new Error(`prepared directory name became invalid: ${entry.name}`);
    resolved.set(entry.fileId, created.id);
  }
  return resolved;
}

/**
 * Admits one prepared archival plan and reconciles its deployment-global names.
 *
 * Every directory read, create, ownership write and membership write uses the
 * graph composed over the {@link Scope} supplied by this import's own
 * {@link UnitOfWork}. Existing entries are authoritative and are never patched;
 * only entries created by this import receive file-owned metadata.
 * Successful admission collects directory, project-settings and full-tree
 * refreshes, then publishes them only after the unit of work has committed and
 * released its turn. Import creation does not append undo or plan-history rows.
 */
export class ImportService {
  constructor(private readonly opts: ImportServiceOptions) {}

  async import(document: PlanDocumentRequest, actorId: string): Promise<ImportOutcome> {
    const preparation = prepareImport(document, this.opts.scheduler);
    if (!preparation.ok) return preparation;
    const collector = new AnnouncementCollector(this.opts.announcements);
    const admitted = await this.opts.uow.run<AdmittedImportOutcome>(async (scope) => {
      const graph = this.opts.batchServices(scope, collector);
      const directory = graph.directory;
      const [services, teams, people, tags, types, systems] = await Promise.all([
        directory.listServices(),
        directory.listTeams(),
        directory.listPeople(),
        directory.listTags(),
        directory.listWorkItemTypes(),
        directory.listExternalSystems(),
      ]);
      const prepared = preparation.value;
      const created = {
        services: createdNames(prepared.serviceByFileId, services),
        teams: createdNames(prepared.teamByFileId, teams),
        people: createdNames(prepared.personByFileId, people),
        tags: createdNames(prepared.tagByFileId, tags),
        types: createdNames(prepared.typeByFileId, types),
        externalSystems: createdNames(prepared.externalSystemByFileId, systems),
      };
      const directoryChanged =
        importsNewName(prepared.serviceByFileId, services) ||
        importsNewName(prepared.teamByFileId, teams) ||
        importsNewName(prepared.personByFileId, people) ||
        importsNewName(prepared.tagByFileId, tags) ||
        importsNewName(prepared.typeByFileId, types) ||
        importsNewName(prepared.externalSystemByFileId, systems);
      const servicesByFileId = await resolveNamed(
        prepared.serviceByFileId,
        existingIds(services),
        async (name) => await directory.addService(actorId, name),
      );
      const heldTeams = existingIds(teams);
      const teamsByFileId = new Map<string, string>();
      for (const team of prepared.teamByFileId.values()) {
        const held = heldTeams.get(team.name);
        if (held !== undefined) {
          teamsByFileId.set(team.fileId, held);
          continue;
        }
        const created = await directory.addTeam(actorId, team.name);
        if (created === null) throw new Error(`prepared team name became invalid: ${team.name}`);
        const serviceIds = team.serviceFileIds.map((fileId) => {
          const id = servicesByFileId.get(fileId);
          if (id === undefined) throw new Error(`prepared service mapping disappeared: ${fileId}`);
          return id;
        });
        const patched = await directory.patchTeam(created.id, actorId, { serviceIds });
        if (!patched.ok) throw new Error(`created team metadata was refused: ${patched.reason}`);
        teamsByFileId.set(team.fileId, created.id);
      }
      const heldPeople = existingIds(people);
      const peopleByFileId = new Map<string, string>();
      for (const person of prepared.personByFileId.values()) {
        const held = heldPeople.get(person.name);
        if (held !== undefined) {
          // Proof: patching this row with the file's kind and team ids made both source
          // contract runs replace `person/held-team` with `agent/imported-2` byte-for-byte.
          peopleByFileId.set(person.fileId, held);
          continue;
        }
        const teamIds = person.teamFileIds.map((fileId) => {
          const id = teamsByFileId.get(fileId);
          if (id === undefined) throw new Error(`prepared team mapping disappeared: ${fileId}`);
          return id;
        });
        const created = await directory.addPerson(actorId, person.name, teamIds, person.kind);
        if (!created.ok) throw new Error(`created person metadata was refused: ${created.reason}`);
        peopleByFileId.set(person.fileId, created.value.id);
      }
      const tagsByFileId = await resolveNamed(
        prepared.tagByFileId,
        existingIds(tags),
        async (name) => await directory.addTag(actorId, name),
      );
      const typesByFileId = await resolveNamed(
        prepared.typeByFileId,
        existingIds(types),
        async (name) => await directory.addWorkItemType(actorId, name),
      );
      const systemsByFileId = await resolveNamed(
        prepared.externalSystemByFileId,
        existingIds(systems),
        async (name) => await directory.addExternalSystem(actorId, name),
      );
      const requested = prepared.settings.solutionRef;
      const solutionRef =
        requested === null
          ? 'none'
          : // Proof: skipping this admitted lookup made concurrent memory imports both
            // answer `kept` and leaked SQLite's `project.solution_slug` uniqueness error.
            (await scope.stores.projects.findBySolutionSlug(requested.slug)) === null
            ? 'kept'
            : 'left-off';
      const stamp = this.opts.clock.stampFor(actorId);
      const projectId = this.opts.clock.newId();
      const settings = prepared.settings;
      const steps = prepared.steps.map((step) => ({
        id: this.opts.clock.newId(),
        projectId,
        name: step.name,
        position: step.position,
      }));
      const stepsByFileId = new Map(
        prepared.steps.map((step, at) => {
          const written = steps.at(at);
          if (written === undefined) throw new Error('prepared steps changed length during import');
          return [step.fileId, written.id] as const;
        }),
      );
      // Proof: routing this through ProjectService.create made the source contract
      // read `[Dev@10, QA@20]` instead of `[Discover@10, Build@30, Verify@70]`.
      await scope.stores.projects.create(
        {
          id: projectId,
          name: settings.name,
          ownerId: actorId,
          restricted: settings.restricted,
          estimateMethod: settings.estimateMethod,
          depReach: settings.depReach,
          pertWeights: settings.pertWeights,
          estimateRounding: settings.estimateRounding,
          startDate: settings.startDate,
          solutionRef: requested !== null && solutionRef === 'kept' ? requested : null,
          revision: 0,
          createdAt: stamp.at,
          optimizationEnabled: settings.optimizationEnabled,
          scheduleEngine: settings.scheduleEngine,
          scheduleObjective: settings.scheduleObjective,
        },
        steps,
        stamp,
      );
      const bands = await scope.stores.priorityBands.replace(
        projectId,
        prepared.priorityBands,
        stamp,
      );
      if (!bands.ok) throw new Error(`created project refused its priority bands: ${projectId}`);
      for (const capacity of prepared.capacity) {
        const teamId = teamsByFileId.get(capacity.teamFileId);
        if (teamId === undefined)
          throw new Error(`prepared capacity team mapping disappeared: ${capacity.teamFileId}`);
        const written = await scope.stores.capacity.set(projectId, teamId, capacity.size, stamp);
        if (!written.ok) throw new Error(`created project refused its capacity: ${projectId}`);
      }
      for (const marker of prepared.calendarMarkers) {
        const written = await scope.stores.calendarMarkers.create({
          id: this.opts.clock.newId(),
          projectId,
          date: marker.date,
          name: marker.name,
          color: marker.color,
          createdAt: stamp.at,
        });
        if (!written.ok)
          throw new Error(`created project refused its calendar marker: ${written.reason}`);
      }
      // Proof: mapping each row to its file id made the in-memory source replace
      // the original project's three snapshotted rows; its reread became `[]`.
      const rowsByFileId = new Map(
        prepared.workItems.map((row) => [row.fileId, this.opts.clock.newId()] as const),
      );
      const subtree: SubtreeCopy = {
        rows: parentsFirst(prepared.workItems).map((row) => ({
          id: resolvedId(rowsByFileId, row.fileId, 'work item'),
          projectId,
          parentId:
            row.parentFileId === null
              ? null
              : resolvedId(rowsByFileId, row.parentFileId, 'parent work item'),
          position: row.position,
          name: row.name,
          // Proof: omitting this field made the source contract read `''` instead
          // of `Exact parent notes` and `Exact leaf notes` from the stored tree.
          notes: row.notes,
          frozenNumber: row.frozenNumber,
          startNoEarlierThan: row.startNoEarlierThan,
          startNoEarlierThanReason: row.startNoEarlierThanReason,
          deadline: row.deadline,
          factStart: row.factStart,
          factEnd: row.factEnd,
          priority: row.priority,
          serviceTeamId:
            row.serviceTeamFileId === null
              ? null
              : resolvedId(teamsByFileId, row.serviceTeamFileId, 'service team'),
          serviceId:
            row.serviceFileId === null
              ? null
              : resolvedId(servicesByFileId, row.serviceFileId, 'service'),
          maxParallel: row.maxParallel,
          revision: 0,
          teamIds: row.teamFileIds.map((fileId) => resolvedId(teamsByFileId, fileId, 'team label')),
        })),
        respaced: [],
        reparented: [],
        estimates: prepared.workItems.flatMap((row) =>
          row.estimates.map((estimate) => ({
            workItemId: resolvedId(rowsByFileId, row.fileId, 'estimated work item'),
            stepId: resolvedId(stepsByFileId, estimate.stepFileId, 'estimate step'),
            optimistic: estimate.optimistic,
            realistic: estimate.realistic,
            pessimistic: estimate.pessimistic,
          })),
        ),
        actuals: prepared.workItems.flatMap((row) =>
          row.actuals.map((actual) => ({
            workItemId: resolvedId(rowsByFileId, row.fileId, 'actual work item'),
            stepId: resolvedId(stepsByFileId, actual.stepFileId, 'actual step'),
            days: actual.days,
            recordedAt: stamp.at,
          })),
        ),
        progress: prepared.workItems.flatMap((row) =>
          row.progress.map((progress) => ({
            workItemId: resolvedId(rowsByFileId, row.fileId, 'progress work item'),
            stepId: resolvedId(stepsByFileId, progress.stepFileId, 'progress step'),
            state: progress.state,
            statedAt: stamp.at,
          })),
        ),
        measures: prepared.workItems.flatMap((row) =>
          row.measures.map((measure) => ({
            workItemId: resolvedId(rowsByFileId, row.fileId, 'measured work item'),
            stepId: resolvedId(stepsByFileId, measure.stepFileId, 'measure step'),
            metric: measure.metric,
            value: measure.value,
            recordedAt: stamp.at,
          })),
        ),
        assignments: prepared.workItems.flatMap((row) =>
          row.assignments.map((assignment) => ({
            workItemId: resolvedId(rowsByFileId, row.fileId, 'assigned work item'),
            stepId: resolvedId(stepsByFileId, assignment.stepFileId, 'assignment step'),
            personId: resolvedId(peopleByFileId, assignment.personFileId, 'assigned person'),
          })),
        ),
        dependencies: prepared.dependencies.map((dependency) => ({
          id: this.opts.clock.newId(),
          projectId,
          predecessorId: resolvedId(
            rowsByFileId,
            dependency.predecessorFileId,
            'dependency predecessor',
          ),
          successorId: resolvedId(rowsByFileId, dependency.successorFileId, 'dependency successor'),
        })),
        removedEstimates: [],
        removedActuals: [],
        removedProgress: [],
        removedMeasures: [],
      };
      await scope.stores.subtrees.insertSubtree(subtree, stamp);
      for (const [at, row] of prepared.workItems.entries()) {
        const written = await scope.stores.workItems.patch(
          resolvedId(rowsByFileId, row.fileId, 'labelled work item'),
          {
            tagIds: row.tagFileIds.map((fileId) => resolvedId(tagsByFileId, fileId, 'tag label')),
            serviceIds: row.serviceFileIds.map((fileId) =>
              resolvedId(servicesByFileId, fileId, 'service label'),
            ),
            typeIds: row.typeFileIds.map((fileId) =>
              resolvedId(typesByFileId, fileId, 'type label'),
            ),
            externalRefs: row.externalRefs.map((reference) => ({
              systemId: resolvedId(systemsByFileId, reference.systemFileId, 'external system'),
              url: reference.url,
              name: reference.name,
            })),
          },
          stamp,
        );
        if (!written.ok) {
          // Proof: returning `commit:true` here made the rollback contract leak
          // the created `Billing` team after its modeled `unknown_tag` refusal.
          return {
            commit: false,
            value: {
              ok: false,
              code: 'source_refused',
              path: `workItems[${String(at)}]`,
              detail: written.reason,
            },
          };
        }
      }
      if (directoryChanged) {
        // Proof: omitting this fan-out left an existing project's subscriber
        // with no refresh, so its post-import directory read never saw `Billing`.
        for (const project of await scope.stores.projects.list()) {
          await collector.publish(project.id, { type: 'directory_changed' });
        }
      }
      await collector.publish(projectId, {
        type: 'project_settings_changed',
        optimizationEnabled: settings.optimizationEnabled,
        scheduleEngine: settings.scheduleEngine,
        scheduleObjective: settings.scheduleObjective,
      });
      await graph.workItems.announceTreeNow(projectId);
      return {
        commit: true,
        value: {
          ok: true,
          projectId,
          rows: prepared.workItems.length,
          created,
          solutionRef,
        },
      };
    });
    // Proof: moving this drain inside the unit of work made the held-publisher
    // contract time out while its queued ordinary project write waited for admission.
    if (admitted.ok) await collector.send();
    return admitted;
  }
}
