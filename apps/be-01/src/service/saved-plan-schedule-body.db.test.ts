import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addWorkdays,
  firstWorkdayOf,
  type IsoDate,
  lastWorkdayOf,
  type Schedule,
  SCHEDULE_ALGORITHM_ID,
  type Scheduled,
} from '@wbs/domain';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { CapacityRepository } from '../repository/capacity';
import { openConnection } from '../repository/db';
import { DirectoryRepository } from '../repository/directory';
import { EstimateRepository } from '../repository/estimate';
import { OPEN } from '../repository/gate';
import type { WriteStamp } from '../repository/index';
import { runMigrations } from '../repository/migrate';
import { ProjectRepository } from '../repository/project';
import { SavedPlanCaptureRepository } from '../repository/saved-plan-capture';
import { UserRepository } from '../repository/user';
import { WorkItemRepository } from '../repository/work-item';
import { projectRow } from '../testing/project-fixture';
import { captureAndSchedulePlan } from './saved-plan-schedule';
import {
  buildScheduleBody,
  SCHEDULE_BODY_SCHEMA_VERSION,
  serialiseScheduleBody,
} from './saved-plan-schedule-body';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

const wrote: WriteStamp = { at: 1, by: 'owner' };

/** A Monday, so the first workday of the plan is the start date itself. */
const START: IsoDate = '2026-01-05';

/**
 * The whole `Scheduled`/`ScheduledSlice` field set reaches the stored body.
 *
 * **The expectation is derived from the engine's return value, never written
 * out here**, and that is the point of the suite rather than a style choice.
 * An enumerated expectation and an enumerated writer read the same list, so
 * they agree about a field neither of them knows about — which is precisely the
 * silent drop this row exists to prevent. Spreading `planned`'s own values
 * means a field added to `Scheduled`, `ScheduledSlice` or `Schedule` tomorrow
 * appears in the expectation on the day it is added, and a writer that did not
 * carry it fails here naming the key.
 *
 * The negative that proves it can fail is recorded in `verify.md`:
 * `resourcePredecessorId` deleted from the writer's copy, watched red.
 */
