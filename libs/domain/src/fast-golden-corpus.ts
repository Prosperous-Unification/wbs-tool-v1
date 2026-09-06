/**
 * Fast's golden corpus: fixed plans, and their schedules kept as **bytes**.
 *
 * This is task 1.6(a), and it exists because the thing that phrase used to
 * point at could not do the job. `schedule-identity.test.ts` is a
 * differential corpus — a generated plan through today's engine and through a
 * copy of the `role-crud` engine in the same file — so it compares two
 * implementations inside one commit and stores nothing. There is no artefact
 * for a cache key to protect, and worse, its oracle imports the live
 * `ASSUMED_SLICE_WORKDAYS` (`schedule-identity.test.ts:4`, spent at line
 * 331), so moving that constant moves both sides and the differential stays
 * green by construction. Measured at `09e9ccd7`: with that constant at 3 and
 * `SCHEDULER_CONTRACT_VERSION` still 7, the domain suite went 356/19 across six
 * files and `schedule-identity.test.ts` contributed **zero** of the failures.
 *
 * A corpus that can hold the cache key honest needs stored output. So the
 * schedules below are serialized to `../fixtures/fast-golden-corpus.json`, that
 * file carries the contract version it was produced under, and
 * `fast-golden-corpus.test.ts` refuses a mismatch either way: bytes that moved
 * without a version bump, or a version bump whose bytes were not regenerated.
 *
 * The inputs are hand-written here rather than generated. A generator would put
 * a third copy of the engine's input rules in the repo, and a corpus whose
 * inputs are computed can drift from the plans it claims to describe.
 */

import { SCHEDULER_CONTRACT_VERSION } from './contract-version';
import type { DependencyReach } from './dependency-reach';
import type { PlannedRow } from './derive-numbers';
import {
  type DependencyEdge,
  type PoolSizes,
  type Schedule,
  schedule,
  type Slice,
} from './schedule';

/** One corpus case: a whole `schedule()` argument tuple under a stable name. */
export interface FastGoldenCase {
  readonly name: string;
  readonly rows: readonly PlannedRow[];
  readonly edges: readonly DependencyEdge[];
  readonly slices: readonly Slice[];
  readonly notBefore?: ReadonlyMap<string, number>;
  readonly poolSizes?: PoolSizes;
  readonly reach?: DependencyReach;
}

const leaf = (id: string, position: number, priority: number | null = null): PlannedRow => ({
  id,
  parentId: null,
  position,
  frozenNumber: null,
  priority,
});

const work = (workItemId: string, days: number | null, extra: Partial<Slice> = {}): Slice => ({
  workItemId,
  stepId: null,
  days,
  personId: null,
  width: 1,
  poolIds: [],
  ...extra,
});

/**
 * Eight cases, chosen so each one can lose something a different engine change
 * would break. A corpus of one plan is a corpus that only notices whatever that
 * plan happens to exercise.
 */
