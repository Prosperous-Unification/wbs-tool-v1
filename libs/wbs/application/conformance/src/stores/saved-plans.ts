import type {
  SavedPlanHoldingRow,
  SavedPlanPrincipals,
  SavedPlanRow,
  SavedPlanStore,
  SavedPlanWrite,
  StoredSavedPlan,
} from '@wbs/core';
import { expect } from 'bun:test';

import type { CaseRegistration } from '../case-manifest';
import type { CaseFixture, SeededPlan } from '../source-declaration';
import { type OpenCase, storeCase } from './store-case';

interface SavedPlanState {
  readonly plans: readonly (StoredSavedPlan | null)[];
  readonly lists: readonly (readonly SavedPlanRow[])[];
  readonly principals: readonly (SavedPlanPrincipals | null)[];
}

type Settlement<Value> =
  | { readonly status: 'fulfilled'; readonly value: Value }
  | { readonly status: 'rejected'; readonly reason: unknown };

function ownSettlement<Value>(promise: Promise<Value>): Promise<Settlement<Value>> {
  // Proof: delaying the real primary while the issued SQLite rival rejected made Bun
  // report that rival as unhandled before this ownership was attached.
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason }),
  );
}

function quotaPlan(
  id: string,
  projectId: string,
  name: string,
  createdAt: number,
  input: { readonly bytes: string; readonly sha256: string },
  schedule?: { readonly bytes: string; readonly sha256: string },
): SavedPlanWrite {
  return {
    id,
    projectId,
    name,
    createdBy: 'Quota Writer',
    createdById: DETERMINISTIC_OWNER_B,
    createdAt,
    input: { schemaVersion: 11, ...input },
    schedule:
      schedule === undefined
        ? { present: false, absentReason: 'pending' }
        : {
            present: true,
            body: { schemaVersion: 12, ...schedule },
            inputSha256: input.sha256,
            algorithmId: 'conformance-scheduler',
          },
  };
}

const DETERMINISTIC_OWNER_B = 'owner-b';
const HELD_HASH = 'bf34514df96c59c2de5d80148fbe17a5b9242635ca3ecc7aa38e23842f478355';
const OTHER_HASH = '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c';
const INCOMING_HASH = '20f308b7c45b89eaecd7daa6b17c214d4c303638748d2cd9298171474709a985';
const DATES_HASH = '634793e74e7980a5cab8220e0cfd6c9fc916b78ab1af8a77f165a3be7bd319f0';
const LAST_HASH = 'cb1554f2d98617e8cfbc265940ca894fffb31324d8e9846b70d684e34ef41515';
const RIVAL_HASH = 'a2587844f6a3f32d7fa53ae64c1109cf97b7dfa12912a794afca9d56ad317b70';
const LATE_INPUT_HASH = '9dffefcc444c719ff14991008d275645a34f081c07aa54fd1fb39f51488b4df4';
const LATE_SCHEDULE_HASH = '67f1fdbc1d60444b0f4a7e14af440a54c9be6cb9004c37a71db3a6c70745d160';

function expectedQuotaPlan(
  id: string,
  projectId: string,
  name: string,
  createdAt: number,
  input: string,
  inputBytes: number,
  inputSha256: string,
  schedule: null | { readonly bytes: string; readonly byteCount: number; readonly sha256: string },
): StoredSavedPlan {
  return {
    header: {
      id,
      projectId,
      name,
      createdBy: 'Quota Writer',
      createdById: 'owner-b',
      createdAt,
      inputSchemaVersion: 11,
      inputBytes,
      inputSha256,
      scheduleSchemaVersion: schedule === null ? null : 12,
      scheduleBytes: schedule?.byteCount ?? null,
      scheduleSha256: schedule?.sha256 ?? null,
      scheduleInputSha256: schedule === null ? null : inputSha256,
      schedulerAlgorithmId: schedule === null ? null : 'conformance-scheduler',
      scheduleAbsentReason: schedule === null ? 'pending' : null,
    },
    bodies: { input, schedule: schedule?.bytes ?? null },
  };
}

