import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Project, Step, WriteStamp } from '@wbs/core';
import { workItemRow } from '@wbs/core/testing/work-item-fixture';
import { projectRow } from '@wbs/store-memory/project-fixture';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { ActualRepository } from './actual';
import { openDatabase, openDrizzle } from './db';
import { EstimateRepository } from './estimate';
import { OPEN } from './gate';
import { runMigrations } from './migrate';
import { ProjectRepository } from './project';
import { StepMeasureRepository } from './step-measure';
import { StepProgressRepository } from './step-progress';
import { UserRepository } from './user';
import { WorkItemRepository } from './work-item';

const MIGRATIONS = new URL('../../../../../apps/wbs/be-01/drizzle', import.meta.url).pathname;
const OWNER = 'targeted-owner';
const PROJECT = 'targeted-project';
const FOREIGN_PROJECT = 'targeted-foreign-project';
const STEP = 'targeted-step';
const FOREIGN_STEP = 'targeted-foreign-step';
const ROW = 'targeted-row';
const STAMP: WriteStamp = { at: 1, by: OWNER };

let directory: string;
let path: string;
let estimates: EstimateRepository;
let actuals: ActualRepository;
let progress: StepProgressRepository;
let measures: StepMeasureRepository;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'wbs-targeted-readers-'));
  path = join(directory, 'test.db');
  runMigrations(path, MIGRATIONS);
  const db = openDrizzle(path);
  estimates = new EstimateRepository(db, OPEN);
  actuals = new ActualRepository(db, OPEN);
  progress = new StepProgressRepository(db, OPEN);
  measures = new StepMeasureRepository(db, OPEN);
  await new UserRepository(db, OPEN).create(
    { id: OWNER, username: OWNER, passwordHash: 'x', createdAt: 1 },
    STAMP,
  );
  const project: Project = projectRow({ id: PROJECT, ownerId: OWNER });
  const steps: Step[] = [{ id: STEP, projectId: PROJECT, name: 'Build', position: 10 }];
  await new ProjectRepository(db, OPEN).create(project, steps, STAMP);
  await new WorkItemRepository(db, OPEN).insert(
    workItemRow({ id: ROW, projectId: PROJECT }),
    [],
    STAMP,
  );
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

async function seedSatellites(): Promise<void> {
  await estimates.set(
    { workItemId: ROW, stepId: STEP, optimistic: 1, realistic: 2, pessimistic: 3 },
    STAMP,
  );
  await actuals.set({ workItemId: ROW, stepId: STEP, days: 1, recordedAt: 1 }, STAMP);
  await progress.set({ workItemId: ROW, stepId: STEP, state: 'in_progress', statedAt: 1 }, STAMP);
  await measures.set(
    {
      workItemId: ROW,
      stepId: STEP,
      metric: 'token_estimate',
      value: 1,
      recordedAt: 1,
    },
    STAMP,
  );
}

function corrupt(statements: readonly string[], ignoreChecks = false): void {
  const sqlite = openDatabase(path);
  try {
    sqlite.run('PRAGMA foreign_keys = OFF');
    if (ignoreChecks) sqlite.run('PRAGMA ignore_check_constraints = ON');
    for (const statement of statements) sqlite.run(statement);
  } finally {
    sqlite.close();
  }
}

