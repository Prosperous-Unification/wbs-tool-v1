import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalisePlanInput, serialiseCanonicalPlanInput } from '@wbs/domain';
import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';

import { planInputRowsOf } from '../service/saved-plan-input';
import { bodySha256 } from '../service/saved-plan-integrity';
import { projectRow } from '../testing/project-fixture';
import { CalendarMarkerRepository } from './calendar-marker';
import { CapacityRepository } from './capacity';
import type { Connection, Drizzle } from './db';
import { openConnection, openDatabase } from './db';
import { DirectoryRepository } from './directory';
import type { WriteStamp } from './index';
import { runMigrations } from './migrate';
import { ProjectRepository } from './project';
import type { PlanInputReads } from './saved-plan-capture';
import { SavedPlanCaptureRepository } from './saved-plan-capture';
import { person, project, step, tag, workItem, workItemTag } from './schema';
import { UserRepository } from './user';
import { WorkItemRepository } from './work-item';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

const wrote: WriteStamp = { at: 1, by: 'owner' };

/**
 * A `sql.raw` statement in a form an assertion can match.
 *
 * Serialized rather than stringified: drizzle's `SQL` has no `toString` that
 * yields its text, so `String(statement)` is `[object Object]` — two of those
 * compare equal, and every assertion below would pass on any pair of raw
 * statements at all. The chunk shape is drizzle's, so the tests match on the
 * text they contain rather than pinning it.
 */
const rendered = (statement: unknown): string => JSON.stringify(statement);

/**
 * A connection whose raw statements and reads are recorded in one sequence.
 *
 * `select` is recorded as the literal `read` rather than as SQL: the claim
 * these tests make is about *enclosure* — which statements fall between the
 * `BEGIN` and the `COMMIT` — and rendering seventeen queries would assert their
 * text instead, which is the store's business and not this class's.
 */
interface TracingOptions {
  /** Throw from this read, counting from one, so the capture unwinds. */
  readonly failReadNumber?: number;
  /**
   * What some *other* caller commits just before this read. It stands in for an
   * in-flight request resuming across one of the capture's
   * `await Promise.resolve()` boundaries.
   *
   * `commit` is synchronous because this hook is: it runs inside the `select`
   * interceptor, where nothing can be awaited. That rules the async stores out
   * and is why the writes below are drizzle statements rather than
   * `WorkItemRepository.patch` — a limitation of the seam, stated rather than
   * hidden, and it costs the tests nothing they claim.
   */
  readonly foreignWrite?: { readonly atRead: number; readonly commit: () => void };
  /**
   * The connection the capture is handed. Given one, `close` is a no-op record
   * — the process handle is nobody's to close, which is itself part of what the
   * shared-handle shape gets wrong.
   */
  readonly reuse?: Connection;
}

