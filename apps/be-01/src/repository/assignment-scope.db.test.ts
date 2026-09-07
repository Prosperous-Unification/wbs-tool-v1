import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { WorkItemService } from '../service/work-item.service';
import { personAdded } from '../testing/directory-fixture';
import { inMemoryServices } from '../testing/harness';
import { projectRow } from '../testing/project-fixture';
import { workItemRow } from '../testing/work-item-fixture';
import { openDatabase, openDrizzle } from './db';
import { DirectoryRepository } from './directory';
import { OPEN } from './gate';
import { runMigrations } from './migrate';
import { ProjectRepository } from './project';
import { UserRepository } from './user';
import { WorkItemRepository } from './work-item';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;
const STAMP = { at: 1, by: 'owner' };
let folder: string;
let path: string;
let directory: DirectoryRepository;
let service: WorkItemService;
let recorded: { sql: string; bindings: unknown[] }[];

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'wbs-assignment-scope-'));
  path = join(folder, 'test.db');
  runMigrations(path, FOLDER);
  recorded = [];
  const db = openDrizzle(path, {
    logQuery(sql, bindings) {
      recorded.push({ sql, bindings });
    },
  });
  directory = new DirectoryRepository(db, OPEN);
  const projects = new ProjectRepository(db, OPEN);
  const workItems = new WorkItemRepository(db, OPEN);
  service = inMemoryServices({ projects, workItems, directory }).service;
  await new UserRepository(db, OPEN).create(
    { id: 'owner', username: 'owner', passwordHash: 'x', createdAt: 1 },
    STAMP,
  );
  const team = await directory.addTeam({ id: 'team', name: 'Shared team' }, STAMP);
  for (let index = 0; index < 41; index += 1) {
    const projectId = `project-${String(index)}`;
    const stepId = `step-${String(index)}`;
    const workItemId = `work-${String(index)}`;
    const personId = `person-${String(index)}`;
    await projects.create(
      projectRow({ id: projectId, ownerId: 'owner' }),
      [{ id: stepId, projectId, name: 'Dev', position: 10 }],
      STAMP,
    );
    await workItems.insert(workItemRow({ id: workItemId, projectId }), [], STAMP);
    await personAdded(directory.addPerson({ id: personId, name: personId }, [team.id], STAMP));
    await directory.assign(workItemId, stepId, personId, STAMP);
  }
  recorded = [];
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

/** Examines the actual statements issued by the production call, on its migrated schema. */
function expectBoundedReads(): void {
  const reads = recorded.filter(
    ({ sql }) =>
      /^select /i.test(sql) && /(?:from|join) "(?:assignment|person|person_team)"/.test(sql),
  );
  expect(reads.length).toBeGreaterThan(0);
  const connection = openDatabase(path);
  try {
    for (const read of reads) {
      // Drizzle's logger exposes unknown[]; this test boundary only receives
      // SQLite-supported scalar parameters from the production query builder.
      const bindings = read.bindings as (string | number | null)[];
      const materialized = connection.query(read.sql).all(...bindings);
      expect(materialized.length, `materialized unrelated rows: ${read.sql}`).toBeLessThanOrEqual(
        1,
      );
      const plan = connection
        .query<{ detail: string }, (string | number | null)[]>(`EXPLAIN QUERY PLAN ${read.sql}`)
        .all(...bindings);
      expect(plan.some(({ detail }) => /SEARCH (?:assignment|person) USING/.test(detail))).toBe(
        true,
      );
      expect(
        plan.filter(({ detail }) =>
          /SCAN (?:work_item|assignment|person|person_team)(?:\s|$)/.test(detail),
        ),
      ).toEqual([]);
    }
  } finally {
    connection.close();
  }
}

describe('project-scoped assignment reads', () => {
  it('materializes only assigned project rows and names during a tiny tree read', async () => {
    const tree = await service.tree('project-0');
    expect(tree?.assignedPeople).toEqual([{ id: 'person-0', name: 'person-0' }]);
    expectBoundedReads();
  });

  it('uses an indexed prior assignment read during one assignment write', async () => {
    expect(await service.assign('work-0', 'owner', 'step-0', null)).toEqual({
      ok: true,
      value: null,
    });
    expectBoundedReads();
    expect(await directory.assignmentsOf(['work-1'])).toEqual([
      { workItemId: 'work-1', stepId: 'step-1', personId: 'person-1' },
    ]);
    const undone = await service.undo('project-0', 'owner');
    expect(undone.ok).toBe(true);
    expect(await directory.assignmentsOf(['work-0'])).toEqual([
      { workItemId: 'work-0', stepId: 'step-0', personId: 'person-0' },
    ]);
  });
});
