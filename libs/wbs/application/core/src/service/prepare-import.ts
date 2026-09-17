import type { PlanDocumentRequest } from '@wbs/contracts';
import {
  isHexTriple,
  isIsoDate,
  isMarkerName,
  isOrphanedNotBeforeReason,
  isStepState,
  LONGEST_NOT_BEFORE_REASON,
  MEASURE_METRICS,
  type MeasureMetric,
  MOST_PEOPLE_AT_ONCE,
  PertWeights,
  priorityLadderProblem,
  type StepState,
  type ThreePointEstimate as Estimate,
  ThreePointEstimate,
  validateCustomColor,
} from '@wbs/domain';
import { type } from '@wbs/validation';

import type { StoredDependency } from '../ports/dependency-store';
import type { Scheduler } from '../ports/scheduler';
import type { WorkItem } from '../ports/work-item-store';
import { cleanName } from './clean-name';
import { MOST_CHARACTERS_IN_A_REF_NAME } from './command-normalizers';
import { canDepend } from './dependency';

type DocumentRow = PlanDocumentRequest['workItems'][number];
type DocumentStep = PlanDocumentRequest['steps'][number];
type DocumentDirectory = PlanDocumentRequest['directory'];

export interface PreparedCapacity {
  teamFileId: string;
  size: number;
}

export interface PreparedMarker {
  fileId: string;
  date: string;
  name: string;
  color: string | null;
}

export interface PreparedStep {
  fileId: string;
  name: string;
  position: number;
}

export interface PreparedNamedEntry {
  fileId: string;
  name: string;
}

export interface PreparedTeam extends PreparedNamedEntry {
  serviceFileIds: string[];
}

export interface PreparedPerson extends PreparedNamedEntry {
  kind: DocumentDirectory['people'][number]['kind'];
  teamFileIds: string[];
}

export interface PreparedExternalRef extends PreparedNamedEntry {
  systemFileId: string;
  url: string;
}

export interface PreparedEstimate extends Estimate {
  stepFileId: string;
}

export interface PreparedActual {
  stepFileId: string;
  days: number;
}

export interface PreparedProgress {
  stepFileId: string;
  state: StepState;
}

export interface PreparedMeasure {
  stepFileId: string;
  metric: MeasureMetric;
  value: number;
}

export interface PreparedAssignment {
  stepFileId: string;
  personFileId: string;
}

export interface PreparedWorkItem {
  fileId: string;
  parentFileId: string | null;
  position: number;
  name: string;
  notes: string;
  frozenNumber: string | null;
  startNoEarlierThan: string | null;
  startNoEarlierThanReason: string | null;
  deadline: string | null;
  factStart: string | null;
  factEnd: string | null;
  priority: number | null;
  serviceTeamFileId: string | null;
  serviceFileId: string | null;
  maxParallel: number;
  teamFileIds: string[];
  tagFileIds: string[];
  serviceFileIds: string[];
  typeFileIds: string[];
  externalRefs: PreparedExternalRef[];
  isLeaf: boolean;
  estimates: PreparedEstimate[];
  actuals: PreparedActual[];
  progress: PreparedProgress[];
  measures: PreparedMeasure[];
  assignments: PreparedAssignment[];
}

export interface PreparedDependency {
  predecessorFileId: string;
  successorFileId: string;
}

export interface PreparedImport {
  settings: PlanDocumentRequest['settings'];
  capacity: PreparedCapacity[];
  priorityBands: PlanDocumentRequest['priorityBands'];
  calendarMarkers: PreparedMarker[];
  steps: PreparedStep[];
  workItems: PreparedWorkItem[];
  dependencies: PreparedDependency[];
  stepByFileId: ReadonlyMap<string, PreparedStep>;
  teamByFileId: ReadonlyMap<string, PreparedTeam>;
  personByFileId: ReadonlyMap<string, PreparedPerson>;
  tagByFileId: ReadonlyMap<string, PreparedNamedEntry>;
  serviceByFileId: ReadonlyMap<string, PreparedNamedEntry>;
  typeByFileId: ReadonlyMap<string, PreparedNamedEntry>;
  externalSystemByFileId: ReadonlyMap<string, PreparedNamedEntry>;
}

