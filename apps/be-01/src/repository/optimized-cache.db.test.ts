import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  encodeOptimizedResult,
  type OptimizedResult,
  publishOptimizedResult,
  RESULT_DTO_VERSION,
  type StoredObjectiveValue,
} from '@wbs/contracts/solver/optimized-result';
import {
  encodeSchedule,
  guardRealPublication,
  type PlannedRow,
  type Schedule,
  schedule,
  scoreReal,
  type Slice,
  sliceKey,
  SOLVER_QUANTUM,
} from '@wbs/domain';
import { type ScheduleInput, scheduleInputHash } from '@wbs/domain/canonical-schedule-input';
import { describe, expect, it } from 'bun:test';

import { openDatabase, openDrizzle } from './db';
import { runMigrations } from './migrate';
import { allocateGeneration } from './optimization-generation';
import {
  type AdmissionClaim,
  admissionStillCurrent,
  type CachedOutcome,
  type OptimizedCacheKey,
  type OptimizedPair,
  type OutcomeToStore,
  type OutcomeWriteResult,
  publishedScheduleReaderOf,
  readOptimizedPair,
  readOptimizedPairAndSpawn,
  retryOptimizedPair,
  type Spawner,
  type SpawnRequest,
  storeOptimizedOutcome,
  writerStillHolds,
} from './optimized-schedule-cache';
import { optimizedScheduleCache } from './schema';

/**
 * tasks.md 4.2's proof file, for the half 4.1 has landed: the read.
 *
 * Every case here goes through {@link readOptimizedPair} rather than off a raw
 * select, because the claims are about the *read path* — the generation
 * predicate, the 3.8 boundary and the decode seam — and a select would prove
 * only that SQLite stored what it was given. 4.2's spawner seam lives here too,
 * at the bottom: it is a repository-level injection, so its counts are
 * assertable without the coordinator. 4.4's Retry arm and 4.6's ABA fence still
 * wait for admission.
 */

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

const CONTRACT = '7+1.0.0';
const HASH = 'h1';
const BUDGET = 60_000;

const KEY: OptimizedCacheKey = {
  projectId: 'p-1',
  inputHash: HASH,
  contractVersion: CONTRACT,
  budgetMs: BUDGET,
};

function tempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-optimized-cache-'));
  return {
    path: join(dir, 'test.db'),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedProject(path: string): void {
  const db = openDatabase(path);
  try {
    db.run(
      `INSERT INTO users (id, username, password_hash, created_at) VALUES ('u-1', 'u', 'h', 1)`,
    );
    db.run(
      `INSERT INTO project (id, name, owner_id, restricted, revision, created_at)
       VALUES ('p-1', 'Rewire the shed', 'u-1', 0, 0, 1)`,
    );
  } finally {
    db.close();
  }
}

/** Three two-day blocks in a pool of one, so a stored plan has real waits in it. */
function realPlan(): Schedule {
  const rows: PlannedRow[] = ['a', 'b', 'c'].map((id, at) => ({
    id,
    parentId: null,
    position: (at + 1) * 10,
    frozenNumber: null,
    priority: null,
  }));
  const slices: Slice[] = ['a', 'b', 'c'].map((workItemId) => ({
    workItemId,
    stepId: 'step-dev',
    days: 2,
    personId: null,
    width: 1,
    poolIds: ['team-platform'],
  }));
  return schedule(rows, [], slices, new Map(), new Map([['team-platform', 1]]));
}

function solverResult(plan: Schedule): OptimizedResult {
  return {
    publication: 'solver',
    objectiveValues: {
      makespan: { value: 288, stageValue: 288, bound: 288, status: 'optimal' },
      priority: { value: 41, stageValue: 41, bound: 40, status: 'feasible' },
      movement: { value: 7, stageValue: null, bound: null, status: 'unknown' },
    },
    schedule: plan,
  };
}

/** A prepared database with one allocated generation and nothing cached. */
function prepared(path: string): number {
  runMigrations(path, FOLDER);
  seedProject(path);
  return allocateGeneration(openDrizzle(path), 'p-1', CONTRACT, HASH, 1);
}

/**
 * Writes a row with raw SQL on purpose.
 *
 * The corrupt cases store payloads the typed insert would never produce, and
 * the whole point of 4.8 is what happens to a row this release did not write —
 * one from an earlier version, a restored backup, a hand repair. Going through
 * drizzle's typed insert would prove only that the encoder and the decoder
 * agree, which `optimized-result-dto.test.ts` already proves.
 */
function storeRow(
  path: string,
  values: {
    objective: string;
    generation: number;
    status: string;
    resultJson: string | null;
    failureReason: string | null;
    inputHash?: string;
    contractVersion?: string;
    budgetMs?: number;
  },
): void {
  const db = openDatabase(path);
  try {
    const quote = (value: string | null): string =>
      value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
    db.run(
      `INSERT INTO optimized_schedule_cache
         (project_id, input_hash, objective, contract_version, budget_ms,
          generation, status, result_json, failure_reason, created_at)
       VALUES ('p-1', ${quote(values.inputHash ?? HASH)}, '${values.objective}',
               ${quote(values.contractVersion ?? CONTRACT)}, ${String(values.budgetMs ?? BUDGET)},
               ${String(values.generation)}, '${values.status}', ${quote(values.resultJson)},
               ${quote(values.failureReason)}, 7)`,
    );
  } finally {
    db.close();
  }
}

function storedRowCount(path: string): number {
  const db = openDatabase(path);
  try {
    return (db.query('SELECT COUNT(*) AS n FROM optimized_schedule_cache').get() as { n: number })
      .n;
  } finally {
    db.close();
  }
}

function read(path: string, key: OptimizedCacheKey = KEY): OptimizedPair {
  return readOptimizedPair(openDrizzle(path), key);
}

/**
 * Records every request, so a count and an order are both assertable.
 *
 * At module scope because 4.1b's proof (b) counts spawns too — it is the item
 * that was waiting for this seam to exist, and a second copy of four lines
 * would be two definitions of what "a solve was asked for" means.
 */
function recorder(): { spawn: Spawner; calls: SpawnRequest[] } {
  const calls: SpawnRequest[] = [];
  return { spawn: (request) => void calls.push(request), calls };
}

function readAndSpawn(path: string, spawn: Spawner, key: OptimizedCacheKey = KEY): OptimizedPair {
  return readOptimizedPairAndSpawn(openDrizzle(path), key, spawn);
}

describe('what a stored pair reads as', () => {
  it('serves both objectives for the full key, objectiveValues and plan intact', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      const plan = realPlan();
      const source = solverResult(plan);
      // Load-bearing: over an empty plan the schedule assertion below is vacuous.
      expect(plan.slices.size).toBe(3);
      const payload = JSON.stringify(encodeOptimizedResult(source));
      for (const objective of ['pri', 'time']) {
        storeRow(db.path, {
          objective,
          generation,
          status: 'ok',
          resultJson: payload,
          failureReason: null,
        });
      }

      const pair = read(db.path);

      expect(pair.pri.kind).toBe('ok');
      expect(pair.time.kind).toBe('ok');
      if (pair.pri.kind !== 'ok') throw new Error('unreachable');
      expect(pair.pri.result.objectiveValues).toEqual(source.objectiveValues);
      expect(pair.pri.result.publication).toBe('solver');
      expect(pair.pri.result.schedule).toEqual(plan);
      expect(pair.pri.generation).toBe(generation);
      expect(pair.pri.createdAt).toBe(7);
    } finally {
      db.cleanup();
    }
  });

  it('reads one objective and misses the other when only one has committed', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      storeRow(db.path, {
        objective: 'pri',
        generation,
        status: 'ok',
        resultJson: JSON.stringify(encodeOptimizedResult(solverResult(realPlan()))),
        failureReason: null,
      });

      const pair = read(db.path);

      expect(pair.pri.kind).toBe('ok');
      expect(pair.time).toEqual({ kind: 'miss' });
    } finally {
      db.cleanup();
    }
  });

  /**
   * 4.2's three key-column misses in one case, because they are one claim: the
   * primary key decides the row, and a read for a different key is a miss
   * rather than a near-enough hit. `budgetMs` is the one an implementer drops —
   * it is the only key column that is neither the plan nor the release.
   */
  it('misses a raised budget, a bumped contract version and a changed hash', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      storeRow(db.path, {
        objective: 'pri',
        generation,
        status: 'ok',
        resultJson: JSON.stringify(encodeOptimizedResult(solverResult(realPlan()))),
        failureReason: null,
      });

      expect(read(db.path, { ...KEY, budgetMs: 120_000 }).pri).toEqual({ kind: 'miss' });
      expect(read(db.path, { ...KEY, contractVersion: '8+1.0.0' }).pri).toEqual({ kind: 'miss' });
      expect(read(db.path, { ...KEY, inputHash: 'h2' }).pri).toEqual({ kind: 'miss' });
      // And the row is still there — a miss is a miss, not an eviction.
      expect(storedRowCount(db.path)).toBe(1);
    } finally {
      db.cleanup();
    }
  });

  /**
   * 4.3's claim, at the layer that decides it. A `failed` row is readable —
   * that is what makes the marker suppress a re-spawn — but it never reads
   * `ok`, and serving one as a schedule would publish an empty plan as an
   * optimized one.
   */
  /**
   * tasks.md 4.3's negative check. `Proof:` the relaxed predicate is
   * `outcomeOf`'s `status === 'failed'` branch in `optimized-schedule-cache.ts`
   * — with it rewritten to `status === 'failed' && resultJson === null` and
   * answering `{ kind: 'ok', result: <empty plan> }` instead of
   * `{ kind: 'failed', reason }`, this case fails on `Expected: "failed" /
   * Received: "ok"`. Watched on h2puni at `4eebaa44`: 32 pass / 4 fail against
   * a 36 / 0 baseline for this file. The other three that redden
   * (`leaves the drizzle-typed insert path working for a well-formed row`,
   * `stores a failed row carrying its reason and no payload`, and
   * `lets two releases reading different budgets keep a row each`) all store a
   * failure and read it back, so the relaxation cannot be made to look local.
   *
   * Why it is guarded at all: a failure marker served as a schedule publishes
   * an **empty plan as an optimized one** — every date in the project moves to
   * nothing, and the read reports success while doing it, so nothing downstream
   * has a reason to look. `corrupt` is guarded by the same branch's other arm
   * and for the same reason (4.8).
   */
  it('never lets a failed row satisfy a read, and carries its reason', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      storeRow(db.path, {
        objective: 'time',
        generation,
        status: 'failed',
        resultJson: null,
        failureReason: 'timeout',
      });

      const outcome = read(db.path).time;

      expect(outcome.kind).toBe('failed');
      if (outcome.kind !== 'failed') throw new Error('unreachable');
      expect(outcome.reason).toBe('timeout');
    } finally {
      db.cleanup();
    }
  });
});

