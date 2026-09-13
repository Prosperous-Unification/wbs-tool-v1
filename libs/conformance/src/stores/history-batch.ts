import type {
  SavedPlanHoldingRow,
  SavedPlanStore,
  SavedPlanWrite,
  StoredSavedPlan,
} from '@wbs/core';
import { expect } from 'bun:test';

import type { CaseRegistration, HistoryAdmission, SupplementalCaseId } from '../case-manifest';
import type { CaseFixture, ScenarioControl } from '../source-declaration';

type BatchScenario = Extract<ScenarioControl, { readonly kind: 'batch-settlement' }>;

export interface HistoryBatchFixture extends Pick<
  CaseFixture<SavedPlanStore>,
  'fixtureId' | 'port' | 'seed' | 'close'
> {
  readonly scenario: BatchScenario;
}

export type OpenHistoryBatchCase = (caseId: SupplementalCaseId) => Promise<HistoryBatchFixture>;

interface PlanLiteral {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly body: string;
  readonly bytes: number;
  readonly hash: string;
}

const PLANS = {
  prewrittenCommit: {
    id: 'history-prewritten-commit',
    name: 'Prewritten before commit',
    createdAt: 711,
    body: 'commit-survivor',
    bytes: 15,
    hash: 'history-hash-prewritten-commit',
  },
  prewrittenRollback: {
    id: 'history-prewritten-rollback',
    name: 'Prewritten before rollback',
    createdAt: 712,
    body: 'rollback-survivor',
    bytes: 17,
    hash: 'history-hash-prewritten-rollback',
  },
  commonBusyCommit: {
    id: 'history-common-busy-commit',
    name: 'Busy beside commit',
    createdAt: 713,
    body: 'common-busy-commit',
    bytes: 18,
    hash: 'history-hash-common-busy-commit',
  },
  commonBusyRollback: {
    id: 'history-common-busy-rollback',
    name: 'Busy beside rollback',
    createdAt: 714,
    body: 'common-busy-rollback',
    bytes: 20,
    hash: 'history-hash-common-busy-rollback',
  },
  busySentinel: {
    id: 'history-busy-sentinel',
    name: 'Successful before busy',
    createdAt: 721,
    body: 'busy-survivor',
    bytes: 13,
    hash: 'history-hash-busy-sentinel',
  },
  busyAttempt: {
    id: 'history-busy-attempt',
    name: 'Busy attempt',
    createdAt: 722,
    body: 'busy-attempt',
    bytes: 12,
    hash: 'history-hash-busy-attempt',
  },
  interleavedCommit: {
    id: 'history-interleaved-commit',
    name: 'Interleaved before commit',
    createdAt: 731,
    body: 'interleaved-commit',
    bytes: 18,
    hash: 'history-hash-interleaved-commit',
  },
  interleavedRollback: {
    id: 'history-interleaved-rollback',
    name: 'Interleaved before rollback',
    createdAt: 732,
    body: 'interleaved-rollback',
    bytes: 20,
    hash: 'history-hash-interleaved-rollback',
  },
} as const satisfies Record<string, PlanLiteral>;

function requestOf(plan: PlanLiteral, projectId: string, ownerId: string): SavedPlanWrite {
  return {
    id: plan.id,
    projectId,
    name: plan.name,
    createdBy: 'History Writer',
    createdById: ownerId,
    createdAt: plan.createdAt,
    input: { schemaVersion: 21, bytes: plan.body, sha256: plan.hash },
    schedule: { present: false, absentReason: 'batch-survival' },
  };
}

function expectedOf(plan: PlanLiteral, projectId: string, ownerId: string): StoredSavedPlan {
  return {
    header: {
      id: plan.id,
      projectId,
      name: plan.name,
      createdBy: 'History Writer',
      createdById: ownerId,
      createdAt: plan.createdAt,
      inputSchemaVersion: 21,
      inputBytes: plan.bytes,
      inputSha256: plan.hash,
      scheduleSchemaVersion: null,
      scheduleBytes: null,
      scheduleSha256: null,
      scheduleInputSha256: null,
      schedulerAlgorithmId: null,
      scheduleAbsentReason: 'batch-survival',
    },
    bodies: { input: plan.body, schedule: null },
  };
}

async function writePlan(
  port: SavedPlanStore,
  plan: PlanLiteral,
  projectId: string,
  ownerId: string,
) {
  const observations: { holding: SavedPlanHoldingRow; incomingBytes: number }[] = [];
  const outcome = await port.write(
    requestOf(plan, projectId, ownerId),
    (holding, incomingBytes) => {
      observations.push({ holding: { ...holding }, incomingBytes });
      return Promise.resolve(null);
    },
  );
  return { observations, outcome };
}

type BoundedWrite =
  | { readonly kind: 'settled'; readonly value: Awaited<ReturnType<typeof writePlan>> }
  | { readonly kind: 'pending' };

