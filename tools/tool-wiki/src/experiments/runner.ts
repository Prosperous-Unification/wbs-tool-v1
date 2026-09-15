import { parseOrThrow, type } from '@shared/validation';

import {
  ElapsedReceipt,
  ExperimentManifest,
  InvocationReceipt,
  IsoInstant,
  OpaqueId,
  SchemaVersion,
} from '../contracts/records';
import {
  compareCanonicalText,
  hashCanonical,
  serializeCanonical,
} from '../evidence/content-manifest';
import {
  accountTrial,
  AllocationReceipt,
  TrialAttempt,
  TrialJournal,
  TrialOutcome,
  TrialReport,
  type TrialReport as TrialReportRecord,
  TrialSession,
} from './accounting';

const Sha256 = type(/^[0-9a-f]{64}$/);
const PositiveSafeInteger = type('number.integer>=1').narrow((value, context) =>
  Number.isSafeInteger(value) ? true : context.mustBe('a positive safe integer'),
);
const NonNegativeSafeInteger = type('number.integer>=0').narrow((value, context) =>
  Number.isSafeInteger(value) && !Object.is(value, -0)
    ? true
    : context.mustBe('a nonnegative safe integer'),
);

const AssignedOutcome = type({
  outcomeId: OpaqueId,
  title: 'string>=1',
  stratum: "'independent-module'|'shared-contract'",
  heldOut: 'boolean',
  acceptanceCriteria: 'string[]',
}).onUndeclaredKey('reject');

export const ExecutionPacket = type({
  schemaVersion: SchemaVersion,
  trialId: OpaqueId,
  manifest: ExperimentManifest,
  manifestIdentity: Sha256,
  repeat: PositiveSafeInteger,
  seed: NonNegativeSafeInteger,
  concurrency: PositiveSafeInteger,
  assignmentOrdinal: NonNegativeSafeInteger,
  outcomes: AssignedOutcome.array(),
  cacheCondition: "'cold'|'warm'|'mixed'",
  timeoutMs: PositiveSafeInteger,
}).onUndeclaredKey('reject');
export type ExecutionPacket = typeof ExecutionPacket.infer;

export const ExecutionSessionEvidence = type({
  schemaVersion: SchemaVersion,
  packetIdentity: Sha256,
  processId: OpaqueId,
  cacheCondition: "'cold'|'warm'|'mixed'",
  session: TrialSession,
  attempts: TrialAttempt.array(),
  outcomes: TrialOutcome.array(),
  invocationReceipts: InvocationReceipt.array(),
  elapsedReceipts: ElapsedReceipt.array(),
}).onUndeclaredKey('reject');
export type ExecutionSessionEvidence = typeof ExecutionSessionEvidence.infer;

export const TrialRunRequest = type({
  schemaVersion: SchemaVersion,
  trialId: OpaqueId,
  manifest: ExperimentManifest,
  manifestIdentity: Sha256,
  repeat: PositiveSafeInteger,
  seed: NonNegativeSafeInteger,
  concurrency: PositiveSafeInteger,
  startedAt: IsoInstant,
  endedAt: IsoInstant,
  timeoutMs: PositiveSafeInteger,
  allocationReceipts: AllocationReceipt.array(),
}).onUndeclaredKey('reject');
export type TrialRunRequest = typeof TrialRunRequest.infer;

const LaunchedSession = type({
  assignmentOrdinal: NonNegativeSafeInteger,
  packetIdentity: Sha256,
  processId: OpaqueId,
  sessionId: OpaqueId,
}).onUndeclaredKey('reject');

export const TrialCheckpoint = type({
  schemaVersion: SchemaVersion,
  state: "'running'|'pending'|'completed'",
  trialId: OpaqueId,
  manifestIdentity: Sha256,
  repeat: PositiveSafeInteger,
  seed: NonNegativeSafeInteger,
  concurrency: PositiveSafeInteger,
  launchedSessions: LaunchedSession.array(),
  sessions: ExecutionSessionEvidence.array(),
  pendingSessionIds: OpaqueId.array(),
  'reason?': 'string>=1',
}).onUndeclaredKey('reject');
export type TrialCheckpoint = typeof TrialCheckpoint.infer;

export interface ExecutionLaunch {
  processId: string;
  sessionId: string;
  completion: Promise<unknown>;
  cancel(reason: 'canceled' | 'timeout'): void;
}