describe('the generation predicate on the read', () => {
  /**
   * 4.6's ABA fence, read-side. Allocation deletes superseded rows, but a read
   * between the allocation and its delete must not serve an answer computed
   * against a plan that no longer exists — so the predicate lives on the read
   * as well as in the eviction, and this case writes the stale row *after* the
   * allocation precisely so no delete can hide the defect.
   */
  it('misses a row from an older generation and leaves it in place', () => {
    const db = tempDb();
    try {
      const first = prepared(db.path);
      const second = allocateGeneration(openDrizzle(db.path), 'p-1', CONTRACT, 'h2', 2);
      expect(second).toBeGreaterThan(first);

      storeRow(db.path, {
        objective: 'pri',
        generation: first,
        status: 'ok',
        resultJson: JSON.stringify(encodeOptimizedResult(solverResult(realPlan()))),
        failureReason: null,
      });

      expect(read(db.path).pri).toEqual({ kind: 'miss' });
      expect(storedRowCount(db.path)).toBe(1);
    } finally {
      db.cleanup();
    }
  });

  it('serves nothing before the first allocation, however many rows exist', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seedProject(db.path);
      storeRow(db.path, {
        objective: 'pri',
        generation: 1,
        status: 'ok',
        resultJson: JSON.stringify(encodeOptimizedResult(solverResult(realPlan()))),
        failureReason: null,
      });

      const pair = read(db.path);

      expect(pair.pri).toEqual({ kind: 'miss' });
      expect(pair.time).toEqual({ kind: 'miss' });
      expect(storedRowCount(db.path)).toBe(1);
    } finally {
      db.cleanup();
    }
  });
});

describe('a payload the decoder refuses', () => {
  /**
   * 4.8's rule, and the one that had to be argued for rather than implemented:
   * the row is **left in place**. Deleting it and reporting a miss turns
   * corruption into a read-triggered solve — the timer retry Dany rejected,
   * arriving through the cache instead of the clock — and destroys the evidence
   * at the moment it is found.
   */
  const survives = (path: string, outcome: CachedOutcome, matching: RegExp): void => {
    expect(outcome.kind).toBe('corrupt');
    if (outcome.kind !== 'corrupt') throw new Error('unreachable');
    expect(outcome.reason).toMatch(matching);
    expect(storedRowCount(path)).toBe(1);
  };

  it('reads a truncated payload as corrupt and keeps the row', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      const whole = JSON.stringify(encodeOptimizedResult(solverResult(realPlan())));
      storeRow(db.path, {
        objective: 'pri',
        generation,
        status: 'ok',
        resultJson: whole.slice(0, Math.floor(whole.length / 2)),
        failureReason: null,
      });

      survives(db.path, read(db.path).pri, /JSON|Unexpected|parse/i);
    } finally {
      db.cleanup();
    }
  });

  it('reads a wrong dtoVersion as corrupt and keeps the row', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      const stored = encodeOptimizedResult(solverResult(realPlan()));
      storeRow(db.path, {
        objective: 'pri',
        generation,
        status: 'ok',
        resultJson: JSON.stringify({ ...stored, dtoVersion: RESULT_DTO_VERSION + 1 }),
        failureReason: null,
      });

      survives(db.path, read(db.path).pri, /dtoVersion/);
    } finally {
      db.cleanup();
    }
  });

  /**
   * The `CHECK` forbids this row, so only a database written before the
   * constraint existed can hold it — which is the same provenance argument the
   * 3.8 boundary is built on. It reads `corrupt` rather than throwing because a
   * throw here would wedge the plan read for **both** objectives on one bad
   * row, which is the outcome `corrupt` exists to prevent.
   */
  it('reads an ok row with no payload as corrupt rather than throwing', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      const raw = openDatabase(db.path);
      try {
        raw.run('PRAGMA ignore_check_constraints = ON');
        raw.run(
          `INSERT INTO optimized_schedule_cache
             (project_id, input_hash, objective, contract_version, budget_ms,
              generation, status, result_json, failure_reason, created_at)
           VALUES ('p-1', '${HASH}', 'pri', '${CONTRACT}', ${String(BUDGET)}, ${String(generation)},
                   'ok', NULL, NULL, 7)`,
        );
      } finally {
        raw.close();
      }

      survives(db.path, read(db.path).pri, /no result_json/);
    } finally {
      db.cleanup();
    }
  });
});

describe('a plan-infeasible row, decoded by its own codec', () => {
  /**
   * Assumption A1 (schema.ts) reuses `result_json` for the infeasibility
   * certificate, and says a payload that fails to decode reads `corrupt` on
   * exactly the rule an `ok` row obeys. `decodePlanInfeasible` has since landed
   * beside the failure path, so all three cases below are now the whole of A1
   * rather than its envelope half: the versioned envelope, and — in the third
   * case — a certificate whose offending-item list is malformed, which the
   * earlier envelope-only read served as `plan-infeasible` and which now reads
   * `corrupt`. The tightening was a change to `decodePayload` and to no caller,
   * exactly as the split predicted.
   */
  it('reads a versioned certificate as plan-infeasible and hands it over whole', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      const certificate = {
        dtoVersion: 1,
        items: [{ ownerWorkItemId: 'parent', boundWorkItemId: 'a', effectiveDeadlineOffset: 10 }],
      };
      storeRow(db.path, {
        objective: 'time',
        generation,
        status: 'plan-infeasible',
        resultJson: JSON.stringify(certificate),
        failureReason: null,
      });

      const outcome = read(db.path).time;

      expect(outcome.kind).toBe('plan-infeasible');
      if (outcome.kind !== 'plan-infeasible') throw new Error('unreachable');
      expect(outcome.certificate).toEqual({ items: certificate.items });
    } finally {
      db.cleanup();
    }
  });

  it('reads an unversioned certificate as corrupt and keeps the row', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      storeRow(db.path, {
        objective: 'time',
        generation,
        status: 'plan-infeasible',
        resultJson: JSON.stringify({ items: [] }),
        failureReason: null,
      });

      const outcome = read(db.path).time;

      expect(outcome.kind).toBe('corrupt');
      if (outcome.kind !== 'corrupt') throw new Error('unreachable');
      expect(outcome.reason).toMatch(/dtoVersion/);
      expect(storedRowCount(db.path)).toBe(1);
    } finally {
      db.cleanup();
    }
  });

  it('reads a malformed certificate item as corrupt and keeps the row', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      storeRow(db.path, {
        objective: 'time',
        generation,
        status: 'plan-infeasible',
        resultJson: JSON.stringify({
          dtoVersion: 1,
          items: [{ ownerWorkItemId: 'a', boundWorkItemId: 'a', effectiveDeadlineOffset: '10' }],
        }),
        failureReason: null,
      });

      const outcome = read(db.path).time;

      expect(outcome.kind).toBe('corrupt');
      if (outcome.kind !== 'corrupt') throw new Error('unreachable');
      expect(outcome.reason).toMatch(/effectiveDeadlineOffset/);
      expect(storedRowCount(db.path)).toBe(1);
    } finally {
      db.cleanup();
    }
  });

  /**
   * tasks.md 8.7c: the stored row `status` and the DTO union are **different
   * layers**, and `status` is the only thing that tells these two rows apart.
   *
   * Both rows below carry the **same bytes** in `result_json` — a well-formed
   * certificate — and both satisfy the table's payload `CHECK`, which asks only
   * that an `ok` row and a `plan-infeasible` row each have a non-NULL payload
   * and no `failureReason`. So the database cannot distinguish them, and
   * neither can the JSON. Only the discriminator can, and it does: `pri` is an
   * `ok` row whose payload is not a schedule, which is precisely the definition
   * of `corrupt`, while `time` is the same payload under the status that claims
   * it and reads as a certificate.
   *
   * **Why this is the case worth writing.** If `plan-infeasible` had been
   * modelled as "an `ok` row carrying an infeasible payload" rather than as its
   * own status, these two rows would be one row, and the read would have to
   * guess from the payload's shape whether a decode failure meant "the plan
   * cannot be met" or "this row is damaged" — the one point the two must be
   * told apart. Read side by side in a single pair so the discrimination is
   * asserted on one read of one database rather than on two.
   */
  it('tells an ok row carrying a certificate from a plan-infeasible row carrying the same bytes', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      const payload = JSON.stringify({
        dtoVersion: 1,
        items: [{ ownerWorkItemId: 'parent', boundWorkItemId: 'leaf', effectiveDeadlineOffset: 7 }],
      });
      for (const [objective, status] of [
        ['pri', 'ok'],
        ['time', 'plan-infeasible'],
      ]) {
        storeRow(db.path, {
          objective,
          generation,
          status,
          resultJson: payload,
          failureReason: null,
        });
      }

      const pair = read(db.path);

      expect(pair.pri.kind).toBe('corrupt');
      expect(pair.time.kind).toBe('plan-infeasible');
      if (pair.time.kind !== 'plan-infeasible') throw new Error('unreachable');
      expect(pair.time.certificate.items).toEqual([
        { ownerWorkItemId: 'parent', boundWorkItemId: 'leaf', effectiveDeadlineOffset: 7 },
      ]);
      expect(storedRowCount(db.path)).toBe(2);
    } finally {
      db.cleanup();
    }
  });
});

