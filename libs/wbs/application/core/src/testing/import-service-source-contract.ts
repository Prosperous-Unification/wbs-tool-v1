import type { PlanDocumentRequest } from '@wbs/contracts';
import { describe, expect, it } from 'bun:test';

import { servicesOver } from '../compose';
import { clockOf } from '../ports/clock';
import type { ProjectStore } from '../ports/project-store';
import type { NewProject } from '../ports/project-store';
import type { Source } from '../ports/source';
import type { TransactionalStores } from '../ports/stores';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { WorkItemStore } from '../ports/work-item-store';
import type { Broadcaster, ProjectEvent } from '../service/broadcast';
import { ImportService } from '../service/import.service';
import { classifyPlanDocument, PlanDocumentService } from '../service/plan-document';
import { type RecordingBroadcaster, recordingBroadcaster } from './broadcast-fixture';
import { planDocumentFixture } from './plan-document-fixture';
import { fastScheduler } from './scheduler-fixture';

const ACTOR = 'import-owner';
const STAMP = { at: 1_757_851_200_000, by: ACTOR };

interface ImportHarnessOptions {
  announcements?: Broadcaster;
  uow?: UnitOfWork<TransactionalStores>;
}

function importService(
  source: Source<TransactionalStores>,
  options: ImportHarnessOptions = {},
): ImportService {
  let next = 0;
  const clock = clockOf({
    now: () => STAMP.at,
    newId: () => `imported-${String(++next)}`,
  });
  const announcements = options.announcements ?? recordingBroadcaster();
  return new ImportService({
    clock,
    scheduler: fastScheduler,
    uow: options.uow ?? source.uow,
    announcements,
    batchServices: (scope, broadcast) =>
      servicesOver(scope.stores, { clock, broadcast, scheduler: fastScheduler }),
  });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve = (_value: T): void => {
    throw new Error('deferred resolved before initialization');
  };
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function projectFixture(id: string, name: string): NewProject {
  return {
    id,
    name,
    ownerId: ACTOR,
    restricted: false,
    estimateMethod: 'pert',
    depReach: 'whole-item',
    pertWeights: { optimistic: 1, realistic: 4, pessimistic: 1 },
    estimateRounding: 'ceil',
    startDate: null,
    solutionRef: null,
    revision: 0,
    createdAt: STAMP.at,
  };
}

function heldBroadcaster(
  publishing: Deferred<undefined>,
  continuePublishing: Promise<void>,
): RecordingBroadcaster {
  const published: { projectId: string; event: ProjectEvent }[] = [];
  let held = false;
  return {
    published,
    async publish(projectId, event) {
      published.push({ projectId, event });
      if (held) return;
      held = true;
      publishing.resolve(undefined);
      await continuePublishing;
    },
    latestSeq: (projectId) =>
      Promise.resolve(published.filter((entry) => entry.projectId === projectId).length - 1),
  };
}

function roundTripFixture(): PlanDocumentRequest {
  const document = planDocumentFixture();
  document.settings = {
    ...document.settings,
    name: 'Round trip plan',
    restricted: true,
    estimateMethod: 'pessimistic',
    depReach: 'anchor-slice',
    pertWeights: { optimistic: 2, realistic: 3, pessimistic: 5 },
    estimateRounding: 'round',
    solutionRef: {
      slug: 'round-trip-solution',
      url: 'https://example.test/solutions/round-trip',
    },
    optimizationEnabled: false,
    scheduleEngine: 'optimized',
    scheduleObjective: 'time',
  };
  document.steps = [
    { id: 'step-discover', name: 'Discover', position: 10 },
    { id: 'step-build', name: 'Build', position: 30 },
    { id: 'step-verify', name: 'Verify', position: 70 },
  ];
  document.calendarMarkers = [
    {
      id: 'marker-release',
      date: '2026-09-21',
      name: 'Release train',
      color: '#f70100',
    },
  ];
  const root = document.workItems.at(0);
  if (root === undefined) throw new Error('plan document fixture has no root work item');
  root.name = 'Release';
  root.notes = 'Parent notes';
  root.frozenNumber = 'ROUND-1';
  root.maxParallel = 3;
  root.estimates = { 'step-discover': { optimistic: 10, realistic: 20, pessimistic: 30 } };
  root.actuals = { 'step-discover': 12 };
  root.progress = { 'step-discover': 'done' };
  root.measures = { hours_actual: { 'step-discover': 18 } };
  root.assignees = {};
  document.workItems.push(
    {
      ...structuredClone(root),
      id: 'row-build',
      parentId: root.id,
      position: 10,
      name: 'Build release',
      notes: 'Leaf notes',
      frozenNumber: null,
      startNoEarlierThan: '2026-09-15',
      startNoEarlierThanReason: 'Environment opens',
      deadline: '2026-09-17',
      factStart: '2026-09-15',
      factEnd: '2026-09-16',
      priority: 7,
      maxParallel: 2,
      externalRefs: [
        {
          id: 'external-build-a',
          systemId: 'system-1',
          url: 'https://example.test/issues/2',
          name: 'ISSUE-2',
        },
        {
          id: 'external-build-b',
          systemId: 'system-1',
          url: 'https://example.test/issues/3',
          name: 'ISSUE-3',
        },
      ],
      estimates: { 'step-build': { optimistic: 2, realistic: 4, pessimistic: 8 } },
      actuals: { 'step-build': 3 },
      progress: { 'step-build': 'in_progress' },
      measures: {
        token_estimate: { 'step-build': 1200 },
        token_actual: { 'step-build': 900 },
        hours_actual: { 'step-build': 6 },
      },
      dependsOn: [],
      assignees: { 'step-verify': 'person-1' },
    },
    {
      ...structuredClone(root),
      id: 'row-verify',
      parentId: root.id,
      position: 20,
      name: 'Verify release',
      notes: 'Dependency successor',
      frozenNumber: null,
      serviceTeamId: null,
      serviceId: null,
      teamIds: [],
      tagIds: [],
      serviceIds: [],
      typeIds: [],
      externalRefs: [],
      estimates: { 'step-verify': { optimistic: 1, realistic: 2, pessimistic: 5 } },
      actuals: {},
      progress: {},
      measures: {},
      dependsOn: ['row-build'],
      assignees: {},
    },
  );
  return document;
}

async function exportProject(
  source: Source<TransactionalStores>,
  projectId: string,
): Promise<PlanDocumentRequest> {
  const clock = clockOf({ now: () => STAMP.at, newId: () => crypto.randomUUID() });
  const broadcast = recordingBroadcaster();
  const graph = servicesOver(source.stores, { clock, broadcast, scheduler: fastScheduler });
  const [project, tree] = await Promise.all([
    source.stores.projects.findById(projectId),
    graph.workItems.tree(projectId),
  ]);
  if (project === null) throw new Error(`imported project disappeared: ${projectId}`);
  if (tree === null || 'kind' in tree) throw new Error(`imported project cannot be exported`);
  const exported = await new PlanDocumentService({
    directory: source.stores.directory,
    markers: graph.calendarMarkers,
    clock,
  }).export(project, tree);
  const classified = await classifyPlanDocument(exported);
  if (!classified.ok) throw new Error(`exported project refused at ${classified.path}`);
  return classified.value;
}

function authoredSnapshot(document: PlanDocumentRequest): unknown {
  const aliases = new Map<string, string>();
  const alias = (kind: string, id: string, name: string): void => {
    aliases.set(id, `${kind}:${name}`);
  };
  for (const step of document.steps) alias('step', step.id, step.name);
  for (const row of document.workItems) alias('work-item', row.id, row.name);
  for (const team of document.directory.teams) alias('team', team.id, team.name);
  for (const person of document.directory.people) alias('person', person.id, person.name);
  for (const tag of document.directory.tags) alias('tag', tag.id, tag.name);
  for (const service of document.directory.services) alias('service', service.id, service.name);
  for (const type of document.directory.types) alias('type', type.id, type.name);
  for (const system of document.directory.externalSystems)
    alias('external-system', system.id, system.name);
  for (const marker of document.calendarMarkers)
    alias('marker', marker.id, `${marker.date}:${marker.name}`);
  for (const row of document.workItems) {
    for (const reference of row.externalRefs)
      alias('external-ref', reference.id, `${reference.url}:${reference.name}`);
  }

  const authored = structuredClone(document);
  authored.document.exportedAt = '<export-stamp>';
  authored.settings.solutionRef = null;
  const replaceIds = (value: unknown): unknown => {
    if (typeof value === 'string') return aliases.get(value) ?? value;
    if (Array.isArray(value)) return value.map(replaceIds);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [aliases.get(key) ?? key, replaceIds(field)]),
    );
  };
  return replaceIds(authored);
}

