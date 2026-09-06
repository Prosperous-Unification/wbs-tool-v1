import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';
import { scheduleInputHash } from '@wbs/domain/canonical-schedule-input';
import { afterEach, describe, expect, it } from 'bun:test';

import { openDatabase, openDrizzle } from '../repository/db';
import { runMigrations } from '../repository/migrate';
import { reserveSolverSlot } from '../repository/optimization-admission';
import { allocateGeneration, readGeneration } from '../repository/optimization-generation';
import { readOptimizedPair } from '../repository/optimized-schedule-cache';
import { solverSlot } from '../repository/schema';
import {
  OptimizationCoordinator,
  type ReservedSolverChild,
  type ReservedSolverTerminal,
  type ReservedSpawnRequest,
} from './optimization-coordinator';
import { runSolverChildLifecycle } from './solver-child-lifecycle';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;
const CONTRACT = '7+0.1.0';
const BUDGET = 60_000;

const INPUT: ScheduleInput = {
  rows: [{ id: 'w-1', parentId: null, position: 10, frozenNumber: null, priority: null }],
  edges: [],
  slices: [
    {
      workItemId: 'w-1',
      stepId: 'step-dev',
      days: 2,
      personId: null,
      width: 1,
      poolIds: [],
    },
  ],
  notBefore: new Map(),
  poolSizes: new Map(),
  reach: 'whole-item',
  deadlines: new Map(),
};
const FEASIBLE_RESPONSE = `${JSON.stringify({
  wireVersion: 1,
  status: 'feasible',
  offsets: { 'w-1\u0000step-dev': 0 },
  objectiveValues: {
    makespan: { value: 96, stageValue: 96, bound: 96, status: 'optimal' },
    priority: { value: 0, stageValue: 0, bound: 0, status: 'optimal' },
    movement: { value: 0, stageValue: 0, bound: 0, status: 'optimal' },
  },
})}\n`;

const dirs: string[] = [];

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

