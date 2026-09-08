import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { CapacityRepository } from '../repository/capacity';
import type { Connection } from '../repository/db';
import { openConnection } from '../repository/db';
import { DirectoryRepository } from '../repository/directory';
import { OPEN } from '../repository/gate';
import type { WriteStamp } from '../repository/index';
import { runMigrations } from '../repository/migrate';
import { ProjectRepository } from '../repository/project';
import { SavedPlanRepository } from '../repository/saved-plan';
import { SavedPlanCaptureRepository } from '../repository/saved-plan-capture';
import { savedPlan, savedPlanBody } from '../repository/schema';
import { StepRepository } from '../repository/step';
import { UserRepository } from '../repository/user';
import { WorkItemRepository } from '../repository/work-item';
import { nodeDigest } from '../runtime/bun-runtime';
import { projectRow } from '../testing/project-fixture';
import { SavedPlanService } from './saved-plan.service';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

const wrote: WriteStamp = { at: 1, by: 'owner' };
const OPENED_AT = 1_756_000_123;

const sha256 = (bytes: string): string => createHash('sha256').update(bytes, 'utf8').digest('hex');

/**
 * Task 4.2 — **immutability asserted by hash, not by field list.**
 *
 * A field-by-field comparison of the stored body against the live plan stays
 * green for every field the writer forgot to store: both sides are missing it,
 * so both sides agree. Hashing the whole body removes that escape — the digest
 * covers what was written, including the parts nobody thought to assert — so
 * this file compares **bytes and both SHA-256 values** before and after the live
 * plan moves under the record, and nothing else.
 */