export const FAST_GOLDEN_CASES: readonly FastGoldenCase[] = [
  {
    // Dates, ordering and the critical path, with nothing resource-bound.
    name: 'chain-of-three',
    rows: [leaf('a', 10), leaf('b', 20), leaf('c', 30)],
    edges: [
      { predecessorId: 'a', successorId: 'b' },
      { predecessorId: 'b', successorId: 'c' },
    ],
    slices: [work('a', 3), work('b', 2), work('c', 4)],
  },
  {
    // The case the 1.6 watched red aims at: `days: null` on the middle leaf, so
    // ASSUMED_SLICE_WORKDAYS is spent here and every downstream date moves with
    // it. Without a case like this the corpus cannot see that constant at all.
    name: 'unestimated-middle',
    rows: [leaf('a', 10), leaf('b', 20), leaf('c', 30)],
    edges: [
      { predecessorId: 'a', successorId: 'b' },
      { predecessorId: 'b', successorId: 'c' },
    ],
    slices: [work('a', 2), work('b', null), work('c', 1)],
  },
  {
    // Capacity: two independent leaves in a pool that holds one, so the second
    // waits on a slot rather than on a dependency. Pins the resource tie-break
    // and `boundBy: 'capacity'`.
    name: 'pool-of-one',
    rows: [leaf('a', 10), leaf('b', 20)],
    edges: [],
    slices: [work('a', 2, { poolIds: ['team'] }), work('b', 2, { poolIds: ['team'] })],
    poolSizes: new Map([['team', 1]]),
  },
  {
    // A manual floor and an assignee, together: the floor pushes `b` later and
    // the shared person keeps `a` and `b` off each other regardless.
    name: 'floor-and-person',
    rows: [leaf('a', 10), leaf('b', 20)],
    edges: [],
    slices: [work('a', 2, { personId: 'p' }), work('b', 1, { personId: 'p' })],
    notBefore: new Map([['b', 5]]),
  },
  {
    // `reach` is on `contract-version.ts`'s own bump list and no case above can
    // see it: with one slice per work item both arms agree. Two steps each and
    // an edge between the items is the smallest plan where they differ — under
    // `whole-item` `b` waits for all of `a`, under `anchor-slice` only for
    // `a`'s anchor. Stored under `anchor-slice`, so flipping the default is a
    // corpus failure rather than a silent semantic change.
    name: 'anchor-slice-reach',
    rows: [leaf('a', 10), leaf('b', 20)],
    edges: [{ predecessorId: 'a', successorId: 'b' }],
    slices: [
      work('a', 2, { stepId: 'design' }),
      work('a', 3, { stepId: 'build' }),
      work('b', 1, { stepId: 'design' }),
      work('b', 2, { stepId: 'build' }),
    ],
    reach: 'anchor-slice',
  },
  {
    // The duration rule's other arm — `days / width` — and the snapping that
    // follows it. 5 days across a width of 2 is 2.5, which is the case a
    // corpus of whole numbers cannot distinguish from a rule that rounds.
    name: 'fractional-duration',
    rows: [leaf('a', 10), leaf('b', 20)],
    edges: [{ predecessorId: 'a', successorId: 'b' }],
    slices: [work('a', 5, { width: 2 }), work('b', 1)],
  },
  {
    // Float, and the `snapWorkdays` on it (`schedule.ts:1564-1599`). A diamond
    // whose two branches are unequal gives the short one real slack, and thirds
    // make that slack a repeating fraction — which is where a bare
    // `latestStart - earliestStart` and a snapped one stop agreeing.
    name: 'diamond-float-thirds',
    rows: [leaf('a', 10), leaf('b', 20), leaf('c', 30), leaf('d', 40)],
    edges: [
      { predecessorId: 'a', successorId: 'b' },
      { predecessorId: 'a', successorId: 'c' },
      { predecessorId: 'b', successorId: 'd' },
      { predecessorId: 'c', successorId: 'd' },
    ],
    slices: [
      work('a', 1, { width: 3 }),
      work('b', 4, { width: 3 }),
      work('c', 1, { width: 3 }),
      work('d', 2, { width: 3 }),
    ],
  },
  {
    // Numbering semantics — the last name on `contract-version.ts`'s bump list
    // that no case above could reach. `deriveNumbers` is spent at
    // `schedule.ts:1890` and read at `:1902` as the **third of four** leveling
    // tie-breaks (priority, start, float, number, `at`), so it changes output
    // only where leveling reorders slices tied on the first three.
    //
    // `pool-of-one` is that shape and still cannot see it, for a reason worth
    // writing down: its rows are declared in position order, so the number
    // order and the plan's own order agree and the number decides nothing it
    // was not already going to decide. THIS CASE IS `pool-of-one` WITH THE TWO
    // ORDERS PULLED APART — `b` sits at position 10 and `a` at 20, so
    // `deriveNumbers` gives `b` = `010` and `a` = `020`, while `index.leafIds`
    // is the `rows` **array** order (`schedule.ts:326`) and puts `a`'s node
    // first.
    //
    // The last tie-break cannot save it either: `node.at` is the slice's index
    // **within its own work item** (`schedule.ts:1813`), so with one slice each
    // both are 0. Priority is absent, both start at 0 and both carry zero
    // float, which leaves the number as the only line in `goesFirst` that
    // separates these two nodes at all.
    name: 'inverted-numbering-tie',
    rows: [leaf('a', 20), leaf('b', 10)],
    edges: [],
    slices: [work('a', 2, { poolIds: ['team'] }), work('b', 2, { poolIds: ['team'] })],
    poolSizes: new Map([['team', 1]]),
  },
];

/**
 * A `Schedule` as deterministic, comparable JSON.
 *
 * `Schedule` holds `Map`s (`schedule.ts:247`), and `JSON.stringify` renders a
 * `Map` as `{}` — a corpus checked in that way would pass against every
 * possible engine, which is the check-that-cannot-fail failure. Entries are
 * sorted by key so a change in insertion order is not a diff.
 */
export const serializeSchedule = (found: Schedule): unknown => {
  const entries = <V>(map: Map<string, V>): [string, V][] =>
    [...map.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return JSON.parse(
    JSON.stringify({
      ...found,
      slices: entries(found.slices),
      workItems: entries(found.workItems),
    }),
  ) as unknown;
};

/** The corpus as it stands in this working tree, ready to compare or to write. */
export const computeFastGoldenCorpus = (): {
  contractVersion: number;
  cases: Record<string, unknown>;
} => {
  const cases: Record<string, unknown> = {};
  for (const each of FAST_GOLDEN_CASES) {
    // TASK-280's audit: the seventh argument is omitted here **and that is the
    // correct value**, unlike the publication guard's omission this task fixed.
    // A `FastGoldenCase` has no deadline field, so there is no deadline to pass
    // — and the corpus is the fixture 1.6 and 4.3's no-op proof compares
    // against, which requires every case to come out byte-identical whether the
    // argument is supplied empty or left to its default. Adding `new Map()` here
    // would change nothing and would read as if a source had been consulted.
    cases[each.name] = serializeSchedule(
      schedule(
        each.rows,
        each.edges,
        each.slices,
        each.notBefore ?? new Map(),
        each.poolSizes ?? new Map(),
        each.reach ?? 'whole-item',
      ),
    );
  }
  return { contractVersion: SCHEDULER_CONTRACT_VERSION, cases };
};