export interface ExecutionAdapter {
  start(packet: ExecutionPacket): ExecutionLaunch;
}

export interface TrialCheckpointStore {
  save(checkpoint: TrialCheckpoint): void;
}

export type TrialRunOutcome =
  | {
      status: 'verified';
      journal: TrialJournal;
      report: TrialReportRecord;
      checkpoint: TrialCheckpoint;
    }
  | { status: 'pending'; reason: string; checkpoint: TrialCheckpoint };

function sameSet(actual: readonly string[], expected: readonly string[], label: string): void {
  const normalize = (identities: readonly string[]) => [...identities].sort(compareCanonicalText);
  if (serializeCanonical(normalize(actual)) !== serializeCanonical(normalize(expected))) {
    throw new Error(`${label} differ`);
  }
}

/** Produces stable randomized round-robin assignments without changing the frozen outcome set. */
export function assignTrialOutcomes(
  manifestInput: unknown,
  seed: number,
  repeat: number,
  concurrency: number,
): string[][] {
  const manifest = parseOrThrow(ExperimentManifest, manifestInput);
  const envelope = parseOrThrow(
    type({
      seed: NonNegativeSafeInteger,
      repeat: PositiveSafeInteger,
      concurrency: PositiveSafeInteger,
    }).onUndeclaredKey('reject'),
    { seed, repeat, concurrency },
  );
  if (!manifest.seeds.includes(envelope.seed))
    throw new Error('trial seed is absent from manifest');
  if (envelope.concurrency > manifest.resources.maxConcurrentSessions) {
    throw new Error('trial concurrency exceeds manifest resource capacity');
  }
  if (manifest.corpus.outcomes.length < envelope.concurrency) {
    throw new Error('trial corpus cannot assign at least one outcome to every session');
  }
  const hashed = manifest.corpus.outcomes
    .map(({ outcomeId }) => outcomeId)
    .sort((left, right) =>
      compareCanonicalText(
        hashCanonical({ seed: envelope.seed, repeat: envelope.repeat, outcomeId: left }),
        hashCanonical({ seed: envelope.seed, repeat: envelope.repeat, outcomeId: right }),
      ),
    );
  const rotation = (envelope.seed + envelope.repeat - 1) % hashed.length;
  const ordered = [...hashed.slice(rotation), ...hashed.slice(0, rotation)];
  const assignments = Array.from({ length: envelope.concurrency }, () => [] as string[]);
  ordered.forEach((outcomeId, index) => assignments[index % envelope.concurrency].push(outcomeId));
  return assignments;
}

function checkpoint(
  request: TrialRunRequest,
  state: TrialCheckpoint['state'],
  launchedSessions: TrialCheckpoint['launchedSessions'],
  sessions: ExecutionSessionEvidence[],
  pendingSessionIds: string[],
  reason?: string,
): TrialCheckpoint {
  return parseOrThrow(TrialCheckpoint, {
    schemaVersion: 1,
    state,
    trialId: request.trialId,
    manifestIdentity: request.manifestIdentity,
    repeat: request.repeat,
    seed: request.seed,
    concurrency: request.concurrency,
    launchedSessions: [...launchedSessions].sort(
      (left, right) => left.assignmentOrdinal - right.assignmentOrdinal,
    ),
    sessions: [...sessions].sort(
      (left, right) =>
        launchedSessions.findIndex(({ sessionId }) => sessionId === left.session.sessionId) -
        launchedSessions.findIndex(({ sessionId }) => sessionId === right.session.sessionId),
    ),
    pendingSessionIds: [...pendingSessionIds].sort(compareCanonicalText),
    ...(reason === undefined ? {} : { reason }),
  });
}

function awaitLaunch(
  launch: ExecutionLaunch,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      launch.cancel('canceled');
      finish();
      reject(new Error(`session ${launch.sessionId} was canceled`));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      launch.cancel('timeout');
      finish();
      reject(new Error(`session ${launch.sessionId} timed out`));
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    launch.completion.then(
      (evidence) => {
        if (settled) return;
        settled = true;
        finish();
        resolve(evidence);
      },
      (cause: unknown) => {
        if (settled) return;
        settled = true;
        finish();
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      },
    );
  });
}