describe('targeted SQLite readers reject malformed stored state', () => {
  it('seeks one immediate predecessor instead of aggregating the project prefix', async () => {
    const sqlite = openDatabase(path);
    try {
      sqlite.run(`
        WITH RECURSIVE sequence(n) AS (
          SELECT 0
          UNION ALL
          SELECT n + 1 FROM sequence WHERE n < 9999
        )
        INSERT INTO work_item (id, project_id, position)
        SELECT printf('row-%05d', n), '${PROJECT}', n + 1 FROM sequence
      `);
    } finally {
      sqlite.close();
    }

    const statements: { sql: string; parameters: unknown[] }[] = [];
    const db = openDrizzle(path, {
      logQuery(sql, parameters) {
        statements.push({ sql, parameters });
      },
    });
    const repository = new WorkItemRepository(db, OPEN);
    expect(await repository.listPlacements(PROJECT, ['row-09999'])).toEqual([
      { id: 'row-09999', afterId: 'row-09998' },
    ]);
    const read = statements.at(0);
    if (read === undefined) throw new Error('placement reader emitted no SQL statement');
    const parameters = read.parameters.map((parameter) => {
      if (typeof parameter !== 'string' && typeof parameter !== 'number' && parameter !== null) {
        throw new Error('placement query emitted an unsupported SQLite binding');
      }
      return parameter;
    });
    const explain = openDatabase(path);
    try {
      const opcodes = explain
        .query<{ opcode: string }, (string | number | null)[]>(`EXPLAIN ${read.sql}`)
        .all(...parameters)
        .map(({ opcode }) => opcode);
      // Proof: restoring the self-join/MAX production query adds AggStep and
      // walks the 9,999-row predecessor prefix instead of stopping after one seek.
      expect(opcodes).not.toContain('AggStep');
      expect(opcodes).toContain('SeekLT');
      expect(opcodes).toContain('DecrJumpZero');
    } finally {
      explain.close();
    }
  });

  it('seeks one populated predecessor for each value placement reader', async () => {
    const sqlite = openDatabase(path);
    try {
      sqlite.run(`
        WITH RECURSIVE sequence(n) AS (
          SELECT 0 UNION ALL SELECT n + 1 FROM sequence WHERE n < 9999
        )
        INSERT INTO work_item (id, project_id, position)
        SELECT printf('row-%05d', n), '${PROJECT}', n + 1 FROM sequence
      `);
      sqlite.run(`INSERT INTO estimate (work_item_id, step_id, optimistic, realistic, pessimistic)
        SELECT id, '${STEP}', 1, 2, 3 FROM work_item WHERE id LIKE 'row-%'`);
      sqlite.run(`INSERT INTO actual (work_item_id, step_id, days, recorded_at)
        SELECT id, '${STEP}', 1, 1 FROM work_item WHERE id LIKE 'row-%'`);
      sqlite.run(`INSERT INTO step_progress (work_item_id, step_id, state, stated_at)
        SELECT id, '${STEP}', 'done', 1 FROM work_item WHERE id LIKE 'row-%'`);
      sqlite.run(`INSERT INTO step_measure (work_item_id, step_id, metric, value, recorded_at)
        SELECT id, '${STEP}', 'token_actual', 1, 1 FROM work_item WHERE id LIKE 'row-%'`);
    } finally {
      sqlite.close();
    }

    const statements: { sql: string; parameters: unknown[] }[] = [];
    const db = openDrizzle(path, {
      logQuery: (sql, parameters) => statements.push({ sql, parameters }),
    });
    const repositories = [
      new EstimateRepository(db, OPEN),
      new ActualRepository(db, OPEN),
      new StepProgressRepository(db, OPEN),
      new StepMeasureRepository(db, OPEN),
    ] as const;
    for (const repository of repositories) {
      expect(await repository.listPlacements(PROJECT, ['row-09999'])).toEqual([
        { id: 'row-09999', afterId: 'row-09998' },
      ]);
    }
    expect(statements).toHaveLength(4);
    const explain = openDatabase(path);
    try {
      for (const read of statements) {
        const parameters = read.parameters.map((parameter) => {
          if (
            typeof parameter !== 'string' &&
            typeof parameter !== 'number' &&
            parameter !== null
          ) {
            throw new Error('value placement query emitted an unsupported SQLite binding');
          }
          return parameter;
        });
        const opcodes = explain
          .query<{ opcode: string }, (string | number | null)[]>(`EXPLAIN ${read.sql}`)
          .all(...parameters)
          .map(({ opcode }) => opcode);
        // Proof: replacing the correlated descending seek with MAX adds AggStep
        // and scans the populated 9,999-group prefix before answering one ID.
        expect(opcodes).not.toContain('AggStep');
        expect(opcodes).toContain('SeekLT');
        expect(opcodes).toContain('DecrJumpZero');
      }
    } finally {
      explain.close();
    }
  });

  it('names missing work-item owners in all four families', async () => {
    await seedSatellites();
    corrupt([
      `UPDATE estimate SET work_item_id = 'missing-owner' WHERE work_item_id = '${ROW}'`,
      `UPDATE actual SET work_item_id = 'missing-owner' WHERE work_item_id = '${ROW}'`,
      `UPDATE step_progress SET work_item_id = 'missing-owner' WHERE work_item_id = '${ROW}'`,
      `UPDATE step_measure SET work_item_id = 'missing-owner' WHERE work_item_id = '${ROW}'`,
    ]);

    // Proof: inner joins hid all four missing owners; the left-join readers name them.
    expect(estimates.listByWorkItems(PROJECT, ['missing-owner'])).rejects.toThrow(
      /invalid work-item reference/,
    );
    expect(actuals.listByWorkItems(PROJECT, ['missing-owner'])).rejects.toThrow(
      /invalid work-item reference/,
    );
    expect(progress.listByWorkItems(PROJECT, ['missing-owner'])).rejects.toThrow(
      /invalid work-item reference/,
    );
    expect(measures.listByWorkItems(PROJECT, ['missing-owner'])).rejects.toThrow(
      /invalid work-item reference/,
    );
  });

  it('names missing step references in all four families', async () => {
    await seedSatellites();
    corrupt([
      `UPDATE estimate SET step_id = 'missing-step' WHERE work_item_id = '${ROW}'`,
      `UPDATE actual SET step_id = 'missing-step' WHERE work_item_id = '${ROW}'`,
      `UPDATE step_progress SET step_id = 'missing-step' WHERE work_item_id = '${ROW}'`,
      `UPDATE step_measure SET step_id = 'missing-step' WHERE work_item_id = '${ROW}'`,
    ]);

    // Proof: inner joins hid missing steps; each targeted left join now names its broken row.
    expect(estimates.listByWorkItems(PROJECT, [ROW])).rejects.toThrow(/invalid step reference/);
    expect(actuals.listByWorkItems(PROJECT, [ROW])).rejects.toThrow(/invalid step reference/);
    expect(progress.listByWorkItems(PROJECT, [ROW])).rejects.toThrow(/invalid step reference/);
    expect(measures.listByWorkItems(PROJECT, [ROW])).rejects.toThrow(/invalid step reference/);
  });

  it('names foreign-project step references in all four families', async () => {
    const db = openDrizzle(path);
    await new ProjectRepository(db, OPEN).create(
      projectRow({ id: FOREIGN_PROJECT, ownerId: OWNER }),
      [{ id: FOREIGN_STEP, projectId: FOREIGN_PROJECT, name: 'Foreign', position: 10 }],
      STAMP,
    );
    await seedSatellites();
    corrupt([
      `UPDATE estimate SET step_id = '${FOREIGN_STEP}' WHERE work_item_id = '${ROW}'`,
      `UPDATE actual SET step_id = '${FOREIGN_STEP}' WHERE work_item_id = '${ROW}'`,
      `UPDATE step_progress SET step_id = '${FOREIGN_STEP}' WHERE work_item_id = '${ROW}'`,
      `UPDATE step_measure SET step_id = '${FOREIGN_STEP}' WHERE work_item_id = '${ROW}'`,
    ]);

    // Proof: checking only step existence admitted four references owned by another project.
    expect(estimates.listByWorkItems(PROJECT, [ROW])).rejects.toThrow(/invalid step reference/);
    expect(actuals.listByWorkItems(PROJECT, [ROW])).rejects.toThrow(/invalid step reference/);
    expect(progress.listByWorkItems(PROJECT, [ROW])).rejects.toThrow(/invalid step reference/);
    expect(measures.listByWorkItems(PROJECT, [ROW])).rejects.toThrow(/invalid step reference/);
  });

  it('rejects malformed values representable by SQLite dynamic typing', async () => {
    await seedSatellites();
    corrupt(
      [
        `UPDATE estimate SET optimistic = 'broken' WHERE work_item_id = '${ROW}'`,
        `UPDATE actual SET days = 'broken' WHERE work_item_id = '${ROW}'`,
        `UPDATE step_progress SET state = 'broken' WHERE work_item_id = '${ROW}'`,
        `UPDATE step_measure SET value = 'broken' WHERE work_item_id = '${ROW}'`,
      ],
      true,
    );

    // Proof: unchecked typed projections returned all four malformed values.
    expect(estimates.listByWorkItems(PROJECT, [ROW])).rejects.toThrow(/invalid day value/);
    expect(actuals.listByWorkItems(PROJECT, [ROW])).rejects.toThrow(/invalid day value/);
    expect(progress.listByWorkItems(PROJECT, [ROW])).rejects.toThrow(/invalid state/);
    expect(measures.listByWorkItems(PROJECT, [ROW])).rejects.toThrow(/invalid value/);
  });

  it('rejects malformed measure metrics after constraint-bypassing corruption', async () => {
    await seedSatellites();
    corrupt([`UPDATE step_measure SET metric = 'broken' WHERE work_item_id = '${ROW}'`], true);

    // Proof: without the reader check a constraint-bypassing metric projected as typed state.
    expect(measures.listByWorkItems(PROJECT, [ROW])).rejects.toThrow(/invalid metric/);
  });

  it('rejects non-finite numeric values and timestamps SQLite can store', async () => {
    await seedSatellites();
    corrupt([
      `UPDATE estimate SET pessimistic = 9e999 WHERE work_item_id = '${ROW}'`,
      `UPDATE actual SET recorded_at = 9e999 WHERE work_item_id = '${ROW}'`,
      `UPDATE step_progress SET stated_at = -9e999 WHERE work_item_id = '${ROW}'`,
      `UPDATE step_measure SET recorded_at = 9e999 WHERE work_item_id = '${ROW}'`,
    ]);

    // Proof: without finite-number checks SQLite's infinities reached all four answers.
    expect(estimates.listByWorkItems(PROJECT, [ROW])).rejects.toThrow(/invalid day value/);
    expect(actuals.listByWorkItems(PROJECT, [ROW])).rejects.toThrow(/invalid recorded time/);
    expect(progress.listByWorkItems(PROJECT, [ROW])).rejects.toThrow(/invalid stated time/);
    expect(measures.listByWorkItems(PROJECT, [ROW])).rejects.toThrow(/invalid recorded time/);
  });

  it('records the constraints that prevent malformed closed sets and bound NaN', async () => {
    await seedSatellites();
    const sqlite = openDatabase(path);
    try {
      // Proof: these failures identify schema prevention; they are not reader proofs.
      expect(() =>
        sqlite.run(`UPDATE step_progress SET state = 'broken' WHERE work_item_id = '${ROW}'`),
      ).toThrow(/CHECK constraint failed: role_progress_state/);
      expect(() =>
        sqlite.run(`UPDATE step_measure SET metric = 'broken' WHERE work_item_id = '${ROW}'`),
      ).toThrow(/CHECK constraint failed: role_measure_metric/);
      expect(() =>
        sqlite
          .query(`UPDATE estimate SET optimistic = ? WHERE work_item_id = '${ROW}'`)
          .run(Number.NaN),
      ).toThrow(/NOT NULL constraint failed: estimate.optimistic/);
    } finally {
      sqlite.close();
    }
  });
});