const never = new Promise<number>(() => undefined);

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: Error) => void;
} {
  let settle: ((value: T) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  return {
    promise,
    resolve: (value) => {
      if (settle === undefined) throw new Error('deferred promise has no resolver');
      settle(value);
    },
    reject: (error) => {
      if (fail === undefined) throw new Error('deferred promise has no rejecter');
      fail(error);
    },
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function database(): { path: string; db: ReturnType<typeof openDrizzle> } {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-optimization-coordinator-'));
  dirs.push(dir);
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  return { path, db: openDrizzle(path) };
}

function seedProject(path: string): void {
  const db = openDatabase(path);
  try {
    db.run(
      `INSERT INTO users (id, username, password_hash, created_at)
       VALUES ('u-1', 'owner', 'hash', 1)`,
    );
    db.run(
      `INSERT INTO project (id, name, owner_id, restricted, revision, created_at,
                            optimization_enabled, schedule_engine, schedule_objective)
       VALUES ('p-1', 'Plan', 'u-1', 0, 0, 1, 1, 'optimized', 'pri')`,
    );
  } finally {
    db.close();
  }
}

function coordinator(
  db: ReturnType<typeof openDrizzle>,
  calls: ReservedSpawnRequest[],
  ownerId = 'blue',
  childOf: (
    request: ReservedSpawnRequest,
  ) => ReservedSolverChild | Promise<ReservedSolverChild> = () => ({
    pid: 100 + calls.length,
    stdout: stream(''),
    stderr: stream(''),
    exited: never,
    verdict: () => undefined,
    kill: () => undefined,
  }),
  runChild: typeof runSolverChildLifecycle = () => Promise.resolve({ kind: 'exited', code: 0 }),
  onChildError: (error: unknown) => void = (error) => {
    throw error;
  },
): OptimizationCoordinator {
  let token = 0;
  return new OptimizationCoordinator({
    db,
    contractVersion: CONTRACT,
    solverVersion: '0.1.0',
    budgetMs: BUDGET,
    ownerId,
    now: () => 10,
    attemptToken: () => `${ownerId}-token-${String(token++)}`,
    spawn: async (request) => {
      calls.push(request);
      return await childOf(request);
    },
    runChild,
    onChildError,
  });
}

describe('OptimizationCoordinator read', () => {
  it('bypasses allocation and both solvers when the canonical plan has no work', () => {
    const { path, db } = database();
    seedProject(path);
    const calls: ReservedSpawnRequest[] = [];
    const empty: ScheduleInput = { ...INPUT, rows: [], slices: [] };
    const zeroDuration: ScheduleInput = {
      ...INPUT,
      slices: INPUT.slices.map((slice) => ({ ...slice, days: 0 })),
    };

    for (const input of [empty, zeroDuration]) {
      expect(coordinator(db, calls).read({ projectId: 'p-1', objective: 'pri', input })).toBeNull();
      expect(calls).toEqual([]);
      expect(db.select().from(solverSlot).all()).toEqual([]);
      expect(readGeneration(db, 'p-1', CONTRACT)).toBeNull();
    }

    // Proof: deleting the zero-work guard creates generation 1 and two slot
    // rows on the first cold read, despite there being nothing to optimize.
  });

  it('requests both absent objectives once while Fast remains the immediate answer', async () => {
    const { path, db } = database();
    seedProject(path);
    const calls: ReservedSpawnRequest[] = [];

    expect(
      coordinator(db, calls).read({ projectId: 'p-1', objective: 'pri', input: INPUT }),
    ).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.map(({ objective }) => objective)).toEqual(['pri', 'time']);
    expect(calls.every(({ key }) => key.inputHash === scheduleInputHash(INPUT))).toBe(true);
    expect(calls.map(({ request }) => request.objective)).toEqual(['pri', 'time']);
    expect(calls[0].request.baselineOffsets).toBe(calls[1].request.baselineOffsets);
    expect(
      db
        .select({
          ownerId: solverSlot.ownerId,
          attemptToken: solverSlot.attemptToken,
          lifecycle: solverSlot.lifecycle,
          pid: solverSlot.pid,
        })
        .from(solverSlot)
        .all(),
    ).toEqual([
      { ownerId: 'blue', attemptToken: 'blue-token-0', lifecycle: 'running', pid: 101 },
      { ownerId: 'blue', attemptToken: 'blue-token-1', lifecycle: 'running', pid: 102 },
    ]);

    expect(
      coordinator(db, calls, 'green').read({
        projectId: 'p-1',
        objective: 'time',
        input: INPUT,
      }),
    ).toBeNull();
    expect(calls.map(({ objective }) => objective)).toEqual(['pri', 'time']);

    // Proof: bypassing SQLite leaves zero rows; removing the full-key conflict
    // check lets green call the spawner twice more for the same generation.
  });

  it('stores both preflight refusals without creating a launcher', () => {
    const { path, db } = database();
    seedProject(path);
    const calls: ReservedSpawnRequest[] = [];
    const tooLate: ScheduleInput = {
      ...INPUT,
      notBefore: new Map([['w-1', 50_000_000]]),
    };

    expect(
      coordinator(db, calls).read({ projectId: 'p-1', objective: 'pri', input: tooLate }),
    ).toBeNull();
    expect(calls).toEqual([]);
    expect(db.select().from(solverSlot).all()).toEqual([]);

    const pair = readOptimizedPair(db, {
      projectId: 'p-1',
      inputHash: scheduleInputHash(tooLate),
      contractVersion: CONTRACT,
      budgetMs: BUDGET,
    });
    expect(pair.pri).toMatchObject({ kind: 'failed', reason: 'horizon-overflow' });
    expect(pair.time).toMatchObject({ kind: 'failed', reason: 'horizon-overflow' });

    // Proof: passing the refusal to spawn creates two launcher calls; skipping
    // the fenced store leaves both variants as misses and repeats on every read.
  });

  it('does not automatically request exact-key failed or corrupt objectives', () => {
    const { path, db } = database();
    seedProject(path);
    const inputHash = scheduleInputHash(INPUT);
    const generation = allocateGeneration(db, 'p-1', CONTRACT, inputHash, 2);
    const write = openDatabase(path);
    try {
      write.run(
        `INSERT INTO optimized_schedule_cache
           (project_id, input_hash, objective, contract_version, budget_ms,
            generation, status, result_json, failure_reason, created_at)
         VALUES ('p-1', '${inputHash}', 'pri', '${CONTRACT}', ${String(BUDGET)},
                 ${String(generation)}, 'failed', NULL, 'timeout', 3),
                ('p-1', '${inputHash}', 'time', '${CONTRACT}', ${String(BUDGET)},
                 ${String(generation)}, 'ok', '{', NULL, 3)`,
      );
    } finally {
      write.close();
    }
    const calls: ReservedSpawnRequest[] = [];

    expect(
      coordinator(db, calls).read({ projectId: 'p-1', objective: 'pri', input: INPUT }),
    ).toBeNull();
    expect(calls).toEqual([]);

    // Proof: admitting every non-ok outcome fails here with two requests; a
    // failed or corrupt row is durable evidence and only explicit Retry spends it.
  });

  it('aborts and awaits a launcher whose reservation was reclaimed before its PID bind', async () => {
    const { path, db } = database();
    seedProject(path);
    const calls: ReservedSpawnRequest[] = [];
    const verdicts: string[] = [];
    let killed = 0;
    const instance = coordinator(db, calls, 'blue', (request) => {
      expect(
        reserveSolverSlot(db, {
          projectId: request.key.projectId,
          contractVersion: request.key.contractVersion,
          generation: request.generation,
          objective: request.objective,
          budgetMs: request.key.budgetMs,
          ownerId: 'green',
          attemptToken: `replacement-${request.objective}`,
          now: request.admission.admittedDeadlineAt + 1,
        }),
      ).toMatchObject({ kind: 'reserved' });
      return {
        pid: 42,
        stdout: stream(''),
        stderr: stream(''),
        exited: Promise.resolve(0),
        verdict: (verdict) => void verdicts.push(verdict),
        kill: () => void (killed += 1),
      };
    });

    expect(instance.read({ projectId: 'p-1', objective: 'pri', input: INPUT })).toBeNull();
    await instance.drain();
    expect(verdicts).toEqual(['abort', 'abort']);
    expect(killed).toBe(0);
    expect(
      db
        .select({ token: solverSlot.attemptToken, lifecycle: solverSlot.lifecycle })
        .from(solverSlot)
        .all(),
    ).toEqual([
      { token: 'replacement-pri', lifecycle: 'starting' },
      { token: 'replacement-time', lifecycle: 'starting' },
    ]);

    // Proof: dropping the bind CAS or sending `bound` unconditionally lets
    // both delayed launchers exec against replacement-owned reservations.
    // Calling kill here would race the host's awaited abort cleanup.
  });

  it('runs bound children through evaluation, the token-fenced store, and release', async () => {
    const { path, db } = database();
    seedProject(path);
    const calls: ReservedSpawnRequest[] = [];
    const instance = coordinator(
      db,
      calls,
      'blue',
      () => ({
        pid: 100 + calls.length,
        stdout: stream(FEASIBLE_RESPONSE),
        stderr: stream(''),
        exited: Promise.resolve(0),
        verdict: () => undefined,
        kill: () => undefined,
      }),
      runSolverChildLifecycle,
    );

    expect(instance.read({ projectId: 'p-1', objective: 'pri', input: INPUT })).toBeNull();
    await instance.drain();

    const pair = readOptimizedPair(db, {
      projectId: 'p-1',
      inputHash: scheduleInputHash(INPUT),
      contractVersion: CONTRACT,
      budgetMs: BUDGET,
    });
    expect(pair.pri.kind).toBe('ok');
    expect(pair.time.kind).toBe('ok');
    expect(db.select().from(solverSlot).all()).toEqual([]);
    expect(instance.read({ projectId: 'p-1', objective: 'time', input: INPUT })).not.toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('stores an internal failure but retains admission when creation has no terminal proof', async () => {
    const { path, db } = database();
    seedProject(path);
    const calls: ReservedSpawnRequest[] = [];
    const errors: unknown[] = [];
    const instance = coordinator(
      db,
      calls,
      'blue',
      () => {
        throw new Error('launcher is absent');
      },
      () => new Promise(() => undefined),
      (error) => void errors.push(error),
    );

    expect(instance.read({ projectId: 'p-1', objective: 'pri', input: INPUT })).toBeNull();
    await instance.drain();

    const pair = readOptimizedPair(db, {
      projectId: 'p-1',
      inputHash: scheduleInputHash(INPUT),
      contractVersion: CONTRACT,
      budgetMs: BUDGET,
    });
    expect(pair.pri).toMatchObject({ kind: 'failed', reason: 'internal-error' });
    expect(pair.time).toMatchObject({ kind: 'failed', reason: 'internal-error' });
    expect(
      db.select({ lifecycle: solverSlot.lifecycle, pid: solverSlot.pid }).from(solverSlot).all(),
    ).toEqual([
      { lifecycle: 'starting', pid: null },
      { lifecycle: 'starting', pid: null },
    ]);
    expect(errors).toHaveLength(2);

    expect(instance.read({ projectId: 'p-1', objective: 'time', input: INPUT })).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('kills and stores failure without releasing when bind transport has no terminal proof', async () => {
    const { path, db } = database();
    seedProject(path);
    const calls: ReservedSpawnRequest[] = [];
    const errors: unknown[] = [];
    let killed = 0;
    const instance = coordinator(
      db,
      calls,
      'blue',
      () => ({
        pid: 100 + calls.length,
        stdout: stream(''),
        stderr: stream('broken pipe'),
        exited: Promise.resolve(137),
        verdict: () => {
          throw new Error('bind pipe closed');
        },
        kill: () => void (killed += 1),
      }),
      runSolverChildLifecycle,
      (error) => void errors.push(error),
    );

    expect(instance.read({ projectId: 'p-1', objective: 'pri', input: INPUT })).toBeNull();
    await instance.drain();

    const pair = readOptimizedPair(db, {
      projectId: 'p-1',
      inputHash: scheduleInputHash(INPUT),
      contractVersion: CONTRACT,
      budgetMs: BUDGET,
    });
    expect(pair.pri).toMatchObject({ kind: 'failed', reason: 'internal-error' });
    expect(pair.time).toMatchObject({ kind: 'failed', reason: 'internal-error' });
    expect(
      db.select({ lifecycle: solverSlot.lifecycle, pid: solverSlot.pid }).from(solverSlot).all(),
    ).toEqual([
      { lifecycle: 'running', pid: 101 },
      { lifecycle: 'running', pid: 102 },
    ]);
    expect(killed).toBe(2);
    expect(errors).toHaveLength(2);
  });

  it('tracks asynchronous start through bind and child lifecycle in drain', async () => {
    const { path, db } = database();
    seedProject(path);
    const calls: ReservedSpawnRequest[] = [];
    const starts: ReturnType<typeof deferred<ReservedSolverChild>>[] = [];
    const instance = coordinator(db, calls, 'blue', () => {
      const start = deferred<ReservedSolverChild>();
      starts.push(start);
      return start.promise;
    });

    expect(instance.read({ projectId: 'p-1', objective: 'pri', input: INPUT })).toBeNull();
    expect(calls).toHaveLength(2);
    expect(starts).toHaveLength(2);
    expect(db.select({ lifecycle: solverSlot.lifecycle }).from(solverSlot).all()).toEqual([
      { lifecycle: 'starting' },
      { lifecycle: 'starting' },
    ]);

    let drained = false;
    const draining = instance.drain().then(() => void (drained = true));
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    expect(drained).toBe(false);

    for (const [index, start] of starts.entries()) {
      start.resolve({
        pid: 201 + index,
        stdout: stream(''),
        stderr: stream(''),
        exited: Promise.resolve(0),
        verdict: () => undefined,
        kill: () => undefined,
      });
    }
    await draining;
    expect(drained).toBe(true);
    expect(
      db.select({ lifecycle: solverSlot.lifecycle, pid: solverSlot.pid }).from(solverSlot).all(),
    ).toEqual([
      { lifecycle: 'running', pid: 201 },
      { lifecycle: 'running', pid: 202 },
    ]);
  });

  it('classifies authenticated terminal evidence before evaluating solver output', async () => {
    const cases = [
      {
        terminal: { exitCode: 0, deadlineKilled: true, oomKilled: true },
        expected: 'timeout',
      },
      {
        terminal: { exitCode: 0, deadlineKilled: false, oomKilled: true },
        expected: 'oom',
      },
      {
        terminal: { exitCode: 0, deadlineKilled: false, oomKilled: false },
        expected: 'ok',
      },
      {
        terminal: { exitCode: 1, deadlineKilled: false, oomKilled: false },
        expected: 'internal-error',
      },
    ] as const;

    for (const item of cases) {
      const { path, db } = database();
      seedProject(path);
      const calls: ReservedSpawnRequest[] = [];
      const terminal: Promise<ReservedSolverTerminal> = Promise.resolve(item.terminal);
      const instance = coordinator(
        db,
        calls,
        'blue',
        () => ({
          pid: 300 + calls.length,
          stdout: stream(FEASIBLE_RESPONSE),
          stderr: stream(''),
          exited: terminal.then((evidence) => evidence.exitCode),
          terminal,
          verdict: () => undefined,
          kill: () => undefined,
        }),
        runSolverChildLifecycle,
      );

      expect(instance.read({ projectId: 'p-1', objective: 'pri', input: INPUT })).toBeNull();
      await instance.drain();
      const pair = readOptimizedPair(db, {
        projectId: 'p-1',
        inputHash: scheduleInputHash(INPUT),
        contractVersion: CONTRACT,
        budgetMs: BUDGET,
      });
      for (const outcome of [pair.pri, pair.time]) {
        if (item.expected === 'ok') expect(outcome.kind).toBe('ok');
        else expect(outcome).toMatchObject({ kind: 'failed', reason: item.expected });
      }
      expect(db.select().from(solverSlot).all()).toEqual([]);
    }
  });

  it('stores internal-error and retains the slot when terminal evidence is lost after start', async () => {
    const { path, db } = database();
    seedProject(path);
    const calls: ReservedSpawnRequest[] = [];
    const terminals: ReturnType<typeof deferred<ReservedSolverTerminal>>[] = [];
    const errors: unknown[] = [];
    const instance = coordinator(
      db,
      calls,
      'blue',
      () => {
        const terminal = deferred<ReservedSolverTerminal>();
        terminals.push(terminal);
        return {
          pid: 400 + calls.length,
          stdout: stream(''),
          stderr: stream(''),
          exited: terminal.promise.then((evidence) => evidence.exitCode),
          terminal: terminal.promise,
          verdict: () => undefined,
          kill: () => undefined,
        };
      },
      runSolverChildLifecycle,
      (error) => void errors.push(error),
    );

    expect(instance.read({ projectId: 'p-1', objective: 'pri', input: INPUT })).toBeNull();
    await Promise.resolve();
    for (const terminal of terminals) {
      terminal.reject(new Error('supervisor EOF before terminal'));
    }
    await instance.drain();

    const pair = readOptimizedPair(db, {
      projectId: 'p-1',
      inputHash: scheduleInputHash(INPUT),
      contractVersion: CONTRACT,
      budgetMs: BUDGET,
    });
    expect(pair.pri).toMatchObject({ kind: 'failed', reason: 'internal-error' });
    expect(pair.time).toMatchObject({ kind: 'failed', reason: 'internal-error' });
    expect(db.select({ lifecycle: solverSlot.lifecycle }).from(solverSlot).all()).toEqual([
      { lifecycle: 'running' },
      { lifecycle: 'running' },
    ]);
    expect(errors).toHaveLength(2);
  });
});