type LaterFault = { kind: 'refused' } | { kind: 'thrown'; cause: Error };

interface AdmittedImportState {
  projectId: string;
  rowIds: string[];
  teamId: string;
}

function faultedUnitOfWork(
  source: Source<TransactionalStores>,
  fault: LaterFault,
  admitted: Deferred<AdmittedImportState>,
  continueWrite: Promise<void>,
): UnitOfWork<TransactionalStores> {
  return {
    run: (act) =>
      source.uow.run(async (scope) => {
        const stored = scope.stores.workItems;
        let faulted = false;
        const patch: WorkItemStore['patch'] = async (id, changes, stamp) => {
          if (faulted) return stored.patch(id, changes, stamp);
          faulted = true;
          const project = (await scope.stores.projects.list()).find(
            ({ name }) => name === 'Portable plan',
          );
          const team = (await scope.stores.directory.listTeams()).find(
            ({ name }) => name === 'Billing',
          );
          if (project === undefined || team === undefined)
            throw new Error('import did not create its project and team before the later write');
          admitted.resolve({
            projectId: project.id,
            rowIds: (await stored.listByProject(project.id)).map(({ id: rowId }) => rowId),
            teamId: team.id,
          });
          await continueWrite;
          if (fault.kind === 'thrown') throw fault.cause;
          return { ok: false, reason: 'unknown_tag' };
        };
        const workItems: WorkItemStore = {
          listByProject: (projectId) => stored.listByProject(projectId),
          listByIds: (projectId, ids) => stored.listByIds(projectId, ids),
          listPlacements: (projectId, ids) => stored.listPlacements(projectId, ids),
          findById: (id) => stored.findById(id),
          insert: (workItem, respaced, stamp) => stored.insert(workItem, respaced, stamp),
          patch,
          move: (id, parentId, position, respaced, stamp) =>
            stored.move(id, parentId, position, respaced, stamp),
          setPositions: (placements, moved, stamp) => stored.setPositions(placements, moved, stamp),
          setFrozenNumbers: (updates, stamp) => stored.setFrozenNumbers(updates, stamp),
          remove: (ids, promoted, stamp) => stored.remove(ids, promoted, stamp),
        };
        return act({ stores: { ...scope.stores, workItems } });
      }),
  };
}

