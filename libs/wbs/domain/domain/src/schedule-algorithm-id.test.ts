import { describe, expect, it } from 'bun:test';

import type { PlannedRow } from './derive-numbers';
import type { DependencyReach } from './index';
import type {
  DependencyEdge,
  PoolSizes,
  Schedule,
  Scheduled,
  ScheduledSlice,
  Slice,
} from './schedule';
import { schedule, SCHEDULE_ALGORITHM_ID } from './schedule';

/**
 * The enforcement `SCHEDULE_ALGORITHM_ID` cannot supply on its own.
 *
 * A saved plan stores that string so a reader can ask "were these dates
 * computed by the engine running now?". The value only answers that question if
 * it moves when the engine's behaviour moves, and a constant has no way to
 * notice that it did not. So the behaviour is digested over a fixed corpus and
 * the digest is pinned **beside** the id: a semantics change turns one test red
 * naming both, and the fix is to bump the id and re-pin the digest in the same
 * commit.
 *
 * The digest is over behaviour, not over `schedule.ts`'s bytes, and the
 * difference is the whole point. A source hash moves on a comment edit, so it
 * would be re-pinned by rote within a month and would then be noise rather than
 * a gate; a behavioural digest is silent through every refactor and rename, and
 * speaks exactly when some input produces a different `Schedule`.
 *
 * **What it does not do** is decide the new id for you. It cannot: it detects
 * that behaviour changed, and whether that is a bump or a bug is a human call.
 */

/** The engine's own signature, so the negatives below can stand in for it. */
type ScheduleFn = (
  rows: readonly PlannedRow[],
  edges: readonly DependencyEdge[],
  slices: readonly Slice[],
  notBefore?: ReadonlyMap<string, number>,
  poolSizes?: PoolSizes,
  reach?: DependencyReach,
) => Schedule;

interface ScheduleCase {
  name: string;
  rows: readonly PlannedRow[];
  edges: readonly DependencyEdge[];
  slices: readonly Slice[];
  notBefore?: ReadonlyMap<string, number>;
  poolSizes?: PoolSizes;
  reach?: DependencyReach;
}

const DEV = 'step-dev';
const QA = 'step-qa';

const item = (id: string, parentId: string | null, position: number): PlannedRow => ({
  id,
  parentId,
  position,
  frozenNumber: null,
  priority: null,
});

const slice = (
  workItemId: string,
  stepId: string | null,
  days: number | null,
  extra: Partial<Slice> = {},
): Slice => ({
  workItemId,
  stepId,
  days,
  personId: null,
  width: 1,
  poolIds: [],
  ...extra,
});

/**
 * Plans chosen so that every mechanism in the pass decides something.
 *
 * Each case exists to make one class of edit visible: drop a case and the
 * semantics it covers can change under a green digest. A chain and a diamond
 * pin the forward and backward passes and therefore float and criticality; the
 * step case pins `stepOrder`; the `notBefore` case pins that a manual floor
 * pushes and never pins; the person case pins the levelling queue and
 * `waitingForPerson`; the pool case pins reservations, `capacityTeamId`, the
 * whole `capacityPredecessorIds` set and `waitingForCapacity`; the unestimated
 * case pins `ASSUMED_SLICE_WORKDAYS` and the `estimated` flag; and the
 * `anchor-slice` case pins the reach mode, which is a parameter whose default
 * changing is exactly the kind of silent semantics change this file is for.
 *
 * The reach case earned its place on the way in. It was first written with a
 * `reach` of `'first-slice'` — a value `DependencyReach` does not have. `bun
 * test` does not typecheck, so it ran, took the not-`'anchor-slice'` branch and
 * produced a perfectly stable digest; only `tsc` caught it. The digest moved
 * from `136e8314b76e0398` to `5f5d507bdf199577` when the value was corrected,
 * which is this guard doing on its own author exactly what it is here to do to
 * everyone else: a changed placement is a changed digest.
 *
 * The corpus is fixed, not generated. A random corpus would make the pinned
 * digest a seed's property rather than the engine's.
 */
