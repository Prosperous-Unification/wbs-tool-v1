import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { CapacityRepository } from '../repository/capacity';
import type { Connection } from '../repository/db';
import { openConnection } from '../repository/db';
import { DependencyRepository } from '../repository/dependency';
import { DirectoryRepository } from '../repository/directory';
import { OPEN } from '../repository/gate';
import type { WriteStamp } from '../repository/index';
import { runMigrations } from '../repository/migrate';
import { ProjectRepository } from '../repository/project';
import { SavedPlanRepository } from '../repository/saved-plan';
import { SavedPlanCaptureRepository } from '../repository/saved-plan-capture';
import { savedPlan, savedPlanBody } from '../repository/schema';
import { UserRepository } from '../repository/user';
import { WorkItemRepository } from '../repository/work-item';
import { nodeDigest } from '../runtime/bun-runtime';
import { projectRow } from '../testing/project-fixture';
import { SavedPlanService } from './saved-plan.service';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

const wrote: WriteStamp = { at: 1, by: 'owner' };

/** The instant the service is told the snapshot opened. */
const OPENED_AT = 1_756_000_123;

const sha256 = (bytes: string): string => createHash('sha256').update(bytes, 'utf8').digest('hex');

describe('SavedPlanService.save', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'wbs-saved-plan-service-'));
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
      [{ id: 'st-1', projectId: 'p1', name: 'Dev', position: 10 }],
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

  const service = (): SavedPlanService =>
    new SavedPlanService({
      digest: nodeDigest,
      capture: new SavedPlanCaptureRepository({ openConnection: () => openConnection(path) }),
      plans: new SavedPlanRepository({ openConnection: () => openConnection(path) }),
      newId: () => 'sp-1',
      now: () => OPENED_AT,
    });

  const save = () =>
    service().save({
      projectId: 'p1',
      name: 'before the rewire',
      createdBy: 'Ada Lovelace',
      createdById: null,
    });

  // Unfiltered on purpose, and not only because a service test may not import
  // `drizzle-orm`: each case writes at most one saved plan, so "the rows this
  // save produced" and "every row in the table" are the same set — and a
  // second header appearing from anywhere fails the length assertion below
  // rather than being filtered quietly out of sight.
  const headers = () => reader.db.select().from(savedPlan);
  const bodies = () => reader.db.select().from(savedPlanBody);

  it('writes one header and both bodies, and the returned record round-trips', async () => {
    const result = await save();

    expect(result.outcome).toBe('saved');
    if (result.outcome !== 'saved') return;
    const record = result.record;
    expect(record.schedule.present).toBe(true);
    if (!record.schedule.present) return;

    const rows = await headers();
    expect(rows.length).toBe(1);
    const header = rows[0];
    // The whole header, field for field, against what `save` said it wrote:
    // an assertion on a subset stays green for every column the service
    // forgot to fill, which is the failure this row exists to catch.
    expect(header.projectId).toBe('p1');
    expect(header.name).toBe('before the rewire');
    expect(header.createdBy).toBe('Ada Lovelace');
    expect(header.createdAt).toBe(OPENED_AT);
    expect(header.inputSchemaVersion).toBe(record.input.schemaVersion);
    expect(header.inputSha256).toBe(record.input.sha256);
    expect(header.inputBytes).toBe(Buffer.byteLength(record.input.bytes, 'utf8'));
    expect(header.scheduleSchemaVersion).toBe(record.schedule.body.schemaVersion);
    expect(header.scheduleSha256).toBe(record.schedule.body.sha256);
    expect(header.scheduleBytes).toBe(Buffer.byteLength(record.schedule.body.bytes, 'utf8'));
    expect(header.scheduleInputSha256).toBe(record.input.sha256);
    expect(header.schedulerAlgorithmId).toBe(record.schedule.algorithmId);
    expect(header.scheduleAbsentReason).toBeNull();

    // Two body rows, and the stored bytes are the returned bytes exactly.
    const stored = await bodies();
    expect(stored.map((row) => row.kind).sort()).toEqual(['input', 'schedule']);
    const byKind = new Map(stored.map((row) => [row.kind, row.bytes]));
    expect(byKind.get('input')).toBe(record.input.bytes);
    expect(byKind.get('schedule')).toBe(record.schedule.body.bytes);
  });

  it('takes each hash over the exact bytes it stored', async () => {
    const result = await save();
    if (result.outcome !== 'saved') throw new Error('expected a save');

    const stored = new Map((await bodies()).map((row) => [row.kind, row.bytes]));
    // Recomputed from the row, not from the record: this is the check the read
    // path (task 5.2) makes, and it only means anything if the hash was taken
    // over what SQLite holds rather than over a second rendering of the value.
    expect(sha256(stored.get('input')!)).toBe(result.record.input.sha256);
    expect(sha256(stored.get('schedule')!)).toBe(
      result.record.schedule.present ? result.record.schedule.body.sha256 : '',
    );
  });

  it('stores the input body a reader can parse back to the captured plan', async () => {
    const result = await save();
    if (result.outcome !== 'saved') throw new Error('expected a save');

    const parsed = JSON.parse(result.record.input.bytes) as {
      schemaVersion: number;
      project: { id: string; name: string; startDate: string | null };
      workItems: { id: string }[];
    };
    expect(parsed.schemaVersion).toBe(result.record.input.schemaVersion);
    expect(parsed.project.id).toBe('p1');
    expect(parsed.project.name).toBe('Rewire the shed');
    expect(parsed.project.startDate).toBe('2026-03-02');
    expect(parsed.workItems.map((row) => row.id)).toEqual(['wi-1', 'wi-2']);
  });

  /**
   * The account the route will authorise against reaches the stored row.
   *
   * Asserted off the header rather than off `result.record`, because the record
   * is what the service assembled and this is about what the repository wrote:
   * a `values()` that silently omitted the column would return a perfectly
   * correct record beside a row full of nulls.
   */
  it('carries the saving account through save to the stored header', async () => {
    const result = await service().save({
      projectId: 'p1',
      name: 'before the rewire',
      createdBy: 'Ada Lovelace',
      createdById: 'owner',
    });

    expect(result.outcome).toBe('saved');
    const rows = await headers();
    expect(rows.length).toBe(1);
    expect(rows[0]?.createdById).toBe('owner');
    // Different strings on purpose: equal ones would pass against an insert that
    // wrote the display name into the reference column.
    expect(rows[0]?.createdBy).toBe('Ada Lovelace');
  });

  it('answers no_project for a project that does not exist, and writes nothing', async () => {
    const result = await service().save({
      projectId: 'missing',
      name: 'x',
      createdBy: 'Ada Lovelace',
      createdById: null,
    });

    expect(result.outcome).toBe('no_project');
    expect((await headers()).length).toBe(0);
    expect((await bodies()).length).toBe(0);
  });

  it('saves a cyclic plan with no schedule and the reason infeasible', async () => {
    const seed = openConnection(path);
    const deps = new DependencyRepository(seed.db, OPEN);
    await deps.add(
      { id: 'd-1', projectId: 'p1', predecessorId: 'wi-1', successorId: 'wi-2' },
      wrote,
    );
    await deps.add(
      { id: 'd-2', projectId: 'p1', predecessorId: 'wi-2', successorId: 'wi-1' },
      wrote,
    );
    seed.close();

    const result = await save();

    expect(result.outcome).toBe('saved');
    if (result.outcome !== 'saved') return;
    // The plan is saved: a cycle is a reason there are no dates, not a reason
    // to refuse the input body a comparison would otherwise have nothing to
    // read. The dates are absent and say why.
    expect(result.record.schedule.present).toBe(false);
    const rows = await headers();
    expect(rows.length).toBe(1);
    expect(rows[0].scheduleAbsentReason).toBe('infeasible');
    expect(rows[0].scheduleBytes).toBeNull();
    expect(rows[0].scheduleSha256).toBeNull();
    expect(rows[0].schedulerAlgorithmId).toBeNull();
    // The input body is there in full, which is the whole point of saving it.
    expect((await bodies()).map((row) => row.kind)).toEqual(['input']);
  });

  it('refuses on the body limit before opening the write transaction', async () => {
    const refusing = new SavedPlanService({
      digest: nodeDigest,
      capture: new SavedPlanCaptureRepository({ openConnection: () => openConnection(path) }),
      plans: new SavedPlanRepository({ openConnection: () => openConnection(path) }),
      newId: () => 'sp-1',
      now: () => OPENED_AT,
      quota: { mostBytesPerBody: 8, mostPlansPerProject: 100, mostBytesPerProject: 64 * 1024 },
    });

    const result = await refusing.save({
      projectId: 'p1',
      name: 'too big',
      createdBy: 'Ada Lovelace',
      createdById: null,
    });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.refusal.limit).toBe('body_bytes');
    expect(result.refusal.allowed).toBe(8);
    expect((await headers()).length).toBe(0);
  });

  it('reads the body limit from construction, so raising it admits the same save', async () => {
    // The same save, the same bytes, one number moved. Without it, the refusal
    // above would also pass against a service that hard-codes a small bound.
    const admitting = new SavedPlanService({
      digest: nodeDigest,
      capture: new SavedPlanCaptureRepository({ openConnection: () => openConnection(path) }),
      plans: new SavedPlanRepository({ openConnection: () => openConnection(path) }),
      newId: () => 'sp-1',
      now: () => OPENED_AT,
      quota: {
        mostBytesPerBody: 8 * 1024 * 1024,
        mostPlansPerProject: 100,
        mostBytesPerProject: 64 * 1024 * 1024,
      },
    });

    const result = await admitting.save({
      projectId: 'p1',
      name: 'fits',
      createdBy: 'Ada Lovelace',
      createdById: null,
    });

    expect(result.outcome).toBe('saved');
    expect((await headers()).length).toBe(1);
  });

  it('reads the count limit from construction, so raising it admits the same save', async () => {
    // Task 4.7 names **the count**, and it is the limit worth naming: the body
    // bound above is a property of one save, while this one is a property of
    // the project and is the only one of the three a caller could plausibly
    // have hard-coded at the call site as `100`.
    let issued = 0;
    const capped = (mostPlansPerProject: number): SavedPlanService =>
      new SavedPlanService({
        digest: nodeDigest,
        capture: new SavedPlanCaptureRepository({ openConnection: () => openConnection(path) }),
        plans: new SavedPlanRepository({ openConnection: () => openConnection(path) }),
        // Distinct per save: two records is the state under test, and a reused
        // id would fail on the primary key instead of on the quota.
        newId: () => 'sp-' + String((issued += 1)),
        now: () => OPENED_AT,
        quota: {
          mostBytesPerBody: 8 * 1024 * 1024,
          mostPlansPerProject,
          mostBytesPerProject: 64 * 1024 * 1024,
        },
      });
    const request = {
      projectId: 'p1',
      name: 'once more',
      createdBy: 'Ada Lovelace',
      createdById: null,
    };

    expect((await capped(1).save(request)).outcome).toBe('saved');
    const refused = await capped(1).save(request);
    expect(refused.outcome).toBe('refused');
    if (refused.outcome !== 'refused') return;
    expect(refused.refusal.limit).toBe('plan_count');
    // The comparison is against the state *after* the save: one held, this
    // would be the second, and the limit is one.
    expect(refused.refusal.asked).toBe(2);
    expect(refused.refusal.allowed).toBe(1);
    expect((await headers()).length).toBe(1);

    // One number moved in configuration, nothing else: the same save lands.
    expect((await capped(2).save(request)).outcome).toBe('saved');
    expect((await headers()).length).toBe(2);
  });
});