function assertEvidence(packet: ExecutionPacket, launch: ExecutionLaunch, input: unknown) {
  const evidence = parseOrThrow(ExecutionSessionEvidence, input);
  if (
    evidence.packetIdentity !== hashCanonical(packet) ||
    evidence.processId !== launch.processId ||
    evidence.session.processId !== launch.processId ||
    evidence.session.sessionId !== launch.sessionId
  ) {
    throw new Error(`session ${launch.sessionId} evidence differs from its launch`);
  }
  if (evidence.cacheCondition !== packet.cacheCondition) {
    throw new Error(`session ${launch.sessionId} changed the pinned cache condition`);
  }
  sameSet(
    evidence.outcomes.map(({ outcomeId }) => outcomeId),
    packet.outcomes.map(({ outcomeId }) => outcomeId),
    `session ${launch.sessionId} assigned and observed outcomes`,
  );
  return evidence;
}

function maximumActiveSessions(sessions: readonly ExecutionSessionEvidence[]): number {
  const events = sessions.flatMap(({ session }) => [
    { at: Date.parse(session.startedAt), change: 1 },
    { at: Date.parse(session.endedAt), change: -1 },
  ]);
  events.sort((left, right) => left.at - right.at || left.change - right.change);
  let active = 0;
  let maximum = 0;
  for (const event of events) {
    active += event.change;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

/** Runs one pinned trial through an injected structured execution adapter. */
export async function runTrial(
  requestInput: unknown,
  adapter: ExecutionAdapter,
  store: TrialCheckpointStore,
  signal?: AbortSignal,
): Promise<TrialRunOutcome> {
  const request = parseOrThrow(TrialRunRequest, requestInput);
  if (request.manifestIdentity !== hashCanonical(request.manifest)) {
    throw new Error('trial manifest identity differs from canonical manifest bytes');
  }
  const assignments = assignTrialOutcomes(
    request.manifest,
    request.seed,
    request.repeat,
    request.concurrency,
  );
  const outcomeById = new Map(
    request.manifest.corpus.outcomes.map((outcome) => [outcome.outcomeId, outcome]),
  );
  const packets = assignments.map((outcomeIds, assignmentOrdinal) =>
    parseOrThrow(ExecutionPacket, {
      schemaVersion: 1,
      trialId: request.trialId,
      manifest: request.manifest,
      manifestIdentity: request.manifestIdentity,
      repeat: request.repeat,
      seed: request.seed,
      concurrency: request.concurrency,
      assignmentOrdinal,
      outcomes: outcomeIds.map((outcomeId) => outcomeById.get(outcomeId)),
      cacheCondition: request.manifest.resources.cacheCondition,
      timeoutMs: Math.min(request.timeoutMs, request.manifest.retryPolicy.timeBudgetMs),
    }),
  );
  const launches: { packet: ExecutionPacket; launch: ExecutionLaunch }[] = [];
  try {
    for (const packet of packets) launches.push({ packet, launch: adapter.start(packet) });
  } catch (cause) {
    for (const { launch } of launches) launch.cancel('canceled');
    const reason = cause instanceof Error ? cause.message : String(cause);
    const interruptedSessions = launches.map(({ packet, launch }) => ({
      assignmentOrdinal: packet.assignmentOrdinal,
      packetIdentity: hashCanonical(packet),
      processId: launch.processId,
      sessionId: launch.sessionId,
    }));
    const unavailable = checkpoint(
      request,
      'pending',
      interruptedSessions,
      [],
      interruptedSessions.map(({ sessionId }) => sessionId),
      reason,
    );
    store.save(unavailable);
    return { status: 'pending', reason, checkpoint: unavailable };
  }
  const launchedSessions = launches.map(({ packet, launch }) => ({
    assignmentOrdinal: packet.assignmentOrdinal,
    packetIdentity: hashCanonical(packet),
    processId: launch.processId,
    sessionId: launch.sessionId,
  }));
  const sessions: ExecutionSessionEvidence[] = [];
  store.save(
    checkpoint(
      request,
      'running',
      launchedSessions,
      sessions,
      launchedSessions.map(({ sessionId }) => sessionId),
    ),
  );

  const failures: string[] = [];
  const launchControllers = launches.map(() => new AbortController());
  const abortLaunches = () => {
    launchControllers.forEach((controller) => {
      controller.abort();
    });
  };
  const terminal = { evidenceFailure: undefined as Error | undefined };
  signal?.addEventListener('abort', abortLaunches, { once: true });
  if (signal?.aborted) abortLaunches();
  try {
    await Promise.all(
      launches.map(async ({ packet, launch }, launchIndex) => {
        let rawEvidence: unknown;
        let completedNormally = false;
        try {
          rawEvidence = await awaitLaunch(
            launch,
            packet.timeoutMs,
            launchControllers[launchIndex].signal,
          );
          completedNormally = true;
        } catch (cause) {
          failures.push(cause instanceof Error ? cause.message : String(cause));
        }
        if (completedNormally) {
          try {
            sessions.push(assertEvidence(packet, launch, rawEvidence));
          } catch (cause) {
            if (terminal.evidenceFailure === undefined) {
              terminal.evidenceFailure = cause instanceof Error ? cause : new Error(String(cause));
              // Proof: substituting the first session's process identity made runner.test.ts
              // receive no sibling cancellation and a second running checkpoint after rejection.
              abortLaunches();
            }
          }
        }
        if (terminal.evidenceFailure !== undefined) return;
        const completedIds = new Set(sessions.map(({ session }) => session.sessionId));
        store.save(
          checkpoint(
            request,
            failures.length === 0 ? 'running' : 'pending',
            launchedSessions,
            sessions,
            launchedSessions
              .map(({ sessionId }) => sessionId)
              .filter((sessionId) => !completedIds.has(sessionId)),
            failures.length === 0 ? undefined : failures.sort(compareCanonicalText).join('; '),
          ),
        );
      }),
    );
  } finally {
    signal?.removeEventListener('abort', abortLaunches);
  }
  if (terminal.evidenceFailure !== undefined) {
    const pending = checkpoint(
      request,
      'pending',
      launchedSessions,
      sessions,
      launchedSessions
        .map(({ sessionId }) => sessionId)
        .filter((sessionId) => !sessions.some(({ session }) => session.sessionId === sessionId)),
      terminal.evidenceFailure.message,
    );
    store.save(pending);
    throw terminal.evidenceFailure;
  }
  if (failures.length !== 0) {
    const reason = failures.sort(compareCanonicalText).join('; ');
    const partial = checkpoint(
      request,
      'pending',
      launchedSessions,
      sessions,
      launchedSessions
        .map(({ sessionId }) => sessionId)
        .filter((sessionId) => !sessions.some(({ session }) => session.sessionId === sessionId)),
      reason,
    );
    store.save(partial);
    return { status: 'pending', reason, checkpoint: partial };
  }
  if (maximumActiveSessions(sessions) < request.concurrency) {
    // Proof: returning two disjoint groups of four for an eight-session request made
    // runner.test.ts reach verified accounting until this active-interval check was restored.
    throw new Error(
      `trial did not record ${String(request.concurrency)} simultaneous active sessions`,
    );
  }
  const journal = parseOrThrow(TrialJournal, {
    schemaVersion: 1,
    trialId: request.trialId,
    manifest: request.manifest,
    manifestIdentity: request.manifestIdentity,
    repeat: request.repeat,
    seed: request.seed,
    concurrency: request.concurrency,
    startedAt: request.startedAt,
    endedAt: request.endedAt,
    status: sessions.some(({ session }) => session.status === 'censored')
      ? 'censored'
      : sessions.some(({ session }) => session.status === 'failed')
        ? 'failed'
        : 'completed',
    sessions: sessions.map(({ session }) => session),
    attempts: sessions.flatMap(({ attempts }) => attempts),
    outcomes: sessions.flatMap(({ outcomes }) => outcomes),
    invocationReceipts: sessions.flatMap(({ invocationReceipts }) => invocationReceipts),
    elapsedReceipts: sessions.flatMap(({ elapsedReceipts }) => elapsedReceipts),
    allocationReceipts: request.allocationReceipts,
  });
  const report = accountTrial(journal);
  const completed = checkpoint(request, 'completed', launchedSessions, sessions, []);
  store.save(completed);
  return { status: 'verified', journal, report, checkpoint: completed };
}

/** Refuses reports whose pinned conditions differ; concurrency/repeat/seed live outside manifests. */
export function assertComparableTrials(inputs: readonly unknown[]): TrialReportRecord[] {
  const reports = inputs.map((input) => parseOrThrow(TrialReport, input));
  const identities = new Set(reports.map(({ manifestIdentity }) => manifestIdentity));
  // Proof: changing only the pinned hypothesis after one observation made runner.test.ts accept
  // the pair as comparable until exact manifest identity equality was restored.
  if (identities.size > 1) throw new Error('trials have incomparable pinned manifests');
  return reports;
}