describe('a saved plan does not move when the live plan does', () => {
  let dir: string;
  let path: string;
  let reader: Connection;

  const item = (id: string, position: number) => ({
    id,
    projectId: 'p1',
    parentId: null,
    position,
    name: id,
    notes: '',
    frozenNumber: null,
    priority: null,
    startNoEarlierThan: null,
    serviceTeamId: null,
    serviceId: null,
    maxParallel: 1,
    startNoEarlierThanReason: null,
    deadline: null,
    revision: 0,
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wbs-saved-plan-immutable-'));
    path = join(dir, 'test.db');
    runMigrations(path, FOLDER);
    const seed = openConnection(path);
    const db = seed.db;
    await new UserRepository(db, OPEN).create(
      { id: 'owner', username: 'owner', passwordHash: 'x', createdAt: 1 },
      wrote,
    );
    await new ProjectRepository(db, OPEN).create(
      projectRow({
        id: 'p1',
        name: 'Rewire the shed',
        ownerId: 'owner',
        estimateMethod: 'realistic',
        startDate: '2026-03-02',
      }),
      [
        { id: 'st-1', projectId: 'p1', name: 'Dev', position: 10 },
        { id: 'st-2', projectId: 'p1', name: 'Review', position: 20 },
      ],
      wrote,
    );
    const directory = new DirectoryRepository(db, OPEN);
    await directory.addTeam({ id: 't-platform', name: 'Platform' }, wrote);
    await directory.addPerson({ id: 'pp-ada', name: 'Ada' }, ['t-platform'], wrote);
    await new CapacityRepository(db, OPEN).set('p1', 't-platform', 4, wrote);
    const items = new WorkItemRepository(db, OPEN);
    await items.insert(item('wi-1', 10), [], wrote);
    await items.insert(item('wi-2', 20), [], wrote);
    seed.close();
    reader = openConnection(path);
  });

  afterEach(() => {
    reader.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const save = (id = 'sp-1') =>
    new SavedPlanService({
      digest: nodeDigest,
      capture: new SavedPlanCaptureRepository({ openConnection: () => openConnection(path) }),
      plans: new SavedPlanRepository({ openConnection: () => openConnection(path) }),
      newId: () => id,
      now: () => OPENED_AT,
    }).save({
      projectId: 'p1',
      name: 'before the rewire',
      createdBy: 'Ada Lovelace',
      createdById: null,
    });

  /** The five edits task 4.2 names, each reaching the capture by its own route. */
  const moveTheLivePlan = async (): Promise<void> => {
    const live = openConnection(path);
    const items = new WorkItemRepository(live.db, OPEN);
    await items.patch('wi-1', { name: 'renamed after the save' }, wrote);
    await items.remove(['wi-2'], [], wrote);
    await new StepRepository(live.db, OPEN).remove('p1', 'st-2', true, wrote);
    await new ProjectRepository(live.db, OPEN).update(
      'p1',
      { estimateMethod: 'optimistic', startDate: '2027-01-04' },
      wrote,
    );
    live.close();
  };

  /**
   * Everything the record holds, read the way another process would read it.
   *
   * Returned as drizzle typed the rows — no `Record<string, unknown>` in
   * between. A cast to an index signature would make every column below an
   * `unknown` compared against an `unknown`, which is a comparison that cannot
   * be wrong and therefore cannot be evidence.
   */
  const stored = async () => {
    const headers = await reader.db.select().from(savedPlan);
    expect(headers.length).toBe(1);
    const rows = await reader.db.select().from(savedPlanBody);
    return { header: headers[0], bodies: new Map(rows.map((row) => [row.kind, row.bytes])) };
  };

  it('keeps both bodies and both hashes byte-identical across five live edits', async () => {
    const saved = await save();
    expect(saved.outcome).toBe('saved');
    const before = await stored();

    await moveTheLivePlan();

    // The live plan really did move — otherwise the assertions below are a
    // comparison of a record against itself and would pass on any writer.
    const moved = openConnection(path);
    const nowItems = await new WorkItemRepository(moved.db, OPEN).listByProject('p1');
    const nowProject = await new ProjectRepository(moved.db, OPEN).findById('p1');
    const nowSteps = await new ProjectRepository(moved.db, OPEN).stepsOf('p1');
    moved.close();
    expect(nowItems.map((row) => row.name)).toEqual(['renamed after the save']);
    expect(nowSteps.map((row) => row.id)).toEqual(['st-1']);
    expect(nowProject?.estimateMethod).toBe('optimistic');
    expect(nowProject?.startDate).toBe('2027-01-04');

    const after = await stored();
    // Bytes first: this is the property, and the hashes below are the check a
    // reader can make cheaply once it holds them.
    expect(after.bodies).toEqual(before.bodies);
    expect(sha256(after.bodies.get('input')!)).toBe(before.header.inputSha256);
    // `schedule_sha256` is nullable in the schema because a schedule-less save
    // is legal; this save has one, and asserting that first is what lets the
    // comparison below be against a hash rather than against `null`.
    const scheduleSha = before.header.scheduleSha256;
    expect(scheduleSha).not.toBeNull();
    if (scheduleSha === null) return;
    expect(sha256(after.bodies.get('schedule')!)).toBe(scheduleSha);
    // The whole header, not the two hash columns: `input_bytes`,
    // `scheduler_algorithm_id` and `created_at` are as restatable as the digests
    // are, and an assertion on the hashes alone would not notice them moving.
    expect(after.header).toEqual(before.header);
    // And the saved plan still names the item the live plan no longer has.
    expect(before.bodies.get('input')!).toContain('wi-2');
  });

  it('captures those same five edits, so the equality above is not blindness', async () => {
    // The control the assertion above needs. Bytes that never move are also
    // what a writer that stores nothing of substance produces, and the live
    // assertions in that test prove only that SQLite moved — not that a
    // *capture* would have seen it. Saving again over the moved plan and
    // finding a different digest is what makes the first test immutability
    // rather than insensitivity.
    const first = await save('sp-1');
    if (first.outcome !== 'saved') throw new Error('expected a save');
    await moveTheLivePlan();
    const second = await save('sp-2');
    if (second.outcome !== 'saved') throw new Error('expected a second save');

    expect(second.record.input.sha256).not.toBe(first.record.input.sha256);
    expect(second.record.input.bytes).not.toBe(first.record.input.bytes);
    expect(second.record.input.bytes).not.toContain('wi-2');
    // Both records are still there, each with its own bytes: the second save
    // wrote a new row rather than restating the first.
    const rows = await reader.db.select().from(savedPlanBody);
    expect(rows.length).toBe(4);
  });
});