function quotaSentinel(seed: SeededPlan) {
  return {
    request: quotaPlan('saved-other-project', seed.projectIds[1], 'Other project sentinel', 500, {
      bytes: 'é',
      sha256: OTHER_HASH,
    }),
    expected: expectedQuotaPlan(
      'saved-other-project',
      'project-b',
      'Other project sentinel',
      500,
      'é',
      2,
      OTHER_HASH,
      null,
    ),
  };
}

async function readQuotaState(fixture: CaseFixture<SavedPlanStore>, ids: readonly string[]) {
  return {
    plans: await Promise.all(ids.map((id) => fixture.readers.savedPlans.readOf(id))),
    lists: await Promise.all(
      fixture.seed.projectIds.map((id) => fixture.readers.savedPlans.listOf(id)),
    ),
    principals: await Promise.all(ids.map((id) => fixture.readers.savedPlans.principalsOf(id))),
  };
}

function expectedQuotaState(
  fixture: CaseFixture<SavedPlanStore>,
  plans: readonly (StoredSavedPlan | null)[],
  projectA: readonly StoredSavedPlan[],
  other: StoredSavedPlan,
) {
  return {
    plans: [...plans],
    lists: [projectA.map(({ header }) => header), [other.header]],
    principals: plans.map((plan) =>
      plan === null
        ? null
        : principals(
            {
              id: plan.header.id,
              projectId: plan.header.projectId,
              name: plan.header.name,
              createdBy: plan.header.createdBy,
              createdById: plan.header.createdById,
              createdAt: plan.header.createdAt,
              input: {
                schemaVersion: plan.header.inputSchemaVersion,
                bytes: plan.bodies.input ?? '',
                sha256: plan.header.inputSha256,
              },
              schedule: { present: false, absentReason: 'pending' },
            },
            plan.header.projectId === fixture.seed.projectIds[0]
              ? fixture.seed.ownerIds[0]
              : fixture.seed.ownerIds[1],
          ),
    ),
  };
}

async function assertQuotaRefusal(fixture: CaseFixture<SavedPlanStore>) {
  const other = quotaSentinel(fixture.seed);
  const held = quotaPlan(
    'quota-held',
    fixture.seed.projectIds[0],
    'Quota held',
    501,
    {
      bytes: 'held-🔒',
      sha256: HELD_HASH,
    },
    { bytes: 'é', sha256: OTHER_HASH },
  );
  const expectedHeld = expectedQuotaPlan(
    'quota-held',
    'project-a',
    'Quota held',
    501,
    'held-🔒',
    9,
    HELD_HASH,
    { bytes: 'é', byteCount: 2, sha256: OTHER_HASH },
  );
  await writePlan(fixture.port, structuredClone(other.request), other.expected);
  await writePlan(fixture.port, structuredClone(held), expectedHeld);
  expect(await readQuotaState(fixture, ['quota-held', 'saved-other-project'])).toEqual(
    expectedQuotaState(fixture, [expectedHeld, other.expected], [expectedHeld], other.expected),
  );
  const incoming = quotaPlan(
    'quota-refused',
    fixture.seed.projectIds[0],
    'Quota refused',
    502,
    { bytes: 'incoming-🧭', sha256: INCOMING_HASH },
    { bytes: 'dates-📅', sha256: DATES_HASH },
  );
  const observations: { holding: SavedPlanHoldingRow; incomingBytes: number }[] = [];
  const outcome = await fixture.port.write(structuredClone(incoming), (holding, incomingBytes) => {
    observations.push({ holding: { plans: holding.plans, bytes: holding.bytes }, incomingBytes });
    return Promise.resolve({ limit: 'conformance_quota', asked: 34, allowed: 33 } as const);
  });
  const state = await readQuotaState(fixture, [
    'quota-refused',
    'quota-held',
    'saved-other-project',
  ]);
  expect({ observations, outcome, state }).toEqual({
    observations: [{ holding: { plans: 1, bytes: 11 }, incomingBytes: 23 }],
    outcome: {
      outcome: 'refused',
      refusal: { limit: 'conformance_quota', asked: 34, allowed: 33 },
    },
    state: expectedQuotaState(
      fixture,
      [null, expectedHeld, other.expected],
      [expectedHeld],
      other.expected,
    ),
  });
}