function heldSolutionUnitOfWork(
  source: Source<TransactionalStores>,
  creationHeld: Deferred<undefined>,
  secondStarted: Deferred<undefined>,
  continueCreate: Promise<void>,
): UnitOfWork<TransactionalStores> {
  let invocation = 0;
  return {
    run: (act) => {
      invocation += 1;
      const current = invocation;
      if (current === 2) secondStarted.resolve(undefined);
      return source.uow.run(async (scope) => {
        if (current !== 1) return act(scope);
        const stored = scope.stores.projects;
        let held = false;
        const projects: ProjectStore = {
          async create(project, steps, stamp) {
            if (!held) {
              held = true;
              creationHeld.resolve(undefined);
              await continueCreate;
            }
            return stored.create(project, steps, stamp);
          },
          findById: (id) => stored.findById(id),
          findBySolutionSlug: (slug) => stored.findBySolutionSlug(slug),
          list: () => stored.list(),
          listFor: (userId) => stored.listFor(userId),
          recordOpen: (projectId, stamp) => stored.recordOpen(projectId, stamp),
          update: (id, changes, stamp) => stored.update(id, changes, stamp),
          stepsOf: (projectId) => stored.stepsOf(projectId),
        };
        return act({ stores: { ...scope.stores, projects } });
      });
    },
  };
}