export type ImportRefusalCode =
  | 'invalid_body'
  | 'unknown_ref'
  | 'cycle'
  | 'ancestor'
  | 'deadline_before_project_start'
  | 'engine_unavailable';

/** The complete file-id resolution, or the first fault in stable document order. */
export type ImportPreparation =
  | { ok: true; value: PreparedImport }
  | { ok: false; code: ImportRefusalCode; path: string; detail: string | null };

type Refusal = Extract<ImportPreparation, { ok: false }>;

const refuses = (code: ImportRefusalCode, path: string, detail: string | null = null): Refusal => ({
  ok: false,
  code,
  path,
  detail,
});

interface Indexed<T> {
  byId: Map<string, T>;
}

function indexById<T extends { id: string }>(rows: T[], path: string): Indexed<T> | Refusal {
  const byId = new Map<string, T>();
  for (let at = 0; at < rows.length; at += 1) {
    const row = rows.at(at);
    if (row === undefined) throw new Error(`${path} changed length during preparation`);
    // Proof: removing the duplicate lookup made the mounted duplicate-row test miss this path.
    if (row.id === '' || byId.has(row.id))
      return refuses('invalid_body', `${path}[${String(at)}].id`, row.id);
    byId.set(row.id, row);
  }
  return { byId };
}

function isRefusal<T>(indexed: Indexed<T> | Refusal): indexed is Refusal {
  return 'ok' in indexed;
}

function normalizedNamed<T extends { name: string }>(rows: T[], path: string): T[] | Refusal {
  const seen = new Set<string>();
  for (let at = 0; at < rows.length; at += 1) {
    const row = rows.at(at);
    if (row === undefined) throw new Error(`${path} changed length during preparation`);
    const name = cleanName(row.name);
    // Proof: removing the normalized-name lookup made the mounted duplicate-tag test return 204.
    if (name === null || seen.has(name))
      return refuses('invalid_body', `${path}[${String(at)}].name`, name);
    row.name = name;
    seen.add(name);
  }
  return rows;
}

function isFiniteNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function stepEntries(
  values: Record<string, unknown>,
  path: string,
  steps: ReadonlyMap<string, DocumentStep>,
): [string, unknown][] | Refusal {
  const entries = Object.entries(values);
  for (const [stepId] of entries) {
    // Proof: bypassing this lookup made the mounted unknown-step test return 204.
    if (!steps.has(stepId)) return refuses('unknown_ref', `${path}.${stepId}`);
  }
  return entries;
}