async function assertQuotaWindow(fixture: CaseFixture<SavedPlanStore>) {
  if (fixture.scenario.kind !== 'competing-history-write')
    throw new Error('quota window requires competing-history-write');
  const other = quotaSentinel(fixture.seed);
  const held = quotaPlan(
    'quota-window-held',
    fixture.seed.projectIds[0],
    'Quota window held',
    511,
    { bytes: 'held-🔒', sha256: HELD_HASH },
  );
  const last = quotaPlan(
    'quota-window-last',
    fixture.seed.projectIds[0],
    'Quota window last',
    512,
    { bytes: 'last-🧩', sha256: LAST_HASH },
  );
  const rival = quotaPlan(
    'quota-window-rival',
    fixture.seed.projectIds[0],
    'Quota window rival',
    513,
    { bytes: 'rival-🚫', sha256: RIVAL_HASH },
  );
  const expectedHeld = expectedQuotaPlan(
    'quota-window-held',
    'project-a',
    'Quota window held',
    511,
    'held-🔒',
    9,
    HELD_HASH,
    null,
  );
  const expectedLast = expectedQuotaPlan(
    'quota-window-last',
    'project-a',
    'Quota window last',
    512,
    'last-🧩',
    9,
    LAST_HASH,
    null,
  );
  await writePlan(fixture.port, structuredClone(other.request), other.expected);
  await writePlan(fixture.port, structuredClone(held), expectedHeld);
  expect(await readQuotaState(fixture, ['quota-window-held', 'saved-other-project'])).toEqual(
    expectedQuotaState(fixture, [expectedHeld, other.expected], [expectedHeld], other.expected),
  );
  const primaryObservations: { holding: SavedPlanHoldingRow; incomingBytes: number }[] = [];
  const rivalObservations: { holding: SavedPlanHoldingRow; incomingBytes: number }[] = [];
  const rivalAttempt: { settlement?: Promise<Settlement<unknown>> } = {};
  let primarySettlement: Settlement<unknown>;
  try {
    const primaryOutcome = await fixture.port.write(
      structuredClone(last),
      (holding, incomingBytes) => {
        primaryObservations.push({
          holding: { plans: holding.plans, bytes: holding.bytes },
          incomingBytes,
        });
        const rivalPromise =
          fixture.scenario.kind === 'competing-history-write'
            ? fixture.scenario.rivalWriter.write(
                structuredClone(rival),
                (rivalHolding, rivalIncomingBytes) => {
                  rivalObservations.push({
                    holding: { plans: rivalHolding.plans, bytes: rivalHolding.bytes },
                    incomingBytes: rivalIncomingBytes,
                  });
                  return Promise.resolve(
                    rivalHolding.plans + 1 > 2
                      ? ({ limit: 'plan_count', asked: 3, allowed: 2 } as const)
                      : null,
                  );
                },
              )
            : undefined;
        rivalAttempt.settlement =
          rivalPromise === undefined ? undefined : ownSettlement(rivalPromise);
        return Promise.resolve(null);
      },
    );
    primarySettlement = { status: 'fulfilled', value: primaryOutcome };
  } catch (failure) {
    primarySettlement = { status: 'rejected', reason: failure };
  }
  const rivalSettlement =
    rivalAttempt.settlement === undefined ? undefined : await rivalAttempt.settlement;
  if (primarySettlement.status === 'rejected' && rivalSettlement?.status === 'rejected')
    throw new AggregateError(
      [primarySettlement.reason, rivalSettlement.reason],
      'quota primary and rival both failed',
      { cause: primarySettlement.reason },
    );
  if (primarySettlement.status === 'rejected') throw primarySettlement.reason;
  if (rivalSettlement?.status === 'rejected') throw rivalSettlement.reason;
  if (rivalSettlement === undefined)
    throw new Error('quota rival was not issued inside the check callback');
  const primaryOutcome = primarySettlement.value;
  const rivalOutcome = rivalSettlement.value;
  const expectedMechanism =
    fixture.scenario.expectedRival === 'quota-refused'
      ? {
          rivalObservations: [{ holding: { plans: 2, bytes: 18 }, incomingBytes: 10 }],
          rivalOutcome: {
            outcome: 'refused',
            refusal: { limit: 'plan_count', asked: 3, allowed: 2 },
          },
        }
      : { rivalObservations: [], rivalOutcome: { outcome: 'snapshot_busy' } };
  const state = await readQuotaState(fixture, [
    'quota-window-last',
    'quota-window-held',
    'quota-window-rival',
    'saved-other-project',
  ]);
  expect({ primaryObservations, primaryOutcome, rivalObservations, rivalOutcome, state }).toEqual({
    primaryObservations: [{ holding: { plans: 1, bytes: 9 }, incomingBytes: 9 }],
    primaryOutcome: { outcome: 'written' },
    ...expectedMechanism,
    state: expectedQuotaState(
      fixture,
      [expectedLast, expectedHeld, null, other.expected],
      [expectedLast, expectedHeld],
      other.expected,
    ),
  });
}

