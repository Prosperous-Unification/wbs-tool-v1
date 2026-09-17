import { mkdtempSync, rmSync } from 'node:fs';
import { arch, cpus, platform, release, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Broadcaster,
  clockOf,
  type Decision,
  type PlanCommand,
  PlanCommandRunner,
  type PlanCommandRunnerOptions,
  type PlanTransactionalStores,
  type Scope,
  servicesOver,
  type UnitOfWork,
  type WriteStamp,
} from '@wbs/core';
import { fastScheduler } from '@wbs/core/testing/scheduler-fixture';
import { workItemRow } from '@wbs/core/testing/work-item-fixture';
import { projectRow } from '@wbs/store-memory/project-fixture';
import { expect, it } from 'bun:test';
import type { Logger } from 'drizzle-orm';

import { runMigrations } from './migrate';
import { openSqliteSource } from './source';

const MIGRATIONS = new URL('../../../../../apps/wbs/be-01/drizzle', import.meta.url).pathname;
const OWNER = 'working-plan-performance-owner';
const PROJECT = 'working-plan-performance-project';
const STEP = 'working-plan-performance-step';
const STAMP: WriteStamp = { at: 1, by: OWNER };
const ROWS = 200;

const silentBroadcaster: Broadcaster = {
  publish: () => Promise.resolve(),
  latestSeq: () => Promise.resolve(-1),
};

interface FullReads {
  workItems: number;
  estimates: number;
  actuals: number;
  progress: number;
  measures: number;
  dependencies: number;
}

interface ReadCounts {
  readonly full: FullReads;
  targeted: number;
  placements: number;
  assignments: number;
  sqlWrites: number;
}

function emptyFullReads(): FullReads {
  return { workItems: 0, estimates: 0, actuals: 0, progress: 0, measures: 0, dependencies: 0 };
}

function emptyCounts(): ReadCounts {
  return { full: emptyFullReads(), targeted: 0, placements: 0, assignments: 0, sqlWrites: 0 };
}

function resetCounts(counts: ReadCounts): void {
  Object.assign(counts.full, emptyFullReads());
  counts.targeted = 0;
  counts.placements = 0;
  counts.assignments = 0;
  counts.sqlWrites = 0;
}

function sqlCounter(counts: ReadCounts): Logger {
  return {
    logQuery(query) {
      if (/^\s*(?:insert|update|delete)\b/iu.test(query)) counts.sqlWrites += 1;
    },
  };
}

function countedPort<Port extends object>(
  source: Port,
  methods: Readonly<Record<string, () => void>>,
): Port {
  return new Proxy(source, {
    get(target, property) {
      const member = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      return (...parameters: readonly unknown[]) => {
        const observe = typeof property === 'string' ? methods[property] : undefined;
        if (observe !== undefined) observe();
        return Reflect.apply(member, target, parameters) as unknown;
      };
    },
  });
}

function countStoreCalls(
  stores: PlanTransactionalStores,
  counts: ReadCounts,
): PlanTransactionalStores {
  const count = (collection: keyof FullReads) => () => {
    counts.full[collection] += 1;
  };
  const targeted = () => {
    counts.targeted += 1;
  };
  const placement = () => {
    counts.placements += 1;
  };
  const assignment = () => {
    counts.assignments += 1;
  };
  return {
    ...stores,
    workItems: countedPort(stores.workItems, {
      listByProject: count('workItems'),
      listByIds: targeted,
      listPlacements: placement,
    }),
    estimates: countedPort(stores.estimates, {
      listByProject: count('estimates'),
      listByWorkItems: targeted,
      listPlacements: placement,
    }),
    actuals: countedPort(stores.actuals, {
      listByProject: count('actuals'),
      listByWorkItems: targeted,
      listPlacements: placement,
    }),
    progress: countedPort(stores.progress, {
      listByProject: count('progress'),
      listByWorkItems: targeted,
      listPlacements: placement,
    }),
    measures: countedPort(stores.measures, {
      listByProject: count('measures'),
      listByWorkItems: targeted,
      listPlacements: placement,
    }),
    dependencies: countedPort(stores.dependencies, {
      listByProject: count('dependencies'),
      listByWorkItems: targeted,
    }),
    directory: countedPort(stores.directory, {
      assignmentsInProject: assignment,
      assignmentsFor: assignment,
      assignmentsOf: assignment,
    }),
  };
}