const CORPUS: readonly ScheduleCase[] = [
  {
    name: 'chain with a shared successor',
    rows: [item('a', null, 10), item('b', null, 20), item('c', null, 30)],
    edges: [
      { predecessorId: 'a', successorId: 'c' },
      { predecessorId: 'b', successorId: 'c' },
    ],
    slices: [slice('a', DEV, 2), slice('b', DEV, 5), slice('c', DEV, 1)],
  },
  {
    name: 'diamond under a parent, edges declared on the parent',
    rows: [item('p', null, 10), item('p1', 'p', 10), item('p2', 'p', 20), item('after', null, 20)],
    edges: [{ predecessorId: 'p', successorId: 'after' }],
    slices: [slice('p1', DEV, 3), slice('p2', DEV, 4), slice('after', DEV, 2)],
  },
  {
    name: 'two steps on one work item',
    rows: [item('a', null, 10), item('b', null, 20)],
    edges: [{ predecessorId: 'a', successorId: 'b' }],
    slices: [slice('a', DEV, 3), slice('a', QA, 2), slice('b', DEV, 1)],
  },
  {
    name: 'a manual floor that pushes, and one that does not',
    rows: [item('a', null, 10), item('b', null, 20)],
    edges: [{ predecessorId: 'a', successorId: 'b' }],
    slices: [slice('a', DEV, 4), slice('b', DEV, 2)],
    notBefore: new Map([
      ['a', 3],
      ['b', 1],
    ]),
  },
  {
    name: 'one person on two independent work items',
    rows: [item('a', null, 10), item('b', null, 20)],
    edges: [],
    slices: [slice('a', DEV, 3, { personId: 'kat' }), slice('b', DEV, 2, { personId: 'kat' })],
  },
  {
    name: 'a pool of two holding a width-two block',
    rows: [item('a', null, 10), item('b', null, 20), item('x', null, 30)],
    edges: [],
    slices: [
      slice('a', DEV, 5, { poolIds: ['team-1'] }),
      slice('b', DEV, 7, { poolIds: ['team-1'] }),
      slice('x', DEV, 4, { poolIds: ['team-1'], width: 2 }),
    ],
    poolSizes: new Map([['team-1', 2]]),
  },
  {
    name: 'an unestimated leaf beside an estimated one',
    rows: [item('a', null, 10), item('b', null, 20)],
    edges: [{ predecessorId: 'a', successorId: 'b' }],
    slices: [slice('a', DEV, null), slice('b', DEV, 2)],
  },
  {
    name: 'the same plan under anchor-slice reach',
    rows: [item('a', null, 10), item('b', null, 20)],
    edges: [{ predecessorId: 'a', successorId: 'b' }],
    slices: [slice('a', DEV, 3), slice('a', QA, 2), slice('b', DEV, 1)],
    reach: 'anchor-slice',
  },
];

/**
 * `eventsVisited` is excluded, and it is the only exclusion.
 *
 * It counts the levelling window's work — instrumentation about the run, not
 * about the plan — so an optimization that visits fewer events and places every
 * slice identically would move the digest and demand a bump this file exists to
 * make meaningful. The same key is excluded from the stored schedule body for
 * the same reason (`saved-plans` tasks.md 3.4).
 *
 * Everything else is taken from the value rather than listed, so a field
 * `Scheduled` or `Schedule` gains later is digested the day it is added. An
 * enumerated list would stay green across exactly the change nobody remembered
 * to add to it.
 */
const INSTRUMENTATION_KEY: keyof Schedule = 'eventsVisited';

const semanticPart = (result: Schedule): Record<string, unknown> => {
  const source = result as unknown as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(source)
      .filter((key) => key !== INSTRUMENTATION_KEY)
      .map((key) => [key, source[key]]),
  );
};

/** Maps in key order, objects in key order, so the serialization is stable. */
const stable = (value: unknown): unknown => {
  if (value instanceof Map) {
    const entries = [...(value as Map<string, unknown>).entries()];
    return entries
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, stable(entry)]);
  }
  if (Array.isArray(value)) return (value as unknown[]).map(stable);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .map((key) => [key, stable(source[key])]),
    );
  }
  return value;
};

/**
 * FNV-1a, twice, at two offsets — sixteen hex characters.
 *
 * Written out rather than imported because `domain` is tagged
 * `runtime:isomorphic` and may not reach a runtime module. Nothing here is a
 * security property: the digest only has to change when the serialization
 * changes, and a person has to be able to read it in a diff.
 */
const digestOf = (text: string): string => {
  const pass = (offset: number): string => {
    let hash = offset;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  };
  return `${pass(0x811c9dc5)}${pass(0x9e3779b9)}`;
};

/**
 * The whole corpus through one engine, as one string.
 *
 * A **pure function of the engine passed in**, which is what makes the
 * negatives below arguments rather than a note: the sensitivity of this digest
 * is re-measured on every run, against engines that differ from the real one in
 * exactly one field.
 */
export const scheduleBehaviourDigest = (run: ScheduleFn): string =>
  digestOf(
    JSON.stringify(
      CORPUS.map((plan) => [
        plan.name,
        stable(
          semanticPart(
            run(plan.rows, plan.edges, plan.slices, plan.notBefore, plan.poolSizes, plan.reach),
          ),
        ),
      ]),
    ),
  );

/**
 * The behaviour `SCHEDULE_ALGORITHM_ID` names, pinned.
 *
 * **Re-pin this and bump the id together, or neither.** A red assertion here
 * means some input now produces a different `Schedule`; if that was intended,
 * `SCHEDULE_ALGORITHM_ID` is stale as of the same commit.
 */
const PINNED = {
  id: 'slice-leveling-v2',
  digest: '18b55455829f4eb1',
} as const;

/**
 * `v1` was `5f5d507bdf199577`, and this is what moved it: tasks.md 5.1 and 5.2.
 *
 * **Recorded because the digest cannot say what changed and this file's whole
 * value is that somebody had to look.** The corpus above passes no deadlines,
 * so 5.1's reordering ties on both new comparisons and moved not one date in
 * it — the digest moved on 5.2 alone, the `lateBy` field now published on every
 * slice, which reads `null` throughout this deadline-free corpus. That is a
 * shape change rather than a placement change, and it is still an identity
 * change: a `v1` plan carries no `lateBy` at all, so a reader that found the
 * field absent could not tell "computed before the field existed" from
 * "computed and on time".
 *
 * The measurement was on h2puni at the committed bytes, not on the workspace
 * box, and both values are in this comment so a future re-pin can be checked
 * against the one it replaced.
 */