async function assertLateBodyFailure(fixture: CaseFixture<SavedPlanStore>) {
  if (
    fixture.scenario.kind !== 'late-write' ||
    fixture.scenario.point !== 'saved-plan-schedule-body'
  )
    throw new Error('late body case requires saved-plan schedule-body control');
  const other = quotaSentinel(fixture.seed);
  const sentinel = quotaPlan('late-sentinel', fixture.seed.projectIds[0], 'Late sentinel', 521, {
    bytes: 'held-🔒',
    sha256: HELD_HASH,
  });
  const expectedSentinel = expectedQuotaPlan(
    'late-sentinel',
    'project-a',
    'Late sentinel',
    521,
    'held-🔒',
    9,
    HELD_HASH,
    null,
  );
  await writePlan(fixture.port, structuredClone(other.request), other.expected);
  await writePlan(fixture.port, structuredClone(sentinel), expectedSentinel);
  expect(await readQuotaState(fixture, ['late-sentinel', 'saved-other-project'])).toEqual(
    expectedQuotaState(
      fixture,
      [expectedSentinel, other.expected],
      [expectedSentinel],
      other.expected,
    ),
  );
  const target = quotaPlan(
    'late-target',
    fixture.seed.projectIds[0],
    'Late target',
    522,
    { bytes: 'late-input-🔧', sha256: LATE_INPUT_HASH },
    { bytes: 'late-schedule-📆', sha256: LATE_SCHEDULE_HASH },
  );
  const expectedTarget = expectedQuotaPlan(
    'late-target',
    'project-a',
    'Late target',
    522,
    'late-input-🔧',
    15,
    LATE_INPUT_HASH,
    { bytes: 'late-schedule-📆', byteCount: 18, sha256: LATE_SCHEDULE_HASH },
  );
  const observations: { holding: SavedPlanHoldingRow; incomingBytes: number }[] = [];
  fixture.scenario.arm();
  let rejected = false;
  try {
    await fixture.port.write(structuredClone(target), (holding, incomingBytes) => {
      observations.push({ holding: { plans: holding.plans, bytes: holding.bytes }, incomingBytes });
      return Promise.resolve(null);
    });
  } catch {
    rejected = true;
  }
  const state = await readQuotaState(fixture, [
    'late-target',
    'late-sentinel',
    'saved-other-project',
  ]);
  expect({
    observations,
    rejected,
    reached: fixture.scenario.reached(),
    evidence: fixture.scenario.evidence(),
    state,
  }).toEqual({
    observations: [{ holding: { plans: 1, bytes: 9 }, incomingBytes: 33 }],
    rejected: true,
    reached: true,
    evidence: {
      savedPlan: {
        header: expectedTarget.header,
        bodies: { input: 'late-input-🔧', schedule: null },
      },
    },
    state: expectedQuotaState(
      fixture,
      [null, expectedSentinel, other.expected],
      [expectedSentinel],
      other.expected,
    ),
  });
}

function storedPlan(
  plan: SavedPlanWrite,
  inputBytes: number,
  scheduleBytes: number | null,
): StoredSavedPlan {
  return {
    header: {
      id: plan.id,
      projectId: plan.projectId,
      name: plan.name,
      createdBy: plan.createdBy,
      createdById: plan.createdById,
      createdAt: plan.createdAt,
      inputSchemaVersion: plan.input.schemaVersion,
      inputBytes,
      inputSha256: plan.input.sha256,
      scheduleSchemaVersion: plan.schedule.present ? plan.schedule.body.schemaVersion : null,
      scheduleBytes,
      scheduleSha256: plan.schedule.present ? plan.schedule.body.sha256 : null,
      scheduleInputSha256: plan.schedule.present ? plan.schedule.inputSha256 : null,
      schedulerAlgorithmId: plan.schedule.present ? plan.schedule.algorithmId : null,
      scheduleAbsentReason: plan.schedule.present ? null : plan.schedule.absentReason,
    },
    bodies: {
      input: plan.input.bytes,
      schedule: plan.schedule.present ? plan.schedule.body.bytes : null,
    },
  };
}