/** Runs the import-directory contract against one real source implementation. */
export function importServiceSourceContract(
  openSource: () => Promise<Source<TransactionalStores>>,
) {
  describe('ImportService admitted writes', () => {
    async function ownedSource(): Promise<Source<TransactionalStores>> {
      const source = await openSource();
      if ((await source.stores.users.findById(ACTOR)) !== null) return source;
      const created = await source.stores.users.create(
        { id: ACTOR, username: ACTOR, passwordHash: 'x', createdAt: STAMP.at },
        STAMP,
      );
      if (created === null) throw new Error('test owner name was already held');
      return source;
    }

    it('reuses an existing tag by name', async () => {
      const source = await ownedSource();
      try {
        await source.stores.directory.addTag({ id: 'held-tag', name: 'Release' }, STAMP);
        const document = planDocumentFixture();

        const imported = await importService(source).import(document, ACTOR);

        expect(imported).toMatchObject({
          ok: true,
          rows: 1,
          created: {
            teams: ['Billing'],
            people: ['Kat'],
            tags: [],
            services: ['Billing API'],
            types: ['Milestone'],
            externalSystems: ['Tracker'],
          },
          solutionRef: 'none',
        });

        expect(await source.stores.directory.listTags()).toEqual([
          { id: 'held-tag', name: 'Release' },
        ]);
        expect(
          (await source.stores.directory.listExternalSystems()).map(({ name }) => name),
        ).toContain('Tracker');
      } finally {
        await source.close();
      }
    });

    it('keeps an existing person byte-equivalent when the file disagrees', async () => {
      const source = await ownedSource();
      try {
        const heldTeam = await source.stores.directory.addTeam(
          { id: 'held-team', name: 'Existing team' },
          STAMP,
        );
        const added = await source.stores.directory.addPerson(
          { id: 'held-person', name: 'Kat', kind: 'person' },
          [heldTeam.id],
          STAMP,
        );
        if (!added.ok) throw new Error('test person membership was refused');
        const before = (await source.stores.directory.listPeople()).find(
          ({ id }) => id === added.person.id,
        );
        if (before === undefined) throw new Error('test person vanished before import');
        const beforeBytes = JSON.stringify(before);
        const document = planDocumentFixture();

        await importService(source).import(document, ACTOR);

        const after = (await source.stores.directory.listPeople()).find(
          ({ id }) => id === added.person.id,
        );
        expect(JSON.stringify(after)).toBe(beforeBytes);
      } finally {
        await source.close();
      }
    });

    it('restores a new agent kind and memberships', async () => {
      const source = await ownedSource();
      try {
        const document = planDocumentFixture();

        await importService(source).import(document, ACTOR);

        const team = (await source.stores.directory.listTeams()).find(
          ({ name }) => name === 'Billing',
        );
        const person = (await source.stores.directory.listPeople()).find(
          ({ name }) => name === 'Kat',
        );
        if (team === undefined) throw new Error('imported team was not stored');
        if (person === undefined) throw new Error('imported person was not stored');
        expect(person).toEqual({
          id: person.id,
          name: 'Kat',
          kind: 'agent',
          teamIds: [team.id],
        });
      } finally {
        await source.close();
      }
    });

    it('leaves off a solution slug already held inside admission', async () => {
      const source = await ownedSource();
      try {
        await source.stores.projects.create(
          {
            id: 'held-project',
            name: 'Held solution',
            ownerId: ACTOR,
            restricted: false,
            estimateMethod: 'pert',
            depReach: 'whole-item',
            pertWeights: { optimistic: 1, realistic: 4, pessimistic: 1 },
            estimateRounding: 'ceil',
            startDate: null,
            solutionRef: { slug: 'held-solution', url: 'https://example.test/held' },
            revision: 0,
            createdAt: STAMP.at,
          },
          [],
          STAMP,
        );
        const document = planDocumentFixture();
        document.settings.solutionRef = {
          slug: 'held-solution',
          url: 'https://example.test/imported',
        };

        const imported = await importService(source).import(document, ACTOR);

        expect(imported).toMatchObject({ ok: true, solutionRef: 'left-off' });
      } finally {
        await source.close();
      }
    });

    it('stores exact project settings, nondefault step order, capacity, bands, and marker', async () => {
      const source = await ownedSource();
      try {
        const document = planDocumentFixture();
        document.settings.name = 'Exact imported plan';
        document.settings.restricted = true;
        document.settings.estimateMethod = 'pessimistic';
        document.settings.depReach = 'anchor-slice';
        document.settings.pertWeights = { optimistic: 2, realistic: 3, pessimistic: 5 };
        document.settings.estimateRounding = 'round';
        document.settings.scheduleEngine = 'optimized';
        document.settings.scheduleObjective = 'time';
        document.steps = [
          { id: 'step-discover', name: 'Discover', position: 10 },
          { id: 'step-build', name: 'Build', position: 30 },
          { id: 'step-verify', name: 'Verify', position: 70 },
        ];
        const row = document.workItems.at(0);
        if (row === undefined) throw new Error('plan document fixture has no work item');
        row.estimates = {
          'step-discover': { optimistic: 1, realistic: 2, pessimistic: 3 },
        };
        row.actuals = {};
        row.progress = {};
        row.measures = {};
        row.assignees = { 'step-build': 'person-1' };
        document.calendarMarkers = [
          {
            id: 'file-marker',
            date: '2026-09-21',
            name: 'Release train',
            color: '#f70100',
          },
        ];

        const imported = await importService(source).import(document, ACTOR);
        if (!imported.ok) throw new Error(`valid import refused at ${imported.path}`);
        const project = await source.stores.projects.findById(imported.projectId);
        const steps = await source.stores.projects.stepsOf(imported.projectId);
        const teams = await source.stores.directory.listTeams();
        const billing = teams.find(({ name }) => name === 'Billing');
        if (billing === undefined) throw new Error('imported capacity team was not stored');

        expect(steps.map(({ name, position }) => ({ name, position }))).toEqual([
          { name: 'Discover', position: 10 },
          { name: 'Build', position: 30 },
          { name: 'Verify', position: 70 },
        ]);
        expect(project).toEqual({
          id: imported.projectId,
          name: 'Exact imported plan',
          ownerId: ACTOR,
          restricted: true,
          estimateMethod: 'pessimistic',
          depReach: 'anchor-slice',
          pertWeights: { optimistic: 2, realistic: 3, pessimistic: 5 },
          estimateRounding: 'round',
          startDate: '2026-09-14',
          solutionRef: null,
          revision: 0,
          createdAt: STAMP.at,
          optimizationEnabled: false,
          scheduleEngine: 'optimized',
          scheduleObjective: 'time',
        });
        expect(await source.stores.priorityBands.listFor(imported.projectId)).toEqual([
          { startsAt: 1, defaultValue: 10, label: 'Critical' },
          { startsAt: 21, defaultValue: 30, label: 'High' },
          { startsAt: 41, defaultValue: 50, label: 'Medium' },
          { startsAt: 61, defaultValue: 70, label: 'Low' },
          { startsAt: 81, defaultValue: 90, label: 'Lowest' },
        ]);
        expect(await source.stores.capacity.listFor(imported.projectId)).toEqual([
          { serviceTeamId: billing.id, size: 2 },
        ]);
        const markers = await source.stores.calendarMarkers.listFor(imported.projectId);
        const marker = markers.at(0);
        if (marker === undefined) throw new Error('imported calendar marker was not stored');
        expect(markers).toHaveLength(1);
        expect(marker.id).not.toBe('file-marker');
        expect({
          projectId: marker.projectId,
          date: marker.date,
          name: marker.name,
          color: marker.color,
          createdAt: marker.createdAt,
        }).toEqual({
          projectId: imported.projectId,
          date: '2026-09-21',
          name: 'Release train',
          color: '#f70100',
          createdAt: STAMP.at,
        });
      } finally {
        await source.close();
      }
    });

    it('stores a fresh complete tree without changing rows that own the file ids', async () => {
      const source = await ownedSource();
      try {
        const document = planDocumentFixture();
        const root = document.workItems.at(0);
        if (root === undefined) throw new Error('plan document fixture has no root work item');
        root.notes = 'Exact parent notes';
        root.frozenNumber = 'IMPORT-7';
        root.maxParallel = 3;
        root.estimates = { 'step-1': { optimistic: -1, realistic: -1, pessimistic: -1 } };
        root.actuals = { 'step-1': -1 };
        root.progress = { 'step-1': 'done' };
        root.measures = { hours_actual: { 'step-1': -1 } };
        root.assignees = {};
        root.externalRefs = [];
        document.workItems.push(
          {
            ...structuredClone(root),
            id: 'row-2',
            parentId: 'row-1',
            position: 10,
            name: 'Build release',
            notes: 'Exact leaf notes',
            frozenNumber: null,
            startNoEarlierThan: '2026-09-15',
            startNoEarlierThanReason: 'Environment opens',
            deadline: '2026-09-17',
            factStart: '2026-09-15',
            factEnd: '2026-09-16',
            priority: 7,
            maxParallel: 2,
            teamIds: [],
            tagIds: [],
            serviceIds: [],
            typeIds: [],
            externalRefs: [
              {
                id: 'external-ref-2a',
                systemId: 'system-1',
                url: 'https://example.test/issues/2',
                name: 'ISSUE-2',
              },
              {
                id: 'external-ref-2b',
                systemId: 'system-1',
                url: 'https://example.test/issues/3',
                name: 'ISSUE-3',
              },
            ],
            estimates: { 'step-1': { optimistic: 2, realistic: 4, pessimistic: 8 } },
            actuals: { 'step-1': 3 },
            progress: { 'step-1': 'in_progress' },
            measures: {
              token_estimate: { 'step-1': 1200 },
              token_actual: { 'step-1': 900 },
              hours_actual: { 'step-1': 6 },
            },
            dependsOn: [],
            assignees: { 'step-2': 'person-1' },
          },
          {
            ...structuredClone(root),
            id: 'row-3',
            parentId: 'row-1',
            position: 20,
            name: 'Verify release',
            notes: 'Dependency successor',
            teamIds: [],
            tagIds: [],
            serviceIds: [],
            typeIds: [],
            estimates: {},
            actuals: {},
            progress: {},
            measures: {},
            dependsOn: ['row-2'],
            assignees: {},
          },
        );
        await source.stores.projects.create(
          {
            id: 'source-project',
            name: 'Rows holding file ids',
            ownerId: ACTOR,
            restricted: false,
            estimateMethod: 'pert',
            depReach: 'whole-item',
            pertWeights: { optimistic: 1, realistic: 4, pessimistic: 1 },
            estimateRounding: 'ceil',
            startDate: null,
            solutionRef: null,
            revision: 0,
            createdAt: STAMP.at,
          },
          document.steps.map(({ id, name, position }) => ({
            id,
            projectId: 'source-project',
            name,
            position,
          })),
          STAMP,
        );
        await source.stores.subtrees.insertSubtree(
          {
            rows: document.workItems.map(({ id, parentId, position, name }) => ({
              id,
              projectId: 'source-project',
              parentId,
              position,
              name: `Original ${name}`,
              notes: `Original notes ${id}`,
              frozenNumber: null,
              startNoEarlierThan: null,
              startNoEarlierThanReason: null,
              deadline: null,
              factStart: null,
              factEnd: null,
              priority: null,
              serviceTeamId: null,
              serviceId: null,
              maxParallel: 1,
              revision: 0,
              teamIds: [],
            })),
            respaced: [],
            reparented: [],
            estimates: [],
            actuals: [],
            progress: [],
            measures: [],
            assignments: [],
            dependencies: [],
            removedEstimates: [],
            removedActuals: [],
            removedProgress: [],
            removedMeasures: [],
          },
          STAMP,
        );
        const originals = await source.stores.workItems.listByProject('source-project');

        const imported = await importService(source).import(document, ACTOR);
        if (!imported.ok) throw new Error(`valid import refused at ${imported.path}`);
        const [rows, steps, estimates, actuals, progress, measures, dependencies, assigned] =
          await Promise.all([
            source.stores.workItems.listByProject(imported.projectId),
            source.stores.projects.stepsOf(imported.projectId),
            source.stores.estimates.listByProject(imported.projectId),
            source.stores.actuals.listByProject(imported.projectId),
            source.stores.progress.listByProject(imported.projectId),
            source.stores.measures.listByProject(imported.projectId),
            source.stores.dependencies.listByProject(imported.projectId),
            source.stores.directory.assignmentsInProject(imported.projectId),
          ]);
        const importedRoot = rows.find(({ name }) => name === 'Ship');
        const importedLeaf = rows.find(({ name }) => name === 'Build release');
        const importedSuccessor = rows.find(({ name }) => name === 'Verify release');
        if (
          importedRoot === undefined ||
          importedLeaf === undefined ||
          importedSuccessor === undefined
        )
          throw new Error('imported hierarchy is incomplete');
        const build = steps.find(({ name }) => name === 'Build');
        const qa = steps.find(({ name }) => name === 'QA');
        if (build === undefined || qa === undefined)
          throw new Error('imported steps are incomplete');
        const teams = await source.stores.directory.listTeams();
        const tags = await source.stores.directory.listTags();
        const services = await source.stores.directory.listServices();
        const types = await source.stores.directory.listWorkItemTypes();
        const systems = await source.stores.directory.listExternalSystems();
        const people = await source.stores.directory.listPeople();
        const billing = teams.find(({ name }) => name === 'Billing');
        const release = tags.find(({ name }) => name === 'Release');
        const billingApi = services.find(({ name }) => name === 'Billing API');
        const milestone = types.find(({ name }) => name === 'Milestone');
        const tracker = systems.find(({ name }) => name === 'Tracker');
        const kat = people.find(({ name }) => name === 'Kat');
        if (
          billing === undefined ||
          release === undefined ||
          billingApi === undefined ||
          milestone === undefined ||
          tracker === undefined ||
          kat === undefined
        )
          throw new Error('imported directory is incomplete');

        expect(await source.stores.workItems.listByProject('source-project')).toEqual(originals);
        expect(imported.projectId).not.toBe('source-project');
        expect(billing.id).not.toBe('team-1');
        expect(release.id).not.toBe('tag-1');
        expect(billingApi.id).not.toBe('service-1');
        expect(milestone.id).not.toBe('type-1');
        expect(tracker.id).not.toBe('system-1');
        expect(kat.id).not.toBe('person-1');
        expect(rows.map(({ id }) => id)).not.toContain('row-1');
        expect(rows.map(({ id }) => id)).not.toContain('row-2');
        expect(rows.map(({ id }) => id)).not.toContain('row-3');
        expect(steps.map(({ id }) => id)).not.toContain('step-1');
        expect(steps.map(({ id }) => id)).not.toContain('step-2');
        expect(importedLeaf.externalRefs.map(({ id }) => id)).not.toContain('external-ref-2a');
        expect(importedLeaf.externalRefs.map(({ id }) => id)).not.toContain('external-ref-2b');
        expect(importedRoot).toMatchObject({
          parentId: null,
          position: 10,
          notes: 'Exact parent notes',
          frozenNumber: 'IMPORT-7',
          startNoEarlierThan: '2026-09-14',
          startNoEarlierThanReason: 'Release window',
          deadline: '2026-09-18',
          priority: 2,
          serviceTeamId: billing.id,
          serviceId: billingApi.id,
          maxParallel: 3,
          teamIds: [billing.id],
          tagIds: [release.id],
          serviceIds: [billingApi.id],
          typeIds: [milestone.id],
        });
        expect(importedLeaf).toMatchObject({
          parentId: importedRoot.id,
          position: 10,
          notes: 'Exact leaf notes',
          startNoEarlierThan: '2026-09-15',
          startNoEarlierThanReason: 'Environment opens',
          deadline: '2026-09-17',
          factStart: '2026-09-15',
          factEnd: '2026-09-16',
          priority: 7,
          maxParallel: 2,
          teamIds: [],
          tagIds: [],
          serviceIds: [],
          typeIds: [],
        });
        expect(importedSuccessor.parentId).toBe(importedRoot.id);
        expect(
          importedLeaf.externalRefs.map(({ systemId, url, name }) => ({ systemId, url, name })),
        ).toEqual([
          {
            systemId: tracker.id,
            url: 'https://example.test/issues/2',
            name: 'ISSUE-2',
          },
          {
            systemId: tracker.id,
            url: 'https://example.test/issues/3',
            name: 'ISSUE-3',
          },
        ]);
        expect(estimates).toEqual([
          {
            workItemId: importedLeaf.id,
            stepId: build.id,
            optimistic: 2,
            realistic: 4,
            pessimistic: 8,
          },
        ]);
        expect(actuals).toEqual([
          { workItemId: importedLeaf.id, stepId: build.id, days: 3, recordedAt: STAMP.at },
        ]);
        expect(progress).toEqual([
          {
            workItemId: importedLeaf.id,
            stepId: build.id,
            state: 'in_progress',
            statedAt: STAMP.at,
          },
        ]);
        expect(
          Object.fromEntries(measures.map(({ metric, ...measure }) => [metric, measure])),
        ).toEqual({
          token_estimate: {
            workItemId: importedLeaf.id,
            stepId: build.id,
            value: 1200,
            recordedAt: STAMP.at,
          },
          token_actual: {
            workItemId: importedLeaf.id,
            stepId: build.id,
            value: 900,
            recordedAt: STAMP.at,
          },
          hours_actual: {
            workItemId: importedLeaf.id,
            stepId: build.id,
            value: 6,
            recordedAt: STAMP.at,
          },
        });
        expect(assigned.assignments).toEqual([
          { workItemId: importedLeaf.id, stepId: qa.id, personId: kat.id },
        ]);
        const dependency = dependencies.at(0);
        if (dependency === undefined) throw new Error('imported dependency was not stored');
        expect(dependencies).toEqual([
          {
            id: dependency.id,
            projectId: imported.projectId,
            predecessorId: importedLeaf.id,
            successorId: importedSuccessor.id,
          },
        ]);
        expect(dependency.id).not.toBe('row-2');
        expect(dependency.id).not.toBe('row-3');
      } finally {
        await source.close();
      }
    });

    for (const fault of [
      { kind: 'refused' } as const,
      { kind: 'thrown', cause: new Error('injected later source failure') } as const,
    ]) {
      it(`rolls back visible admitted writes after a later store ${fault.kind}`, async () => {
        const source = await ownedSource();
        try {
          const admitted = deferred<AdmittedImportState>();
          const release = deferred<undefined>();
          const announcements = recordingBroadcaster();
          const service = importService(source, {
            announcements,
            uow: faultedUnitOfWork(source, fault, admitted, release.promise),
          });
          const settled = service.import(planDocumentFixture(), ACTOR).then(
            (outcome) => ({ kind: 'returned' as const, outcome }),
            (cause: unknown) => ({ kind: 'threw' as const, cause }),
          );

          const visible = await admitted.promise;
          expect(visible.rowIds).toHaveLength(1);
          expect(visible.teamId).not.toBe('team-1');
          release.resolve(undefined);
          const terminal = await settled;
          if (fault.kind === 'refused') {
            expect(terminal).toEqual({
              kind: 'returned',
              outcome: {
                ok: false,
                code: 'source_refused',
                path: 'workItems[0]',
                detail: 'unknown_tag',
              },
            });
          } else {
            expect(terminal).toEqual({ kind: 'threw', cause: fault.cause });
          }
          expect(
            (await source.stores.directory.listTeams()).some(({ name }) => name === 'Billing'),
          ).toBe(false);
          expect(await source.stores.projects.findById(visible.projectId)).toBeNull();
          expect(await source.stores.workItems.listByProject(visible.projectId)).toEqual([]);
          expect(announcements.published).toEqual([]);
        } finally {
          await source.close();
        }
      });
    }

    it('serializes concurrent imports competing for one free solution slug', async () => {
      const source = await ownedSource();
      try {
        const creationHeld = deferred<undefined>();
        const secondStarted = deferred<undefined>();
        const release = deferred<undefined>();
        const service = importService(source, {
          uow: heldSolutionUnitOfWork(source, creationHeld, secondStarted, release.promise),
        });
        const firstDocument = planDocumentFixture();
        firstDocument.settings.name = 'First concurrent import';
        firstDocument.settings.solutionRef = {
          slug: 'shared-free-solution',
          url: 'https://example.test/solutions/first',
        };
        const secondDocument = planDocumentFixture();
        secondDocument.settings.name = 'Second concurrent import';
        secondDocument.settings.solutionRef = {
          slug: 'shared-free-solution',
          url: 'https://example.test/solutions/second',
        };

        const first = service.import(firstDocument, ACTOR);
        await creationHeld.promise;
        const second = service.import(secondDocument, ACTOR);
        await secondStarted.promise;
        release.resolve(undefined);
        const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
        if (!firstOutcome.ok || !secondOutcome.ok)
          throw new Error('valid concurrent import was refused');

        expect(firstOutcome.solutionRef).toBe('kept');
        expect(secondOutcome.solutionRef).toBe('left-off');
        expect(firstOutcome.projectId).not.toBe(secondOutcome.projectId);
        expect(await source.stores.projects.findById(firstOutcome.projectId)).toMatchObject({
          name: 'First concurrent import',
          solutionRef: {
            slug: 'shared-free-solution',
            url: 'https://example.test/solutions/first',
          },
        });
        expect(await source.stores.projects.findById(secondOutcome.projectId)).toMatchObject({
          name: 'Second concurrent import',
          solutionRef: null,
        });
      } finally {
        await source.close();
      }
    });

    it('publishes directory, project, and tree refreshes without writing history', async () => {
      const source = await ownedSource();
      try {
        const existingProjectId = 'existing-subscriber-project';
        await source.stores.projects.create(
          projectFixture(existingProjectId, 'Existing subscriber'),
          [],
          STAMP,
        );
        const published: { projectId: string; event: ProjectEvent }[] = [];
        const subscriberReads: string[][] = [];
        const announcements: Broadcaster = {
          async publish(projectId, event) {
            published.push({ projectId, event });
            if (projectId === existingProjectId && event.type === 'directory_changed') {
              subscriberReads.push(
                (await source.stores.directory.listTeams()).map(({ name }) => name),
              );
            }
          },
          latestSeq: () => Promise.resolve(-1),
        };

        const imported = await importService(source, { announcements }).import(
          planDocumentFixture(),
          ACTOR,
        );
        if (!imported.ok) throw new Error(`valid import refused at ${imported.path}`);

        expect(subscriberReads).toEqual([['Billing']]);
        expect(
          published
            .filter(({ projectId }) => projectId === imported.projectId)
            .map(({ event }) => event.type),
        ).toEqual(['directory_changed', 'project_settings_changed', 'tree_replaced']);
        expect(
          published.find(
            ({ projectId, event }) =>
              projectId === imported.projectId && event.type === 'project_settings_changed',
          ),
        ).toEqual({
          projectId: imported.projectId,
          event: {
            type: 'project_settings_changed',
            optimizationEnabled: false,
            scheduleEngine: 'fast',
            scheduleObjective: 'pri',
          },
        });
        const tree = published.find(
          ({ projectId, event }) =>
            projectId === imported.projectId && event.type === 'tree_replaced',
        );
        if (tree?.event.type !== 'tree_replaced')
          throw new Error('import did not announce its tree');
        expect(tree.event.workItems.map(({ name }) => name)).toEqual(['Ship']);
        expect(await source.stores.journal.entriesFor(imported.projectId, ACTOR)).toEqual([]);
        expect(await source.stores.planEvents.listFor(imported.projectId, {})).toEqual([]);
      } finally {
        await source.close();
      }
    });

    it('releases admission before a held publisher settles', async () => {
      const source = await ownedSource();
      try {
        const publishing = deferred<undefined>();
        const release = deferred<undefined>();
        const announcements = heldBroadcaster(publishing, release.promise);
        const importing = importService(source, { announcements }).import(
          planDocumentFixture(),
          ACTOR,
        );
        await publishing.promise;

        const ordinary = source.uow.run(async (scope) => {
          await scope.stores.projects.create(
            projectFixture('ordinary-project', 'Ordinary write'),
            [],
            STAMP,
          );
          return { commit: true, value: undefined };
        });
        await ordinary;
        expect(await source.stores.projects.findById('ordinary-project')).not.toBeNull();

        release.resolve(undefined);
        const imported = await importing;
        expect(imported.ok).toBe(true);
      } finally {
        await source.close();
      }
    });

    it('round trips every authored input while storing leaf values only', async () => {
      const source = await ownedSource();
      try {
        const service = importService(source);
        const seeded = await service.import(roundTripFixture(), ACTOR);
        if (!seeded.ok) throw new Error(`round-trip seed refused at ${seeded.path}`);
        const exported = await exportProject(source, seeded.projectId);
        const directoryBefore = {
          teams: await source.stores.directory.listTeams(),
          people: await source.stores.directory.listPeople(),
          tags: await source.stores.directory.listTags(),
          services: await source.stores.directory.listServices(),
          types: await source.stores.directory.listWorkItemTypes(),
          systems: await source.stores.directory.listExternalSystems(),
        };

        const restored = await service.import(exported, ACTOR);
        if (!restored.ok) throw new Error(`round-trip restore refused at ${restored.path}`);
        expect(restored.solutionRef).toBe('left-off');
        const reexported = await exportProject(source, restored.projectId);
        expect({
          teams: await source.stores.directory.listTeams(),
          people: await source.stores.directory.listPeople(),
          tags: await source.stores.directory.listTags(),
          services: await source.stores.directory.listServices(),
          types: await source.stores.directory.listWorkItemTypes(),
          systems: await source.stores.directory.listExternalSystems(),
        }).toEqual(directoryBefore);

        const rows = await source.stores.workItems.listByProject(restored.projectId);
        const parent = rows.find(({ name }) => name === 'Release');
        const build = rows.find(({ name }) => name === 'Build release');
        const verify = rows.find(({ name }) => name === 'Verify release');
        if (parent === undefined || build === undefined || verify === undefined)
          throw new Error('round-trip hierarchy is incomplete');
        const [estimates, actuals, progress, measures] = await Promise.all([
          source.stores.estimates.listByProject(restored.projectId),
          source.stores.actuals.listByProject(restored.projectId),
          source.stores.progress.listByProject(restored.projectId),
          source.stores.measures.listByProject(restored.projectId),
        ]);
        // Proof: admitting exported parent roll-ups made each source table name
        // the parent here. The second export still matched because its roll-up
        // masks those duplicate stored facts, so the source-table check is the
        // assertion that observed the fault.
        expect({
          parentFacts: {
            estimates: estimates.some(({ workItemId }) => workItemId === parent.id),
            actuals: actuals.some(({ workItemId }) => workItemId === parent.id),
            progress: progress.some(({ workItemId }) => workItemId === parent.id),
            measures: measures.some(({ workItemId }) => workItemId === parent.id),
          },
          reexported: authoredSnapshot(reexported),
        }).toEqual({
          parentFacts: { estimates: false, actuals: false, progress: false, measures: false },
          reexported: authoredSnapshot(exported),
        });
        expect(new Set(estimates.map(({ workItemId }) => workItemId))).toEqual(
          new Set([build.id, verify.id]),
        );
      } finally {
        await source.close();
      }
    });
  });
}