/** One perturbed value of the same shape — the smallest change a real edit makes. */
const perturbed = (value: unknown): unknown => {
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'string') return `${value}~`;
  if (Array.isArray(value)) return [...(value as unknown[]), 'perturbation'];
  return 'perturbation';
};

/** The real engine with one field of one slice moved, standing in for a semantics change. */
const engineWithSliceFieldMoved =
  (field: string): ScheduleFn =>
  (...args) => {
    const real = schedule(...args);
    const slices = new Map(real.slices);
    const firstKey = [...slices.keys()].sort()[0];
    const target = slices.get(firstKey) as unknown as Record<string, unknown>;
    slices.set(firstKey, {
      ...target,
      [field]: perturbed(target[field]),
    } as unknown as ScheduledSlice);
    return { ...real, slices };
  };

/** The same, one field of one **work item** — the projection the table reads. */
const engineWithWorkItemFieldMoved =
  (field: string): ScheduleFn =>
  (...args) => {
    const real = schedule(...args);
    const workItems = new Map(real.workItems);
    const firstKey = [...workItems.keys()].sort()[0];
    const target = workItems.get(firstKey) as unknown as Record<string, unknown>;
    workItems.set(firstKey, {
      ...target,
      [field]: perturbed(target[field]),
    } as unknown as Scheduled);
    return { ...real, workItems };
  };

/** The same, one of the top-level counts. */
const engineWithCountMoved =
  (field: string): ScheduleFn =>
  (...args) => {
    const real = schedule(...args);
    return { ...real, [field]: perturbed((real as unknown as Record<string, unknown>)[field]) };
  };

const sample = schedule(
  CORPUS[0].rows,
  CORPUS[0].edges,
  CORPUS[0].slices,
  CORPUS[0].notBefore,
  CORPUS[0].poolSizes,
  CORPUS[0].reach,
);
const sampleSlice = [...sample.slices.values()][0];
const sampleWorkItem = [...sample.workItems.values()][0];
const SLICE_FIELDS = Object.keys(sampleSlice);
const WORK_ITEM_FIELDS = Object.keys(sampleWorkItem);
const COUNT_FIELDS = Object.keys(semanticPart(sample)).filter(
  (key) => key !== 'slices' && key !== 'workItems',
);

describe('the scheduling algorithm identity', () => {
  it('is a monotonically versioned engine name', () => {
    expect(SCHEDULE_ALGORITHM_ID).toMatch(/^[a-z][a-z0-9-]*-v[1-9][0-9]*$/);
  });

  it('is the id the pinned behaviour was pinned against', () => {
    // Not a tautology across time: `PINNED.id` is what the digest below was
    // measured under, so bumping the constant without re-measuring fails here
    // rather than shipping a new id attached to old evidence.
    expect(SCHEDULE_ALGORITHM_ID).toBe(PINNED.id);
  });

  it('names the behaviour that is pinned beside it', () => {
    expect(scheduleBehaviourDigest(schedule)).toBe(PINNED.digest);
  });
});

describe('the digest notices a semantics change', () => {
  const baseline = scheduleBehaviourDigest(schedule);

  it('reads every field of a scheduled slice, whatever they are', () => {
    // A precondition, not decoration: an empty field list would make every
    // `it.each` below vacuous and the suite would pass having proved nothing.
    expect(SLICE_FIELDS.length).toBeGreaterThan(5);
    for (const field of SLICE_FIELDS) {
      expect(scheduleBehaviourDigest(engineWithSliceFieldMoved(field))).not.toBe(baseline);
    }
  });

  it('reads every field of a work item projection, whatever they are', () => {
    expect(WORK_ITEM_FIELDS.length).toBeGreaterThan(5);
    for (const field of WORK_ITEM_FIELDS) {
      expect(scheduleBehaviourDigest(engineWithWorkItemFieldMoved(field))).not.toBe(baseline);
    }
  });

  it('reads the top-level counts, whatever they are', () => {
    expect(COUNT_FIELDS).toContain('waitingForPerson');
    expect(COUNT_FIELDS).toContain('waitingForCapacity');
    for (const field of COUNT_FIELDS) {
      expect(scheduleBehaviourDigest(engineWithCountMoved(field))).not.toBe(baseline);
    }
  });

  it('stays silent on instrumentation, which is the one thing it excludes', () => {
    const withOtherEventCount: ScheduleFn = (...args) => ({
      ...schedule(...args),
      eventsVisited: schedule(...args).eventsVisited + 1000,
    });
    expect(scheduleBehaviourDigest(withOtherEventCount)).toBe(baseline);
  });

  it('is stable across runs of the same engine', () => {
    expect(scheduleBehaviourDigest(schedule)).toBe(baseline);
  });
});