function principals(plan: SavedPlanWrite, projectOwnerId: string): SavedPlanPrincipals {
  return {
    savedPlanId: plan.id,
    projectId: plan.projectId,
    projectOwnerId,
    createdById: plan.createdById,
  };
}

async function writePlan(port: SavedPlanStore, plan: SavedPlanWrite, expected: StoredSavedPlan) {
  expect(await port.write(plan, () => Promise.resolve(null))).toEqual({ outcome: 'written' });
  expect(await port.readOf(plan.id)).toEqual(expected);
}

async function assertState(
  fixture: CaseFixture<SavedPlanStore>,
  ids: readonly string[],
  state: SavedPlanState,
) {
  expect(await Promise.all(ids.map((id) => fixture.readers.savedPlans.readOf(id)))).toEqual([
    ...state.plans,
  ]);
  expect(
    await Promise.all(fixture.seed.projectIds.map((id) => fixture.readers.savedPlans.listOf(id))),
  ).toEqual(state.lists.map((rows) => [...rows]));
  expect(await Promise.all(ids.map((id) => fixture.readers.savedPlans.principalsOf(id)))).toEqual([
    ...state.principals,
  ]);
}

function writePlans(seed: SeededPlan) {
  const present: SavedPlanWrite = {
    id: 'saved-present',
    projectId: seed.projectIds[0],
    name: 'Present plan',
    createdBy: 'Ada Display',
    createdById: seed.ownerIds[1],
    createdAt: 301,
    input: { schemaVersion: 7, bytes: 'A🔦B', sha256: 'input-hash-present' },
    schedule: {
      present: true,
      body: { schemaVersion: 9, bytes: 'é', sha256: 'schedule-hash-present' },
      inputSha256: 'input-hash-present',
      algorithmId: 'scheduler-present',
    },
  };
  const absent: SavedPlanWrite = {
    id: 'saved-absent',
    projectId: seed.projectIds[0],
    name: 'Absent plan',
    createdBy: 'Guest Snapshot',
    createdById: null,
    createdAt: 302,
    input: { schemaVersion: 3, bytes: 'Zürich', sha256: 'input-hash-absent' },
    schedule: { present: false, absentReason: 'infeasible' },
  };
  return {
    present,
    absent,
    expectedPresent: storedPlan(present, 6, 2),
    expectedAbsent: storedPlan(absent, 7, null),
  };
}

function touchPlans(seed: SeededPlan) {
  const target: SavedPlanWrite = {
    id: 'touch-target',
    projectId: seed.projectIds[0],
    name: 'Touch target',
    createdBy: 'External author',
    createdById: seed.ownerIds[1],
    createdAt: 401,
    input: { schemaVersion: 1, bytes: 'target', sha256: 'hash-target' },
    schedule: { present: false, absentReason: 'not-requested' },
  };
  const nullCreator: SavedPlanWrite = {
    id: 'touch-null-creator',
    projectId: seed.projectIds[0],
    name: 'Null creator',
    createdBy: 'Deleted account display',
    createdById: null,
    createdAt: 402,
    input: { schemaVersion: 2, bytes: 'nullable', sha256: 'hash-nullable' },
    schedule: { present: false, absentReason: 'not-requested' },
  };
  const peer: SavedPlanWrite = {
    id: 'touch-peer',
    projectId: seed.projectIds[0],
    name: 'Project peer',
    createdBy: 'Owner A display',
    createdById: seed.ownerIds[0],
    createdAt: 403,
    input: { schemaVersion: 3, bytes: 'peer', sha256: 'hash-peer' },
    schedule: { present: false, absentReason: 'not-requested' },
  };
  const otherProject: SavedPlanWrite = {
    id: 'touch-other-project',
    projectId: seed.projectIds[1],
    name: 'Other project sentinel',
    createdBy: 'Owner A cross-project',
    createdById: seed.ownerIds[0],
    createdAt: 404,
    input: { schemaVersion: 4, bytes: 'sentinel', sha256: 'hash-sentinel' },
    schedule: { present: false, absentReason: 'not-requested' },
  };
  const expectedTarget = storedPlan(target, 6, null);
  const expectedNullCreator = storedPlan(nullCreator, 8, null);
  const expectedPeer = storedPlan(peer, 4, null);
  const expectedOtherProject = storedPlan(otherProject, 8, null);
  return {
    plans: [target, nullCreator, peer, otherProject] as const,
    stored: [expectedTarget, expectedNullCreator, expectedPeer, expectedOtherProject] as const,
    principals: [
      principals(target, seed.ownerIds[0]),
      principals(nullCreator, seed.ownerIds[0]),
      principals(peer, seed.ownerIds[0]),
      principals(otherProject, seed.ownerIds[1]),
    ] as const,
  };
}

