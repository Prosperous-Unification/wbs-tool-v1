import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Project, Step, WorkItem, WriteStamp } from '@wbs/core';
import { workItemRow } from '@wbs/core/testing/work-item-fixture';
import { projectRow } from '@wbs/store-memory/project-fixture';
import { personAdded } from '@wbs/store-memory/testing/service-fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { ActualRepository } from './actual';
import { openDatabase, openDrizzle } from './db';
import { DirectoryRepository } from './directory';
import { EstimateRepository } from './estimate';
import { OPEN } from './gate';
import { runMigrations } from './migrate';
import { ProjectRepository } from './project';
import { StepRepository } from './step';
import { StepMeasureRepository } from './step-measure';
import { StepProgressRepository } from './step-progress';
import { UserRepository } from './user';
import { WorkItemRepository } from './work-item';

/**
 * The step table's write path, against real SQLite.
 *
 * Real, and only real. Every claim here is one SQLite makes and no fixture
 * can: the unique index that refuses a second `Design`, the foreign key that
 * `estimate.step_id` has no cascade for, and the revision arithmetic that
 * happens inside the statement rather than in this process.
 */
const FOLDER = new URL('../../../apps/be-01/drizzle', import.meta.url).pathname;

let dir: string;
let ownerId: string;
let steps: StepRepository;
let projects: ProjectRepository;
let estimates: EstimateRepository;
let actuals: ActualRepository;
let progress: StepProgressRepository;
let measures: StepMeasureRepository;
let directory: DirectoryRepository;
let workItems: WorkItemRepository;
let projectId: string;
let otherProjectId: string;
let devId: string;
let qaId: string;

/**
 * The stamp every write here carries. The account is the projects' owner, which
 * the `created_by` foreign key requires to exist; the owner's own signup carries
 * it too, because a new account authors its own row.
 */
const wrote = (): WriteStamp => ({ at: 1, by: ownerId });

const newProject = (ownerId: string, name: string): Project =>
  projectRow({
    id: crypto.randomUUID(),
    name,
    ownerId,
  });

const newItem = (id: string, position: number, name: string): WorkItem =>
  workItemRow({
    id,
    projectId,
    position,
    name,
  });

const revisionOf = async (id: string): Promise<number> => {
  const found = await projects.findById(id);
  if (found === null) throw new Error(`no project ${id}`);
  return found.revision;
};

const workItemRevisionOf = async (id: string): Promise<number> => {
  const found = await workItems.findById(id);
  if (found === null) throw new Error(`no work item ${id}`);
  return found.revision;
};