async function observeWrite(
  write: Promise<Awaited<ReturnType<typeof writePlan>>>,
): Promise<BoundedWrite> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      write.then((value) => ({ kind: 'settled' as const, value })),
      new Promise<{ readonly kind: 'pending' }>((resolve) => {
        timer = setTimeout(() => {
          resolve({ kind: 'pending' });
        }, 25);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function assertSetup(
  fixture: HistoryBatchFixture,
  plan: PlanLiteral,
): Promise<StoredSavedPlan> {
  const projectId = fixture.seed.projectIds[0];
  const ownerId = fixture.seed.ownerIds[1];
  const expected = expectedOf(plan, projectId, ownerId);
  const written = await writePlan(fixture.port, plan, projectId, ownerId);
  expect({
    written,
    stored: await fixture.port.readOf(plan.id),
    lists: await Promise.all(fixture.seed.projectIds.map((id) => fixture.port.listOf(id))),
  }).toEqual({
    written: {
      observations: [{ holding: { plans: 0, bytes: 0 }, incomingBytes: plan.bytes }],
      outcome: { outcome: 'written' },
    },
    stored: expected,
    lists: [[expected.header], []],
  });
  return expected;
}

async function assertBatchCase(
  fixture: HistoryBatchFixture,
  admission: HistoryAdmission,
  caseId: SupplementalCaseId,
): Promise<void> {
  const decision = caseId === 'history.batch:independent-commit' ? 'commit' : 'rollback';
  const isCommon =
    caseId !== 'history.batch:busy-does-not-wait' &&
    caseId !== 'history.batch:interleaved-success-survives';
  const prewrittenLiteral =
    caseId === 'history.batch:busy-does-not-wait'
      ? PLANS.busySentinel
      : decision === 'commit'
        ? PLANS.prewrittenCommit
        : PLANS.prewrittenRollback;
  const prewritten =
    admission === 'immediate-busy' || isCommon
      ? await assertSetup(fixture, prewrittenLiteral)
      : null;
  const attemptLiteral =
    admission === 'immediate-busy'
      ? caseId === 'history.batch:busy-does-not-wait'
        ? PLANS.busyAttempt
        : decision === 'commit'
          ? PLANS.commonBusyCommit
          : PLANS.commonBusyRollback
      : decision === 'commit'
        ? PLANS.interleavedCommit
        : PLANS.interleavedRollback;
  const projectId = fixture.seed.projectIds[0];
  const ownerId = fixture.seed.ownerIds[1];
  let attempt: Awaited<ReturnType<typeof writePlan>> | undefined;
  let bounded: BoundedWrite | undefined;
  let didOperationFail = false;
  let operationFailure: unknown;
  let didSettlementFail = false;
  let settlementFailure: unknown;
  await fixture.scenario.begin();
  await fixture.scenario.entered;
  const write = writePlan(fixture.port, attemptLiteral, projectId, ownerId);
  try {
    bounded = await observeWrite(write);
    if (bounded.kind === 'settled') attempt = bounded.value;
  } catch (cause) {
    didOperationFail = true;
    operationFailure = cause;
  }
  try {
    await fixture.scenario.settle(decision);
  } catch (cause) {
    didSettlementFail = true;
    settlementFailure = cause;
  }
  if (bounded?.kind === 'pending') {
    try {
      attempt = await write;
    } catch (cause) {
      didOperationFail = true;
      operationFailure = cause;
    }
  }
  if (didOperationFail && didSettlementFail)
    throw new AggregateError(
      [operationFailure, settlementFailure],
      'history batch write and settlement failed',
      { cause: operationFailure },
    );
  if (didOperationFail)
    throw operationFailure instanceof Error
      ? operationFailure
      : new Error('history batch operation failed', { cause: operationFailure });
  if (didSettlementFail)
    throw settlementFailure instanceof Error
      ? settlementFailure
      : new Error('history batch settlement failed', { cause: settlementFailure });
  attempt ??= await write;

  const attempted =
    admission === 'independent-write' ? expectedOf(attemptLiteral, projectId, ownerId) : null;
  const projectA = [attempted, prewritten]
    .filter((plan): plan is StoredSavedPlan => plan !== null)
    .sort((left, right) => right.header.createdAt - left.header.createdAt);
  const expectedHolding =
    prewritten === null
      ? { plans: 0, bytes: 0 }
      : { plans: 1, bytes: prewritten.header.inputBytes };
  expect({
    bounded,
    attempt,
    prewritten: prewritten === null ? null : await fixture.port.readOf(prewritten.header.id),
    attempted: await fixture.port.readOf(attemptLiteral.id),
    lists: await Promise.all(fixture.seed.projectIds.map((id) => fixture.port.listOf(id))),
  }).toEqual({
    bounded: {
      kind: 'settled',
      value:
        admission === 'independent-write'
          ? {
              observations: [{ holding: expectedHolding, incomingBytes: attemptLiteral.bytes }],
              outcome: { outcome: 'written' },
            }
          : { observations: [], outcome: { outcome: 'snapshot_busy' } },
    },
    attempt:
      admission === 'independent-write'
        ? {
            observations: [{ holding: expectedHolding, incomingBytes: attemptLiteral.bytes }],
            outcome: { outcome: 'written' },
          }
        : { observations: [], outcome: { outcome: 'snapshot_busy' } },
    prewritten,
    attempted,
    lists: [projectA.map(({ header }) => header), []],
  });
}

function registration(
  caseId: SupplementalCaseId,
  admission: HistoryAdmission,
  open: OpenHistoryBatchCase,
): CaseRegistration {
  return {
    family: 'history',
    caseId,
    async openAndRun() {
      const fixture = await open(caseId);
      return {
        fixtureId: fixture.fixtureId,
        assert: () => assertBatchCase(fixture, admission, caseId),
        close: () => fixture.close(),
      };
    },
  };
}

/** Registers common batch survival plus the declaration-selected admission mechanism. */
export function historyBatchRegistrations(
  admission: HistoryAdmission,
  open: OpenHistoryBatchCase,
): readonly CaseRegistration[] {
  const mechanism =
    admission === 'immediate-busy'
      ? 'history.batch:busy-does-not-wait'
      : 'history.batch:interleaved-success-survives';
  return [
    registration('history.batch:independent-commit', admission, open),
    registration('history.batch:independent-rollback', admission, open),
    registration(mechanism, admission, open),
  ];
}