function parseLeaf(
  row: DocumentRow,
  at: number,
  steps: ReadonlyMap<string, DocumentStep>,
):
  | Pick<PreparedWorkItem, 'estimates' | 'actuals' | 'progress' | 'measures' | 'assignments'>
  | Refusal {
  const prefix = `workItems[${String(at)}]`;
  const estimateEntries = stepEntries(row.estimates, `${prefix}.estimates`, steps);
  if ('ok' in estimateEntries) return estimateEntries;
  const estimates: PreparedEstimate[] = [];
  for (const [stepId, value] of estimateEntries) {
    const estimate = ThreePointEstimate(value);
    // Proof: bypassing this parse made the unordered-estimate test accept 3/2/1.
    if (estimate instanceof type.errors)
      return refuses('invalid_body', `${prefix}.estimates.${stepId}`);
    estimates.push({ stepFileId: stepId, ...estimate });
  }

  const actualEntries = stepEntries(row.actuals, `${prefix}.actuals`, steps);
  if ('ok' in actualEntries) return actualEntries;
  const actuals: PreparedActual[] = [];
  for (const [stepId, days] of actualEntries) {
    // Proof: bypassing this guard made the mounted negative-actual test return 204.
    if (!isFiniteNonnegative(days)) return refuses('invalid_body', `${prefix}.actuals.${stepId}`);
    actuals.push({ stepFileId: stepId, days });
  }

  const progressEntries = stepEntries(row.progress, `${prefix}.progress`, steps);
  if ('ok' in progressEntries) return progressEntries;
  const progress: PreparedProgress[] = [];
  for (const [stepId, state] of progressEntries) {
    // Proof: bypassing this predicate made the invalid-progress test accept not_started.
    if (!isStepState(state)) return refuses('invalid_body', `${prefix}.progress.${stepId}`);
    progress.push({ stepFileId: stepId, state });
  }

  const measures: PreparedMeasure[] = [];
  for (const [metric, values] of Object.entries(row.measures)) {
    // Proof: removing the metric predicate made the unknown-metric test accept hours.
    // Proof: removing the record predicate made the non-object-measure-map test fail with ok:true.
    if (!isMeasureMetric(metric) || !isUnknownRecord(values))
      return refuses('invalid_body', `${prefix}.measures.${metric}`);
    const measured = stepEntries(values, `${prefix}.measures.${metric}`, steps);
    if ('ok' in measured) return measured;
    for (const [stepId, value] of measured) {
      // Proof: bypassing this guard made the negative-measure test accept -1.
      if (!isFiniteNonnegative(value))
        return refuses('invalid_body', `${prefix}.measures.${metric}.${stepId}`);
      measures.push({ stepFileId: stepId, metric, value });
    }
  }
  return { estimates, actuals, progress, measures, assignments: [] };
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMeasureMetric(metric: string): metric is MeasureMetric {
  return MEASURE_METRICS.some((known) => known === metric);
}

function rowShape(row: DocumentRow): WorkItem {
  return {
    id: row.id,
    projectId: 'file',
    parentId: row.parentId,
    position: row.position,
    name: row.name,
    notes: row.notes,
    frozenNumber: row.frozenNumber,
    startNoEarlierThan: row.startNoEarlierThan,
    startNoEarlierThanReason: row.startNoEarlierThanReason,
    deadline: row.deadline,
    factStart: row.factStart,
    factEnd: row.factEnd,
    priority: row.priority,
    serviceTeamId: row.serviceTeamId,
    serviceId: row.serviceId,
    maxParallel: row.maxParallel,
    revision: 0,
  };
}

function preparedRow(
  row: DocumentRow,
): Omit<
  PreparedWorkItem,
  'isLeaf' | 'estimates' | 'actuals' | 'progress' | 'measures' | 'assignments'
> {
  return {
    fileId: row.id,
    parentFileId: row.parentId,
    position: row.position,
    name: row.name,
    notes: row.notes,
    frozenNumber: row.frozenNumber,
    startNoEarlierThan: row.startNoEarlierThan,
    startNoEarlierThanReason: row.startNoEarlierThanReason,
    deadline: row.deadline,
    factStart: row.factStart,
    factEnd: row.factEnd,
    priority: row.priority,
    serviceTeamFileId: row.serviceTeamId,
    serviceFileId: row.serviceId,
    maxParallel: row.maxParallel,
    teamFileIds: row.teamIds,
    tagFileIds: row.tagIds,
    serviceFileIds: row.serviceIds,
    typeFileIds: row.typeIds,
    externalRefs: row.externalRefs.map((reference) => ({
      fileId: reference.id,
      systemFileId: reference.systemId,
      url: reference.url,
      name: reference.name,
    })),
  };
}

function preparedNamed<T extends { id: string; name: string }>(
  index: ReadonlyMap<string, T>,
): ReadonlyMap<string, PreparedNamedEntry> {
  return new Map(
    [...index].map(([fileId, entry]) => [fileId, { fileId, name: entry.name }] as const),
  );
}

function firstHierarchyRefusal(
  rows: DocumentRow[],
  byId: ReadonlyMap<string, DocumentRow>,
): Refusal | null {
  const siblings = new Set<string>();
  for (let at = 0; at < rows.length; at += 1) {
    const row = rows.at(at);
    if (row === undefined) throw new Error('workItems changed length during preparation');
    if (row.parentId !== null && !byId.has(row.parentId))
      return refuses('unknown_ref', `workItems[${String(at)}].parentId`);
    const sibling = `${row.parentId ?? ''}\u0000${String(row.position)}`;
    if (siblings.has(sibling)) return refuses('invalid_body', `workItems[${String(at)}].position`);
    siblings.add(sibling);
    const seen = new Set<string>();
    let cursor: DocumentRow | undefined = row;
    while (cursor !== undefined && cursor.parentId !== null) {
      if (seen.has(cursor.id)) return refuses('cycle', `workItems[${String(at)}].parentId`);
      seen.add(cursor.id);
      cursor = byId.get(cursor.parentId);
    }
  }
  return null;
}

function firstDependencyRefusal(rows: DocumentRow[]): Refusal | null {
  const shaped = rows.map(rowShape);
  const edges: (StoredDependency & { path: string })[] = [];
  for (let successorAt = 0; successorAt < rows.length; successorAt += 1) {
    const successor = rows.at(successorAt);
    if (successor === undefined) throw new Error('workItems changed length during preparation');
    for (let predecessorAt = 0; predecessorAt < successor.dependsOn.length; predecessorAt += 1) {
      const predecessorId = successor.dependsOn.at(predecessorAt);
      if (predecessorId === undefined)
        throw new Error('dependsOn changed length during preparation');
      edges.push({
        id: `file-edge-${String(edges.length)}`,
        projectId: 'file',
        predecessorId,
        successorId: successor.id,
        path: `workItems[${String(successorAt)}].dependsOn[${String(predecessorAt)}]`,
      });
    }
  }
  for (let at = 0; at < edges.length; at += 1) {
    const edge = edges.at(at);
    if (edge === undefined) throw new Error('dependency list changed during preparation');
    // Proof: bypassing this planner made the ancestry/cycle test accept both complete graphs.
    const refusal = canDepend(
      shaped,
      edges.filter((_entry, index) => index !== at),
      edge.predecessorId,
      edge.successorId,
    );
    if (refusal === 'not_found') return refuses('unknown_ref', edge.path);
    if (refusal !== null) return refuses(refusal, edge.path);
  }
  return null;
}

function validateDates(row: DocumentRow, at: number, projectStart: string | null): Refusal | null {
  const dates = [
    ['startNoEarlierThan', row.startNoEarlierThan],
    ['deadline', row.deadline],
    ['factStart', row.factStart],
    ['factEnd', row.factEnd],
  ] as const;
  for (const [field, value] of dates) {
    // Proof: bypassing date validation made the mounted deadline-before-start test return 204.
    if (value !== null && !isIsoDate(value))
      return refuses('invalid_body', `workItems[${String(at)}].${field}`);
  }
  if (row.startNoEarlierThanReason !== null) {
    const reason = row.startNoEarlierThanReason.trim();
    // Proof: bypassing this bound made the overlong-reason case accept 201 characters.
    if (reason.length > LONGEST_NOT_BEFORE_REASON)
      return refuses('invalid_body', `workItems[${String(at)}].startNoEarlierThanReason`);
    row.startNoEarlierThanReason = reason === '' ? null : reason;
  }
  // Proof: bypassing the pair rule made the orphan-reason case accept words without a date.
  if (isOrphanedNotBeforeReason(row.startNoEarlierThan, row.startNoEarlierThanReason))
    return refuses('invalid_body', `workItems[${String(at)}].startNoEarlierThanReason`);
  // Proof: bypassing this comparison made the mounted deadline-before-start test return 204.
  if (projectStart !== null && row.deadline !== null && row.deadline < projectStart)
    return refuses('deadline_before_project_start', `workItems[${String(at)}].deadline`);
  return null;
}

/**
 * Validates and resolves one archival document completely before source admission.
 *
 * The input has already crossed {@link PlanDocumentRequest}'s structural boundary,
 * but leaf step maps remain opaque there so derived parent aggregates can be
 * discarded without interpretation. This pass derives leafhood from `parentId`,
 * validates only leaf maps, checks hierarchy and dependencies against the complete
 * file graph, and names every remaining reference as a `…FileId`. The returned
 * value therefore cannot be mistaken for a store-ready object carrying database ids.
 *
 * Enabled scheduling is the only case that asks the installed scheduler. A disabled
 * plan retains an optimized preference so a later deployment can enable it.
 */
export function prepareImport(
  supplied: PlanDocumentRequest,
  scheduler: Pick<Scheduler, 'supports'>,
): ImportPreparation {
  const document = structuredClone(supplied);
  const projectName = cleanName(document.settings.name);
  // Proof: bypassing this check made the blank-project-name test accept whitespace.
  if (projectName === null) return refuses('invalid_body', 'settings.name');
  document.settings.name = projectName;
  // Proof: bypassing this predicate made the invalid-project-start test accept 2026-02-31.
  if (document.settings.startDate !== null && !isIsoDate(document.settings.startDate))
    return refuses('invalid_body', 'settings.startDate');
  // Proof: bypassing this parse made the invalid-PERT test accept three zero weights.
  if (PertWeights(document.settings.pertWeights) instanceof type.errors)
    return refuses('invalid_body', 'settings.pertWeights');
  // Proof: bypassing capability refusal made the mounted unavailable-engine test return 204.
  if (
    document.settings.optimizationEnabled &&
    !scheduler.supports(document.settings.scheduleEngine)
  )
    return refuses('engine_unavailable', 'settings.scheduleEngine');

  for (let at = 0; at < document.capacity.length; at += 1) {
    const entry = document.capacity.at(at);
    if (entry === undefined) throw new Error('capacity changed length during preparation');
    // Proof: bypassing this range made the mounted zero-capacity test return 204.
    if (!Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > MOST_PEOPLE_AT_ONCE)
      return refuses('invalid_body', `capacity[${String(at)}].size`);
    // Proof: bypassing this lookup made the duplicate-capacity-team test fail with ok:true.
    if (document.capacity.slice(0, at).some(({ teamId }) => teamId === entry.teamId))
      return refuses('invalid_body', `capacity[${String(at)}].teamId`);
  }

  for (let at = 0; at < document.priorityBands.length; at += 1) {
    const band = document.priorityBands.at(at);
    if (band === undefined) throw new Error('priorityBands changed length during preparation');
    band.label = band.label.trim();
    // Proof: bypassing this guard made the nonpositive-band-start test fail with ok:true.
    if (!Number.isSafeInteger(band.startsAt) || band.startsAt < 1)
      return refuses('invalid_body', `priorityBands[${String(at)}].startsAt`);
    // Proof: bypassing this guard made the nonpositive-band-default test fail with ok:true.
    if (!Number.isSafeInteger(band.defaultValue) || band.defaultValue < 1)
      return refuses('invalid_body', `priorityBands[${String(at)}].defaultValue`);
    const previous = at === 0 ? undefined : document.priorityBands.at(at - 1);
    // Proof: bypassing ordered starts made the mounted invalid-band path assertion fail.
    if (previous !== undefined && band.startsAt <= previous.startsAt)
      return refuses('invalid_body', `priorityBands[${String(at)}].startsAt`);
  }
  // Proof: bypassing the ladder parser made an out-of-band default pass.
  if (priorityLadderProblem(document.priorityBands) !== null)
    return refuses('invalid_body', 'priorityBands');

  const markerIndex = indexById(document.calendarMarkers, 'calendarMarkers');
  if (isRefusal(markerIndex)) return markerIndex;
  for (let at = 0; at < document.calendarMarkers.length; at += 1) {
    const marker = document.calendarMarkers.at(at);
    if (marker === undefined) throw new Error('calendarMarkers changed length during preparation');
    // Proof: bypassing this predicate made the malformed-marker-date case pass.
    if (!isIsoDate(marker.date))
      return refuses('invalid_body', `calendarMarkers[${String(at)}].date`);
    // Proof: bypassing this predicate made the blank-marker-name case pass.
    if (!isMarkerName(marker.name))
      return refuses('invalid_body', `calendarMarkers[${String(at)}].name`);
    // Proof: bypassing this check made the malformed-marker-color case pass.
    if (
      marker.color !== null &&
      (!isHexTriple(marker.color) || !validateCustomColor(marker.color).ok)
    )
      return refuses('invalid_body', `calendarMarkers[${String(at)}].color`, marker.color);
  }

  const directoryLists = [
    ['teams', document.directory.teams],
    ['people', document.directory.people],
    ['tags', document.directory.tags],
    ['services', document.directory.services],
    ['types', document.directory.types],
    ['externalSystems', document.directory.externalSystems],
  ] as const;
  for (const [kind, rows] of directoryLists) {
    const normalized = normalizedNamed(rows, `directory.${kind}`);
    if ('ok' in normalized) return normalized;
  }

  const teams = indexById(document.directory.teams, 'directory.teams');
  if (isRefusal(teams)) return teams;
  const people = indexById(document.directory.people, 'directory.people');
  if (isRefusal(people)) return people;
  const tags = indexById(document.directory.tags, 'directory.tags');
  if (isRefusal(tags)) return tags;
  const services = indexById(document.directory.services, 'directory.services');
  if (isRefusal(services)) return services;
  const types = indexById(document.directory.types, 'directory.types');
  if (isRefusal(types)) return types;
  const externalSystems = indexById(
    document.directory.externalSystems,
    'directory.externalSystems',
  );
  if (isRefusal(externalSystems)) return externalSystems;

  for (let at = 0; at < document.capacity.length; at += 1) {
    const capacity = document.capacity.at(at);
    if (capacity === undefined) throw new Error('capacity changed length during preparation');
    // Proof: bypassing this lookup made the unknown-capacity-team test pass.
    if (!teams.byId.has(capacity.teamId))
      return refuses('unknown_ref', `capacity[${String(at)}].teamId`, capacity.teamId);
  }

  for (let at = 0; at < document.directory.teams.length; at += 1) {
    const team = document.directory.teams.at(at);
    if (team === undefined) throw new Error('teams changed length during preparation');
    for (let refAt = 0; refAt < team.serviceIds.length; refAt += 1)
      // Proof: bypassing this lookup made the unknown-owned-service test pass.
      if (!services.byId.has(team.serviceIds[refAt] ?? ''))
        return refuses(
          'unknown_ref',
          `directory.teams[${String(at)}].serviceIds[${String(refAt)}]`,
        );
  }
  for (let at = 0; at < document.directory.people.length; at += 1) {
    const person = document.directory.people.at(at);
    if (person === undefined) throw new Error('people changed length during preparation');
    for (let refAt = 0; refAt < person.teamIds.length; refAt += 1)
      // Proof: bypassing this lookup made the unknown-membership-team test pass.
      if (!teams.byId.has(person.teamIds[refAt] ?? ''))
        return refuses('unknown_ref', `directory.people[${String(at)}].teamIds[${String(refAt)}]`);
  }

  const normalizedSteps = normalizedNamed(document.steps, 'steps');
  if ('ok' in normalizedSteps) return normalizedSteps;
  const steps = indexById(document.steps, 'steps');
  if (isRefusal(steps)) return steps;
  const stepPositions = new Set<number>();
  for (let at = 0; at < document.steps.length; at += 1) {
    const step = document.steps.at(at);
    if (step === undefined) throw new Error('steps changed length during preparation');
    // Proof: bypassing this guard made the duplicate-step-position case pass.
    if (!Number.isSafeInteger(step.position) || stepPositions.has(step.position))
      return refuses('invalid_body', `steps[${String(at)}].position`, String(step.position));
    stepPositions.add(step.position);
  }
  const rows = indexById(document.workItems, 'workItems');
  if (isRefusal(rows)) return rows;
  // Proof: bypassing whole-graph hierarchy validation made the mounted self-cycle test return 204.
  const hierarchyRefusal = firstHierarchyRefusal(document.workItems, rows.byId);
  if (hierarchyRefusal !== null) return hierarchyRefusal;
  const parents = new Set(document.workItems.flatMap((row) => row.parentId ?? []));
  const preparedRows: PreparedWorkItem[] = [];
  const externalRefIds = new Set<string>();

  for (let at = 0; at < document.workItems.length; at += 1) {
    const row = document.workItems.at(at);
    if (row === undefined) throw new Error('workItems changed length during preparation');
    const rowName = cleanName(row.name);
    // Proof: bypassing this guard made the blank-row-name test fail with ok:true.
    if (rowName === null) return refuses('invalid_body', `workItems[${String(at)}].name`);
    row.name = rowName;
    // Proof: bypassing this guard made the fractional-row-position test pass.
    if (!Number.isSafeInteger(row.position))
      return refuses('invalid_body', `workItems[${String(at)}].position`);
    const dateRefusal = validateDates(row, at, document.settings.startDate);
    if (dateRefusal !== null) return dateRefusal;
    // Proof: bypassing this guard made the mounted zero-priority test return 204.
    if (row.priority !== null && (!Number.isSafeInteger(row.priority) || row.priority < 1))
      return refuses('invalid_body', `workItems[${String(at)}].priority`);
    // Proof: bypassing this range made the zero-parallelism test pass.
    if (
      !Number.isSafeInteger(row.maxParallel) ||
      row.maxParallel < 1 ||
      row.maxParallel > MOST_PEOPLE_AT_ONCE
    )
      return refuses('invalid_body', `workItems[${String(at)}].maxParallel`);
    const references = [
      [row.serviceTeamId === null ? [] : [row.serviceTeamId], teams.byId, 'serviceTeamId'],
      [row.serviceId === null ? [] : [row.serviceId], services.byId, 'serviceId'],
      [row.teamIds, teams.byId, 'teamIds'],
      [row.tagIds, tags.byId, 'tagIds'],
      [row.serviceIds, services.byId, 'serviceIds'],
      [row.typeIds, types.byId, 'typeIds'],
    ] as const;
    for (const [ids, index, field] of references) {
      for (let refAt = 0; refAt < ids.length; refAt += 1)
        // Proof: bypassing this lookup made the unknown-row-tag test pass.
        if (!index.has(ids[refAt] ?? ''))
          return refuses(
            'unknown_ref',
            `workItems[${String(at)}].${field}${ids.length === 1 && !field.endsWith('Ids') ? '' : `[${String(refAt)}]`}`,
          );
    }
    for (let refAt = 0; refAt < row.externalRefs.length; refAt += 1) {
      const reference = row.externalRefs.at(refAt);
      if (reference === undefined)
        throw new Error('externalRefs changed length during preparation');
      // Proof: removing the duplicate lookup made the duplicate-external-ref-id test pass.
      if (reference.id === '' || externalRefIds.has(reference.id))
        return refuses(
          'invalid_body',
          `workItems[${String(at)}].externalRefs[${String(refAt)}].id`,
        );
      externalRefIds.add(reference.id);
      // Proof: bypassing this guard made the empty-external-URL test pass.
      if (reference.url === '')
        return refuses(
          'invalid_body',
          `workItems[${String(at)}].externalRefs[${String(refAt)}].url`,
        );
      // Proof: bypassing this bound made the overlong-external-ref-name test pass.
      if (reference.name.length > MOST_CHARACTERS_IN_A_REF_NAME)
        return refuses(
          'invalid_body',
          `workItems[${String(at)}].externalRefs[${String(refAt)}].name`,
        );
      // Proof: bypassing this lookup made the mounted unknown-system test return 204.
      if (!externalSystems.byId.has(reference.systemId))
        return refuses(
          'unknown_ref',
          `workItems[${String(at)}].externalRefs[${String(refAt)}].systemId`,
        );
    }
    const assignments: PreparedAssignment[] = [];
    for (const [stepId, personId] of Object.entries(row.assignees)) {
      // Proof: bypassing this lookup made the unknown-assignment-step test fail with ok:true.
      if (!steps.byId.has(stepId))
        return refuses('unknown_ref', `workItems[${String(at)}].assignees.${stepId}`);
      // Proof: bypassing this lookup made the mounted unknown-person test return 204.
      if (!people.byId.has(personId))
        return refuses('unknown_ref', `workItems[${String(at)}].assignees.${stepId}`);
      assignments.push({ stepFileId: stepId, personFileId: personId });
    }
    // Proof: forcing every row to leaf made the round-trip contract store its
    // restored parent in all four value tables even though re-export hid the duplication.
    const leaf = !parents.has(row.id);
    const values = leaf
      ? parseLeaf(row, at, steps.byId)
      : { estimates: [], actuals: [], progress: [], measures: [], assignments: [] };
    if ('ok' in values) return values;
    preparedRows.push({ ...preparedRow(row), isLeaf: leaf, ...values, assignments });
  }

  // Proof: bypassing graph validation made the mounted dangling-dependency test return 204.
  const dependencyRefusal = firstDependencyRefusal(document.workItems);
  if (dependencyRefusal !== null) return dependencyRefusal;
  const dependencies = document.workItems.flatMap((row) =>
    row.dependsOn.map((predecessorFileId) => ({
      predecessorFileId,
      successorFileId: row.id,
    })),
  );
  const preparedSteps = document.steps.map(({ id, name, position }) => ({
    fileId: id,
    name,
    position,
  }));
  const stepByFileId = new Map(preparedSteps.map((step) => [step.fileId, step] as const));
  const preparedTeams = document.directory.teams.map(({ id, name, serviceIds }) => ({
    fileId: id,
    name,
    serviceFileIds: serviceIds,
  }));
  const teamByFileId = new Map(preparedTeams.map((team) => [team.fileId, team] as const));
  const preparedPeople = document.directory.people.map(({ id, name, kind, teamIds }) => ({
    fileId: id,
    name,
    kind,
    teamFileIds: teamIds,
  }));
  const personByFileId = new Map(preparedPeople.map((person) => [person.fileId, person] as const));
  return {
    ok: true,
    value: {
      settings: document.settings,
      capacity: document.capacity.map(({ teamId, size }) => ({ teamFileId: teamId, size })),
      priorityBands: document.priorityBands,
      calendarMarkers: document.calendarMarkers.map(({ id, date, name, color }) => ({
        fileId: id,
        date,
        name,
        color,
      })),
      steps: preparedSteps,
      workItems: preparedRows,
      dependencies,
      stepByFileId,
      teamByFileId,
      personByFileId,
      tagByFileId: preparedNamed(tags.byId),
      serviceByFileId: preparedNamed(services.byId),
      typeByFileId: preparedNamed(types.byId),
      externalSystemByFileId: preparedNamed(externalSystems.byId),
    },
  };
}
