import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalisePlanInput, serialiseCanonicalPlanInput } from '@wbs/domain';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { CapacityRepository } from '../repository/capacity';
import type { Connection, Drizzle } from '../repository/db';
import { openConnection } from '../repository/db';
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
import { fastScheduler } from './optimizer-wiring';
import { SavedPlanService } from './saved-plan.service';
import { planInputRowsOf } from './saved-plan-input';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

const wrote: WriteStamp = { at: 1, by: 'owner' };

const OPENED_AT = 1_756_000_123;
const PLAN_ID = 'sp-1';

/**
 * The three boundaries task 4.3 names, as a union rather than three booleans.
 *
 * Named for the gap they sit in rather than for the statement they break,
 * because the property is about the gap: a save that dies there leaves no
 * header, no body, and an untouched live plan.
 */
type Boundary = 'between header and input body' | 'between the two bodies' | 'at commit';

/** The failure injected. Its identity is asserted, so it is one value. */
const INJECTED = new Error('injected write failure');

/** A dying write connection, and how far the save got before it died. */
interface Faulting {
  /** Handed to {@link SavedPlanRepository} as its `openConnection`. */
  readonly open: () => Connection;
  /**
   * Body inserts that actually reached SQLite before the failure — 0, 1 and 2
   * for the three boundaries in order. This is what tells the three cases
   * apart: "no header, no body" is true of all of them, so without it an
   * injector that fired at one boundary three times would pass three times.
   */
  readonly reached: () => number;
}

/**
 * A write connection that dies at one boundary inside `SavedPlanRepository.write`.
 *
 * The seam is `openConnection`, which the repository already takes injected, so
 * nothing test-only is added to the production class: the ordering under test is
 * the shipped ordering rather than a copy of it with hooks in the gaps.
 *
 * The two body boundaries are identified **by table**, not by counting every
 * insert — `savedPlanBody` insert 1 is the input body and insert 2 the schedule
 * body, which stays true if the header ever grows a second row.
 *
 * `at commit` is identified **by state**, which is the only honest way here:
 * this file may not import `drizzle-orm` (eslint confines it to `repository/`),
 * so the `COMMIT` statement object cannot be compared against anything. Instead
 * the interceptor fires at the first raw statement issued while this save's
 * header is already visible *on this connection* — precisely the commit, since
 * `BEGIN IMMEDIATE` is issued before any insert and no other connection can see
 * an uncommitted row. `fired` makes it fire once: `write`'s rollback is a raw
 * statement in the same still-open transaction and must reach SQLite, or the
 * case would prove nothing about rolling back.
 */
function faultingAt(path: string, boundary: Boundary): Faulting {
  let fired = false;
  let bodyInserts = 0;
  let reached = 0;
  const fire = (): never => {
    fired = true;
    throw INJECTED;
  };
  const open = (): Connection => {
    const real = openConnection(path);
    // Own-property overrides on a delegate whose prototype is the real client,
    // so every method this test does not name still runs drizzle's own, with the
    // real client's `session` and `dialect` reached through the chain.
    const db = Object.create(real.db) as Drizzle;
    Object.assign(db, {
      insert(table: Parameters<Drizzle['insert']>[0]) {
        if (table === savedPlanBody) {
          bodyInserts += 1;
          if (boundary === 'between header and input body' && bodyInserts === 1) fire();
          if (boundary === 'between the two bodies' && bodyInserts === 2) fire();
          reached += 1;
        }
        return real.db.insert(table);
      },
      run(statement: Parameters<Drizzle['run']>[0]) {
        const holdsThisHeader =
          !fired &&
          boundary === 'at commit' &&
          real.db
            .select()
            .from(savedPlan)
            .all()
            .some((row) => row.id === PLAN_ID);
        if (holdsThisHeader) fire();
        real.db.run(statement);
      },
    });
    return { db, close: real.close };
  };
  return { open, reached: () => reached };
}

describe('SavedPlanService.save is atomic', () => {
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
    dir = mkdtempSync(join(tmpdir(), 'wbs-saved-plan-atomicity-'));
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

  const capture = (): SavedPlanCaptureRepository =>
    new SavedPlanCaptureRepository({ openConnection: () => openConnection(path) });

  const headers = () => reader.db.select().from(savedPlan);
  const bodies = () => reader.db.select().from(savedPlanBody);

  /**
   * The live plan, as the bytes the next save would store.
   *
   * Not a row count and not a field list: the canonical input body is the
   * complete statement of what a save reads, so its bytes before against after
   * is "the live plan is untouched" with nothing left over. A count assertion
   * stays green for an edit that only replaced a name.
   */
  const livePlanBytes = async (): Promise<string> => {
    const reads = await capture().readPlanInput('p1');
    if (reads === null) throw new Error('expected the project to still exist');
    return serialiseCanonicalPlanInput(canonicalisePlanInput(planInputRowsOf(reads)));
  };

  const cases: { boundary: Boundary; bodiesWritten: number }[] = [
    { boundary: 'between header and input body', bodiesWritten: 0 },
    { boundary: 'between the two bodies', bodiesWritten: 1 },
    { boundary: 'at commit', bodiesWritten: 2 },
  ];

  for (const { boundary, bodiesWritten } of cases) {
    it(`leaves no header, no body and an untouched live plan when it fails ${boundary}`, async () => {
      const before = await livePlanBytes();
      const faulting = faultingAt(path, boundary);
      const service = new SavedPlanService({
        scheduler: fastScheduler,
        digest: nodeDigest,
        capture: capture(),
        plans: new SavedPlanRepository({ openConnection: faulting.open }),
        newId: () => PLAN_ID,
        now: () => OPENED_AT,
      });

      // Awaited through a catch rather than `.rejects`, which in this suite is
      // load-bearing twice over: bun's matcher is not thenable so `await-thenable`
      // refuses the await, and an unawaited `.rejects` would let the assertions
      // below run against a write that has not finished failing yet.
      //
      // The identity is asserted, not merely that something threw: a save that
      // tripped over a constraint of its own would also reject, and would say
      // nothing about what a failure *at this boundary* leaves behind.
      let refused: unknown = null;
      try {
        await service.save({
          projectId: 'p1',
          name: 'lost',
          createdBy: 'Ada',
          createdById: null,
        });
      } catch (thrown) {
        refused = thrown;
      }
      expect(refused).toBe(INJECTED);

      // The boundary was the one claimed, and not one of the other two.
      expect(faulting.reached()).toBe(bodiesWritten);

      expect(await headers()).toEqual([]);
      expect(await bodies()).toEqual([]);
      expect(await livePlanBytes()).toBe(before);
    });
  }
});