async function assertWrites(fixture: CaseFixture<SavedPlanStore>) {
  const plans = writePlans(fixture.seed);
  await writePlan(fixture.port, plans.present, plans.expectedPresent);
  await writePlan(fixture.port, plans.absent, plans.expectedAbsent);

  await assertState(fixture, [plans.present.id, plans.absent.id], {
    plans: [plans.expectedPresent, plans.expectedAbsent],
    lists: [[plans.expectedAbsent.header, plans.expectedPresent.header], []],
    principals: [
      principals(plans.present, fixture.seed.ownerIds[0]),
      principals(plans.absent, fixture.seed.ownerIds[0]),
    ],
  });
}

async function assertTouches(fixture: CaseFixture<SavedPlanStore>) {
  const plans = touchPlans(fixture.seed);
  for (const [index, plan] of plans.plans.entries()) {
    const expected = plans.stored[index];
    await writePlan(fixture.port, plan, expected);
  }

  const ids = [...plans.plans.map(({ id }) => id), 'missing-touch-plan'];
  const initial: SavedPlanState = {
    plans: [...plans.stored, null],
    lists: [
      [plans.stored[2].header, plans.stored[1].header, plans.stored[0].header],
      [plans.stored[3].header],
    ],
    principals: [...plans.principals, null],
  };
  await assertState(fixture, ids, initial);

  expect(await fixture.port.renameTo('touch-target', 'Renamed target')).toBe('touched');
  const renamedTarget: StoredSavedPlan = {
    header: { ...plans.stored[0].header, name: 'Renamed target' },
    bodies: { input: 'target', schedule: null },
  };
  const renamed: SavedPlanState = {
    plans: [renamedTarget, plans.stored[1], plans.stored[2], plans.stored[3], null],
    lists: [
      [plans.stored[2].header, plans.stored[1].header, renamedTarget.header],
      [plans.stored[3].header],
    ],
    principals: initial.principals,
  };
  await assertState(fixture, ids, renamed);

  expect(await fixture.port.renameTo('missing-touch-plan', 'Never stored')).toBe('no_such_plan');
  await assertState(fixture, ids, renamed);
  expect(await fixture.port.deleteOf('missing-touch-plan')).toBe('no_such_plan');
  await assertState(fixture, ids, renamed);

  expect(await fixture.port.deleteOf('touch-target')).toBe('touched');
  await assertState(fixture, ids, {
    plans: [null, plans.stored[1], plans.stored[2], plans.stored[3], null],
    lists: [[plans.stored[2].header, plans.stored[1].header], [plans.stored[3].header]],
    principals: [null, plans.principals[1], plans.principals[2], plans.principals[3], null],
  });
}

/** Registers saved-plan byte, body, ownership and touch evidence. */
export function savedPlanRegistrations(open: OpenCase<'savedPlans'>): readonly CaseRegistration[] {
  return [
    storeCase('savedPlans', 'savedPlans.write:bytes-and-bodies', open, assertWrites),
    storeCase('savedPlans', 'savedPlans.write:quota-refusal', open, assertQuotaRefusal),
    storeCase('savedPlans', 'savedPlans.write:quota-window', open, assertQuotaWindow),
    storeCase('savedPlans', 'savedPlans.touch:principals-scope', open, assertTouches),
    storeCase('savedPlans', 'savedPlans.write:late-body-failure', open, assertLateBodyFailure),
  ];
}