const DAYS = { optimistic: 1, realistic: 2, pessimistic: 3 };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-step-'));
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  const db = openDrizzle(path);
  steps = new StepRepository(db, OPEN);
  projects = new ProjectRepository(db, OPEN);
  estimates = new EstimateRepository(db, OPEN);
  actuals = new ActualRepository(db, OPEN);
  progress = new StepProgressRepository(db, OPEN);
  measures = new StepMeasureRepository(db, OPEN);
  directory = new DirectoryRepository(db, OPEN);
  workItems = new WorkItemRepository(db, OPEN);

  ownerId = crypto.randomUUID();
  await new UserRepository(db, OPEN).create(
    { id: ownerId, username: 'owner', passwordHash: 'x', createdAt: 1 },
    wrote(),
  );

  const project = newProject(ownerId, 'Rewire the shed');
  projectId = project.id;
  devId = crypto.randomUUID();
  qaId = crypto.randomUUID();
  const starting: Step[] = [
    { id: devId, projectId, name: 'Dev', position: 10 },
    { id: qaId, projectId, name: 'QA', position: 20 },
  ];
  await projects.create(project, starting, wrote());

  const other = newProject(ownerId, 'Re-tile the roof');
  otherProjectId = other.id;
  await projects.create(
    other,
    [{ id: crypto.randomUUID(), projectId: other.id, name: 'Dev', position: 10 }],
    wrote(),
  );

  await workItems.insert(newItem('strip', 10, 'Strip'), [], wrote());
  await workItems.insert(newItem('sand', 20, 'Sand'), [], wrote());
  await workItems.insert(newItem('paint', 30, 'Paint'), [], wrote());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the names the schema uses', () => {
  /**
   * The physical schema and the domain agree, and this reads the **live
   * migrated database** rather than the schema file to say so.
   *
   * It replaces `the step table's physical name is still role`, which recorded
   * the disagreement `steps-not-phases` left behind and which
   * `20260831120000_rename_role_to_step` was written to end. That test was
   * deliberately built to go red the day the rename ran; this is what it
   * becomes.
   *
   * Proof: `ALTER TABLE assignment RENAME COLUMN role_id TO step_id` removed
   * from the migration, watched failing here on
   * `Expected to contain: "step_id" / Received: [ "work_item_id", "role_id",
   * "person_id" ]`. Observed 2026-08-31.
   *
   * Removing the **table** rename instead was tried first and is not the fault
   * to inject: the migration's own
   * `CREATE UNIQUE INDEX step_project_name ON step` then fails inside
   * `runMigrations`, so the run dies in `beforeEach` and this assertion is
   * never reached.
   */
  it('names steps everywhere the database does, and role nowhere', () => {
    // Through `openDatabase`, never `new Database`: the pragmas are
    // per-connection and the ESLint rule that keeps them so is the point.
    const sqlite = openDatabase(join(dir, 'test.db'));
    try {
      const objectsNamed = (type: string, name: string): number =>
        sqlite
          .query<{ n: number }, [string, string]>(
            'SELECT count(*) AS n FROM sqlite_master WHERE type = ? AND name = ?',
          )
          .get(type, name)?.n ?? 0;

      for (const table of ['step', 'step_progress', 'step_measure'])
        expect(objectsNamed('table', table)).toBe(1);
      for (const table of ['role', 'role_progress', 'role_measure'])
        expect(objectsNamed('table', table)).toBe(0);
      expect(objectsNamed('index', 'step_project_name')).toBe(1);

      // The column every join in this repository is written against.
      const columnsOf = (table: string): string[] =>
        sqlite
          .query<{ name: string }, [string]>('SELECT name FROM pragma_table_info(?)')
          .all(table)
          .map((column) => column.name);
      for (const table of ['estimate', 'actual', 'assignment', 'step_progress', 'step_measure'])
        expect(columnsOf(table)).toContain('step_id');
      for (const table of ['estimate', 'actual', 'assignment', 'step_progress', 'step_measure'])
        expect(columnsOf(table)).not.toContain('role_id');

      // Not one table, column or index name left carrying the word. The sweep
      // rather than a list, because a name nobody thought to name is exactly
      // the one a rename forgets.
      const named = sqlite
        .query<{ type: string; name: string }, []>(
          "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
        )
        .all();
      expect(named.filter((each) => /role/i.test(each.name))).toEqual([]);
      const roleColumns = named
        .filter((each) => each.type === 'table')
        .flatMap((each) =>
          columnsOf(each.name)
            .filter((column) => /role/i.test(column))
            .map((column) => `${each.name}.${column}`),
        );
      expect(roleColumns).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  /**
   * There is no boundary left for a comment to reconcile, so `schema.ts` must
   * not carry one.
   *
   * The spec `20260831120000_rename_role_to_step` implements says the schema
   * "SHALL NOT carry a comment reconciling a physical name with a domain name,
   * because they SHALL agree". This is that sentence, made breakable: the
   * paragraph it is about opened with **The physical name is `role`, and the
   * domain name is `step`.**
   *
   * `step.ts` is exempt and named here rather than left to be discovered: its
   * `isDuplicateName` comment says "physical" about the string SQLite puts in
   * an error message, which is a real fact about SQLite rather than a
   * disagreement between two names.
   *
   * Proof: that paragraph pasted back onto {@link step}, watched failing on
   * `expect(received).toEqual(expected)` with
   * `+ "* **The physical name is \`role\`, and the domain name is \`step\`.**
   * Every"` among three received lines against an empty expectation. Observed
   * 2026-08-31.
   */
  it('leaves no comment in the schema reconciling a physical name with a domain one', () => {
    const schema = readFileSync(join(import.meta.dir, 'schema.ts'), 'utf8');

    const reconciling = schema
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /physical name|physical\*\* name|domain name/i.test(line));

    expect(reconciling).toEqual([]);
  });
});