describe('the 3.8 boundary still throws on the read path', () => {
  /**
   * 4.8's first half. An unknown *enum value* is not a corrupt payload: there
   * is no honest answer to a question about a token this release has never
   * heard of, so the read throws naming the column and the value, exactly as
   * `toProject` does. The distinction from `corrupt` is the point — one is an
   * absent payload, the other an unrecognised vocabulary.
   */
  it('throws naming the column when a stored objective is unknown', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      const raw = openDatabase(db.path);
      try {
        raw.run('PRAGMA ignore_check_constraints = ON');
        raw.run(
          `INSERT INTO optimized_schedule_cache
             (project_id, input_hash, objective, contract_version, budget_ms,
              generation, status, result_json, failure_reason, created_at)
           VALUES ('p-1', '${HASH}', 'cost', '${CONTRACT}', ${String(BUDGET)}, ${String(generation)},
                   'failed', NULL, 'timeout', 7)`,
        );
      } finally {
        raw.close();
      }

      expect(() => read(db.path)).toThrow(/optimized_schedule_cache\.objective.*cost/);
    } finally {
      db.cleanup();
    }
  });

  /**
   * Injects a row the `CHECK` constraints forbid, which is the only way to
   * reach the read's own guard: the column constraint is the first fence and
   * the validator is the second, and 4.8 is a claim about the second. A row
   * like this arrives from an earlier release, a restored backup or a hand
   * repair — never from this code.
   */
  function injectUnchecked(path: string, values: { status: string; failureReason: string | null }) {
    const generation = prepared(path);
    const raw = openDatabase(path);
    try {
      raw.run('PRAGMA ignore_check_constraints = ON');
      const quote = (value: string | null): string => (value === null ? 'NULL' : `'${value}'`);
      raw.run(
        `INSERT INTO optimized_schedule_cache
           (project_id, input_hash, objective, contract_version, budget_ms,
            generation, status, result_json, failure_reason, created_at)
         VALUES ('p-1', '${HASH}', 'pri', '${CONTRACT}', ${String(BUDGET)}, ${String(generation)},
                 '${values.status}', NULL, ${quote(values.failureReason)}, 7)`,
      );
    } finally {
      raw.close();
    }
  }

  /**
   * 4.8's second value. `status` decides which branch of `outcomeOf` runs, so a
   * token this release has never heard of is not a state to render — it is a
   * question with no honest answer, and defaulting it would pick a branch at
   * random on a row nobody can interpret.
   *
   * `Proof:` the removed guard is `isOptimizedScheduleStatus` in
   * `optimizer-rows.ts`; with its `throw` replaced by a cast this case fails
   * because the read returns instead of throwing.
   */
  it('throws naming the column when a stored status is unknown', () => {
    const db = tempDb();
    try {
      injectUnchecked(db.path, { status: 'cancelled', failureReason: null });

      expect(() => read(db.path)).toThrow(/optimized_schedule_cache\.status.*cancelled/);
    } finally {
      db.cleanup();
    }
  });

  /**
   * 4.8's third value, and the one with a real consequence rather than a
   * theoretical one: `failure_reason` is what the UI puts in front of a person,
   * so a cast would render an unrecognised token as if the product had meant
   * it.
   *
   * `Proof:` the removed guard is `isSolverFailureReason` in
   * `optimizer-rows.ts`.
   */
  it('throws naming the column when a stored failure reason is unknown', () => {
    const db = tempDb();
    try {
      injectUnchecked(db.path, { status: 'failed', failureReason: 'ran-out-of-patience' });

      expect(() => read(db.path)).toThrow(
        /optimized_schedule_cache\.failure_reason.*ran-out-of-patience/,
      );
    } finally {
      db.cleanup();
    }
  });

  it('leaves the drizzle-typed insert path working for a well-formed row', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      openDrizzle(db.path)
        .insert(optimizedScheduleCache)
        .values({
          projectId: 'p-1',
          inputHash: HASH,
          objective: 'pri',
          contractVersion: CONTRACT,
          budgetMs: BUDGET,
          generation,
          status: 'failed',
          resultJson: null,
          failureReason: 'oom',
          createdAt: 7,
        })
        .run();

      const outcome = read(db.path).pri;

      expect(outcome.kind).toBe('failed');
      if (outcome.kind !== 'failed') throw new Error('unreachable');
      expect(outcome.reason).toBe('oom');
    } finally {
      db.cleanup();
    }
  });
});

describe("the writer's own slot, which is 4.1's first condition", () => {
  /**
   * The fence that is not implied by the row existing. A reclaimed owner
   * re-reserving the same seat has the same primary key and the same `ownerId`;
   * only the freshly minted token tells the two attempts apart, and it is what
   * keeps a late write from a reclaimed child out of the cache.
   */
  const CLAIM = {
    projectId: 'p-1',
    contractVersion: CONTRACT,
    generation: 1,
    objective: 'pri',
    budgetMs: BUDGET,
    ownerId: 'coordinator-a',
    attemptToken: 'tok-1',
  } as const;

  function reserve(
    path: string,
    generation: number,
    over: { ownerId?: string; attemptToken?: string; lifecycle?: string } = {},
  ): void {
    const db = openDatabase(path);
    try {
      db.run(
        `INSERT INTO solver_slot
           (project_id, contract_version, generation, objective, budget_ms,
            owner_id, attempt_token, lifecycle, pid, started_at, heartbeat_at,
            cancel_requested_at, admitted_deadline_at)
         VALUES ('p-1', '${CONTRACT}', ${String(generation)}, 'pri', ${String(BUDGET)},
                 '${over.ownerId ?? CLAIM.ownerId}', '${over.attemptToken ?? CLAIM.attemptToken}',
                 '${over.lifecycle ?? 'running'}', 4242, 1, 1, NULL, 99)`,
      );
    } finally {
      db.close();
    }
  }

  const holds = (path: string, claim = CLAIM): boolean =>
    writerStillHolds(openDrizzle(path), claim);

  it('holds when the seat carries this attempt', () => {
    const db = tempDb();
    try {
      prepared(db.path);
      reserve(db.path, 1);

      expect(holds(db.path)).toBe(true);
    } finally {
      db.cleanup();
    }
  });

  it('does not hold when the seat is empty', () => {
    const db = tempDb();
    try {
      prepared(db.path);

      expect(holds(db.path)).toBe(false);
    } finally {
      db.cleanup();
    }
  });

  /**
   * The case the token exists for, and the one a row-existence check passes:
   * same project, same seat, same coordinator, second attempt.
   */
  it('does not hold when the same owner has re-reserved the seat', () => {
    const db = tempDb();
    try {
      prepared(db.path);
      reserve(db.path, 1, { attemptToken: 'tok-2' });

      expect(holds(db.path)).toBe(false);
    } finally {
      db.cleanup();
    }
  });

  it('does not hold when another coordinator took the seat with this token', () => {
    const db = tempDb();
    try {
      prepared(db.path);
      reserve(db.path, 1, { ownerId: 'coordinator-b' });

      expect(holds(db.path)).toBe(false);
    } finally {
      db.cleanup();
    }
  });

  /** A different generation is a different seat, not the same one moved on. */
  it('does not hold against a slot reserved under another generation', () => {
    const db = tempDb();
    try {
      prepared(db.path);
      reserve(db.path, 2);

      expect(holds(db.path)).toBe(false);
    } finally {
      db.cleanup();
    }
  });

  /**
   * `starting` is a real reservation whose process has not been forked yet, so
   * it authorizes a write. Requiring `running` would refuse a legitimate commit
   * from a child that finished before its lifecycle row was advanced.
   */
  it('holds on a starting slot, because a reservation is not a process', () => {
    const db = tempDb();
    try {
      prepared(db.path);
      const raw = openDatabase(db.path);
      try {
        raw.run(
          `INSERT INTO solver_slot
             (project_id, contract_version, generation, objective, budget_ms,
              owner_id, attempt_token, lifecycle, pid, started_at, heartbeat_at,
              cancel_requested_at, admitted_deadline_at)
           VALUES ('p-1', '${CONTRACT}', 1, 'pri', ${String(BUDGET)},
                   '${CLAIM.ownerId}', '${CLAIM.attemptToken}', 'starting', NULL, 1, 1, NULL, 99)`,
        );
      } finally {
        raw.close();
      }

      expect(holds(db.path)).toBe(true);
    } finally {
      db.cleanup();
    }
  });

  /** 3.8 again: a corrupted slot row must not silently authorize a write. */
  it('throws naming the column when the slot lifecycle is unknown', () => {
    const db = tempDb();
    try {
      prepared(db.path);
      const raw = openDatabase(db.path);
      try {
        raw.run('PRAGMA ignore_check_constraints = ON');
        raw.run(
          `INSERT INTO solver_slot
             (project_id, contract_version, generation, objective, budget_ms,
              owner_id, attempt_token, lifecycle, pid, started_at, heartbeat_at,
              cancel_requested_at, admitted_deadline_at)
           VALUES ('p-1', '${CONTRACT}', 1, 'pri', ${String(BUDGET)},
                   '${CLAIM.ownerId}', '${CLAIM.attemptToken}', 'wedged', 1, 1, 1, NULL, 99)`,
        );
      } finally {
        raw.close();
      }

      expect(() => holds(db.path)).toThrow(/solver_slot\.lifecycle.*wedged/);
    } finally {
      db.cleanup();
    }
  });
});

describe("the generation the attempt was admitted under, which is 4.1's second and third conditions", () => {
  const ADMITTED: AdmissionClaim = {
    projectId: 'p-1',
    contractVersion: CONTRACT,
    generation: 1,
    admittedCancelEpoch: 0,
  };

  const current = (path: string, claim = ADMITTED): boolean =>
    admissionStillCurrent(openDrizzle(path), claim);

  function bumpCancelEpoch(path: string): void {
    const db = openDatabase(path);
    try {
      db.run(
        `UPDATE optimization_generation SET cancel_epoch = cancel_epoch + 1
         WHERE project_id = 'p-1' AND contract_version = '${CONTRACT}'`,
      );
    } finally {
      db.close();
    }
  }

  it('is current for the generation just allocated', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);

      expect(current(db.path, { ...ADMITTED, generation })).toBe(true);
    } finally {
      db.cleanup();
    }
  });

  it('is not current once a new generation has been allocated', () => {
    const db = tempDb();
    try {
      const first = prepared(db.path);
      allocateGeneration(openDrizzle(db.path), 'p-1', CONTRACT, 'h2', 2);

      expect(current(db.path, { ...ADMITTED, generation: first })).toBe(false);
    } finally {
      db.cleanup();
    }
  });

  /**
   * The cancel a generation bump cannot stand in for: the plan did not change,
   * so `generation` is untouched, and only the epoch says the run was cancelled.
   */
  it('is not current once the cancel epoch has moved under an unchanged generation', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      bumpCancelEpoch(db.path);

      expect(current(db.path, { ...ADMITTED, generation })).toBe(false);
    } finally {
      db.cleanup();
    }
  });

  it('is not current when there is no generation row at all', () => {
    const db = tempDb();
    try {
      runMigrations(db.path, FOLDER);
      seedProject(db.path);

      expect(current(db.path)).toBe(false);
    } finally {
      db.cleanup();
    }
  });

  /** Blue and green each own their row, so green's allocation is not blue's. */
  it("is unaffected by another contract version's allocation", () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      allocateGeneration(openDrizzle(db.path), 'p-1', '8+1.0.0', 'h1', 2);

      expect(current(db.path, { ...ADMITTED, generation })).toBe(true);
    } finally {
      db.cleanup();
    }
  });

  /**
   * `draining` admits no new work; it does not discard a solve already admitted
   * and still holding its slot. Refusing that commit would throw the completed
   * work away and leave the key with no outcome at all.
   */
  it('stays current while the generation is draining', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      const raw = openDatabase(db.path);
      try {
        raw.run(
          `UPDATE optimization_generation SET admission_state = 'draining'
           WHERE project_id = 'p-1' AND contract_version = '${CONTRACT}'`,
        );
      } finally {
        raw.close();
      }

      expect(current(db.path, { ...ADMITTED, generation })).toBe(true);
    } finally {
      db.cleanup();
    }
  });
});

