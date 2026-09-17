import { type } from 'arktype';

import { project } from './project-response';
import { requestSchema, responseSchema } from './schema-shape';
import { workItemTree } from './work-item-response';

const planHeader = type({
  format: "'wbs-plan'",
  version: '1',
  exportedAt: 'string',
});

const planSettings = type({
  name: 'string',
  restricted: 'boolean',
  estimateMethod: "'pert' | 'optimistic' | 'realistic' | 'pessimistic'",
  depReach: "'whole-item' | 'anchor-slice'",
  pertWeights: { optimistic: 'number', realistic: 'number', pessimistic: 'number' },
  estimateRounding: "'exact' | 'floor' | 'round' | 'ceil'",
  startDate: 'string | null',
  solutionRef: type({ slug: 'string', url: 'string' }).or('null'),
  optimizationEnabled: 'boolean',
  scheduleEngine: "'fast' | 'optimized'",
  scheduleObjective: "'pri' | 'time'",
});

const named = type({ id: 'string', name: 'string' });
const directory = type({
  teams: type({ id: 'string', name: 'string', serviceIds: 'string[]' }).array(),
  people: type({
    id: 'string',
    name: 'string',
    kind: "'person' | 'agent'",
    teamIds: 'string[]',
  }).array(),
  tags: named.array(),
  services: named.array(),
  types: named.array(),
  externalSystems: named.array(),
});

const authoredMarker = type({
  id: 'string',
  date: 'string',
  name: 'string',
  color: 'string | null',
});

/**
 * Version 1 keeps the complete established export and adds every authored value
 * needed to interpret its file-local references during a restore.
 */
export const planDocument = workItemTree.and({
  project,
  document: planHeader,
  settings: planSettings,
  capacity: type({ teamId: 'string', size: 'number' }).array(),
  calendarMarkers: authoredMarker.array(),
  directory,
});

export type PlanDocument = (typeof planDocument)['infer'];

/** Additive responses remain readable by clients written for this version. */
export const planDocumentResponse = responseSchema(planDocument);

/** The classifier reads only the format/version header before version-specific content. */
export const planDocumentHeaderRequest = requestSchema(
  type({
    document: type({ format: "'wbs-plan'", version: 'number.integer', exportedAt: 'string' }),
  }),
  { undeclaredKeys: 'delete' },
);

const opaqueStepValues = type({ '[string]': 'unknown' });
const authoredWorkItem = type({
  id: 'string',
  parentId: 'string | null',
  position: 'number',
  name: 'string',
  notes: 'string',
  frozenNumber: 'string | null',
  startNoEarlierThan: 'string | null',
  startNoEarlierThanReason: 'string | null',
  deadline: 'string | null',
  factStart: 'string | null',
  factEnd: 'string | null',
  // Proof: loosening this to unknown made the mounted document boundary accept
  // "high" at workItems[3].priority with 204 instead of 400 invalid_body.
  priority: 'number | null',
  serviceTeamId: 'string | null',
  serviceId: 'string | null',
  maxParallel: 'number',
  teamIds: 'string[]',
  tagIds: 'string[]',
  serviceIds: 'string[]',
  typeIds: 'string[]',
  externalRefs: type({ id: 'string', systemId: 'string', url: 'string', name: 'string' }).array(),
  estimates: opaqueStepValues,
  actuals: opaqueStepValues,
  progress: opaqueStepValues,
  measures: opaqueStepValues,
  dependsOn: 'string[]',
  assignees: type({ '[string]': 'string' }),
});

/**
 * The archival request projection admits old additive/read-only fields and
 * returns only writable version-1 content. Step-value maps stay opaque until
 * hierarchy validation determines which rows are leaves.
 */
const writablePlanDocument = type({
  document: type({ format: "'wbs-plan'", version: 'number.integer', exportedAt: 'string' }),
  settings: planSettings,
  capacity: type({ teamId: 'string', size: 'number' }).array(),
  priorityBands: type({ startsAt: 'number', defaultValue: 'number', label: 'string' }).array(),
  calendarMarkers: authoredMarker.array(),
  directory,
  workItems: authoredWorkItem.array(),
  steps: type({ id: 'string', name: 'string', position: 'number' }).array(),
});

export const planDocumentRequest = requestSchema(writablePlanDocument, {
  undeclaredKeys: 'delete',
});

export type PlanDocumentRequest = (typeof writablePlanDocument)['infer'];
