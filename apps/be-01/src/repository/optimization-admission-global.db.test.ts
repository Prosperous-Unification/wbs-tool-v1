import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { openDatabase, openDrizzle } from './db';
import { runMigrations } from './migrate';
import { reserveSolverSlot } from './optimization-admission';
import { allocateGeneration } from './optimization-generation';
import { solverSlot } from './schema';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;
const CONTRACT = '7+0.1.0';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('reserveSolverSlot global capacity', () => {
  it('refuses a seventeenth seat across two coordinators sharing one SQLite file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wbs-optimization-global-admission-'));
    dirs.push(dir);
    const path = join(dir, 'test.db');
    runMigrations(path, FOLDER);
    const raw = openDatabase(path);
    try {
      raw.run(
        `INSERT INTO users (id, username, password_hash, created_at)
         VALUES ('u-1', 'owner', 'hash', 1)`,
      );
      for (let project = 1; project <= 5; project += 1) {
        raw.run(
          `INSERT INTO project (id, name, owner_id, restricted, revision, created_at,
                                optimization_enabled, schedule_engine, schedule_objective)
           VALUES (?, ?, 'u-1', 0, 0, 1, 1, 'optimized', 'pri')`,
          [`p-${String(project)}`, `Plan ${String(project)}`],
        );
      }
    } finally {
      raw.close();
    }

    const blue = openDrizzle(path);
    const green = openDrizzle(path);
    const generations = new Map<string, number>();
    for (let project = 1; project <= 5; project += 1) {
      const projectId = `p-${String(project)}`;
      generations.set(projectId, allocateGeneration(blue, projectId, CONTRACT, 'hash-1', 2));
    }

    for (let index = 0; index < 16; index += 1) {
      const projectId = `p-${String(Math.floor(index / 4) + 1)}`;
      expect(
        reserveSolverSlot(index % 2 === 0 ? blue : green, {
          projectId,
          contractVersion: CONTRACT,
          generation: generations.get(projectId)!,
          objective: index % 2 === 0 ? 'pri' : 'time',
          budgetMs: 60_000 + (index % 4),
          ownerId: `owner-${String(index)}`,
          attemptToken: `token-${String(index)}`,
          now: 10,
        }),
      ).toMatchObject({ kind: 'reserved' });
    }

    expect(
      reserveSolverSlot(green, {
        projectId: 'p-5',
        contractVersion: CONTRACT,
        generation: generations.get('p-5')!,
        objective: 'pri',
        budgetMs: 70_000,
        ownerId: 'seventeenth-owner',
        attemptToken: 'seventeenth-token',
        now: 10,
      }),
    ).toEqual({ kind: 'global-full' });
    expect(blue.select().from(solverSlot).all()).toHaveLength(16);

    // Proof: changing the global comparison from >= to > admits the seventeenth
    // row. Using one connection throughout leaves the two-coordinator boundary
    // this regression is about unexercised.
  });
});