describe("4.1's conditional write, with all four conditions composed", () => {
  const CLAIM = {
    projectId: 'p-1',
    contractVersion: CONTRACT,
    generation: 1,
    objective: 'pri',
    budgetMs: BUDGET,
    ownerId: 'coordinator-a',
    attemptToken: 'tok-1',
  } as const;

  /** The seat the writer holds, exactly as the coordinator reserves it. */
  function reserve(path: string, over: { attemptToken?: string } = {}): void {
    const db = openDatabase(path);
    try {
      db.run(
        `INSERT INTO solver_slot
           (project_id, contract_version, generation, objective, budget_ms,
            owner_id, attempt_token, lifecycle, pid, started_at, heartbeat_at,
            cancel_requested_at, admitted_deadline_at)
         VALUES ('p-1', '${CONTRACT}', 1, 'pri', ${String(BUDGET)},
                 '${CLAIM.ownerId}', '${over.attemptToken ?? CLAIM.attemptToken}',
                 'running', 4242, 1, 1, NULL, 99)`,
      );
    } finally {
      db.close();
    }
  }

  function setEnabled(path: string, enabled: 0 | 1): void {
    const db = openDatabase(path);
    try {
      db.run(`UPDATE project SET optimization_enabled = ${String(enabled)} WHERE id = 'p-1'`);
    } finally {
      db.close();
    }
  }

  function bumpCancelEpoch(path: string): void {
    const db = openDatabase(path);
    try {
      db.run(
        `UPDATE optimization_generation SET cancel_epoch = cancel_epoch + 1
         WHERE project_id = 'p-1' AND contract_version = '${CONTRACT}'`,
      );
    } finally {
      db.close();
    }
  }

  /**
   * A prepared database with one allocated generation, the seat reserved and
   * the project switched on — the state a legitimate commit starts from.
   */
  function admitted(path: string): number {
    const generation = prepared(path);
    reserve(path);
    setEnabled(path, 1);
    return generation;
  }

  function commit(
    path: string,
    outcome: OutcomeToStore,
    over: { attemptToken?: string; generation?: number; admittedCancelEpoch?: number } = {},
  ): OutcomeWriteResult {
    return storeOptimizedOutcome(openDrizzle(path), {
      claim: {
        ...CLAIM,
        attemptToken: over.attemptToken ?? CLAIM.attemptToken,
        generation: over.generation ?? CLAIM.generation,
      },
      inputHash: HASH,
      admittedCancelEpoch: over.admittedCancelEpoch ?? 0,
      outcome,
      now: 1_700,
    });
  }

  it('stores an ok row the pair read serves back whole', () => {
    const db = tempDb();
    try {
      admitted(db.path);
      const plan = realPlan();
      // Load-bearing: over an empty plan the schedule assertion below is vacuous.
      expect(plan.slices.size).toBe(3);
      const source = solverResult(plan);

      expect(commit(db.path, { kind: 'ok', result: source })).toBe('stored');

      const pair = read(db.path);
      expect(pair.time.kind).toBe('miss');
      expect(pair.pri.kind).toBe('ok');
      if (pair.pri.kind !== 'ok') throw new Error('unreachable');
      expect(pair.pri.result.objectiveValues).toEqual(source.objectiveValues);
      expect(pair.pri.result.schedule).toEqual(plan);
      expect(pair.pri.generation).toBe(1);
      expect(pair.pri.createdAt).toBe(1_700);
    } finally {
      db.cleanup();
    }
  });

  it('stores a failed row carrying its reason and no payload', () => {
    const db = tempDb();
    try {
      admitted(db.path);

      expect(commit(db.path, { kind: 'failed', reason: 'timeout' })).toBe('stored');

      const pair = read(db.path);
      expect(pair.pri.kind).toBe('failed');
      if (pair.pri.kind !== 'failed') throw new Error('unreachable');
      expect(pair.pri.reason).toBe('timeout');
    } finally {
      db.cleanup();
    }
  });

  it('stores a plan-infeasible row carrying its versioned certificate', () => {
    const db = tempDb();
    try {
      admitted(db.path);
      const certificate = {
        items: [
          { ownerWorkItemId: 'parent', boundWorkItemId: 'leaf', effectiveDeadlineOffset: 10 },
        ],
      };

      expect(commit(db.path, { kind: 'plan-infeasible', certificate })).toBe('stored');

      const pair = read(db.path);
      expect(pair.pri).toMatchObject({ kind: 'plan-infeasible', certificate });
    } finally {
      db.cleanup();
    }
  });

  /**
   * The condition the token exists for: the seat was reclaimed and re-reserved
   * by a second attempt, so this writer's own token is no longer in it.
   */
  it('refuses a writer whose seat carries a newer attempt, and stores nothing', () => {
    const db = tempDb();
    try {
      admitted(db.path);
      const reclaimed = openDatabase(db.path);
      try {
        reclaimed.run(`UPDATE solver_slot SET attempt_token = 'tok-2' WHERE project_id = 'p-1'`);
      } finally {
        reclaimed.close();
      }

      expect(commit(db.path, { kind: 'failed', reason: 'timeout' })).toBe('superseded');
      expect(storedRowCount(db.path)).toBe(0);
    } finally {
      db.cleanup();
    }
  });

  it('refuses a writer whose generation has been superseded, and stores nothing', () => {
    const db = tempDb();
    try {
      admitted(db.path);
      allocateGeneration(openDrizzle(db.path), 'p-1', CONTRACT, 'h2', 2);

      expect(commit(db.path, { kind: 'failed', reason: 'timeout' })).toBe('superseded');
      expect(storedRowCount(db.path)).toBe(0);
    } finally {
      db.cleanup();
    }
  });

  it('refuses a writer admitted under an older cancel epoch, and stores nothing', () => {
    const db = tempDb();
    try {
      admitted(db.path);
      bumpCancelEpoch(db.path);

      expect(commit(db.path, { kind: 'failed', reason: 'timeout' })).toBe('superseded');
      expect(storedRowCount(db.path)).toBe(0);
    } finally {
      db.cleanup();
    }
  });

  /**
   * The fourth predicate, and the one no other fence covers: admission
   * happened while the project was on, and the owner switched it off while the
   * solve was still running. Every other condition still holds here — same
   * seat, same token, same generation, same cancel epoch.
   */
  it('refuses a commit against a project whose optimizer was switched off mid-solve', () => {
    const db = tempDb();
    try {
      admitted(db.path);
      setEnabled(db.path, 0);

      expect(commit(db.path, { kind: 'ok', result: solverResult(realPlan()) })).toBe('superseded');
      expect(storedRowCount(db.path)).toBe(0);
    } finally {
      db.cleanup();
    }
  });

  /** The default every existing project already carries, never turned on. */
  it('refuses a commit against a project that was never switched on', () => {
    const db = tempDb();
    try {
      prepared(db.path);
      reserve(db.path);

      expect(commit(db.path, { kind: 'failed', reason: 'timeout' })).toBe('superseded');
      expect(storedRowCount(db.path)).toBe(0);
    } finally {
      db.cleanup();
    }
  });

  /**
   * 4.1's headline sentence: a superseded run cannot overwrite an `ok` with a
   * `failed`. The primary key omits `generation`, so the two collide by
   * construction and the insert is conditional rather than an upsert.
   */
  /**
   * tasks.md 4.6, the ABA fence. Run hash A, edit to B — which allocates and
   * so cancels A — then undo to A. The plan is back where it was and the key is
   * character-for-character the one the original child was admitted against;
   * only the generation says that child belongs to a run nobody is waiting for.
   * Its write is refused, the current answer is untouched, and nothing is
   * deleted on the way past.
   *
   * **The cancel epoch is deliberately NOT bumped here.** Both predicates would
   * refuse this write, and a case that trips two fences proves neither: 4.7's
   * watched red removes the generation predicate and must see this fail, which
   * it cannot if the epoch is also refusing. The epoch's own arm is the case
   * below.
   *
   * Recorded so the boundary is not mistaken for the whole claim: no event is
   * emitted because nothing at this layer emits one. Events are slice 7's, and
   * the assertion that a refused write publishes nothing belongs with them.
   *
   * tasks.md 4.7's negative check. `Proof:` the removed predicate is
   * `current.generation === claim.generation` in `admissionStillCurrent` —
   * with it deleted and the cancel-epoch comparison left standing, this case
   * fails on `Expected: "superseded" / Received: "stored"`. Watched on h2puni
   * at `d91717f4`: 48 pass / 3 fail against a 51 / 0 baseline, script
   * `/home/puni1/mut46-r37.sh`. The other two are the predicate's own unit case
   * and 4.1's superseded-writer case. `inputHash` alone cannot tell a
   * resurrected run from a current one — after the undo the two are identical —
   * which is the whole reason the generation exists.
   */
  it('refuses the original child after an undo restores its hash, and touches nothing', () => {
    const db = tempDb();
    try {
      admitted(db.path);

      // A is edited to B, which allocates; the undo allocates again. The
      // original child is still holding a generation-1 admission.
      expect(allocateGeneration(openDrizzle(db.path), 'p-1', CONTRACT, 'h2', 10)).toBe(2);
      expect(allocateGeneration(openDrizzle(db.path), 'p-1', CONTRACT, HASH, 20)).toBe(3);

      // The answer the current generation has, which must survive the refusal.
      storeRow(db.path, {
        objective: 'time',
        generation: 3,
        status: 'ok',
        resultJson: JSON.stringify(encodeOptimizedResult(solverResult(realPlan()))),
        failureReason: null,
      });
      const before = storedRowCount(db.path);

      expect(commit(db.path, { kind: 'ok', result: solverResult(realPlan()) })).toBe('superseded');

      expect(storedRowCount(db.path)).toBe(before);
      const pair = read(db.path);
      expect(pair.time.kind).toBe('ok');
      // And the resurrected child wrote nothing of its own.
      expect(pair.pri).toEqual({ kind: 'miss' });
    } finally {
      db.cleanup();
    }
  });

  /** The same refusal reached through the cancel epoch, with the generation unmoved. */
  it('refuses a child whose run was cancelled even when its generation still stands', () => {
    const db = tempDb();
    try {
      admitted(db.path);
      bumpCancelEpoch(db.path);
      storeRow(db.path, {
        objective: 'time',
        generation: 1,
        status: 'ok',
        resultJson: JSON.stringify(encodeOptimizedResult(solverResult(realPlan()))),
        failureReason: null,
      });
      const before = storedRowCount(db.path);

      expect(commit(db.path, { kind: 'ok', result: solverResult(realPlan()) })).toBe('superseded');

      expect(storedRowCount(db.path)).toBe(before);
      expect(read(db.path).time.kind).toBe('ok');
    } finally {
      db.cleanup();
    }
  });

  it('does not overwrite a stored ok with a failed for the same key', () => {
    const db = tempDb();
    try {
      admitted(db.path);
      const source = solverResult(realPlan());
      expect(commit(db.path, { kind: 'ok', result: source })).toBe('stored');

      expect(commit(db.path, { kind: 'failed', reason: 'timeout' })).toBe('already-recorded');

      expect(storedRowCount(db.path)).toBe(1);
      const pair = read(db.path);
      expect(pair.pri.kind).toBe('ok');
      if (pair.pri.kind !== 'ok') throw new Error('unreachable');
      expect(pair.pri.createdAt).toBe(1_700);
    } finally {
      db.cleanup();
    }
  });

  /**
   * tasks.md 4.11b on the **production write path**: the guard's two arms, the
   * mapping onto `publication`, and the ordering obligation that makes the guard
   * mean anything.
   *
   * The decision itself is proved at the seam it is made in
   * (`libs/domain/src/publication-guard.test.ts`, both mandated fixtures with
   * three mutations). What is proved *here* is that the answer survives to a
   * durable row and back: a floor row storing Fast's own schedule with
   * real-domain values, a solver row keeping the run's quantised ones, and the
   * fact that a row written before the guard runs can never be corrected.
   *
   * **The seat is fixed to `'pri'`** (`reserve`, and the `solver_slot` insert it
   * writes), so every case below is a PRI variant and the primary term is
   * `priority`. That is why 4.11b's second mandated fixture — an equal primary
   * carrying a strictly *better secondary* — lives in the domain file and not
   * here: its shape needs `makespan` as the primary. The arm it exercises, "a
   * tie publishes the solver's schedule", is exercised here on a tie.
   */
  describe('4.11b — the publication guard reaching a durable row', () => {
    /**
     * 2.11's fixture: three serial `days=1, width=5` slices. `durationOf` is
     * `1 / 5`, so real Fast runs 0 → 0.2 → 0.4 → 0.6 while the model the solver
     * sees has every duration rounded up to a whole `SOLVER_QUANTUM` unit — 9.6
     * rounds to 10 — and its optimum is 0, 10, 20 units. Worse in the real
     * domain on BOTH terms: makespan 0.6167 against 0.6, priority 1.225
     * against 1.2.
     */
    function widthFiveInput(): ScheduleInput {
      const rows: PlannedRow[] = ['a', 'b', 'c'].map((id, at) => ({
        id,
        parentId: null,
        position: (at + 1) * 10,
        frozenNumber: null,
        priority: null,
      }));
      const slices: Slice[] = ['a', 'b', 'c'].map((workItemId) => ({
        workItemId,
        stepId: null,
        days: 1,
        personId: null,
        width: 5,
        poolIds: [],
      }));
      return {
        rows,
        edges: [
          { predecessorId: 'a', successorId: 'b' },
          { predecessorId: 'b', successorId: 'c' },
        ],
        slices,
        notBefore: new Map(),
        poolSizes: new Map(),
        reach: 'whole-item',
        deadlines: new Map(),
      };
    }

    const fastOf = (input: ScheduleInput): Schedule =>
      schedule(
        input.rows,
        input.edges,
        input.slices,
        input.notBefore,
        input.poolSizes,
        input.reach,
      );

    const quantisedOptimumOf = (input: ScheduleInput): Schedule =>
      schedule(
        input.rows,
        input.edges,
        input.slices,
        input.notBefore,
        input.poolSizes,
        input.reach,
        // **`deadlines` is the seventh argument and `pinnedStarts` the eighth.**
        // This map is pinned starts, and it was passed positionally as the
        // seventh when `deadlines` arrived in front of it (tasks.md 4.1), which
        // is why the empty map here is load-bearing rather than noise: the
        // starts landed in `deadlines` instead, keyed by slice key where that
        // argument is keyed by work item id, so the fold matched nothing, no
        // start was ever pinned, and `quantisedOptimumOf` returned Fast's own
        // schedule. Both sides of the guard then scored the same plan and it
        // chose `optimized` — the two `4.11b` cases below went red at
        // `e0f5bd84` and were found at `371f68c5`, having been red the whole
        // time in between. `libs/domain/src/publication-guard.test.ts` holds the
        // same fixture and was moved to eight arguments with the seam; this
        // copy was not, and a positional seventh argument is silent about it.
        new Map(),
        new Map([
          [sliceKey('a', null), 0 / SOLVER_QUANTUM],
          [sliceKey('b', null), 10 / SOLVER_QUANTUM],
          [sliceKey('c', null), 20 / SOLVER_QUANTUM],
        ]),
      );

    const UNWEIGHTED = () => 1;
    const NO_MOVEMENT = () => 0;

    /** What the run itself reported, in the solver's own integer units. */
    const REPORTED: Readonly<Record<'makespan' | 'priority' | 'movement', StoredObjectiveValue>> = {
      makespan: { value: 30, stageValue: 30, bound: 30, status: 'optimal' },
      priority: { value: 60, stageValue: 60, bound: 60, status: 'optimal' },
      movement: { value: 0, stageValue: null, bound: null, status: 'unknown' },
    };

    it('stores Fast own schedule as a quantisation-floor row when the solver lost to quantisation', () => {
      const db = tempDb();
      try {
        admitted(db.path);
        const input = widthFiveInput();
        const decision = guardRealPublication(
          input,
          quantisedOptimumOf(input),
          'priority',
          UNWEIGHTED,
          NO_MOVEMENT,
        );
        expect(decision.chosen).toBe('baseline');

        const result = publishOptimizedResult(decision, REPORTED);
        expect(commit(db.path, { kind: 'ok', result })).toBe('stored');

        const pair = read(db.path);
        if (pair.pri.kind !== 'ok') throw new Error('the floor row did not read back as ok');
        const stored = pair.pri.result;

        expect(stored.publication).toBe('quantisation-floor');
        // The stored plan IS Fast's, not the solver's. A floor row presented as a
        // solver win is exactly what `publication` is stored rather than
        // inferred to prevent.
        expect(stored.schedule).toEqual(fastOf(input));
        // Every value recomputed in the real domain, on the schedule stored —
        // asserted against the scorer rather than against a literal, because
        // 0.2 + 0.2 + 0.2 !== 0.6 in IEEE-754.
        const rescored = scoreReal(stored.schedule, UNWEIGHTED, NO_MOVEMENT);
        expect(stored.objectiveValues.makespan.value).toBe(rescored.makespan);
        expect(stored.objectiveValues.priority.value).toBe(rescored.priority);
        expect(stored.objectiveValues.movement.value).toBe(rescored.movement);
        // Fractional by construction, which is why 4.12b's numeric domain is
        // per-publication: the safe-integer rule would have rejected this row.
        expect(Number.isSafeInteger(stored.objectiveValues.priority.value)).toBe(false);
        // No stage produced these numbers.
        for (const term of ['makespan', 'priority', 'movement'] as const) {
          expect(stored.objectiveValues[term].stageValue).toBeNull();
          expect(stored.objectiveValues[term].bound).toBeNull();
          expect(stored.objectiveValues[term].status).toBe('unknown');
        }
      } finally {
        db.cleanup();
      }
    });

    it('keeps the run own quantised numbers on a solver row when the primary ties', () => {
      const db = tempDb();
      try {
        admitted(db.path);
        const input = widthFiveInput();
        // Fast scored against itself: the primary ties exactly, and a tie
        // publishes the solver's schedule.
        const decision = guardRealPublication(
          input,
          fastOf(input),
          'priority',
          UNWEIGHTED,
          NO_MOVEMENT,
        );
        expect(decision.chosen).toBe('optimized');

        expect(
          commit(db.path, { kind: 'ok', result: publishOptimizedResult(decision, REPORTED) }),
        ).toBe('stored');

        const pair = read(db.path);
        if (pair.pri.kind !== 'ok') throw new Error('the solver row did not read back as ok');
        expect(pair.pri.result.publication).toBe('solver');
        // The guard's real-domain scores measured the comparison; they are not
        // what the run reported, and a solver row carries the report.
        expect(pair.pri.result.objectiveValues).toEqual(REPORTED);
      } finally {
        db.cleanup();
      }
    });

    /**
     * The item's third watched red: **move the guard after the cache write and
     * (i) fails with a `'solver'` row already durable.**
     *
     * This is the case that makes "before any cache write" a rule rather than a
     * preference. `storeOptimizedOutcome` is not an upsert — `onConflictDoNothing`
     * over a primary key that excludes `generation` — so the first write wins
     * permanently, and a guard that ran afterwards would have nothing to correct.
     */
    it('cannot correct a solver row written before the guard ran', () => {
      const db = tempDb();
      try {
        admitted(db.path);
        const input = widthFiveInput();
        const unguarded: OptimizedResult = {
          publication: 'solver',
          objectiveValues: REPORTED,
          schedule: quantisedOptimumOf(input),
        };

        expect(commit(db.path, { kind: 'ok', result: unguarded })).toBe('stored');

        // The guard now runs and says "substitute Fast" — too late.
        const decision = guardRealPublication(
          input,
          quantisedOptimumOf(input),
          'priority',
          UNWEIGHTED,
          NO_MOVEMENT,
        );
        expect(decision.chosen).toBe('baseline');
        expect(
          commit(db.path, { kind: 'ok', result: publishOptimizedResult(decision, REPORTED) }),
        ).toBe('already-recorded');

        const pair = read(db.path);
        if (pair.pri.kind !== 'ok') throw new Error('the durable row did not read back as ok');
        // Still the worse schedule, still tagged as a solver win.
        expect(pair.pri.result.publication).toBe('solver');
        expect(pair.pri.result.schedule).toEqual(quantisedOptimumOf(input));
        expect(pair.pri.result.schedule).not.toEqual(fastOf(input));
      } finally {
        db.cleanup();
      }
    });
  });
});

