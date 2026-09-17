import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';
import { afterEach, describe, expect, it } from 'bun:test';

import { openDatabase, openDrizzle } from '../repository/db';
import { DrizzleEventLogStore } from '../repository/event-log';
import { OPEN } from '../repository/gate';
import { runMigrations } from '../repository/migrate';
import { solverSlot } from '../repository/schema';
import {
  OptimizationCoordinator,
  type ReservedSolverChild,
  type ReservedSpawnRequest,
} from './optimization-coordinator';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;
const CONTRACT = '7+0.1.0';
const BUDGET_MS = 60_000;
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

const dirs: string[] = [];
const children: Bun.Subprocess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function database() {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-spawn-handshake-'));
  dirs.push(dir);
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  const raw = openDatabase(path);
  try {
    raw.run(
      `INSERT INTO users (id, username, password_hash, created_at)
       VALUES ('u-1', 'owner', 'hash', 1)`,
    );
    raw.run(
      `INSERT INTO project (id, name, owner_id, restricted, revision, created_at,
                            optimization_enabled, schedule_engine, schedule_objective)
       VALUES ('p-1', 'Plan', 'u-1', 0, 0, 1, 1, 'optimized', 'pri')`,
    );
  } finally {
    raw.close();
  }
  return { dir, blue: openDrizzle(path), green: openDrizzle(path) };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (resolvePromise === undefined) throw new Error('missing deferred resolver');
      resolvePromise();
    },
  };
}

async function until(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 500; turn += 1) {
    if (check()) return;
    await Bun.sleep(2);
  }
  throw new Error('spawn-handshake condition did not arrive');
}

function processChild(
  request: ReservedSpawnRequest,
  folder: string,
  owner: string,
): { readonly child: ReservedSolverChild; readonly marker: string; readonly release: string } {
  const identity = `${owner}-${request.objective}-${request.admission.attemptToken}`;
  const marker = join(folder, `${identity}.solved`);
  const release = join(folder, `${identity}.release`);
  const script = `
    const verdict = (await new Response(Bun.stdin.stream()).text()).split("\\n", 1)[0];
    if (verdict !== "bound") process.exit(42);
    await Bun.write(${JSON.stringify(marker)}, "solved");
    while (!(await Bun.file(${JSON.stringify(release)}).exists())) await Bun.sleep(2);
  `;
  const subprocess = Bun.spawn([process.execPath, '-e', script], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.push(subprocess);
  let decided = false;
  return {
    marker,
    release,
    child: {
      pid: subprocess.pid,
      stdout: subprocess.stdout,
      stderr: subprocess.stderr,
      exited: subprocess.exited,
      verdict: (verdict) => {
        if (decided) throw new Error('test launcher received a second verdict');
        decided = true;
        void subprocess.stdin.write(`${verdict}\n`);
        if (verdict === 'bound') {
          void subprocess.stdin.write(`${JSON.stringify(request.request)}\n`);
        }
        void subprocess.stdin.end();
      },
      kill: () => {
        subprocess.kill();
      },
    },
  };
}

describe('the two-coordinator spawn handshake', () => {
  it('aborts delayed launchers after deadline reclamation while replacements alone solve', async () => {
    const { dir, blue, green } = database();
    const paused = deferred();
    let now = 10;
    let token = 0;
    const blueAttempts: ReturnType<typeof processChild>[] = [];
    const greenAttempts: ReturnType<typeof processChild>[] = [];
    const errors: unknown[] = [];
    const coordinator = (db: typeof blue, owner: string): OptimizationCoordinator =>
      new OptimizationCoordinator({
        db,
        contractVersion: CONTRACT,
        solverVersion: '0.1.0',
        budgetMs: BUDGET_MS,
        ownerId: owner,
        now: () => now,
        attemptToken: () => `${owner}-${String(token++)}`,
        inputOf: () => Promise.resolve(INPUT),
        enabledOf: () => Promise.resolve(true),
        spawn: async (request) => {
          const attempt = processChild(request, dir, owner);
          (owner === 'blue' ? blueAttempts : greenAttempts).push(attempt);
          if (owner === 'blue') await paused.promise;
          return attempt.child;
        },
        eventLog: new DrizzleEventLogStore(db, OPEN),
        pushRecorded: () => Promise.resolve(),
        onChildError: (error) => errors.push(error),
      });
    const blueCoordinator = coordinator(blue, 'blue');
    const greenCoordinator = coordinator(green, 'green');

    expect(blueCoordinator.read({ projectId: 'p-1', objective: 'pri', input: INPUT })).toBeNull();
    await until(() => blueAttempts.length === 2);
    const firstRows = blue.select().from(solverSlot).all();
    expect(firstRows).toHaveLength(2);
    expect(firstRows.every(({ lifecycle }) => lifecycle === 'starting')).toBe(true);
    now = Math.max(...firstRows.map(({ admittedDeadlineAt }) => admittedDeadlineAt)) + 1;

    expect(greenCoordinator.read({ projectId: 'p-1', objective: 'time', input: INPUT })).toBeNull();
    await until(
      () => greenAttempts.length === 2 && greenAttempts.every(({ marker }) => existsSync(marker)),
    );
    const replacementRows = green.select().from(solverSlot).all();
    expect(replacementRows).toHaveLength(2);
    expect(
      replacementRows.every(
        ({ ownerId, lifecycle }) => ownerId === 'green' && lifecycle === 'running',
      ),
    ).toBe(true);
    expect(replacementRows.length).toBeLessThanOrEqual(4);
    expect(green.select().from(solverSlot).all().length).toBeLessThanOrEqual(16);

    paused.resolve();
    await Promise.all(blueAttempts.map(({ child }) => child.exited));
    expect(blueAttempts.every(({ marker }) => !existsSync(marker))).toBe(true);
    expect(greenAttempts.every(({ marker }) => existsSync(marker))).toBe(true);
    expect(
      green
        .select()
        .from(solverSlot)
        .all()
        .every(({ ownerId }) => ownerId === 'green'),
    ).toBe(true);

    await Promise.all(greenAttempts.map(({ release }) => Bun.write(release, 'release')));
    await Promise.all([blueCoordinator.drain(), greenCoordinator.drain()]);
    expect(green.select().from(solverSlot).all()).toEqual([]);
    expect(errors).toEqual([]);

    // Watched red: dropping the attempt-token and `lifecycle = starting`
    // predicates lets delayed blue launchers overwrite the green running rows
    // and create a second solve for each objective.
  });
});
