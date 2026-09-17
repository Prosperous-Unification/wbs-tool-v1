import { describe, expect, it } from 'bun:test';

import type { PlannedRow } from './derive-numbers';
import { type PoolSizes, type Schedule, schedule, type Slice, sliceKey } from './schedule';
import {
  CACHE_DTO_VERSION,
  decodeSchedule,
  encodeSchedule,
  type StoredSchedule,
} from './schedule-cache-dto';

/**
 * The cache payload seam (tasks.md 4.12): what a stored plan keeps, and the four
 * ways a stored plan is refused rather than served.
 *
 * Every case here runs against a plan the **real engine** produced, not against
 * a literal: the defect this seam exists for is that `JSON.stringify` renders a
 * `Map` as `{}`, and a hand-written fixture would be a second implementation of
 * the shape under test — it would agree with whatever the encoder happened to
 * emit. `schedule()` is the oracle.
 */

const DEV = 'step-dev';
const PLATFORM = 'team-platform';

let position = 0;
const item = (id: string): PlannedRow => ({
  id,
  parentId: null,
  position: (position += 10),
  frozenNumber: null,
  priority: null,
});

const slice = (workItemId: string, days: number, extra: Partial<Slice> = {}): Slice => ({
  workItemId,
  stepId: DEV,
  days,
  personId: null,
  width: 1,
  poolIds: [PLATFORM],
  ...extra,
});

const pool = (size: number): PoolSizes => new Map([[PLATFORM, size]]);

/**
 * A plan with a real capacity wait in it.
 *
 * A pool of one and three two-day blocks, so two of the three are held by the
 * pool: `waitingForCapacity`, `capacityPredecessorIds`, `capacityTeamId` and
 * `resourcePredecessorId` are all non-empty, and `eventsVisited` counts a
 * levelling pass that actually ran. A round trip over a plan where those were
 * all zero and null would prove nothing about them.
 */
function realPlan(): Schedule {
  const rows = [item('a'), item('b'), item('c')];
  const slices = [slice('a', 2), slice('b', 2), slice('c', 2)];
  return schedule(rows, [], slices, new Map(), pool(1));
}

/** The trip a cached row actually takes: encode, through SQLite's TEXT, decode. */
function throughJson(plan: Schedule): Schedule {
  return decodeSchedule(JSON.parse(JSON.stringify(encodeSchedule(plan))));
}

/** A stored payload, mutable, for the negatives below. */
function stored(plan: Schedule): StoredSchedule {
  return JSON.parse(JSON.stringify(encodeSchedule(plan))) as StoredSchedule;
}

describe('what a stored schedule keeps', () => {
  it('reloads a real plan whole, maps and projections included', () => {
    const plan = realPlan();

    // The fixture is load-bearing: a plan with nothing waiting would let an
    // encoder that dropped the three counters pass.
    expect(plan.slices.size).toBe(3);
    expect(plan.workItems.size).toBe(3);
    expect(plan.waitingForCapacity).toBeGreaterThan(0);
    expect(plan.eventsVisited).toBeGreaterThan(0);
    const held = [...plan.slices.values()].filter((one) => one.boundBy === 'capacity');
    expect(held.length).toBeGreaterThan(0);
    expect(held[0]?.capacityPredecessorIds.length).toBeGreaterThan(0);
    expect(held[0]?.capacityTeamId).toBe(PLATFORM);

    expect(throughJson(plan)).toEqual(plan);
  });

  it('is why the seam exists: the plan itself stringifies to empty maps', () => {
    const plan = realPlan();

    // Not a straw man — this is the shape an implementation storing the
    // `Schedule` directly would write, and it type-checks everywhere.
    const naive = JSON.parse(JSON.stringify(plan)) as { slices: unknown; workItems: unknown };
    expect(naive.slices).toEqual({});
    expect(naive.workItems).toEqual({});

    const dto = encodeSchedule(plan);
    expect(dto.slices).toHaveLength(3);
    expect(dto.workItems).toHaveLength(3);
    expect(dto.dtoVersion).toBe(CACHE_DTO_VERSION);
  });

  it('keeps a parent, whose workItems entry no slice names', () => {
    // `workItems` is not the slice ids. A parent has no work of its own — it has
    // a span — so it carries an entry and no slice, on every plan with a tree in
    // it. design.md's "workItems covering exactly the projected ids" therefore
    // cannot be read as set equality: a decoder enforcing the reverse direction
    // would reject every plan that has a parent row.
    const rows: PlannedRow[] = [
      { id: 'p', parentId: null, position: 10, frozenNumber: null, priority: null },
      { id: 'kid', parentId: 'p', position: 20, frozenNumber: null, priority: null },
    ];
    const plan = schedule(rows, [], [slice('kid', 2)], new Map(), pool(1));

    expect(plan.workItems.has('p')).toBe(true);
    expect([...plan.slices.values()].some((one) => one.workItemId === 'p')).toBe(false);

    expect(throughJson(plan)).toEqual(plan);
  });

  it('emits one encoding per plan, whatever order the maps were built in', () => {
    const plan = realPlan();

    // The same plan with both maps rebuilt in reverse key order. A `Map`
    // iterates in insertion order, so this is a real second insertion order for
    // one schedule — which is the thing that must not reach the row, because a
    // row whose bytes depend on it cannot be compared between two runs.
    const reversed: Schedule = {
      ...plan,
      slices: new Map([...plan.slices].reverse()),
      workItems: new Map([...plan.workItems].reverse()),
    };
    expect([...reversed.slices.keys()]).not.toEqual([...plan.slices.keys()]);

    expect(JSON.stringify(encodeSchedule(reversed))).toBe(JSON.stringify(encodeSchedule(plan)));
    expect(encodeSchedule(plan).slices.map((entry) => entry.key)).toEqual(
      [...plan.slices.keys()].sort(),
    );
  });
});