describe("4.1b's retention bound, which is a bound and not an exclusion", () => {
  const CLAIM = {
    projectId: 'p-1',
    contractVersion: CONTRACT,
    generation: 1,
    objective: 'pri',
    budgetMs: BUDGET,
    ownerId: 'coordinator-a',
    attemptToken: 'tok-1',
  } as const;

  /** One seat per budget, because the slot's primary key carries `budgetMs`. */
  function reserve(path: string, budgetMs: number, contractVersion = CONTRACT): void {
    const db = openDatabase(path);
    try {
      db.run(
        // OR REPLACE, because proof (b) below re-takes the seat every time a
        // read asks for a solve — under the mutation that is nine more times,
        // and a primary-key conflict there would fail the case for the wrong
        // reason.
        `INSERT OR REPLACE INTO solver_slot
           (project_id, contract_version, generation, objective, budget_ms,
            owner_id, attempt_token, lifecycle, pid, started_at, heartbeat_at,
            cancel_requested_at, admitted_deadline_at)
         VALUES ('p-1', '${contractVersion}', 1, 'pri', ${String(budgetMs)},
                 'coordinator-a', 'tok-1', 'running', 4242, 1, 1, NULL, 99)`,
      );
    } finally {
      db.close();
    }
  }

  function enable(path: string): void {
    const db = openDatabase(path);
    try {
      db.run(`UPDATE project SET optimization_enabled = 1 WHERE id = 'p-1'`);
    } finally {
      db.close();
    }
  }

  function commit(
    path: string,
    budgetMs: number,
    now: number,
    contractVersion = CONTRACT,
  ): OutcomeWriteResult {
    return storeOptimizedOutcome(openDrizzle(path), {
      claim: { ...CLAIM, budgetMs, contractVersion },
      inputHash: HASH,
      admittedCancelEpoch: 0,
      outcome: { kind: 'failed', reason: 'timeout' },
      now,
    });
  }

  /** Every stored `(contract_version, budget_ms)` for the one objective. */
  function liveBudgets(path: string): { contract: string; budget: number }[] {
    const db = openDatabase(path);
    try {
      return (
        db
          .query(
            `SELECT contract_version AS contract, budget_ms AS budget
               FROM optimized_schedule_cache WHERE objective = 'pri'
              ORDER BY contract_version, budget_ms`,
          )
          .all() as { contract: string; budget: number }[]
      ).map((row) => ({ contract: row.contract, budget: row.budget }));
    } finally {
      db.close();
    }
  }

  /**
   * 4.1b proof (a): raise `budgetMs` three times and bump `contractVersion`
   * with no plan edit at all — same project, same objective, same input hash —
   * and at most two rows survive per project per objective per live contract
   * version. The bound is per contract version, so the bumped release's own
   * row is *not* evicted by the old one's: that is the blue/green half.
   */
  it('keeps two budgets per live contract version and evicts the oldest', () => {
    const db = tempDb();
    try {
      prepared(db.path);
      enable(db.path);

      for (const [budget, at] of [
        [60_000, 10],
        [90_000, 20],
        [120_000, 30],
      ] as const) {
        reserve(db.path, budget);
        expect(commit(db.path, budget, at)).toBe('stored');
      }

      // The bumped release, sharing the file and the plan.
      const green = '8+1.0.0';
      allocateGeneration(openDrizzle(db.path), 'p-1', green, HASH, 40);
      reserve(db.path, 60_000, green);
      expect(commit(db.path, 60_000, 50, green)).toBe('stored');

      // Ordered by `contract_version` then `budget_ms`, so blue's two rows
      // come first: '7+1.0.0' sorts before '8+1.0.0'.
      expect(liveBudgets(db.path)).toEqual([
        { contract: CONTRACT, budget: 90_000 },
        { contract: CONTRACT, budget: 120_000 },
        { contract: green, budget: 60_000 },
      ]);
    } finally {
      db.cleanup();
    }
  });

  /**
   * The livelock the exclusive rule caused, as the state that used to be
   * impossible: two budgets under ONE contract version both survive, so
   * neither release deletes the other's row and neither re-solves.
   */
  it('lets two releases reading different budgets keep a row each', () => {
    const db = tempDb();
    try {
      prepared(db.path);
      enable(db.path);
      reserve(db.path, 60_000);
      expect(commit(db.path, 60_000, 10)).toBe('stored');
      reserve(db.path, 120_000);
      expect(commit(db.path, 120_000, 20)).toBe('stored');

      expect(liveBudgets(db.path)).toEqual([
        { contract: CONTRACT, budget: 60_000 },
        { contract: CONTRACT, budget: 120_000 },
      ]);
      // And both are servable, which is what makes the spawn count stop rising.
      expect(read(db.path, { ...KEY, budgetMs: 60_000 }).pri.kind).toBe('failed');
      expect(read(db.path, { ...KEY, budgetMs: 120_000 }).pri.kind).toBe('failed');
    } finally {
      db.cleanup();
    }
  });

  /** The same write with a servable payload, which is what proof (b) needs. */
  function commitOk(path: string, budgetMs: number, now: number): OutcomeWriteResult {
    return storeOptimizedOutcome(openDrizzle(path), {
      claim: { ...CLAIM, budgetMs },
      inputHash: HASH,
      admittedCancelEpoch: 0,
      outcome: { kind: 'ok', result: solverResult(realPlan()) },
      now,
    });
  }

  /**
   * 4.1b proof (b), which waited on 4.2's spawner and now has it.
   *
   * Two releases read the same file at different budgets, alternating, ten
   * times. Each asks for a solve on its own first read and never again: **two
   * calls on the spawner, in ten reads.** The rows are `ok` here rather than
   * `failed` — the case is vacuous otherwise, because a `failed` row suppresses
   * an auto-spawn all by itself (4.4) and the count would be two whether the
   * rows survived or not.
   *
   * The loop stores the outcome whenever a read asks for one, which is what a
   * coordinator does; so the spawn count IS the solve count, and under the
   * exclusive rule this replaced it rises with the reads rather than stopping
   * at two.
   */
  it('sees exactly two solves across ten alternating reads by two releases', () => {
    const db = tempDb();
    try {
      prepared(db.path);
      enable(db.path);

      const budgets = [60_000, 120_000];
      const asked: number[] = [];
      for (let round = 0; round < 10; round += 1) {
        const budgetMs = budgets[round % budgets.length];
        const release = recorder();
        readAndSpawn(db.path, release.spawn, { ...KEY, budgetMs });
        // `time` never commits here, so ignore it and follow the one objective
        // the bound is scoped to.
        if (release.calls.some((call) => call.objective === 'pri')) {
          asked.push(budgetMs);
          reserve(db.path, budgetMs);
          expect(commitOk(db.path, budgetMs, 100 + round)).toBe('stored');
        }
      }

      expect(asked).toEqual([60_000, 120_000]);
      expect(liveBudgets(db.path)).toEqual([
        { contract: CONTRACT, budget: 60_000 },
        { contract: CONTRACT, budget: 120_000 },
      ]);
      // Both releases end on a hit, which is the state the bound buys.
      expect(read(db.path, { ...KEY, budgetMs: 60_000 }).pri.kind).toBe('ok');
      expect(read(db.path, { ...KEY, budgetMs: 120_000 }).pri.kind).toBe('ok');
    } finally {
      db.cleanup();
    }
  });
});