describe('StepRepository', () => {
  it('adds a step and moves the project’s revision', async () => {
    const before = await revisionOf(projectId);

    const written = await steps.add({ id: 'design', projectId, name: 'Design' }, wrote());

    expect(written).toEqual({
      ok: true,
      step: { id: 'design', projectId, name: 'Design', position: 30 },
    });
    const names = (await steps.listByProject(projectId)).map((each) => each.name);
    expect(names).toEqual(['Dev', 'QA', 'Design']);
    expect(await revisionOf(projectId)).toBe(before + 1);
  });

  it('reads a step added later last, however its name sorts', async () => {
    // The order cannot be inferred from the rows: SQLite answers
    // `WHERE project_id = ?` from `step_project_name`, so without an ORDER BY
    // these come back `Analysis, Dev, QA` — and step order is what a work
    // item's slices run in.
    await steps.add({ id: 'analysis', projectId, name: 'Analysis' }, wrote());

    const names = (await steps.listByProject(projectId)).map((each) => each.name);

    expect(names).toEqual(['Dev', 'QA', 'Analysis']);
  });

  it('reads the same order through the project, which is where the schedule asks', async () => {
    await steps.add({ id: 'analysis-2', projectId, name: 'Analysis' }, wrote());

    const names = (await projects.stepsOf(projectId)).map((each) => each.name);

    expect(names).toEqual(['Dev', 'QA', 'Analysis']);
  });

  it('refuses a name the project already holds, and leaves the steps as they were', async () => {
    const written = await steps.add({ id: 'second-qa', projectId, name: 'QA' }, wrote());

    expect(written).toEqual({ ok: false, reason: 'taken' });
    expect(await steps.listByProject(projectId)).toHaveLength(2);
  });

  it('accepts in one project a name another project holds', async () => {
    const written = await steps.add(
      { id: 'other-qa', projectId: otherProjectId, name: 'QA' },
      wrote(),
    );

    expect(written.ok).toBe(true);
    const names = (await steps.listByProject(otherProjectId)).map((each) => each.name);
    expect(names).toHaveLength(2);
    expect(names).toContain('QA');
  });

  it('renames a step and moves the project’s revision', async () => {
    const before = await revisionOf(projectId);

    const written = await steps.rename(qaId, 'Review', wrote());

    expect(written).toEqual({
      ok: true,
      step: { id: qaId, projectId, name: 'Review', position: 20 },
    });
    expect(await revisionOf(projectId)).toBe(before + 1);
  });

  it('refuses a rename onto a name already in use, leaving both alone', async () => {
    const before = await revisionOf(projectId);

    const written = await steps.rename(qaId, 'Dev', wrote());

    expect(written).toEqual({ ok: false, reason: 'taken' });
    const names = (await steps.listByProject(projectId)).map((each) => each.name).sort();
    expect(names).toEqual(['Dev', 'QA']);
    // The refused write moved nothing, so nobody's precondition is defeated by
    // a request that changed nothing.
    expect(await revisionOf(projectId)).toBe(before);
  });

  it('reports a step that is gone rather than pretending to rename it', async () => {
    expect(await steps.rename('never-existed', 'Design', wrote())).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await steps.findById('never-existed')).toBeNull();
  });

  it('finds a step by id, carrying the project it belongs to', async () => {
    expect(await steps.findById(qaId)).toEqual({ id: qaId, projectId, name: 'QA', position: 20 });
  });

  it('counts the step’s estimates and hands back every assignment in the project', async () => {
    await estimates.set({ workItemId: 'strip', stepId: qaId, ...DAYS }, wrote());
    await estimates.set({ workItemId: 'sand', stepId: qaId, ...DAYS }, wrote());
    await estimates.set({ workItemId: 'sand', stepId: devId, ...DAYS }, wrote());
    const ada = await personAdded(
      directory.addPerson({ id: crypto.randomUUID(), name: 'Ada' }, [], wrote()),
    );
    await directory.assign('strip', devId, ada.id, wrote());
    await directory.assign('strip', qaId, ada.id, wrote());

    const usage = await steps.usageOf(projectId, qaId);

    expect(usage.estimates).toBe(2);
    // Both of the work item's assignments, not only the QA one: what `strip`
    // is assumed to be after QA goes depends on the Dev row staying.
    expect(usage.assignments).toHaveLength(2);
    expect(usage.assignments).toContainEqual({
      workItemId: 'strip',
      stepId: devId,
      personId: ada.id,
    });
  });

  it('removes the step’s estimates, its assignments and its row, and nothing else’s', async () => {
    await estimates.set({ workItemId: 'strip', stepId: qaId, ...DAYS }, wrote());
    await estimates.set({ workItemId: 'strip', stepId: devId, ...DAYS }, wrote());
    await estimates.set({ workItemId: 'sand', stepId: qaId, ...DAYS }, wrote());
    const ada = await personAdded(
      directory.addPerson({ id: crypto.randomUUID(), name: 'Ada' }, [], wrote()),
    );
    await directory.assign('strip', qaId, ada.id, wrote());
    await directory.assign('strip', devId, ada.id, wrote());

    const removed = await steps.remove(projectId, qaId, true, wrote());

    if (!removed.ok) throw new Error(`removal refused: ${removed.reason}`);
    expect(removed.removal.estimates).toBe(2);
    expect(removed.removal.assignments).toBe(1);
    expect([...removed.removal.workItemIds].sort()).toEqual(['sand', 'strip']);
    expect(await steps.findById(qaId)).toBeNull();
    // The other step's rows are the survivors that make the delete's WHERE
    // clause provable: narrowed to the work item alone it would take these too.
    expect(await estimates.listByProject(projectId)).toEqual([
      { workItemId: 'strip', stepId: devId, ...DAYS },
    ]);
    expect(await directory.assignmentsOf(['strip', 'sand'])).toEqual([
      { workItemId: 'strip', stepId: devId, personId: ada.id },
    ]);
    // A step of the same name in another project is not this project's business.
    expect(await steps.listByProject(otherProjectId)).toHaveLength(1);
  });

  it('moves the project and every work item that lost something, and nothing else', async () => {
    await estimates.set({ workItemId: 'strip', stepId: qaId, ...DAYS }, wrote());
    const ada = await personAdded(
      directory.addPerson({ id: crypto.randomUUID(), name: 'Ada' }, [], wrote()),
    );
    await directory.assign('sand', qaId, ada.id, wrote());
    const projectBefore = await revisionOf(projectId);
    const stripBefore = await workItemRevisionOf('strip');
    const sandBefore = await workItemRevisionOf('sand');
    const paintBefore = await workItemRevisionOf('paint');

    await steps.remove(projectId, qaId, true, wrote());

    expect(await revisionOf(projectId)).toBe(projectBefore + 1);
    expect(await workItemRevisionOf('strip')).toBe(stripBefore + 1);
    expect(await workItemRevisionOf('sand')).toBe(sandBefore + 1);
    // Held nothing of that step's, so nobody's read of it differs and a
    // precondition on it must survive.
    expect(await workItemRevisionOf('paint')).toBe(paintBefore);
  });

  it('refuses an unconfirmed removal and deletes nothing, reporting what it read', async () => {
    await estimates.set({ workItemId: 'strip', stepId: qaId, ...DAYS }, wrote());
    const ada = await personAdded(
      directory.addPerson({ id: crypto.randomUUID(), name: 'Ada' }, [], wrote()),
    );
    await directory.assign('strip', qaId, ada.id, wrote());
    const before = await revisionOf(projectId);

    const refused = await steps.remove(projectId, qaId, false, wrote());

    expect(refused).toEqual({
      ok: false,
      reason: 'in_use',
      // The whole project's assignments, so the caller can work out whose
      // assumed assignee moves — the `Dev` row is not there because nobody
      // holds it, and this is what the reading is made from.
      usage: {
        estimates: 1,
        // Nothing recorded against this step, and the count travels anyway: a
        // refusal that reported only estimates would be silent about the one
        // number nobody can retype from memory.
        actuals: 0,
        progress: 0,
        measures: 0,
        assignments: [{ workItemId: 'strip', stepId: qaId, personId: ada.id }],
      },
    });
    expect(await steps.findById(qaId)).not.toBeNull();
    expect(await estimates.listByProject(projectId)).toHaveLength(1);
    expect(await revisionOf(projectId)).toBe(before);
  });

  it('reports a step that is already gone, moving nothing', async () => {
    await steps.remove(projectId, qaId, true, wrote());
    const after = await revisionOf(projectId);

    const second = await steps.remove(projectId, qaId, true, wrote());

    expect(second).toEqual({ ok: false, reason: 'not_found' });
    // The loser of two removals writes nothing at all, the project's revision
    // included: it removed nothing, so nobody's read of the project differs.
    expect(await revisionOf(projectId)).toBe(after);
  });

  it('reports another project’s step as not there, and leaves it alone', async () => {
    const theirs = (await steps.listByProject(otherProjectId)).at(0);
    if (theirs === undefined) throw new Error('the other project was created without steps');
    const before = await revisionOf(projectId);

    const refused = await steps.remove(projectId, theirs.id, true, wrote());

    expect(refused).toEqual({ ok: false, reason: 'not_found' });
    expect(await steps.findById(theirs.id)).toEqual(theirs);
    expect(await revisionOf(projectId)).toBe(before);
  });

  it('deletes an estimate written between the count and the confirmed removal', async () => {
    await estimates.set({ workItemId: 'strip', stepId: qaId, ...DAYS }, wrote());
    const counted = await steps.usageOf(projectId, qaId);
    expect(counted.estimates).toBe(1);

    // The race the confirmation opens: somebody estimates the doomed step on a
    // work item the counts never mentioned, between the refusal and the
    // confirmed delete. The transaction chooses what it deletes for itself, so
    // this is deleted with the rest rather than left pointing at a step that
    // has gone — which is a foreign key error, a 500, and a project nobody can
    // read afterwards.
    await estimates.set({ workItemId: 'paint', stepId: qaId, ...DAYS }, wrote());
    const paintBefore = await workItemRevisionOf('paint');

    const removed = await steps.remove(projectId, qaId, true, wrote());

    if (!removed.ok) throw new Error(`removal refused: ${removed.reason}`);
    expect(removed.removal.estimates).toBe(2);
    expect(await estimates.listByProject(projectId)).toEqual([]);
    expect(await workItemRevisionOf('paint')).toBe(paintBefore + 1);
    expect(await steps.findById(qaId)).toBeNull();
  });

  it('counts the recorded days, and refuses an unconfirmed removal of a step that holds only those', async () => {
    // The case that makes the count load-bearing rather than decorative: this
    // step has no estimate and nobody assigned, so a removal that counted only
    // those two would sail through and take the record of somebody's week with
    // it. `actual.step_id` has no cascade precisely so this cannot happen
    // quietly.
    await actuals.set({ workItemId: 'strip', stepId: qaId, days: 8, recordedAt: 1000 }, wrote());
    const before = await revisionOf(projectId);

    const counted = await steps.usageOf(projectId, qaId);
    const refused = await steps.remove(projectId, qaId, false, wrote());

    expect(counted).toEqual({
      estimates: 0,
      actuals: 1,
      progress: 0,
      measures: 0,
      assignments: [],
    });
    expect(refused).toEqual({
      ok: false,
      reason: 'in_use',
      usage: { estimates: 0, actuals: 1, progress: 0, measures: 0, assignments: [] },
    });
    expect(await steps.findById(qaId)).not.toBeNull();
    expect(await actuals.listByProject(projectId)).toHaveLength(1);
    // A refusal writes nothing at all, the project's revision included.
    expect(await revisionOf(projectId)).toBe(before);
  });

  it('counts the stated progress, and refuses an unconfirmed removal of a step that holds only that', async () => {
    // The third loss, and the one that makes this count load-bearing rather than
    // decorative: this step has no estimate, no recorded day and nobody
    // assigned, so a removal that counted only those three would sail through
    // and turn finished work back into work nobody has started.
    // `step_progress.step_id` has no cascade precisely so this cannot happen
    // quietly.
    //
    // Proof: `spoken.length > 0` dropped from the `in_use` condition, and this
    // fails with the removal proceeding against a step whose only usage is the
    // statement that its work is done; watched 2026-08-18.
    await progress.set(
      { workItemId: 'strip', stepId: qaId, state: 'done', statedAt: 1000 },
      wrote(),
    );
    const before = await revisionOf(projectId);

    const counted = await steps.usageOf(projectId, qaId);
    const refused = await steps.remove(projectId, qaId, false, wrote());

    expect(counted).toEqual({
      estimates: 0,
      actuals: 0,
      progress: 1,
      measures: 0,
      assignments: [],
    });
    expect(refused).toEqual({
      ok: false,
      reason: 'in_use',
      usage: { estimates: 0, actuals: 0, progress: 1, measures: 0, assignments: [] },
    });
    expect(await steps.findById(qaId)).not.toBeNull();
    expect(await progress.listByProject(projectId)).toHaveLength(1);
    // A refusal writes nothing at all, the project's revision included.
    expect(await revisionOf(projectId)).toBe(before);
  });

  it('deletes the stated progress with the step it confirmed, moving the work items that lost one', async () => {
    // The other half, and the one the missing cascade forces: without an
    // explicit delete here the step row cannot go at all — SQLite refuses it —
    // so this is what turns a 500 into a removal that says what it took.
    //
    // Proof: `tx.delete(stepProgress)` struck from `StepRepository.remove`, and
    // this fails with `SQLITE_CONSTRAINT_FOREIGNKEY` thrown out of the
    // transaction; watched 2026-08-18.
    await progress.set(
      { workItemId: 'strip', stepId: qaId, state: 'done', statedAt: 1000 },
      wrote(),
    );
    await progress.set(
      { workItemId: 'sand', stepId: devId, state: 'in_progress', statedAt: 1000 },
      wrote(),
    );
    const stripBefore = await workItemRevisionOf('strip');

    const removed = await steps.remove(projectId, qaId, true, wrote());

    expect(removed).toEqual({
      ok: true,
      removal: {
        estimates: 0,
        actuals: 0,
        progress: 1,
        measures: 0,
        assignments: 0,
        workItemIds: ['strip'],
      },
    });
    expect(await steps.findById(qaId)).toBeNull();
    // The other step's row on another work item survives, which is what makes
    // the delete's `WHERE` provable.
    expect(await progress.listByProject(projectId)).toEqual([
      { workItemId: 'sand', stepId: devId, state: 'in_progress', statedAt: 1000 },
    ]);
    expect(await workItemRevisionOf('strip')).toBe(stripBefore + 1);
  });

  it('counts the figures that are not days, and refuses an unconfirmed removal of a step that holds only those', async () => {
    // The fourth loss. This step has no estimate, no recorded day, no stated
    // progress and nobody assigned, so a removal that counted only those four
    // would sail through and delete what an agent's work on this plan cost —
    // the figures nobody typed and nobody can retype. `step_measure.step_id`
    // has no cascade precisely so this cannot happen quietly.
    //
    // **Two rows on one pair, and the count is 2.** A count of pairs would say
    // "1 figure" for two statements made on two different days in two different
    // units, and a person consenting to that number would be consenting to less
    // than goes.
    await measures.set(
      {
        workItemId: 'strip',
        stepId: qaId,
        metric: 'token_actual',
        value: 12_000,
        recordedAt: 1000,
      },
      wrote(),
    );
    await measures.set(
      {
        workItemId: 'strip',
        stepId: qaId,
        metric: 'hours_actual',
        value: 3,
        recordedAt: 2000,
      },
      wrote(),
    );
    const before = await revisionOf(projectId);

    const counted = await steps.usageOf(projectId, qaId);
    const refused = await steps.remove(projectId, qaId, false, wrote());

    expect(counted).toEqual({
      estimates: 0,
      actuals: 0,
      progress: 0,
      measures: 2,
      assignments: [],
    });
    expect(refused).toEqual({
      ok: false,
      reason: 'in_use',
      usage: { estimates: 0, actuals: 0, progress: 0, measures: 2, assignments: [] },
    });
    expect(await steps.findById(qaId)).not.toBeNull();
    expect(await measures.listByProject(projectId)).toHaveLength(2);
    // A refusal writes nothing at all, the project's revision included.
    expect(await revisionOf(projectId)).toBe(before);
  });

  it('deletes the figures that are not days with the step it confirmed, moving the work items that lost one', async () => {
    // The other half, and the one the missing cascade forces: without an
    // explicit delete here the step row cannot go at all — SQLite refuses it —
    // so this is what turns a 500 into a removal that says what it took.
    //
    // Two work items, so `workItemIds` is a set of the items that lost a row
    // rather than a count of rows: `strip` holds two of this step's figures and
    // appears once.
    await measures.set(
      {
        workItemId: 'strip',
        stepId: qaId,
        metric: 'token_estimate',
        value: 8000,
        recordedAt: 1000,
      },
      wrote(),
    );
    await measures.set(
      {
        workItemId: 'strip',
        stepId: qaId,
        metric: 'token_actual',
        value: 9500,
        recordedAt: 1000,
      },
      wrote(),
    );
    await measures.set(
      {
        workItemId: 'sand',
        stepId: devId,
        metric: 'hours_actual',
        value: 2,
        recordedAt: 1000,
      },
      wrote(),
    );
    const stripBefore = await workItemRevisionOf('strip');

    const removed = await steps.remove(projectId, qaId, true, wrote());

    expect(removed).toEqual({
      ok: true,
      removal: {
        estimates: 0,
        actuals: 0,
        progress: 0,
        measures: 2,
        assignments: 0,
        workItemIds: ['strip'],
      },
    });
    expect(await steps.findById(qaId)).toBeNull();
    // The other step's figure on another work item survives, which is what
    // makes the delete's `WHERE` provable.
    expect(await measures.listByProject(projectId)).toEqual([
      { workItemId: 'sand', stepId: devId, metric: 'hours_actual', value: 2, recordedAt: 1000 },
    ]);
    expect(await workItemRevisionOf('strip')).toBe(stripBefore + 1);
  });

  it('deletes the recorded days with the step it confirmed, moving the work items that lost one', async () => {
    // The other half, and the one the missing cascade forces: without an
    // explicit delete here the step row cannot go at all — SQLite refuses it —
    // so this is what turns a 500 into a removal that says what it took.
    await actuals.set({ workItemId: 'strip', stepId: qaId, days: 8, recordedAt: 1000 }, wrote());
    await actuals.set({ workItemId: 'sand', stepId: devId, days: 2, recordedAt: 1000 }, wrote());
    const stripBefore = await workItemRevisionOf('strip');

    const removed = await steps.remove(projectId, qaId, true, wrote());

    expect(removed).toEqual({
      ok: true,
      removal: {
        estimates: 0,
        actuals: 1,
        progress: 0,
        measures: 0,
        assignments: 0,
        workItemIds: ['strip'],
      },
    });
    expect(await steps.findById(qaId)).toBeNull();
    // The other step's row on another work item survives, which is what makes
    // the delete's `WHERE` provable.
    expect(await actuals.listByProject(projectId)).toEqual([
      { workItemId: 'sand', stepId: devId, days: 2, recordedAt: 1000 },
    ]);
    expect(await workItemRevisionOf('strip')).toBe(stripBefore + 1);
  });
});