const tracing = (
  path: string,
  trace: { statements: string[]; closes: number },
  options: TracingOptions = {},
): Connection => {
  const real = options.reuse ?? openConnection(path);
  let reads = 0;
  const db = new Proxy(real.db, {
    get(target, prop, receiver): unknown {
      if (prop === 'run') {
        return (...args: unknown[]): unknown => {
          trace.statements.push(rendered(args[0]));
          return (target.run as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (prop === 'select') {
        return (...args: unknown[]): unknown => {
          reads += 1;
          trace.statements.push('read');
          const foreign = options.foreignWrite;
          if (reads === foreign?.atRead) {
            foreign.commit();
          }
          if (options.failReadNumber !== undefined && reads === options.failReadNumber) {
            throw new Error('the store fell over mid-capture');
          }
          return (target.select as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  return {
    db,
    close: () => {
      trace.closes += 1;
      if (options.reuse === undefined) real.close();
    },
  };
};

/**
 * The read snapshot 3.1 is, proved on a real database file.
 *
 * Two separate claims live here and they fail for different reasons. The first
 * is *enclosure*: every read the capture makes falls inside one
 * `BEGIN DEFERRED` on a connection this class opened for itself. The second is
 * coverage: the capture-only reads exist because the live projection has two
 * holes, and both are seeded below rather than described.
 */
describe('capturing a project’s plan input', () => {
  let dir: string;
  let path: string;
  let sqlite: Database;
  let trace: { statements: string[]; closes: number };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wbs-saved-plan-capture-'));
    path = join(dir, 'test.db');
    runMigrations(path, FOLDER);
    sqlite = openDatabase(path);
    const seed = openConnection(path);
    const db = seed.db;
    await new UserRepository(db).create(
      { id: 'owner', username: 'owner', passwordHash: 'x', createdAt: 1 },
      wrote,
    );
    await new ProjectRepository(db).create(
      // `name` and `estimateMethod` are generation markers for the torn-read
      // cases below: `before`/`pert` is the seeded state, and the one edit
      // committed mid-capture moves both.
      projectRow({ id: 'p1', name: 'before', ownerId: 'owner', estimateMethod: 'pert' }),
      [{ id: 'st-1', projectId: 'p1', name: 'before', position: 10 }],
      wrote,
    );
    const directory = new DirectoryRepository(db);
    // The first hole: a team the capacity map names and no junction row does.
    await directory.addTeam({ id: 't-platform', name: 'Platform' }, wrote);
    // The second: a person on a team and on no work item.
    await directory.addPerson({ id: 'pp-unassigned', name: 'Ada' }, ['t-platform'], wrote);
    await directory.addTag({ id: 'tag-1', name: 'urgent' }, wrote);
    await directory.addService({ id: 'svc-1', name: 'Wiring' }, wrote);
    await directory.addWorkItemType({ id: 'wit-1', name: 'Task' }, wrote);
    await new CapacityRepository(db).set('p1', 't-platform', 4, wrote);
    const items = new WorkItemRepository(db);
    await items.insert(
      {
        id: 'wi-1',
        projectId: 'p1',
        parentId: null,
        position: 10,
        name: 'before',
        notes: '',
        frozenNumber: null,
        priority: null,
        startNoEarlierThan: null,
        serviceTeamId: null,
        serviceId: null,
        maxParallel: 1,
        startNoEarlierThanReason: null,
        revision: 0,
      },
      [],
      wrote,
    );
    // The junction row, seeded so the mid-capture edit can *remove* it: a
    // delete needs no audit columns, and the direction is immaterial to what is
    // being asserted.
    await items.patch('wi-1', { tagIds: ['tag-1'] }, wrote);
    seed.close();
    trace = { statements: [], closes: 0 };
  });

  afterEach(() => {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const capture = (options: TracingOptions = {}): SavedPlanCaptureRepository =>
    new SavedPlanCaptureRepository({
      openConnection: () => tracing(path, trace, options),
    });

  /** The tag name as a connection outside the capture can see it. */
  const tagNameNow = (): string => {
    const seen = openConnection(path);
    try {
      return (
        seen.db.all<{ name: string }>(sql.raw("SELECT name FROM tag WHERE id = 'tag-1'"))[0]
          ?.name ?? 'gone'
      );
    } finally {
      seen.close();
    }
  };

  /**
   * **A calendar marker changes no saved plan's `input_sha256`** — task 5.2.
   *
   * The hash is reproduced through the product's own pipeline rather than
   * re-implemented: `planInputRowsOf` → `canonicalisePlanInput` →
   * `serialiseCanonicalPlanInput` → `bodySha256`, which is exactly the
   * composition `SavedPlanService.save` writes `input_sha256` from
   * (`saved-plan.service.ts:667-668`). Hashing my own rendering of
   * `PlanInputReads` would be asserting my own serializer.
   *
   * **This assertion passes on `main` today, and the task says so.**
   * `readPlanInput` reads a fixed set of tables and `calendar_marker` is not
   * among them, so equality holds before a line of this feature is written.
   * That is what makes the watched negative the whole content of the slice —
   * without it this is 5.1's own trap committed one slice later.
   *
   * Proof, watched 2026-09-05: with a `calendar_marker` read added inside
   * `readPlanInput()` and its rows returned on the `PlanInputReads` that
   * `planInputRowsOf` folds into the body, the two hashes differ and this case
   * is the only one in the file that goes red. Removed after.
   */
  it('leaves the plan input hash byte-identical when markers are added', async () => {
    const hashNow = async (): Promise<string> => {
      const reads = await capture().readPlanInput('p1');
      expect(reads).not.toBeNull();
      return bodySha256(
        serialiseCanonicalPlanInput(canonicalisePlanInput(planInputRowsOf(reads!))),
      );
    };

    const before = await hashNow();

    // Written on the same connection the seed used, not through the capture's
    // — the claim is about a database that has markers in it, whoever put them
    // there.
    const writing = openConnection(path);
    const markers = new CalendarMarkerRepository(writing.db);
    for (const [index, date] of ['2026-08-18', '2026-08-20', '2026-08-25'].entries()) {
      const written = await markers.create({
        id: `cm-${String(index)}`,
        projectId: 'p1',
        date,
        name: `Marker ${String(index)}`,
        color: null,
        createdAt: 1,
      });
      expect(written.ok).toBe(true);
    }
    // The rows really are there, so "the hash did not move" is a claim about a
    // project with markers rather than about a failed write.
    expect(await new CalendarMarkerRepository(writing.db).listFor('p1')).toHaveLength(3);
    writing.close();

    expect(await hashNow()).toBe(before);
  });

  it('reads everything inside one deferred transaction and closes its connection', async () => {
    // Proof, watched 2026-09-03: with `tx.begin()` moved after the first read —
    // the shape a maintainer writes when the project probe feels like it
    // belongs outside the block — `statements[0]` is `read`, not
    // `BEGIN DEFERRED`, and this fails on the first assertion. With the
    // transaction dropped altogether the first and last assertions both fail.
    const read = await capture().readPlanInput('p1');

    expect(read).not.toBeNull();
    expect(trace.statements.at(0)).toContain('BEGIN DEFERRED');
    expect(trace.statements.at(-1)).toContain('COMMIT');
    // Seventeen reads, and no statement outside the block. Counted rather than
    // listed: which store issues which query is the store's business, but a read
    // that escaped the snapshot would land outside these bounds.
    expect(trace.statements.filter((each) => each === 'read').length).toBeGreaterThanOrEqual(17);
    expect(trace.closes).toBe(1);
  });

  it('captures the team the capacity map names and the person nobody is assigned to', async () => {
    // The whole reason the capture-only reads exist. `slotsFor` is keyed by team
    // id, and the projection's people read is filtered to assigned ids, so both
    // of these rows are named by the plan and captured by nothing the projection
    // does. Proof, watched 2026-09-03: with `listTeams`/`listPeople` dropped from
    // `readPlanInput` the project still captures, every other assertion in this
    // file still passes, and these two expectations go red.
    const read = await capture().readPlanInput('p1');

    expect(read?.capacity.get('t-platform')).toBe(4);
    expect(read?.teams.map((each) => each.id)).toContain('t-platform');
    expect(read?.assignments).toEqual([]);
    expect(read?.people.map((each) => each.id)).toContain('pp-unassigned');
    // The three registries, captured by value for the same reason.
    expect(read?.tags.map((each) => each.id)).toContain('tag-1');
    expect(read?.services.map((each) => each.id)).toContain('svc-1');
    expect(read?.workItemTypes.map((each) => each.id)).toContain('wit-1');
  });

  it('answers null for a project it cannot find, and still closes the connection', async () => {
    expect(await capture().readPlanInput('nope')).toBeNull();
    expect(trace.statements.at(0)).toContain('BEGIN DEFERRED');
    expect(trace.statements.at(-1)).toContain('COMMIT');
    expect(trace.closes).toBe(1);
  });

  it('rolls back and closes the connection when a read throws', async () => {
    // Proof, watched 2026-09-03: with the `finally` removed from
    // `readPlanInput`, `trace.closes` is 0 here and the connection is a leaked
    // WAL reader — which during a blue/green swap is the other colour's problem
    // and shows up nowhere near this test.
    let thrown: unknown;
    try {
      await capture({ failReadNumber: 3 }).readPlanInput('p1');
    } catch (err) {
      thrown = err;
    }

    expect((thrown as Error | undefined)?.message).toContain('fell over mid-capture');
    expect(trace.statements.at(-1)).toContain('ROLLBACK');
    expect(trace.closes).toBe(1);
  });

  it('does not enclose a stranger’s write, because the snapshot is on its own connection', async () => {
    // The positive half of the pair below, and the reason the dedicated
    // connection is worth its one extra open: a write another caller commits on
    // the process handle mid-capture is that caller's, and the capture's
    // rollback leaves it exactly where it landed.
    const elsewhere = openConnection(path);
    try {
      let thrown: unknown;
      try {
        await capture({
          failReadNumber: 4,
          foreignWrite: {
            atRead: 2,
            commit: () => {
              elsewhere.db.run(sql.raw("UPDATE tag SET name = 'renamed' WHERE id = 'tag-1'"));
            },
          },
        }).readPlanInput('p1');
      } catch (err) {
        thrown = err;
      }

      expect((thrown as Error | undefined)?.message).toContain('fell over mid-capture');
      expect(tagNameNow()).toBe('renamed');
    } finally {
      elsewhere.close();
    }
  });

  it('encloses that same write when the capture is run on the shared process handle', async () => {
    // **3.2's first negative, and what settles design.md's hypothesis.** Run the
    // identical scenario on the handle `boot.ts:64` opens for the whole process
    // — the shape `readPlanInput` refuses — and the stranger's write is inside
    // the capture's transaction: the capture unwinds and takes a committed-
    // looking rename with it. Nothing in the writing request can see that
    // happen; it was told its edit succeeded.
    //
    // Watched 2026-09-03: this is the same assertion as the test above with one
    // thing changed, the connection the capture is handed, and it inverts.
    const shared = openConnection(path);
    try {
      let thrown: unknown;
      try {
        await capture({
          reuse: shared,
          failReadNumber: 4,
          foreignWrite: {
            atRead: 2,
            commit: () => {
              shared.db.run(sql.raw("UPDATE tag SET name = 'renamed' WHERE id = 'tag-1'"));
            },
          },
        }).readPlanInput('p1');
      } catch (err) {
        thrown = err;
      }

      expect((thrown as Error | undefined)?.message).toContain('fell over mid-capture');
      expect(tagNameNow()).toBe('urgent');
    } finally {
      shared.close();
    }
  });

  /**
   * One edit, committed as a single transaction by a connection that is not the
   * capture's — the two connections standing in for blue and green.
   *
   * It is spread deliberately across the read order rather than aimed at one
   * table: the project row (read 1), the work item and the `work_item_tag`
   * junction folded into it (read 2), a step (read 9), a person and the
   * `person_team` row that cascades with it (read 12), and the `tag` registry
   * (read 15). A capture that tore anywhere between the first read and the last
   * would show some of these moved and some not — which is exactly the failure
   * mode a revision counter cannot see, since `tag` and `person_team` carry no
   * revision column at all.
   */
  const commitTheEdit = (writer: Drizzle): void => {
    writer.transaction((tx) => {
      tx.update(project)
        .set({ name: 'after', estimateMethod: 'pessimistic' })
        .where(eq(project.id, 'p1'))
        .run();
      tx.update(workItem).set({ name: 'after' }).where(eq(workItem.id, 'wi-1')).run();
      tx.delete(workItemTag).where(eq(workItemTag.workItemId, 'wi-1')).run();
      tx.update(step).set({ name: 'after' }).where(eq(step.id, 'st-1')).run();
      tx.delete(person).where(eq(person.id, 'pp-unassigned')).run();
      tx.update(tag).set({ name: 'after' }).where(eq(tag.id, 'tag-1')).run();
    });
  };

  /**
   * Which side of {@link commitTheEdit} each captured value came from.
   *
   * Every entry is read off the capture rather than off the database, and each
   * one comes from a *different* read, so a torn capture is a witness whose
   * values disagree. Rows that are missing entirely are reported as `missing`
   * rather than folded into `after`, because a dropped read and a post-edit read
   * are not the same defect and must not be able to impersonate each other.
   */
  const sides = (read: PlanInputReads): Record<string, string> => {
    const item = read.workItems.find((each) => each.id === 'wi-1');
    const seededStep = read.steps.find((each) => each.id === 'st-1');
    const seededTag = read.tags.find((each) => each.id === 'tag-1');
    const side = (found: boolean, isBefore: boolean): string =>
      !found ? 'missing' : isBefore ? 'before' : 'after';
    return {
      // read 1 — a rename and a settings change on the project row.
      projectName: side(true, read.project.name === 'before'),
      estimateMethod: side(true, read.project.estimateMethod === 'pert'),
      // read 2 — the item, and the junction the labelled row folds in.
      workItemName: side(item !== undefined, item?.name === 'before'),
      tagJunction: side(item !== undefined, item?.tagIds.includes('tag-1') === true),
      // read 9 — the step edit.
      stepName: side(seededStep !== undefined, seededStep?.name === 'before'),
      // read 12 — the directory cascade: the person, and its `person_team` row.
      unassignedPerson: side(
        true,
        read.people.some((each) => each.id === 'pp-unassigned'),
      ),
      // read 15 — the registry rename, the case with no revision column behind it.
      tagName: side(seededTag !== undefined, seededTag?.name === 'urgent'),
    };
  };

  // 3.2's positive: **every** read boundary, capture-only ones included, not
  // just the twelve the projection shares. Each boundary is its own `it` so the
  // fixture is reseeded — one `it` looping over all seventeen would leave the
  // database in the post-edit state after the first pass and assert nothing
  // afterwards.
  for (let boundary = 1; boundary <= 17; boundary += 1) {
    it(`captures entirely before or entirely after an edit committed at read ${String(boundary)}`, async () => {
      const green = openConnection(path);
      let read: PlanInputReads | null;
      try {
        read = await capture({
          foreignWrite: {
            atRead: boundary,
            commit: () => {
              commitTheEdit(green.db);
            },
          },
        }).readPlanInput('p1');
      } finally {
        green.close();
      }

      expect(read).not.toBeNull();
      const witness = sides(read!);
      // The whole claim, in one line: seven values from seven different reads,
      // and one side between them.
      expect(new Set(Object.values(witness)).size).toBe(1);
      // Named separately so a failure says *which* side, and so a capture that
      // lost every marker at once cannot pass by being uniformly `missing`.
      expect(['before', 'after']).toContain(witness['projectName']);
      // The edit really did land: the capture's snapshot is a snapshot, not a
      // write that never happened.
      expect(tagNameNow()).toBe('after');
    });
  }
});