/**
 * tasks.md 4.2's injected spawner — the seam 4.1b(b), 4.4 and 4.6 all wait on.
 *
 * Every case here asserts on the recorded calls rather than on elapsed time or
 * on a row appearing, which is what 4.2 asks for in as many words. A test that
 * waited would be a test that passes on a slow machine and on a broken one.
 */
describe("4.2's injected spawner, asserted on the calls and not on the clock", () => {
  function storeOk(path: string, generation: number, objective: 'pri' | 'time'): void {
    storeRow(path, {
      objective,
      generation,
      status: 'ok',
      resultJson: JSON.stringify(encodeOptimizedResult(solverResult(realPlan()))),
      failureReason: null,
    });
  }

  it('spawns nothing when the same input is already stored for both objectives', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      storeOk(db.path, generation, 'pri');
      storeOk(db.path, generation, 'time');

      const { spawn, calls } = recorder();
      const pair = readAndSpawn(db.path, spawn);

      expect(calls).toEqual([]);
      expect(pair.pri.kind).toBe('ok');
      expect(pair.time.kind).toBe('ok');
    } finally {
      db.cleanup();
    }
  });

  /**
   * A cold key asks for both, in the stored vocabulary's order, and each
   * request carries the key the read actually ran against — not a rebuilt one.
   * `budgetMs` is the column that proves it: a spawner handed the project and
   * the objective alone could not tell which of two live budgets asked.
   */
  it('asks for both objectives on a cold key, carrying the key it read', () => {
    const db = tempDb();
    try {
      prepared(db.path);

      const { spawn, calls } = recorder();
      const pair = readAndSpawn(db.path, spawn);

      expect(calls).toEqual([
        { key: KEY, objective: 'pri' },
        { key: KEY, objective: 'time' },
      ]);
      expect(pair.pri).toEqual({ kind: 'miss' });
      expect(pair.time).toEqual({ kind: 'miss' });
    } finally {
      db.cleanup();
    }
  });

  it('asks for exactly the objective that has no row when the other has committed', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      storeOk(db.path, generation, 'pri');

      const { spawn, calls } = recorder();
      readAndSpawn(db.path, spawn);

      expect(calls.map((call) => call.objective)).toEqual(['time']);
    } finally {
      db.cleanup();
    }
  });

  /**
   * 4.2's raised-budget miss, asserted on the spawner instead of on the pair.
   * The stored 60 s row is not served to a release configured for 120 s, and
   * the difference is visible as a solve being asked for rather than only as a
   * `miss` in a return value nobody had to act on.
   */
  it('asks again for a raised budget rather than serving the smaller-budget row', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      storeOk(db.path, generation, 'pri');
      storeOk(db.path, generation, 'time');

      const hit = recorder();
      readAndSpawn(db.path, hit.spawn);
      const raised = recorder();
      readAndSpawn(db.path, raised.spawn, { ...KEY, budgetMs: 120_000 });

      expect(hit.calls).toEqual([]);
      expect(raised.calls.map((call) => call.objective)).toEqual(['pri', 'time']);
      expect(raised.calls.every((call) => call.key.budgetMs === 120_000)).toBe(true);
      // The 60 s rows are still there — 4.1b's bound evicts, a read never does.
      expect(storedRowCount(db.path)).toBe(2);
    } finally {
      db.cleanup();
    }
  });

  /**
   * The policy 4.4 and 4.8 rest on, at the layer that decides it: an answer
   * about the solve (`failed`) and a defect in the row (`corrupt`) are both
   * answers this key already has, so neither auto-spawns. 4.4's ten-read and
   * Retry arms and 4.5's watched red are separately numbered; what is settled
   * here is that a read of either state asks for nothing.
   */
  it('asks for nothing against a failed row or a corrupt one', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      storeRow(db.path, {
        objective: 'pri',
        generation,
        status: 'failed',
        resultJson: null,
        failureReason: 'timeout',
      });
      storeRow(db.path, {
        objective: 'time',
        generation,
        status: 'ok',
        resultJson: '{"dtoVersion":',
        failureReason: null,
      });

      const { spawn, calls } = recorder();
      const pair = readAndSpawn(db.path, spawn);

      expect(pair.pri.kind).toBe('failed');
      expect(pair.time.kind).toBe('corrupt');
      expect(calls).toEqual([]);
      // Neither row was deleted on the way past (4.8).
      expect(storedRowCount(db.path)).toBe(2);
    } finally {
      db.cleanup();
    }
  });

  /**
   * 4.2's eviction half, and the honest reading of "a failed row is overwritten
   * by the next run for that key". Nothing UPDATEs it: the primary key omits
   * `generation` and 4.1's insert is `onConflictDoNothing`, so the replacement
   * path is `allocateGeneration`'s delete and nothing else. A changed input
   * allocates, the prior rows go — `failed` ones included, because the delete
   * is scoped by project and contract version and says nothing about status —
   * and a read of the old hash asks for both objectives again.
   */
  it('clears every prior row for the project when a generation is allocated, failed ones included', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      storeOk(db.path, generation, 'pri');
      storeRow(db.path, {
        objective: 'time',
        generation,
        status: 'failed',
        resultJson: null,
        failureReason: 'timeout',
      });
      expect(storedRowCount(db.path)).toBe(2);

      const settled = recorder();
      readAndSpawn(db.path, settled.spawn);
      allocateGeneration(openDrizzle(db.path), 'p-1', CONTRACT, 'h2', 2);

      const after = recorder();
      const pair = readAndSpawn(db.path, after.spawn);

      // The settled pair asked for nothing: `ok` is an answer and so is `failed`.
      expect(settled.calls).toEqual([]);
      expect(storedRowCount(db.path)).toBe(0);
      expect(pair.pri).toEqual({ kind: 'miss' });
      expect(pair.time).toEqual({ kind: 'miss' });
      expect(after.calls.map((call) => call.objective)).toEqual(['pri', 'time']);
    } finally {
      db.cleanup();
    }
  });

  /**
   * 4.2's undo. Editing to a second hash and undoing back to the first leaves
   * the original key looking untouched, and it is not: the answer computed for
   * it was cleared by the edit's own allocation, and the intermediate answer
   * belongs to a hash nobody is asking about. Both read as a miss and both are
   * asked for, which is the only correct behaviour — the plan is back where it
   * was, but no solve for it survives.
   */
  it('misses an undo to a previous hash and asks for both again', () => {
    const db = tempDb();
    try {
      const first = prepared(db.path);
      storeOk(db.path, first, 'pri');
      storeOk(db.path, first, 'time');

      const edited = allocateGeneration(openDrizzle(db.path), 'p-1', CONTRACT, 'h2', 2);
      storeRow(db.path, {
        objective: 'pri',
        generation: edited,
        status: 'ok',
        resultJson: JSON.stringify(encodeOptimizedResult(solverResult(realPlan()))),
        failureReason: null,
        inputHash: 'h2',
      });
      const undone = allocateGeneration(openDrizzle(db.path), 'p-1', CONTRACT, HASH, 3);
      expect(undone).toBeGreaterThan(edited);

      const back = recorder();
      const pair = readAndSpawn(db.path, back.spawn);

      expect(storedRowCount(db.path)).toBe(0);
      expect(pair.pri).toEqual({ kind: 'miss' });
      expect(pair.time).toEqual({ kind: 'miss' });
      expect(back.calls.map((call) => call.objective)).toEqual(['pri', 'time']);
      // And the hash it was edited to is not served either.
      const intermediate = recorder();
      const other = readAndSpawn(db.path, intermediate.spawn, { ...KEY, inputHash: 'h2' });
      expect(other.pri).toEqual({ kind: 'miss' });
      expect(intermediate.calls.map((call) => call.objective)).toEqual(['pri', 'time']);
    } finally {
      db.cleanup();
    }
  });

  /**
   * The delete's scope, proved through the spawner rather than through a row
   * count: allocating for green must not clear blue's answer, or the two
   * releases evict each other on every deploy and each re-solves for ever —
   * the livelock 4.1b's bound exists to prevent, reached through rule 1 instead
   * of rule 2. Blue still hits, and a hit spawns nothing.
   *
   * The two allocations are load-bearing and were added after the first version
   * of this case survived its own mutation: generations are per contract
   * version, so green's first allocation is number 1 and its delete of
   * everything below 1 reaches nothing at all. With one allocation the case
   * passes whether or not the delete carries `contractVersion`, which is a case
   * that asserts a true fact and discriminates nothing.
   */
  it("leaves another contract version's rows alone, so the other release still hits", () => {
    const db = tempDb();
    try {
      const blue = prepared(db.path);
      storeOk(db.path, blue, 'pri');
      storeOk(db.path, blue, 'time');

      const green = { ...KEY, contractVersion: '8+1.0.0' };
      const cold = recorder();
      readAndSpawn(db.path, cold.spawn, green);
      // Green allocates TWICE — deploy, then an edit. Its first allocation is
      // generation 1 and deletes rows below 1, which is nothing whatever the
      // predicate says; only the second one can reach blue's generation-1 rows,
      // so this is the sequence that discriminates the scope rather than one
      // that merely holds under it.
      allocateGeneration(openDrizzle(db.path), 'p-1', green.contractVersion, HASH, 2);
      const second = allocateGeneration(
        openDrizzle(db.path),
        'p-1',
        green.contractVersion,
        'h2',
        3,
      );
      expect(second).toBe(2);

      const stillBlue = recorder();
      const pair = readAndSpawn(db.path, stillBlue.spawn);

      expect(cold.calls.map((call) => call.objective)).toEqual(['pri', 'time']);
      expect(stillBlue.calls).toEqual([]);
      expect(pair.pri.kind).toBe('ok');
      expect(pair.time.kind).toBe('ok');
      expect(storedRowCount(db.path)).toBe(2);
    } finally {
      db.cleanup();
    }
  });

  /**
   * tasks.md 4.4's first two arms. A failed key is read over and over — three
   * collaborators with a project open, refreshing — and asks for nothing every
   * time, because the marker IS the suppression. An edit that leaves the
   * canonical input unchanged (a rename, a reordered field) produces the same
   * hash and therefore the same key, so it is one more of those reads and not a
   * new event; there is nothing for it to spawn.
   *
   * Every read gets its OWN spawner here rather than sharing one recorder, so a
   * total of zero is zero per collaborator and not a total that happens to
   * cancel out.
   *
   * tasks.md 4.5's negative check. `Proof:` the restored branch is
   * `objectivesToAutoSpawn` in `optimized-schedule-cache.ts` — with its
   * predicate widened from `kind === 'miss'` back to `kind !== 'ok'`, which is
   * `failed` and `corrupt` rejoining the auto-spawn set, this case fails on ten
   * reads each asking for `time`. Watched on h2puni at `f1ed862c`: 44 pass /
   * 4 fail against a 48 / 0 baseline, script `/home/puni1/mut44-r37.sh`. The
   * other three that redden all read a settled non-`ok` row and count its
   * spawns, so the widening cannot be made to look local to one case.
   *
   * Why it is guarded: every read of a settled failure becoming a re-solve is
   * the timer retry Dany rejected, arriving through the cache instead of the
   * clock — and it arrives once per open tab, which is worse than a timer.
   */
  it('spawns nothing across ten reads by three collaborators against a failed key', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      storeOk(db.path, generation, 'pri');
      storeRow(db.path, {
        objective: 'time',
        generation,
        status: 'failed',
        resultJson: null,
        failureReason: 'timeout',
      });

      const perRead: SpawnRequest[][] = [];
      for (let read = 0; read < 10; read += 1) {
        const collaborator = recorder();
        const pair = readAndSpawn(db.path, collaborator.spawn);
        expect(pair.time.kind).toBe('failed');
        perRead.push(collaborator.calls);
      }

      expect(perRead).toHaveLength(10);
      expect(perRead.every((calls) => calls.length === 0)).toBe(true);
      // The same-hash edit: a different action, the same key, and so the
      // eleventh read of a settled failure rather than a new one.
      const afterEdit = recorder();
      readAndSpawn(db.path, afterEdit.spawn);
      expect(afterEdit.calls).toEqual([]);
      expect(storedRowCount(db.path)).toBe(2);
    } finally {
      db.cleanup();
    }
  });

  /**
   * tasks.md 8.7's "never auto-respawned", which is the same guard as 4.5 on
   * the seventh state and needs its own case for one reason: `failed` and
   * `corrupt` are engine faults that a later release might legitimately want to
   * retry, while `plan-infeasible` is a **correct answer about the user's own
   * dates**. Re-solving it cannot change anything until a deadline is edited,
   * and editing one moves the input hash and therefore the key — so an
   * auto-respawn here is a solver process burned, once per open tab, to be told
   * the same thing.
   *
   * `Proof:` the restored branch is `objectivesToAutoSpawn` in
   * `optimized-schedule-cache.ts`, predicate widened from `kind === 'miss'`
   * back to `kind !== 'ok'`. The certificate is asserted on every read as well
   * as counted, so the case cannot pass by reading the row as `corrupt` and
   * happening to spawn nothing for a different reason.
   */
  it('spawns nothing across ten reads against a plan-infeasible key, and keeps the row', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      storeOk(db.path, generation, 'pri');
      storeRow(db.path, {
        objective: 'time',
        generation,
        status: 'plan-infeasible',
        resultJson: JSON.stringify({
          dtoVersion: 1,
          items: [
            { ownerWorkItemId: 'parent', boundWorkItemId: 'leaf', effectiveDeadlineOffset: 5 },
          ],
        }),
        failureReason: null,
      });

      const perRead: SpawnRequest[][] = [];
      for (let read = 0; read < 10; read += 1) {
        const collaborator = recorder();
        const pair = readAndSpawn(db.path, collaborator.spawn);
        expect(pair.time.kind).toBe('plan-infeasible');
        if (pair.time.kind !== 'plan-infeasible') throw new Error('unreachable');
        expect(pair.time.certificate.items).toEqual([
          { ownerWorkItemId: 'parent', boundWorkItemId: 'leaf', effectiveDeadlineOffset: 5 },
        ]);
        perRead.push(collaborator.calls);
      }

      expect(perRead.every((calls) => calls.length === 0)).toBe(true);
      expect(storedRowCount(db.path)).toBe(2);
    } finally {
      db.cleanup();
    }
  });

  /**
   * 4.8's second watched red, from the reading side: ten reads against a
   * corrupt key spawn nothing and the row is still there afterwards, and one
   * Retry asks for exactly one child. The delete-and-miss behaviour this
   * replaced would fail the first half on every read — corruption becoming a
   * read-triggered solve is the timer retry Dany rejected, arriving through the
   * cache instead of the clock, and it would destroy the evidence of the defect
   * at the moment it was found.
   */
  it('spawns nothing across ten reads of a corrupt row, and one Retry asks once', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      storeOk(db.path, generation, 'time');
      storeRow(db.path, {
        objective: 'pri',
        generation,
        status: 'ok',
        resultJson: JSON.stringify({ dtoVersion: RESULT_DTO_VERSION + 99 }),
        failureReason: null,
      });

      for (let round = 0; round < 10; round += 1) {
        const reader = recorder();
        const pair = readAndSpawn(db.path, reader.spawn);
        expect(pair.pri.kind).toBe('corrupt');
        expect(reader.calls).toEqual([]);
      }
      expect(storedRowCount(db.path)).toBe(2);

      const retry = recorder();
      retryOptimizedPair(openDrizzle(db.path), KEY, retry.spawn);
      expect(retry.calls.map((call) => call.objective)).toEqual(['pri']);
      expect(storedRowCount(db.path)).toBe(2);
    } finally {
      db.cleanup();
    }
  });

  /**
   * 4.4's third arm. A Retry is a different entry point rather than a flag,
   * so the suppression above is a property of which function the caller
   * reached for. It asks for exactly the objectives with no answer to serve —
   * here the failed one and not the committed one — which is why "exactly one"
   * and not "both".
   */
  it('asks for exactly the failed objective on an explicit Retry, and leaves the ok one alone', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      storeOk(db.path, generation, 'pri');
      storeRow(db.path, {
        objective: 'time',
        generation,
        status: 'failed',
        resultJson: null,
        failureReason: 'timeout',
      });

      const retry = recorder();
      const pair = retryOptimizedPair(openDrizzle(db.path), KEY, retry.spawn);

      expect(retry.calls).toEqual([{ key: KEY, objective: 'time' }]);
      // A Retry reads; it does not write, evict or resurrect.
      expect(pair.pri.kind).toBe('ok');
      expect(pair.time.kind).toBe('failed');
      expect(storedRowCount(db.path)).toBe(2);
    } finally {
      db.cleanup();
    }
  });

  /** A Retry against a corrupt row asks too — 4.8's row is kept, not abandoned. */
  it('asks for a corrupt objective on a Retry while an automatic read does not', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      storeRow(db.path, {
        objective: 'pri',
        generation,
        status: 'ok',
        resultJson: '{"dtoVersion":',
        failureReason: null,
      });
      storeOk(db.path, generation, 'time');

      const automatic = recorder();
      readAndSpawn(db.path, automatic.spawn);
      const retry = recorder();
      retryOptimizedPair(openDrizzle(db.path), KEY, retry.spawn);

      expect(automatic.calls).toEqual([]);
      expect(retry.calls.map((call) => call.objective)).toEqual(['pri']);
      expect(storedRowCount(db.path)).toBe(2);
    } finally {
      db.cleanup();
    }
  });

  /**
   * 4.4's last arm: the marker suppresses its own key and nothing else. A new
   * hash allocates a generation, that allocation clears the failed row with
   * everything else, and the read for the new plan asks for the normal pair.
   */
  it("does not let a failed key suppress a new hash's generation", () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      storeRow(db.path, {
        objective: 'pri',
        generation,
        status: 'failed',
        resultJson: null,
        failureReason: 'no-solution',
      });

      allocateGeneration(openDrizzle(db.path), 'p-1', CONTRACT, 'h2', 2);
      const edited = recorder();
      const pair = readAndSpawn(db.path, edited.spawn, { ...KEY, inputHash: 'h2' });

      expect(edited.calls.map((call) => call.objective)).toEqual(['pri', 'time']);
      expect(edited.calls.every((call) => call.key.inputHash === 'h2')).toBe(true);
      expect(pair.pri).toEqual({ kind: 'miss' });
      expect(storedRowCount(db.path)).toBe(0);
    } finally {
      db.cleanup();
    }
  });
});