describe('what a stored schedule refuses', () => {
  it('refuses a dtoVersion this release does not read, naming it', () => {
    const payload = { ...stored(realPlan()), dtoVersion: CACHE_DTO_VERSION + 1 };

    expect(() => decodeSchedule(payload)).toThrow(
      `stored schedule: unknown dtoVersion ${String(CACHE_DTO_VERSION + 1)}; this release reads ${String(CACHE_DTO_VERSION)}`,
    );
  });

  it('refuses the version-1 row written before slices carried a lateBy', () => {
    // The direction that actually happened, and the one the case above cannot
    // stand in for: a row a *previous* release wrote. `ScheduledSlice.lateBy`
    // is required as of 2026-09-06 and version 1 has no such field, and this
    // decoder deliberately does not validate per-entry shapes — it casts. So
    // the fence is the only thing between an old row and a served plan whose
    // every slice reads `lateBy === undefined` where the contract promises
    // `number | null`.
    //
    // Built by deleting the field rather than by hand, so the payload is
    // exactly the old shape and not an approximation of it.
    const payload = stored(realPlan());
    const version1 = {
      ...payload,
      dtoVersion: 1,
      slices: payload.slices.map((entry) => {
        // Deleted off a loose copy rather than destructured away: `lateBy` is
        // required on `ScheduledSlice`, so the rest-sibling form leaves a bound
        // name this package's lint rejects and `delete` needs the field to be
        // optional. A `Record` is what a stored row is anyway.
        const value: Record<string, unknown> = { ...entry.value };
        delete value['lateBy'];
        return { key: entry.key, value };
      }),
    };
    expect(version1.slices.every((entry) => !('lateBy' in entry.value))).toBe(true);

    expect(() => decodeSchedule(version1)).toThrow(
      `stored schedule: unknown dtoVersion 1; this release reads ${String(CACHE_DTO_VERSION)}`,
    );
  });

  it('refuses one key carried twice, rather than taking the last of them', () => {
    const payload = stored(realPlan());
    // `.at(0)` rather than `[0]`: this package does not compile with
    // `noUncheckedIndexedAccess`, so an index read is typed non-optional and the
    // fixture guard below would be dead code the linter refuses.
    const first = payload.slices.at(0);
    if (first === undefined) throw new Error('broken fixture: no slices');
    payload.slices.push({ ...first });

    expect(() => decodeSchedule(payload)).toThrow(
      `stored schedule: slices carries the key ${JSON.stringify(first.key)} twice`,
    );
  });

  it('refuses a key that disagrees with the entry beside it', () => {
    const payload = stored(realPlan());
    const first = payload.slices.at(0);
    if (first === undefined) throw new Error('broken fixture: no slices');
    // The entry still describes `a`; the key now names a slice that is not in
    // the plan at all. Deliberately not `b`'s key — that collides with `b`'s own
    // entry and the duplicate guard fires first, which is a different case and
    // was watched passing for the wrong reason before this comment existed.
    first.key = sliceKey('zzz', DEV);

    expect(() => decodeSchedule(payload)).toThrow(
      `stored schedule: slices carries the key ${JSON.stringify(sliceKey('zzz', DEV))} against an entry whose own key is ${JSON.stringify(sliceKey('a', DEV))}`,
    );
  });

  it('refuses a slice whose work item has no projection', () => {
    const payload = stored(realPlan());
    payload.workItems = payload.workItems.filter((entry) => entry.key !== 'a');

    expect(() => decodeSchedule(payload)).toThrow(
      `stored schedule: slices[${JSON.stringify(sliceKey('a', DEV))}] has no workItems projection for "a"`,
    );
  });
});