describe('the stored schedule body', () => {
  let dir: string;
  let path: string;

  const seedProject = async (startDate: IsoDate | null): Promise<void> => {
    const seed = openConnection(path);
    const db = seed.db;
    await new UserRepository(db, OPEN).create(
      { id: 'owner', username: 'owner', passwordHash: 'x', createdAt: 1 },
      wrote,
    );
    await new ProjectRepository(db, OPEN).create(
      projectRow({
        id: 'p1',
        name: 'plan',
        ownerId: 'owner',
        estimateMethod: 'realistic',
        startDate,
      }),
      [{ id: 'st-1', projectId: 'p1', name: 'Dev', position: 10 }],
      wrote,
    );
    const directory = new DirectoryRepository(db, OPEN);
    await directory.addTeam({ id: 't-platform', name: 'Platform' }, wrote);
    await directory.addPerson({ id: 'pp-ada', name: 'Ada' }, ['t-platform'], wrote);
    await new CapacityRepository(db, OPEN).set('p1', 't-platform', 1, wrote);
    const items = new WorkItemRepository(db, OPEN);
    const estimates = new EstimateRepository(db, OPEN);
    // Three leaves of different lengths, all on one person: the second and
    // third queue behind the first, so `boundBy` is `person` and
    // `resourcePredecessorId` names a real slice rather than sitting null on
    // every row. A plan whose optional fields are all null would let the
    // negative below pass against a writer that dropped them.
    for (const [id, position, days] of [
      ['wi-1', 10, 3],
      ['wi-2', 20, 2],
      ['wi-3', 30, 4],
    ] as const) {
      await items.insert(
        {
          id,
          projectId: 'p1',
          parentId: null,
          position,
          name: id,
          notes: '',
          frozenNumber: null,
          priority: null,
          startNoEarlierThan: null,
          serviceTeamId: 't-platform',
          serviceId: null,
          maxParallel: 1,
          startNoEarlierThanReason: null,
          deadline: null,
          revision: 0,
        },
        [],
        wrote,
      );
      await estimates.set(
        {
          workItemId: id,
          stepId: 'st-1',
          optimistic: days,
          realistic: days,
          pessimistic: days,
        },
        wrote,
      );
      await directory.assign(id, 'st-1', 'pp-ada', wrote);
    }
    seed.close();
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wbs-saved-plan-body-'));
    path = join(dir, 'test.db');
    runMigrations(path, FOLDER);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const capture = (): SavedPlanCaptureRepository =>
    new SavedPlanCaptureRepository({ openConnection: () => openConnection(path) });

  /** The span the live table renders, recomputed here from the offsets alone. */
  const span = (
    timing: Scheduled,
    startDate: IsoDate | null,
  ): { startsOn: IsoDate | null; endsOn: IsoDate | null } =>
    startDate === null
      ? { startsOn: null, endsOn: null }
      : {
          startsOn: addWorkdays(startDate, firstWorkdayOf(timing.earliestStart)),
          endsOn: addWorkdays(
            startDate,
            lastWorkdayOf(timing.earliestStart, timing.earliestFinish),
          ),
        };

  /**
   * What the body should be, taken from `planned` itself.
   *
   * The top level walks the engine's own keys rather than naming them, minus
   * the one exclusion, for the same reason the per-timing spread does: a count
   * added to `Schedule` later is expected here without an edit.
   */
  const expectedBody = (planned: Schedule, startDate: IsoDate | null): Record<string, unknown> => {
    const expected: Record<string, unknown> = {
      version: SCHEDULE_BODY_SCHEMA_VERSION,
      algorithmId: SCHEDULE_ALGORITHM_ID,
    };
    for (const [key, value] of Object.entries(planned)) {
      if (key === 'eventsVisited') continue;
      expected[key] =
        value instanceof Map
          ? Object.fromEntries(
              [...(value as ReadonlyMap<string, Scheduled>)].map(([id, timing]) => [
                id,
                { ...timing, ...span(timing, startDate) },
              ]),
            )
          : value;
    }
    return expected;
  };

  it('is deep-equal to what schedule() returned, plus the dates', async () => {
    await seedProject(START);
    const result = await captureAndSchedulePlan(capture(), 'p1');
    expect(result).not.toBeNull();
    const { reads, planned } = result!;

    // Parsed back from the bytes, not the object handed to `JSON.stringify`:
    // a `Map`, a `Date` or an `undefined` survives an object comparison and
    // does not survive the round trip, and the body is stored as bytes.
    const stored: unknown = JSON.parse(
      JSON.stringify(buildScheduleBody(planned, reads.project.startDate, SCHEDULE_ALGORITHM_ID)),
    );

    expect(stored).toEqual(expectedBody(planned, START));
  });

  /**
   * The fixture actually exercises the optional fields.
   *
   * Without this the deep equality above would still pass on a plan where
   * `resourcePredecessorId` is null on every slice — and so would a writer that
   * dropped it, since `toEqual` compares `null` against a missing key but the
   * negative below would then have nothing to make fail. This asserts the
   * fixture's own shape, so an edit that flattens the plan fails here rather than
   * quietly weakening the row above.
   */
  it('is computed over a plan whose resource fields are set', async () => {
    await seedProject(START);
    const result = await captureAndSchedulePlan(capture(), 'p1');
    const planned = result!.planned;
    const slices = [...planned.slices.values()];
    expect(slices.length).toBe(3);
    expect(slices.some((each) => each.boundBy === 'person')).toBe(true);
    expect(slices.some((each) => each.resourcePredecessorId !== null)).toBe(true);
    expect(planned.waitingForPerson).toBeGreaterThan(0);
  });

  /**
   * The same schedule with every iteration order reversed.
   *
   * A `Map` iterates in insertion order and `JSON.stringify` emits an object's
   * keys in theirs, so this is the whole class of difference that is about how
   * the value was assembled rather than about the plan.
   */
  const reversed = <T extends Scheduled>(timings: ReadonlyMap<string, T>): Map<string, T> => {
    const out = new Map<string, T>();
    for (const [id, timing] of [...timings].reverse()) {
      const flipped: Record<string, unknown> = {};
      for (const key of Object.keys(timing).reverse()) {
        flipped[key] = (timing as unknown as Record<string, unknown>)[key];
      }
      out.set(id, flipped as unknown as T);
    }
    return out;
  };

  /**
   * The bytes are a fact about the plan, not about how the value was walked.
   *
   * The SHA-256 the header stores is taken over exactly these bytes, so a body
   * whose serialization depended on `Map` insertion order or on the engine's
   * field declaration order would hash differently after a refactor that
   * changed no dates at all — and an immutability check built on that hash
   * would report a plan as changed for a reason the plan knows nothing about.
   */
  it('serializes to the same bytes whatever order the value was assembled in', async () => {
    await seedProject(START);
    const result = await captureAndSchedulePlan(capture(), 'p1');
    const { planned } = result!;
    const bytes = serialiseScheduleBody(buildScheduleBody(planned, START, SCHEDULE_ALGORITHM_ID));

    const flipped: Schedule = {
      ...planned,
      slices: reversed(planned.slices),
      workItems: reversed(planned.workItems),
    };
    expect(serialiseScheduleBody(buildScheduleBody(flipped, START, SCHEDULE_ALGORITHM_ID))).toBe(
      bytes,
    );
    // And the sorting is real rather than the two walks coinciding: a plain
    // stringify of the flipped maps must differ from one of the originals.
    expect(JSON.stringify([...flipped.slices])).not.toBe(JSON.stringify([...planned.slices]));
  });

  it('carries the version and the algorithm identity', async () => {
    await seedProject(START);
    const result = await captureAndSchedulePlan(capture(), 'p1');
    const body = buildScheduleBody(result!.planned, START, SCHEDULE_ALGORITHM_ID);
    expect(body.version).toBe(SCHEDULE_BODY_SCHEMA_VERSION);
    expect(body.algorithmId).toBe(SCHEDULE_ALGORITHM_ID);
  });

  it('never stores eventsVisited', async () => {
    await seedProject(START);
    const result = await captureAndSchedulePlan(capture(), 'p1');
    const body: Record<string, unknown> = buildScheduleBody(
      result!.planned,
      START,
      SCHEDULE_ALGORITHM_ID,
    ) as never;
    expect('eventsVisited' in result!.planned).toBe(true);
    expect('eventsVisited' in body).toBe(false);
  });

  /**
   * A project off the calendar stores nulls, not an absent key.
   *
   * The key set of a stored body may not depend on whether the project had a
   * start date: slice 6's comparison reads key sets, and two bodies that
   * disagree about which keys exist compare as changed for a reason that is not
   * about the plan.
   */
  it('stores null dates rather than absent keys when the project has no start date', async () => {
    await seedProject(null);
    const result = await captureAndSchedulePlan(capture(), 'p1');
    const { reads, planned } = result!;
    expect(reads.project.startDate).toBeNull();
    const stored: unknown = JSON.parse(
      JSON.stringify(buildScheduleBody(planned, reads.project.startDate, SCHEDULE_ALGORITHM_ID)),
    );
    expect(stored).toEqual(expectedBody(planned, null));
    const { workItems } = stored as { workItems: Record<string, Record<string, unknown>> };
    const first = Object.values(workItems)[0];
    expect(first).toBeDefined();
    // `in`, then the value: an absent key and a null one are the same
    // `undefined` to a lookup, and the point of the row is that the key is
    // there even with no calendar to render it from.
    expect('startsOn' in first).toBe(true);
    expect(first['startsOn']).toBeNull();
  });
});
