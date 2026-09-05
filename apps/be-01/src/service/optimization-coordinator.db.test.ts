import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';
import { scheduleInputHash } from '@wbs/domain/canonical-schedule-input';
import { afterEach, describe, expect, it } from 'bun:test';

import { openDatabase, openDrizzle } from '../repository/db';
import { runMigrations } from '../repository/migrate';
import { allocateGeneration } from '../repository/optimization-generation';
import type { SpawnRequest } from '../repository/optimized-schedule-cache';
import { OptimizationCoordinator } from './optimization-coordinator';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;
const CONTRACT = '7+0.1.0';
const BUDGET = 60_000;

const INPUT: ScheduleInput = {
  rows: [
    { id: 'w-1', parentId: null, position: 10, frozenNumber: null, priority: null },
  ],
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
  calls: SpawnRequest[],
): OptimizationCoordinator {
  return new OptimizationCoordinator({
    db,
    contractVersion: CONTRACT,
    budgetMs: BUDGET,
    spawn: (request) => void calls.push(request),
  });
}

describe('OptimizationCoordinator read', () => {
  it('requests both absent objectives once while Fast remains the immediate answer', () => {
    const { db } = database();
    const calls: SpawnRequest[] = [];

    expect(
      coordinator(db, calls).read({ projectId: 'p-1', objective: 'pri', input: INPUT }),
    ).toBeNull();
    expect(calls.map(({ objective }) => objective)).toEqual(['pri', 'time']);
    expect(calls.every(({ key }) => key.inputHash === scheduleInputHash(INPUT))).toBe(true);

    // Proof: replacing the coordinator's spawning read with `readOptimizedPair`
    // fails here with `Expected [ "pri", "time" ], Received []`.
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
    const calls: SpawnRequest[] = [];

    expect(
      coordinator(db, calls).read({ projectId: 'p-1', objective: 'pri', input: INPUT }),
    ).toBeNull();
    expect(calls).toEqual([]);

    // Proof: admitting every non-ok outcome fails here with two requests; a
    // failed or corrupt row is durable evidence and only explicit Retry spends it.
  });
});
