import type { HistoryStores, TransactionalStores } from '@wbs/core';

export type PortName = keyof TransactionalStores | keyof HistoryStores;

export const PORT_NAMES = [
  'projects',
  'users',
  'directory',
  'capacity',
  'priorityBands',
  'calendarMarkers',
  'eventLog',
  'planEvents',
  'steps',
  'workItems',
  'estimates',
  'actuals',
  'measures',
  'progress',
  'dependencies',
  'subtrees',
  'journal',
  'savedPlans',
  'savedPlanCapture',
] as const satisfies readonly PortName[];

export const CASE_MANIFEST = {
  projects: ['projects.create:steps', 'projects.update:scope', 'projects.recordOpen:reader-order'],
  users: [
    'users.create:unique-name',
    'users.find:identity',
    'users.resolveOidcIdentity:issuer-subject',
    'users.resolveOidcIdentity:verified-conflict',
  ],
  directory: [
    'directory.addTag',
    'directory.assign:unknown_person',
    'directory.assign:scope-replace-clear',
    'directory.patchTeam:atomic-refusal',
  ],
  capacity: [
    'capacity.set:project-team-key',
    'capacity.set:clear',
    'capacity.set:missing-reference',
  ],
  priorityBands: [
    'priorityBands.listFor:defaults',
    'priorityBands.replace:whole-project',
    'priorityBands.replace:missing-project',
  ],
  calendarMarkers: ['calendarMarkers.listFor:total-order', 'calendarMarkers.write:project-scope'],
  eventLog: [
    'eventLog.recordEvent',
    'eventLog.rangeSince',
    'eventLog.pruneBeyond',
    'eventLog.pruneBeyond:empty-sequence',
  ],
  planEvents: ['planEvents.listFor:filters-order', 'planEvents.pruneOlderThan:strict-cutoff'],
  steps: ['steps.add', 'steps.rename', 'steps.rename:unknown'],
  workItems: [
    'workItems.listByIds:labels-scope',
    'workItems.listPlacements:source-order',
    'workItems.insert:respace',
    'workItems.patch:refusal-atomic',
    'workItems.move:parent-position',
    'workItems.remove:promotion',
    'workItems.setFrozenNumbers:clear',
  ],
  estimates: [
    'estimates.listByWorkItems:scope-order',
    'estimates.listPlacements:source-order',
    'estimates.set',
    'estimates.set:replace',
    'estimates.set:unknown_step',
    'estimates.remove',
    'estimates.moveAll:ownership',
  ],
  actuals: [
    'actuals.listPlacements:source-order',
    'actuals.listByWorkItems:scope-order',
    'actuals.set:replace',
    'actuals.remove:pair',
    'actuals.moveAll:ownership',
    'actuals.set:unknown_step',
  ],
  measures: [
    'measures.listPlacements:source-order',
    'measures.listByWorkItems:scope-order',
    'measures.set:metric-key',
    'measures.remove:metric-key',
    'measures.moveAll:all-metrics',
    'measures.set:unknown_step',
  ],
  progress: [
    'progress.listPlacements:source-order',
    'progress.listByWorkItems:scope-order',
    'progress.set:replace',
    'progress.remove:absence',
    'progress.moveAll:ownership',
    'progress.set:unknown_step',
  ],
  dependencies: [
    'dependencies.listByWorkItems:incident-scope',
    'dependencies.add:idempotent-pair',
    'dependencies.remove:pair',
    'dependencies.removeAllFor:touching-set',
  ],
  subtrees: ['subtrees.insertSubtree:complete-copy', 'subtrees.insertSubtree:late-failure'],
  journal: [
    'journal.append:history-atomic',
    'journal.append:account-redo-depth',
    'journal.flip:preconditions',
  ],
  savedPlans: [
    'savedPlans.write:bytes-and-bodies',
    'savedPlans.write:quota-refusal',
    'savedPlans.write:quota-window',
    'savedPlans.touch:principals-scope',
    'savedPlans.write:late-body-failure',
  ],
  savedPlanCapture: [
    'savedPlanCapture.readPlanInput:complete',
    'savedPlanCapture.readPlanInput:coherent-interleave',
    'savedPlanCapture.readPlanInput:missing-project',
    'savedPlanCapture.readPlanInput:detached',
  ],
} as const satisfies Record<PortName, readonly string[]>;

export const SUPPLEMENTAL_CASE_MANIFEST = {
  common: ['history.batch:independent-commit', 'history.batch:independent-rollback'],
  immediateBusy: ['history.batch:busy-does-not-wait'],
  independentWrite: ['history.batch:interleaved-success-survives'],
} as const;

export type FamilyCaseId = (typeof CASE_MANIFEST)[PortName][number];
export type SupplementalCaseId =
  (typeof SUPPLEMENTAL_CASE_MANIFEST)[keyof typeof SUPPLEMENTAL_CASE_MANIFEST][number];
export type CaseId = FamilyCaseId | SupplementalCaseId;
export type CaseFamily = PortName | 'history';
export type HistoryAdmission = 'immediate-busy' | 'independent-write';

export interface ExpectedCase {
  readonly family: CaseFamily;
  readonly caseId: CaseId;
}

export interface CaseLifecycle {
  readonly fixtureId: string;
  assert(): Promise<void>;
  close(): Promise<void>;
}

export interface CaseRegistration {
  readonly family: CaseFamily;
  readonly caseId: CaseId;
  openAndRun?(): Promise<CaseLifecycle>;
}

/** Keeps the catalog coupled to the port composition at its type boundary. */
export function defineCaseManifest<
  Transactional extends TransactionalStores,
  History extends HistoryStores,
>(manifest: Record<keyof Transactional | keyof History, readonly string[]>) {
  return manifest;
}

/** The exact cases one source admission mechanism must execute. */
export function expectedCasesFor(admission: HistoryAdmission): readonly ExpectedCase[] {
  const familyCases = PORT_NAMES.flatMap((family) =>
    CASE_MANIFEST[family].map((caseId) => ({ family, caseId })),
  );
  const mechanismCases =
    admission === 'immediate-busy'
      ? SUPPLEMENTAL_CASE_MANIFEST.immediateBusy
      : SUPPLEMENTAL_CASE_MANIFEST.independentWrite;
  return [
    ...familyCases,
    ...SUPPLEMENTAL_CASE_MANIFEST.common.map((caseId) => ({ family: 'history' as const, caseId })),
    ...mechanismCases.map((caseId) => ({ family: 'history' as const, caseId })),
  ];
}