/**
 * The plan read's own input, and the hash the adapter keys on.
 *
 * Built from {@link realPlan}'s rows and slices so the stored schedule and the
 * key it is stored under describe one plan; a fixture whose hash was taken over
 * a different shape would make the miss cases pass for the wrong reason.
 */
function planInput(): ScheduleInput {
  const rows: PlannedRow[] = ['a', 'b', 'c'].map((id, at) => ({
    id,
    parentId: null,
    position: (at + 1) * 10,
    frozenNumber: null,
    priority: null,
  }));
  const slices: Slice[] = ['a', 'b', 'c'].map((workItemId) => ({
    workItemId,
    stepId: 'step-dev',
    days: 2,
    personId: null,
    width: 1,
    poolIds: ['team-platform'],
  }));
  return {
    rows,
    edges: [],
    slices,
    notBefore: new Map(),
    poolSizes: new Map([['team-platform', 1]]),
    reach: 'whole-item',
    deadlines: new Map(),
  };
}

describe('the adapter a plan read asks', () => {
  it('serves the published objective’s stored schedule, keyed on the plan it was given', () => {
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      const plan = realPlan();
      const input = planInput();
      storeRow(db.path, {
        objective: 'pri',
        generation,
        status: 'ok',
        resultJson: JSON.stringify(encodeOptimizedResult(solverResult(plan))),
        failureReason: null,
        inputHash: scheduleInputHash(input),
      });
      const read = publishedScheduleReaderOf(openDrizzle(db.path), {
        contractVersion: CONTRACT,
        budgetMs: BUDGET,
      });
      const served = read({ projectId: 'p-1', objective: 'pri', input });
      // Load-bearing: over an empty plan the comparison below is vacuous.
      expect(plan.slices.size).toBe(3);
      expect(served === null ? null : encodeSchedule(served)).toEqual(encodeSchedule(plan));
    } finally {
      db.cleanup();
    }
  });

  it('answers nothing for the objective that is not the published one', () => {
    // The pair holds two rows and a project publishes one of them. Reading the
    // other would show a planner the schedule of an objective they did not pick.
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      const input = planInput();
      storeRow(db.path, {
        objective: 'pri',
        generation,
        status: 'ok',
        resultJson: JSON.stringify(encodeOptimizedResult(solverResult(realPlan()))),
        failureReason: null,
        inputHash: scheduleInputHash(input),
      });
      const read = publishedScheduleReaderOf(openDrizzle(db.path), {
        contractVersion: CONTRACT,
        budgetMs: BUDGET,
      });
      expect(read({ projectId: 'p-1', objective: 'time', input })).toBeNull();
    } finally {
      db.cleanup();
    }
  });

  it('answers nothing for a failed row, a corrupt payload and a plan nothing was stored for', () => {
    // The three misses are the whole content of this case, and the obvious
    // mutation is NOT its watched red — measured, not argued. Replacing
    // `outcome.kind === 'ok' ? outcome.result.schedule : null` with
    // `outcome.result?.schedule ?? null` leaves all 57 green, because no
    // non-`ok` outcome carries a `result` at all: the two forms are equivalent
    // over every state 4.1's decoder can produce, and the `kind` test is chosen
    // for saying so out loud rather than for being the only thing that works.
    // The reds this case does have are M4 (a fixed `inputHash`, which reddens
    // the serving case) and M6 (`pair.pri` for the asked objective, which
    // reddens the case above). Watched 2026-09-04.
    const db = tempDb();
    try {
      const generation = prepared(db.path);
      const input = planInput();
      storeRow(db.path, {
        objective: 'pri',
        generation,
        status: 'failed',
        resultJson: null,
        failureReason: 'timeout',
        inputHash: scheduleInputHash(input),
      });
      storeRow(db.path, {
        objective: 'time',
        generation,
        status: 'ok',
        resultJson: '{"dtoVersion":1}',
        failureReason: null,
        inputHash: scheduleInputHash(input),
      });
      const read = publishedScheduleReaderOf(openDrizzle(db.path), {
        contractVersion: CONTRACT,
        budgetMs: BUDGET,
      });
      // The same rows and the same slice keys, two days longer each. A plan that
      // differed by SHAPE would be refused by the canonicaliser before it could
      // be hashed — `groupSlicesByLeaf` throws on a slice whose work item is not
      // a row — so the miss below is proved on plan CONTENT, which is the fact
      // the `inputHash` column is there to fence.
      const otherPlan: ScheduleInput = {
        ...input,
        slices: input.slices.map((each) => ({ ...each, days: 4 })),
      };
      expect([
        read({ projectId: 'p-1', objective: 'pri', input }),
        read({ projectId: 'p-1', objective: 'time', input }),
        read({ projectId: 'p-1', objective: 'pri', input: otherPlan }),
      ]).toEqual([null, null, null]);
      // And the third answer is a miss on the HASH rather than on the project:
      // the same read against the stored plan is not a miss for `time`'s row.
      expect(scheduleInputHash(otherPlan)).not.toBe(scheduleInputHash(input));
    } finally {
      db.cleanup();
    }
  });
});