function countedUnitOfWork(
  source: UnitOfWork,
  counts: ReadCounts,
): { readonly uow: UnitOfWork; readonly current: () => PlanTransactionalStores } {
  let admitted: PlanTransactionalStores | undefined;
  return {
    uow: {
      run<T>(act: (scope: Scope) => Promise<Decision<T>>): Promise<T> {
        return source.run((scope) => {
          admitted = countStoreCalls(scope.stores, counts);
          return act({ stores: admitted });
        });
      },
    },
    current: () => {
      if (admitted === undefined) throw new Error('batch services requested before admission');
      return admitted;
    },
  };
}

type RunnerMode = 'cached' | 'uncached';

interface PerformanceFixture {
  readonly source: ReturnType<typeof openSqliteSource>;
  readonly counts: ReadCounts;
  readonly runner: (mode: RunnerMode) => PlanCommandRunner;
  readonly close: () => Promise<void>;
}

function rowId(index: number): string {
  return `row-${String(index).padStart(3, '0')}`;
}

function originalDays(index: number) {
  return { optimistic: index + 1, realistic: index + 2, pessimistic: index + 3 };
}

function changedDays(index: number) {
  return { optimistic: index + 201, realistic: index + 202, pessimistic: index + 203 };
}

async function performanceFixture(name: string): Promise<PerformanceFixture> {
  const directory = mkdtempSync(join(tmpdir(), 'wbs-working-plan-performance-'));
  const dbPath = join(directory, 'source.db');
  runMigrations(dbPath, MIGRATIONS);
  const counts = emptyCounts();
  const source = openSqliteSource({ dbPath, logger: sqlCounter(counts) });
  await source.stores.users.create(
    { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: STAMP.at },
    STAMP,
  );
  await source.stores.projects.create(
    projectRow({ id: PROJECT, ownerId: OWNER, name }),
    [{ id: STEP, projectId: PROJECT, name: 'Step', position: 10 }],
    STAMP,
  );
  const firstPerson = await source.stores.directory.addPerson(
    { id: 'person-a', name: 'Person A' },
    [],
    STAMP,
  );
  const secondPerson = await source.stores.directory.addPerson(
    { id: 'person-b', name: 'Person B' },
    [],
    STAMP,
  );
  if (!firstPerson.ok || !secondPerson.ok) throw new Error('performance people were refused');
  for (let index = 0; index < ROWS; index += 1) {
    const id = rowId(index);
    await source.stores.workItems.insert(
      workItemRow({ id, projectId: PROJECT, name: `Row ${String(index)}` }),
      [],
      STAMP,
    );
    await source.stores.estimates.set(
      { workItemId: id, stepId: STEP, ...originalDays(index) },
      STAMP,
    );
    await source.stores.actuals.set(
      { workItemId: id, stepId: STEP, days: index + 1, recordedAt: 1 },
      STAMP,
    );
    await source.stores.progress.set(
      { workItemId: id, stepId: STEP, state: 'in_progress', statedAt: 1 },
      STAMP,
    );
    await source.stores.measures.set(
      { workItemId: id, stepId: STEP, metric: 'token_estimate', value: index + 1, recordedAt: 1 },
      STAMP,
    );
    const assigned = await source.stores.directory.assign(id, STEP, 'person-b', STAMP);
    if (!assigned.ok) throw new Error(`performance assignment ${id} was refused`);
  }
  resetCounts(counts);

  const clock = clockOf({ now: () => 2, newId: () => crypto.randomUUID() });
  const compose = (stores: PlanTransactionalStores, broadcast: Broadcaster) =>
    servicesOver(stores, { clock, broadcast, scheduler: fastScheduler });
  return {
    source,
    counts,
    runner(mode) {
      const admitted = countedUnitOfWork(source.uow, counts);
      const options: PlanCommandRunnerOptions = {
        uow: admitted.uow,
        announcements: silentBroadcaster,
        publicServices: compose(source.stores, silentBroadcaster),
        // The uncached baseline consumes the raw admitted SQLite ports captured
        // by the real UOW. The cached mode consumes the runner-created plan.
        batchServices: (scope, broadcast) =>
          compose(mode === 'cached' ? scope.stores : admitted.current(), broadcast),
      };
      return new PlanCommandRunner(options);
    },
    close: async () => {
      await source.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function homogeneousCommands(): PlanCommand[] {
  return Array.from({ length: ROWS }, (_, index) => ({
    kind: 'setEstimate' as const,
    workItemId: rowId(index),
    stepId: STEP,
    days: changedDays(index),
  }));
}

function mixedCommands(): PlanCommand[] {
  return Array.from({ length: ROWS }, (_, index): PlanCommand => {
    const id = rowId(index);
    switch (index % 5) {
      case 0:
        return { kind: 'setEstimate', workItemId: id, stepId: STEP, days: changedDays(index) };
      case 1:
        return { kind: 'setActual', workItemId: id, stepId: STEP, days: index + 201 };
      case 2:
        return { kind: 'setProgress', workItemId: id, stepId: STEP, state: 'done' };
      case 3:
        return {
          kind: 'setMeasure',
          workItemId: id,
          stepId: STEP,
          metric: 'token_estimate',
          value: index + 201,
        };
      default:
        return {
          kind: 'setAssignee',
          workItemId: id,
          stepId: STEP,
          personId: index % 10 === 4 ? 'person-a' : 'person-b',
        };
    }
  });
}

function expectBoundedFullReads(counts: ReadCounts): void {
  for (const [collection, reads] of Object.entries(counts.full)) {
    // Proof: delegating WorkingPlan value listByProject reads to the SQLite
    // source made this report 201 estimate full reads for 200 commands.
    expect(reads, `${collection} full-project reads`).toBeLessThanOrEqual(1);
  }
}

async function authoredState(fixture: PerformanceFixture): Promise<string> {
  const stores = fixture.source.stores;
  const [estimates, actuals, progress, measures, assignments] = await Promise.all([
    stores.estimates.listByProject(PROJECT),
    stores.actuals.listByProject(PROJECT),
    stores.progress.listByProject(PROJECT),
    stores.measures.listByProject(PROJECT),
    stores.directory.assignmentsInProject(PROJECT),
  ]);
  return JSON.stringify([
    estimates,
    actuals.map(({ workItemId, stepId, days }) => ({ workItemId, stepId, days })),
    progress.map(({ workItemId, stepId, state }) => ({ workItemId, stepId, state })),
    measures.map(({ workItemId, stepId, metric, value }) => ({
      workItemId,
      stepId,
      metric,
      value,
    })),
    assignments,
  ]);
}

function repositoryObservation(arguments_: readonly string[]): string {
  const repository = new URL('../../..', import.meta.url).pathname;
  const execution = Bun.spawnSync(['git', ...arguments_], { cwd: repository });
  if (execution.exitCode !== 0) {
    throw new Error(`git ${arguments_.join(' ')} failed: ${execution.stderr.toString()}`);
  }
  return execution.stdout.toString().trim();
}

function median(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const upper = ordered.at(middle);
  if (upper === undefined) throw new Error('median requires samples');
  if (ordered.length % 2 === 1) return upper;
  const lower = ordered.at(middle - 1);
  if (lower === undefined) throw new Error('median requires samples');
  return (lower + upper) / 2;
}

function sampleRange(samples: readonly number[]): readonly [number, number] {
  const lowest = Math.min(...samples);
  const highest = Math.max(...samples);
  if (!Number.isFinite(lowest) || !Number.isFinite(highest)) {
    throw new Error('sample range requires finite samples');
  }
  return [lowest, highest];
}

type PerformanceWorkloadName = 'homogeneous' | 'mixed';
type PerformanceReportStatus = 'pending' | 'running' | 'complete' | 'failed';

interface ModePerformanceReport {
  readonly samples: number[];
  median?: number;
  range?: readonly [number, number];
}

interface WorkloadPerformanceReport {
  status: PerformanceReportStatus;
  failure?: string;
  readonly cached: ModePerformanceReport;
  readonly uncached: ModePerformanceReport;
}

interface PerformanceEvidence {
  phase: 'measurements' | 'final';
  status: 'running' | 'complete' | 'failed';
  readonly failures: string[];
  readonly repository: {
    certification: 'frozen-clean' | 'developer-run';
    initialHead?: string;
    finalHead?: string;
    initialStatus?: string;
    finalStatus?: string;
    unchanged?: boolean;
  };
  readonly workload: {
    rows: number;
    commands: number;
    pairs: number;
    order: 'alternating by pair index';
    fixtures: readonly PerformanceWorkloadName[];
  };
  host?: {
    platform: string;
    release: string;
    arch: string;
    cpu: string;
    logicalCpus: number;
    bun: string;
  };
  readonly reports: Record<PerformanceWorkloadName, WorkloadPerformanceReport>;
}

interface PerformanceCertificationOptions {
  readonly certifyClean: boolean;
  readonly pairs?: number;
  readonly observeRepository: (observation: 'head' | 'status') => string;
  readonly measure: (
    workload: PerformanceWorkloadName,
    report: WorkloadPerformanceReport,
  ) => Promise<void>;
  readonly emit: (evidence: PerformanceEvidence) => void;
}

function createModeReport(): ModePerformanceReport {
  return { samples: [] };
}

function createWorkloadReport(): WorkloadPerformanceReport {
  return { status: 'pending', cached: createModeReport(), uncached: createModeReport() };
}

function summarizeReport(report: WorkloadPerformanceReport): void {
  for (const mode of ['uncached', 'cached'] as const) {
    const modeReport = report[mode];
    if (modeReport.samples.length === 0) continue;
    modeReport.median = median(modeReport.samples);
    modeReport.range = sampleRange(modeReport.samples);
  }
}

function describeFailure(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

async function captureFailure(promise: Promise<unknown>): Promise<Error | undefined> {
  try {
    await promise;
    return undefined;
  } catch (reason) {
    return reason instanceof Error ? reason : new Error(String(reason));
  }
}

function readCurrentHost(): PerformanceEvidence['host'] {
  const processors = cpus();
  const processor = processors.at(0);
  if (processor === undefined) throw new Error('performance host has no reported CPU');
  return {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: processor.model,
    logicalCpus: processors.length,
    bun: Bun.version,
  };
}

/**
 * Retains timing evidence while treating measurement, ratio, and repository checks as
 * independent failures. Frozen-clean certification is explicit so ordinary dirty developer
 * runs prove only that their starting repository state stayed unchanged.
 */
async function runPerformanceCertification(
  options: PerformanceCertificationOptions,
): Promise<PerformanceEvidence> {
  const pairs = options.pairs ?? 20;
  const failures: Error[] = [];
  const workloadNames: readonly PerformanceWorkloadName[] = ['homogeneous', 'mixed'];
  const evidence: PerformanceEvidence = {
    phase: 'measurements',
    status: 'running',
    failures: [],
    repository: {
      certification: options.certifyClean ? 'frozen-clean' : 'developer-run',
    },
    workload: {
      rows: ROWS,
      commands: ROWS,
      pairs,
      order: 'alternating by pair index',
      fixtures: workloadNames,
    },
    reports: {
      homogeneous: createWorkloadReport(),
      mixed: createWorkloadReport(),
    },
  };
  const recordFailure = (reason: unknown): void => {
    const failure = reason instanceof Error ? reason : new Error(String(reason));
    failures.push(failure);
    evidence.failures.push(failure.message);
  };

  try {
    evidence.host = readCurrentHost();
    evidence.repository.initialHead = options.observeRepository('head');
    evidence.repository.initialStatus = options.observeRepository('status');
    if (options.certifyClean && evidence.repository.initialStatus !== '') {
      throw new Error('frozen-clean performance certification requires an initially clean tree');
    }

    for (const workload of workloadNames) {
      const report = evidence.reports[workload];
      report.status = 'running';
      try {
        await options.measure(workload, report);
        if (report.cached.samples.length !== pairs || report.uncached.samples.length !== pairs) {
          throw new Error(
            `${workload} requires ${String(pairs)} cached and uncached samples; received ${String(report.cached.samples.length)} and ${String(report.uncached.samples.length)}`,
          );
        }
        report.status = 'complete';
      } catch (reason) {
        report.status = 'failed';
        report.failure = describeFailure(reason);
        recordFailure(reason);
      } finally {
        summarizeReport(report);
      }
    }

    options.emit(structuredClone(evidence));

    for (const workload of workloadNames) {
      const report = evidence.reports[workload];
      if (report.status !== 'complete') continue;
      const cachedMedian = report.cached.median;
      const uncachedMedian = report.uncached.median;
      if (cachedMedian === undefined || uncachedMedian === undefined) {
        recordFailure(new Error(`${workload} complete report has no median`));
        continue;
      }
      const ratio = cachedMedian / uncachedMedian;
      if (ratio > 1.1) {
        recordFailure(
          new Error(`${workload} cached median ratio ${ratio.toFixed(3)} exceeded 1.100`),
        );
      }
    }
  } catch (reason) {
    recordFailure(reason);
  } finally {
    try {
      evidence.repository.finalHead = options.observeRepository('head');
      evidence.repository.finalStatus = options.observeRepository('status');
      const initialHead = evidence.repository.initialHead;
      const initialStatus = evidence.repository.initialStatus;
      if (initialHead !== undefined && initialStatus !== undefined) {
        evidence.repository.unchanged =
          evidence.repository.finalHead === initialHead &&
          evidence.repository.finalStatus === initialStatus;
        if (!evidence.repository.unchanged) {
          recordFailure(new Error('repository HEAD or status changed during performance run'));
        }
      }
    } catch (reason) {
      recordFailure(reason);
    }
    evidence.phase = 'final';
    evidence.status = failures.length === 0 ? 'complete' : 'failed';
    options.emit(structuredClone(evidence));
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, evidence.failures.join('; '));
  }
  return evidence;
}

it('bounds retained reads for 200 estimates and undo restores every distinct original', async () => {
  const fixture = await performanceFixture('Homogeneous correctness');
  try {
    const outcome = await fixture.runner('cached').run(PROJECT, OWNER, homogeneousCommands());
    expect(outcome).toMatchObject({ ok: true });
    expectBoundedFullReads(fixture.counts);
    expect(fixture.counts.targeted).toBeGreaterThan(0);
    // Proof: dropping OpenSqliteSourceOptions.logger plumbing left this at zero
    // while the same admitted runner had committed all 200 writes.
    expect(fixture.counts.sqlWrites).toBeGreaterThan(0);
    process.stdout.write(`homogeneous counts ${JSON.stringify(fixture.counts)}\n`);

    const changed = await fixture.source.stores.estimates.listByProject(PROJECT);
    expect(changed).toEqual(
      Array.from({ length: ROWS }, (_, index) => ({
        workItemId: rowId(index),
        stepId: STEP,
        ...changedDays(index),
      })),
    );
    expect(await fixture.runner('cached').undo(PROJECT, OWNER)).toMatchObject({ ok: true });
    const restored = await fixture.source.stores.estimates.listByProject(PROJECT);
    expect(restored).toEqual(
      Array.from({ length: ROWS }, (_, index) => ({
        workItemId: rowId(index),
        stepId: STEP,
        ...originalDays(index),
      })),
    );
  } finally {
    await fixture.close();
  }
}, 120_000);

it('keeps repeated existing-person assignments inside the plan-only full-read bound', async () => {
  const fixture = await performanceFixture('Mixed correctness');
  try {
    const outcome = await fixture.runner('cached').run(PROJECT, OWNER, mixedCommands());
    expect(outcome).toMatchObject({ ok: true });
    // Proof: routing successful DirectoryStore.assign calls through the global
    // reload barrier made 40 assignments produce 41 full work-item reads.
    expectBoundedFullReads(fixture.counts);
    expect(fixture.counts.assignments).toBeGreaterThan(0);
    expect(fixture.counts.targeted).toBeGreaterThan(0);
    expect(fixture.counts.sqlWrites).toBeGreaterThan(0);
    process.stdout.write(`mixed counts ${JSON.stringify(fixture.counts)}\n`);
  } finally {
    await fixture.close();
  }
}, 120_000);

it('can run the real SQLite command runner over uncached admitted stores', async () => {
  const fixture = await performanceFixture('Uncached runner seam');
  try {
    resetCounts(fixture.counts);
    const outcome = await fixture.runner('uncached').run(PROJECT, OWNER, [
      {
        kind: 'setEstimate',
        workItemId: rowId(0),
        stepId: STEP,
        days: changedDays(0),
      },
      {
        kind: 'setEstimate',
        workItemId: rowId(1),
        stepId: STEP,
        days: changedDays(1),
      },
    ]);

    expect(outcome).toMatchObject({ ok: true });
    expect(fixture.counts.full.workItems).toBeGreaterThan(1);
    expect(fixture.counts.full.estimates).toBeGreaterThan(1);
    expect(fixture.counts.sqlWrites).toBeGreaterThan(0);
  } finally {
    await fixture.close();
  }
}, 120_000);

it('keeps cached medians within ten percent on homogeneous and mixed paired workloads', async () => {
  const certificationValue = process.env['WBS_PERFORMANCE_CERTIFY'];
  if (
    certificationValue !== undefined &&
    certificationValue !== '0' &&
    certificationValue !== '1'
  ) {
    throw new Error('WBS_PERFORMANCE_CERTIFY must be 0, 1, or absent');
  }
  const commands: Record<PerformanceWorkloadName, readonly PlanCommand[]> = {
    homogeneous: homogeneousCommands(),
    mixed: mixedCommands(),
  };

  await runPerformanceCertification({
    certifyClean: certificationValue === '1',
    observeRepository: (observation) =>
      observation === 'head'
        ? repositoryObservation(['rev-parse', 'HEAD'])
        : repositoryObservation(['status', '--short']),
    measure: async (workload, report) => {
      const fixture = await performanceFixture(`Timing ${workload}`);
      try {
        const baseline = await authoredState(fixture);
        for (const mode of ['uncached', 'cached'] as const) {
          expect(await fixture.runner(mode).run(PROJECT, OWNER, commands[workload])).toMatchObject({
            ok: true,
          });
          expect(await fixture.runner(mode).undo(PROJECT, OWNER)).toMatchObject({ ok: true });
          expect(await authoredState(fixture)).toBe(baseline);
        }

        for (let pair = 0; pair < 20; pair += 1) {
          const order: readonly RunnerMode[] =
            pair % 2 === 0 ? ['uncached', 'cached'] : ['cached', 'uncached'];
          for (const mode of order) {
            expect(await authoredState(fixture)).toBe(baseline);
            resetCounts(fixture.counts);
            const started = performance.now();
            const outcome = await fixture.runner(mode).run(PROJECT, OWNER, commands[workload]);
            const elapsed = performance.now() - started;
            expect(outcome).toMatchObject({ ok: true });
            report[mode].samples.push(elapsed);
            expect(await fixture.runner(mode).undo(PROJECT, OWNER)).toMatchObject({ ok: true });
            expect(await authoredState(fixture)).toBe(baseline);
          }
        }
      } finally {
        await fixture.close();
      }
    },
    emit: (evidence) => process.stdout.write(`${JSON.stringify(evidence)}\n`),
  });
}, 600_000);

it('reports both completed workloads before aggregating independent ratio failures', async () => {
  const emissions: PerformanceEvidence[] = [];
  const sample = {
    cached: Array.from({ length: 20 }, () => 111),
    uncached: Array.from({ length: 20 }, () => 100),
  };

  // Proof: restoring the in-loop ratio failure made this test receive no measurement report at
  // all after homogeneous failed, before mixed was attempted; 0 passed, 1 failed.
  const certification = runPerformanceCertification({
    certifyClean: false,
    observeRepository: (argument) => (argument === 'head' ? 'head-a' : ''),
    measure: (_workload, report) => {
      report.cached.samples.push(...sample.cached);
      report.uncached.samples.push(...sample.uncached);
      return Promise.resolve();
    },
    emit: (evidence) => emissions.push(structuredClone(evidence)),
  });

  const failure = await captureFailure(certification);
  expect(failure).toBeInstanceOf(AggregateError);
  const measurement = emissions.find(({ phase }) => phase === 'measurements');
  expect(measurement).toMatchObject({
    phase: 'measurements',
    status: 'running',
    workload: {
      rows: ROWS,
      commands: ROWS,
      pairs: 20,
      order: 'alternating by pair index',
      fixtures: ['homogeneous', 'mixed'],
    },
    host: { bun: Bun.version },
    reports: {
      homogeneous: {
        status: 'complete',
        cached: { median: 111, range: [111, 111] },
        uncached: { median: 100, range: [100, 100] },
      },
      mixed: {
        status: 'complete',
        cached: { median: 111, range: [111, 111] },
        uncached: { median: 100, range: [100, 100] },
      },
    },
  });
  expect(measurement?.reports.homogeneous.cached.samples).toHaveLength(20);
  expect(measurement?.reports.mixed.cached.samples).toHaveLength(20);
  expect(emissions.at(-1)?.status).toBe('failed');
  expect(emissions.at(-1)?.failures).toEqual([
    'homogeneous cached median ratio 1.110 exceeded 1.100',
    'mixed cached median ratio 1.110 exceeded 1.100',
  ]);
});

it('emits partial evidence when an earlier measurement fails', async () => {
  const emissions: PerformanceEvidence[] = [];
  const attempted: PerformanceWorkloadName[] = [];

  const certification = runPerformanceCertification({
    certifyClean: false,
    pairs: 1,
    observeRepository: (argument) => (argument === 'head' ? 'head-a' : ' M local-change'),
    measure: (workload, report) => {
      attempted.push(workload);
      report.uncached.samples.push(101);
      if (workload === 'homogeneous') {
        return Promise.reject(new Error('injected measurement interruption'));
      }
      report.cached.samples.push(100);
      return Promise.resolve();
    },
    emit: (evidence) => emissions.push(structuredClone(evidence)),
  });

  const failure = await captureFailure(certification);
  expect(failure?.message).toContain('injected measurement interruption');
  expect(attempted).toEqual(['homogeneous', 'mixed']);
  expect(emissions.at(-1)?.reports.homogeneous).toMatchObject({
    status: 'failed',
    failure: 'injected measurement interruption',
    uncached: { samples: [101] },
  });
  expect(emissions.at(-1)?.reports.mixed).toMatchObject({ status: 'complete' });
  expect(emissions.at(-1)?.repository).toMatchObject({
    initialHead: 'head-a',
    finalHead: 'head-a',
    initialStatus: ' M local-change',
    finalStatus: ' M local-change',
    unchanged: true,
    certification: 'developer-run',
  });
  expect(emissions.at(-1)?.status).toBe('failed');
  // Proof: removing the outer-final emission left only the pre-check snapshot, without final
  // HEAD, status, or unchanged state; 0 passed, 1 failed at this repository assertion.
});

it('labels and refuses explicit frozen-clean certification from a dirty checkout', async () => {
  const emissions: PerformanceEvidence[] = [];
  const attempted: PerformanceWorkloadName[] = [];

  const failure = await captureFailure(
    runPerformanceCertification({
      certifyClean: true,
      pairs: 1,
      observeRepository: (observation) => (observation === 'head' ? 'head-a' : ' M change'),
      measure: (workload) => {
        attempted.push(workload);
        return Promise.resolve();
      },
      emit: (evidence) => emissions.push(structuredClone(evidence)),
    }),
  );

  // Proof: removing the explicit clean-mode refusal makes measurement run and this setup
  // interruption disappear; ordinary dirty runs remain covered by the preceding test.
  expect(failure?.message).toContain('requires an initially clean tree');
  expect(attempted).toEqual([]);
  expect(emissions).toHaveLength(1);
  expect(emissions[0]).toMatchObject({
    phase: 'final',
    status: 'failed',
    repository: { certification: 'frozen-clean', unchanged: true },
  });
});

it('reports a HEAD or status change before refusing the completed run', async () => {
  const emissions: PerformanceEvidence[] = [];
  let statusObservation = 0;

  const failure = await captureFailure(
    runPerformanceCertification({
      certifyClean: false,
      pairs: 1,
      observeRepository: (observation) => {
        if (observation === 'head') return 'head-a';
        statusObservation += 1;
        return statusObservation === 1 ? '' : ' M change-during-run';
      },
      measure: (_workload, report) => {
        report.cached.samples.push(100);
        report.uncached.samples.push(100);
        return Promise.resolve();
      },
      emit: (evidence) => emissions.push(structuredClone(evidence)),
    }),
  );

  // Proof: comparing only the initial and final HEAD misses this injected status mutation and
  // would certify a run whose source changed while samples were collected.
  expect(failure?.message).toContain('repository HEAD or status changed');
  expect(emissions.at(-1)?.repository).toMatchObject({
    initialHead: 'head-a',
    finalHead: 'head-a',
    initialStatus: '',
    finalStatus: ' M change-during-run',
    unchanged: false,
  });
  expect(emissions.at(-1)?.status).toBe('failed');
});