describe('what a step read publishes', () => {
  /**
   * The audit columns are recorded and not published (ADR 0012), and
   * `STEP_COLUMNS` is what keeps them off the wire for **five** reads and
   * writes: `listByProject`, `findById`, `rename`'s `returning`, and
   * `ProjectRepository.stepsOf`, which is the list `GET /api/projects/{id}`
   * answers with.
   *
   * The comment those reads carried until 2026-09-02 said the declared return
   * type checked the list was complete. It does not: a `Step` with three extra
   * properties is structurally assignable to `Step`, so a bare `select()`
   * typechecks and publishes `created_at`, `updated_at` and `created_by`. The
   * type catches a **missing** column and nothing else, which is why this is a
   * test and not a comment.
   *
   * Proof: `.select(STEP_COLUMNS)` in `listByProject` replaced by `.select()`,
   * watched failing on `expect(received).toEqual(expected) · - Expected - 0 ·
   * + Received + 3` at the `listed` assertion — the three audit columns — and
   * taking `reports another project's step as not there, and leaves it alone`
   * down with it (2026-09-02).
   */
  it('carries the columns the Step type declares and no others', async () => {
    const written = await steps.add({ id: 'design', projectId, name: 'Design' }, wrote());
    if (!written.ok) throw new Error(`add refused: ${written.reason}`);

    const listed = (await steps.listByProject(projectId)).find((each) => each.id === 'design');
    const found = await steps.findById('design');
    const throughProject = (await projects.stepsOf(projectId)).find((each) => each.id === 'design');
    const renamed = await steps.rename('design', 'Drafting', wrote());
    if (!renamed.ok) throw new Error(`rename refused: ${renamed.reason}`);

    const declared = Object.keys(written.step).sort();
    expect(Object.keys(listed ?? {}).sort()).toEqual(declared);
    expect(Object.keys(found ?? {}).sort()).toEqual(declared);
    expect(Object.keys(throughProject ?? {}).sort()).toEqual(declared);
    expect(Object.keys(renamed.step).sort()).toEqual(declared);
    expect(declared).not.toContain('createdBy');
    expect(declared).not.toContain('updatedAt');
  });
});
