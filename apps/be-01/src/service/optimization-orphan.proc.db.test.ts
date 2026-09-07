import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { openConnection, openDatabase } from '../repository/db';
import { runMigrations } from '../repository/migrate';
import { bindSolverSlot, reserveSolverSlot } from '../repository/optimization-admission';
import { allocateGeneration } from '../repository/optimization-generation';
import { solverSlot } from '../repository/schema';

const IMAGE = process.env['WBS_SOLVER_ORPHAN_IMAGE'];
// This process-boundary proof owns a real migrated SQLite database.
const realProcessDescribe = IMAGE === undefined ? describe.skip : describe;
const FOLDER = new URL('../../drizzle', import.meta.url).pathname;
const REQUEST = '/app/libs/contracts/solver/fixtures/request/valid-quantised-baseline.json';
const HOST = new URL('../../scripts/solver-supervisor-orphan-host.ts', import.meta.url).pathname;
const CLIENT = '/app/apps/be-01/scripts/solver-supervisor-orphan-client.ts';
const PROJECT = '11111111-1111-4111-8111-111111111111';
const CONTRACT = '7+0.1.0';

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function command(argv: readonly string[], allowFailure = false): Promise<CommandResult> {
  const child = Bun.spawn([...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (!allowFailure && code !== 0) {
    throw new Error(`orphan process command ${argv.join(' ')} exited ${String(code)}: ${stderr}`);
  }
  return { code, stdout, stderr };
}

async function until(label: string, check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error(`solver orphan process condition did not arrive: ${label}`);
}

function startHost(
  image: string,
  socket: string,
  callerName: string,
  readyMarker: string,
): Bun.Subprocess {
  return Bun.spawn([process.execPath, HOST, image, socket, callerName, readyMarker], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'inherit',
  });
}

async function waitForHost(host: Bun.Subprocess, readyMarker: string): Promise<void> {
  await until('supervisor listen', () => {
    if (host.exitCode !== null) {
      throw new Error(`solver orphan host exited before listen: ${String(host.exitCode)}`);
    }
    return existsSync(readyMarker);
  });
}

async function stopHost(host: Bun.Subprocess): Promise<void> {
  if (host.exitCode === null) host.kill('SIGTERM');
  await host.exited;
}

async function startCaller(
  image: string,
  name: string,
  root: string,
  token: string,
  childDeadlineAt: number,
  markerName: string,
  decision: 'wait' | 'bound' | 'gate',
): Promise<void> {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new Error('solver orphan process: missing uid');
  await command([
    'docker',
    'run',
    '--detach',
    '--name',
    name,
    '--user',
    `${String(uid)}:${String(gid)}`,
    '--volume',
    `${root}:/proof`,
    '--entrypoint',
    'bun',
    image,
    CLIENT,
    '/proof/supervisor.sock',
    REQUEST,
    token,
    String(childDeadlineAt),
    `/proof/${markerName}`,
    decision,
  ]);
}

async function containerRunning(name: string): Promise<boolean> {
  const result = await command(['docker', 'inspect', '--format', '{{.State.Running}}', name], true);
  return result.code === 0 && result.stdout.trim() === 'true';
}

async function containerExists(name: string): Promise<boolean> {
  return (await command(['docker', 'container', 'inspect', name], true)).code === 0;
}

realProcessDescribe('solver supervisor orphan process boundaries', () => {
  it('keeps the slot through coordinator EOF and survives a timer-stopped restart orphan', async () => {
    if (IMAGE === undefined) throw new Error('real process test enabled without an image');
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error('solver orphan process: missing uid');
    const root = mkdtempSync(`/run/user/${String(uid)}/wbs-solver-orphan.`);
    const socket = join(root, 'supervisor.sock');
    const dbPath = join(root, 'proof.db');
    const firstReady = join(root, 'first.ready');
    const secondReady = join(root, 'second.ready');
    const restartReady = join(root, 'restart.ready');
    const callerOne = `wbs-orphan-coordinator-${crypto.randomUUID()}`;
    const callerTwo = `wbs-orphan-restart-${crypto.randomUUID()}`;
    const tokenOne = crypto.randomUUID();
    const tokenTwo = crypto.randomUUID();
    const managedOne = `wbs-solver-${tokenOne}`;
    const managedTwo = `wbs-solver-${tokenTwo}`;
    const timerOne = `wbs-solver-deadline-${tokenOne}`;
    const timerTwo = `wbs-solver-deadline-${tokenTwo}`;
    const exactContainers = [callerOne, callerTwo, managedOne, managedTwo];
    let host: Bun.Subprocess | undefined;
    let closeDatabase: (() => void) | undefined;

    try {
      runMigrations(dbPath, FOLDER);
      const raw = openDatabase(dbPath);
      try {
        raw.run(
          `INSERT INTO users (id, username, password_hash, created_at)
             VALUES ('u-1', 'owner', 'hash', 1)`,
        );
        raw.run(
          `INSERT INTO project (id, name, owner_id, restricted, revision, created_at,
                                  optimization_enabled, schedule_engine, schedule_objective)
             VALUES ('${PROJECT}', 'Plan', 'u-1', 0, 0, 1, 1, 'optimized', 'pri')`,
        );
      } finally {
        raw.close();
      }
      const connection = openConnection(dbPath);
      closeDatabase = connection.close;
      const generation = allocateGeneration(connection.db, PROJECT, CONTRACT, 'hash-1', 1);
      const admission = reserveSolverSlot(connection.db, {
        projectId: PROJECT,
        contractVersion: CONTRACT,
        generation,
        objective: 'pri',
        budgetMs: 25_000,
        ownerId: 'coordinator-process',
        attemptToken: tokenOne,
        now: Date.now(),
      });
      if (admission.kind !== 'reserved') throw new Error('orphan slot was not reserved');

      host = startHost(IMAGE, socket, callerOne, firstReady);
      await waitForHost(host, firstReady);
      await startCaller(
        IMAGE,
        callerOne,
        root,
        tokenOne,
        admission.childDeadlineAt,
        'first.started',
        'gate',
      );
      const firstMarker = join(root, 'first.started');
      await until('first managed child started', () => existsSync(firstMarker));
      const pid = Number(readFileSync(firstMarker, 'utf8'));
      expect(
        bindSolverSlot(connection.db, {
          projectId: PROJECT,
          contractVersion: CONTRACT,
          generation,
          objective: 'pri',
          budgetMs: 25_000,
          attemptToken: tokenOne,
          pid,
        }),
      ).toBe(true);
      await Bun.write(`${firstMarker}.bound`, 'bound');
      await until('first bound verdict sent', () => existsSync(`${firstMarker}.bound-sent`));
      expect(await containerRunning(managedOne)).toBe(true);
      expect(connection.db.select().from(solverSlot).all()).toHaveLength(1);

      await command(['docker', 'kill', callerOne]);
      await until('EOF child removal', async () => !(await containerExists(managedOne)));
      expect(Date.now()).toBeLessThan(admission.childDeadlineAt);
      const rowsAfterCoordinatorDeath = connection.db.select().from(solverSlot).all();
      expect(rowsAfterCoordinatorDeath).toHaveLength(1);
      expect(rowsAfterCoordinatorDeath[0]?.lifecycle).toBe('running');
      // Proof: dropping the supervisor EOF kill leaves managedOne live;
      // releasing on client EOF instead makes this counted row disappear.
      expect(Number(await containerExists(managedOne))).toBeLessThanOrEqual(
        rowsAfterCoordinatorDeath.length,
      );
      await stopHost(host);
      host = undefined;

      const childDeadlineAt = Date.now() + 8_000;
      host = startHost(IMAGE, socket, callerTwo, secondReady);
      await waitForHost(host, secondReady);
      await startCaller(
        IMAGE,
        callerTwo,
        root,
        tokenTwo,
        childDeadlineAt,
        'second.started',
        'bound',
      );
      await until('second managed child started', () => existsSync(join(root, 'second.started')));
      expect(await containerRunning(managedTwo)).toBe(true);

      host.kill(9);
      await host.exited;
      host = undefined;
      expect(await containerRunning(managedTwo)).toBe(true);
      await until('persistent deadline timer fired', async () => {
        return !(await containerRunning(managedTwo));
      });
      expect(Date.now()).toBeGreaterThanOrEqual(childDeadlineAt);

      host = startHost(IMAGE, socket, callerTwo, restartReady);
      await waitForHost(host, restartReady);
      await until('restart orphan removal', async () => !(await containerExists(managedTwo)));
      expect(host.exitCode).toBeNull();
      // Proof: cancelling the timer with supervisor death leaves managedTwo
      // running; treating docker-kill's already-stopped error as fatal keeps
      // the restarted supervisor from creating its listener.
    } finally {
      if (host !== undefined) await stopHost(host);
      closeDatabase?.();
      for (const name of exactContainers) {
        await command(['docker', 'rm', '--force', name], true);
      }
      for (const timer of [timerOne, timerTwo]) {
        await command(['systemctl', '--user', 'stop', `${timer}.timer`, `${timer}.service`], true);
        await command(['systemctl', '--user', 'reset-failed', `${timer}.service`], true);
      }
      for (const file of [
        join(root, 'first.started'),
        join(root, 'first.started.bound'),
        join(root, 'first.started.bound-sent'),
        join(root, 'second.started'),
        firstReady,
        secondReady,
        restartReady,
        socket,
        dbPath,
        `${dbPath}-wal`,
        `${dbPath}-shm`,
      ]) {
        if (existsSync(file)) unlinkSync(file);
      }
      rmdirSync(root);
    }
  }, 60_000);
});
