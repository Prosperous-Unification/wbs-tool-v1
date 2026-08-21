import { describe, expect, it } from 'bun:test';

import type { WorkItem } from '../repository';
import type { DependencyEdge, PoolSizes, Schedule, ScheduledSlice, Slice } from './schedule';
import { schedule, sliceKey } from './schedule';

/**
 * The capacity engine: how many people may be on one work item at once, and how
 * many of a team may be at work at once across a whole plan.
 *
 * The identity half — a plan that sets neither field schedules byte for byte as
 * it did — lives in `schedule-priority.test.ts`'s pin and in
 * `schedule-identity.test.ts`'s thousand-plan differential, both of which this
 * change extended rather than duplicated. What is here is what capacity itself
 * does, and every claim in `openspec/changes/capacity-engine/design.md` that a
 * test can hold.
 */

const DEV = 'role-dev';
const QA = 'role-qa';
const PLATFORM = 'team-platform';

let position = 0;
const item = (
  id: string,
  overrides: Partial<
    Pick<WorkItem, 'parentId' | 'maxParallel' | 'serviceTeamId' | 'priority'>
  > = {},
): WorkItem => ({
  id,
  projectId: 'p1',
  parentId: null,
  position: (position += 10),
  name: id,
  notes: '',
  frozenNumber: null,
  priority: null,
  startNoEarlierThan: null,
  serviceTeamId: null,
  serviceId: null,
  maxParallel: 1,
  revision: 0,
  ...overrides,
});

const edge = (predecessorId: string, successorId: string): DependencyEdge => ({
  predecessorId,
  successorId,
});

/**
 * One slice, with the two facts the caller resolves written out.
 *
 * Written out rather than derived here, because that is exactly the contract:
 * `width` and `poolId` are the **adapter's** reading (`slicesOf` in
 * `work-item.service.ts`), and a fixture that re-derived them would be testing
 * a second implementation of the clamp instead of the engine.
 */
const slice = (
  workItemId: string,
  roleId: string,
  days: number | null,
  extra: Partial<Pick<Slice, 'personId' | 'width' | 'poolId'>> = {},
): Slice => ({
  workItemId,
  roleId,
  days,
  personId: null,
  width: 1,
  poolId: null,
  ...extra,
});

/** One slice's schedule, or a throw — a missing key is a broken fixture, not a null. */
const planned = (found: Schedule, workItemId: string, roleId: string): ScheduledSlice => {
  const one = found.slices.get(sliceKey(workItemId, roleId));
  if (one === undefined) throw new Error(`no slice for ${workItemId}/${roleId}`);
  return one;
};

/** The blocking set as readable `workItem/role` keys, so a failure names rows. */
const blockersOf = (one: ScheduledSlice): string[] =>
  one.capacityPredecessorIds.map((key) => key.replace('\u0000', '/')).sort();

const pool = (size: number): PoolSizes => new Map([[PLATFORM, size]]);

describe('width — effort compressed across the people on it', () => {
  it('compresses six days of effort into two when three may work at once', () => {
    const rows = [item('a', { maxParallel: 3 })];
    const slices = [slice('a', DEV, 6, { width: 3 })];

    const found = schedule(rows, [], slices);

    const dev = planned(found, 'a', DEV);
    // One node, one bar, one row in `slices` — the key is unchanged, which is
    // the whole of D1: a numeric field moved and node identity did not.
    expect(found.slices.size).toBe(1);
    expect(dev.effort).toBe(6);
    expect(dev.width).toBe(3);
    expect(dev.duration).toBe(2);
    expect(dev.earliestStart).toBe(0);
    expect(dev.earliestFinish).toBe(2);
    expect(found.workItems.get('a')).toMatchObject({ duration: 2, earliestFinish: 2 });
  });

  it('divides exactly, so a plan that sets no parallelism is untouched arithmetic', () => {
    // The identity claim at the expression rather than at the plan: for every
    // value that can reach `Slice.days` — finite, non-negative, or null — the
    // division by one gives the same double back. The corpus proof is
    // `schedule-identity.test.ts`; this is the boundary of the class the claim
    // is made about, including the `-0` the prefix sum normalises.
    for (const effort of [0, -0, 1, 3.6666666666666665, 1 / 3, 5e-324, Number.MAX_VALUE]) {
      expect(effort / 1).toBe(effort);
    }
  });

  it('holds a subnormal and a tiny estimate at width 1 and at width 1000', () => {
    // Recorded rather than asserted about: `ThreePointEstimate` is three
    // `number>=0` with no floor under them, so a plan may put 5e-10 of a day
    // against a row and 1000 people on it. The behaviour at that size is a
    // property of tiny estimates, which exists at width 1 today; this change
    // neither introduces nor fixes it, and this is what it does.
    const tiny = 5e-10;
    const wide = schedule(
      [item('a', { maxParallel: 1000 })],
      [],
      [slice('a', DEV, tiny, { width: 1000 })],
    );
    const narrow = schedule([item('b')], [], [slice('b', DEV, tiny)]);

    expect(planned(narrow, 'b', DEV).duration).toBe(tiny);
    expect(planned(wide, 'a', DEV).duration).toBe(tiny / 1000);
    // Both land inside `slackOf`'s 1e-9 window, so both rows read as critical.
    // That is the accepted edge `critical-snap` states, not a new one.
    expect(planned(narrow, 'b', DEV).critical).toBe(true);
    expect(planned(wide, 'a', DEV).critical).toBe(true);
  });
});

describe('capacity — a team is a pool of slots', () => {
  it('waits for a team’s slots to come free before it starts', () => {
    // Three width-1 blocks of 2 days on a team of 2: the third cannot start
    // until the first releases.
    const rows = ['a', 'b', 'c'].map((id) => item(id, { serviceTeamId: PLATFORM }));
    const slices = rows.map((row) => slice(row.id, DEV, 2, { poolId: PLATFORM }));

    const found = schedule(rows, [], slices, new Map(), pool(2));

    expect(planned(found, 'a', DEV)).toMatchObject({ earliestStart: 0, earliestFinish: 2 });
    expect(planned(found, 'b', DEV)).toMatchObject({ earliestStart: 0, earliestFinish: 2 });
    const third = planned(found, 'c', DEV);
    expect(third).toMatchObject({ earliestStart: 2, earliestFinish: 4, boundBy: 'capacity' });
    // The display referent names one of the two that freed the pool, and the
    // whole set is carried beside it.
    expect(blockersOf(third)).toEqual(['a/role-dev', 'b/role-dev']);
    expect(third.resourcePredecessorId).not.toBeNull();
    expect(found.waitingForCapacity).toBe(1);
    expect(found.waitingForPerson).toBe(0);
  });

  it('waits rather than running narrow and widening later', () => {
    // D4. A team of 3 and two width-2 blocks: the second waits for the first
    // to release rather than starting at width 1 on the spare slot. Stretching
    // would make a duration depend on placement order, which is what makes
    // `offsets[]` unsummable before placement.
    const rows = ['a', 'b'].map((id) => item(id, { serviceTeamId: PLATFORM, maxParallel: 2 }));
    const slices = rows.map((row) => slice(row.id, DEV, 4, { width: 2, poolId: PLATFORM }));

    const found = schedule(rows, [], slices, new Map(), pool(3));

    expect(planned(found, 'a', DEV)).toMatchObject({ earliestStart: 0, earliestFinish: 2 });
    expect(planned(found, 'b', DEV)).toMatchObject({
      earliestStart: 2,
      earliestFinish: 4,
      // Two days at width 2, not four at width 1: the block is indivisible.
      duration: 2,
      width: 2,
      boundBy: 'capacity',
    });
  });

  it('skips a gap it cannot fit inside and waits for the whole window', () => {
    // The fixture the whole-window rule needs, and the one a three-block
    // fixture cannot produce: a pool with a short hole followed by a
    // reservation that overlaps the **middle** of the candidate duration. A
    // placement that tested only its start instant takes the hole and runs on
    // top of the later block.
    //
    // Pool of 1. `early` holds it 0→1. `late` is floored to day 2 and holds it
    // 2→6. `wide` needs 3 days: the hole at 1→2 is one day long, so it must
    // wait for 6.
    // The pop order is written down rather than inferred: priority is the
    // first thing `goesFirst` asks, so these three are placed in the order
    // the fixture is about and the hole is really there when `wide` looks.
    const rows = [
      item('early', { serviceTeamId: PLATFORM, priority: 1 }),
      item('late', { serviceTeamId: PLATFORM, priority: 2 }),
      item('wide', { serviceTeamId: PLATFORM, priority: 3 }),
    ];
    const slices = [
      slice('early', DEV, 1, { poolId: PLATFORM }),
      slice('late', DEV, 4, { poolId: PLATFORM }),
      slice('wide', DEV, 3, { poolId: PLATFORM }),
    ];
    // `late` is floored to 2, which is what leaves the hole; `wide` is popped
    // after both because its critical-path start ties and its row number is
    // last.
    const floors = new Map([['late', 2]]);

    const found = schedule(rows, [], slices, floors, pool(1));

    expect(planned(found, 'early', DEV)).toMatchObject({ earliestStart: 0, earliestFinish: 1 });
    expect(planned(found, 'late', DEV)).toMatchObject({ earliestStart: 2, earliestFinish: 6 });
    const wide = planned(found, 'wide', DEV);
    expect(wide).toMatchObject({ earliestStart: 6, earliestFinish: 9, boundBy: 'capacity' });
    // Both reservations had to end for it to fit, so both are in the set.
    expect(blockersOf(wide)).toEqual(['early/role-dev', 'late/role-dev']);
  });

  it('lets a block run through the instant another hands its slot over', () => {
    // The half-open instant, and the fixture that can actually see it. Pool of
    // 2. `held` takes one slot 0→2; `next` is floored to day 2 and takes one
    // 2→4, so at the instant 2 one reservation ends exactly as another begins
    // and the **aggregate** never moves off 1. A width-1 block spanning 0→4
    // therefore fits beside them the whole way.
    //
    // Evaluate the raw entries in insertion order instead and the acquisition
    // at 2 is seen before the release at 2: usage reads 2 for an instant that
    // never existed, and the block is pushed off a slot nobody took.
    //
    // Two blocks abutting cannot see this — the second is placed before any
    // third block searches — which is why the earlier version of this test
    // passed with the aggregation removed.
    const rows = [
      item('held', { serviceTeamId: PLATFORM, priority: 1 }),
      item('next', { serviceTeamId: PLATFORM, priority: 2 }),
      item('through', { serviceTeamId: PLATFORM, priority: 3 }),
    ];
    const slices = [
      slice('held', DEV, 2, { poolId: PLATFORM }),
      slice('next', DEV, 2, { poolId: PLATFORM }),
      slice('through', DEV, 4, { poolId: PLATFORM }),
    ];
    const floors = new Map([['next', 2]]);

    const found = schedule(rows, [], slices, floors, pool(2));

    expect(planned(found, 'held', DEV)).toMatchObject({ earliestStart: 0, earliestFinish: 2 });
    expect(planned(found, 'next', DEV)).toMatchObject({ earliestStart: 2, earliestFinish: 4 });
    expect(planned(found, 'through', DEV)).toMatchObject({
      earliestStart: 0,
      earliestFinish: 4,
      boundBy: 'projectStart',
    });
    expect(found.waitingForCapacity).toBe(0);
  });

  it('answers the same however the rows arrived, so no entry order decides anything', () => {
    // The determinism half of the same claim: the order the reservations are
    // written in is the order the rows are handed over in, and it cannot reach
    // the answer.
    const forwards = [
      item('a', { serviceTeamId: PLATFORM, priority: 1 }),
      item('b', { serviceTeamId: PLATFORM, priority: 2 }),
      item('c', { serviceTeamId: PLATFORM, priority: 3 }),
    ];
    const backwards = [...forwards].reverse();
    const slicesFor = (order: readonly WorkItem[]): Slice[] =>
      order.map((row) => slice(row.id, DEV, row.id === 'b' ? 3 : 2, { poolId: PLATFORM }));

    const one = schedule(forwards, [], slicesFor(forwards), new Map(), pool(2));
    const other = schedule(backwards, [], slicesFor(backwards), new Map(), pool(2));

    for (const id of ['a', 'b', 'c']) {
      expect(planned(other, id, DEV)).toEqual(planned(one, id, DEV));
    }
  });

  it('fits a block exactly as wide as its pool', () => {
    const rows = [item('a', { serviceTeamId: PLATFORM, maxParallel: 2 })];
    const slices = [slice('a', DEV, 4, { width: 2, poolId: PLATFORM })];

    const found = schedule(rows, [], slices, new Map(), pool(2));

    expect(planned(found, 'a', DEV)).toMatchObject({
      earliestStart: 0,
      earliestFinish: 2,
      boundBy: 'projectStart',
    });
  });

  it('gives a slice nobody has estimated no reservation and no wait', () => {
    // The twin of the existing person rule, asserted on the **profile** rather
    // than on the dates: a zero-length block that wrote its two cancelling
    // events is invisible in the dates and visible in the event count, which is
    // where the fault lives.
    //
    // The fixture is shaped around that visibility and not for tidiness. A
    // zero-length block writes both of its events at one instant, so they
    // aggregate to a delta of nothing, and if any other block already has an
    // event there they merge into it and leave no trace at all — which is how
    // an earlier version of this test, on a fixture where every zero-length
    // slice landed on the finish of the role before it, was watched staying
    // green with the guard removed. So the zero-length block is put where the
    // plan has nothing else: `z` at day 0, and the two real blocks held off it
    // by a manual date.
    //
    // Proof: `finish === start` dropped from the reservation's guard, so a
    // zero-length block writes its event pair, and this failed on
    // `eventsVisited` — 4 where 2 was owed, the two searches now stepping over
    // an instant at which nothing is happening; watched 2026-08-12.
    const rows = ['z', 'a', 'b'].map((id) => item(id, { serviceTeamId: PLATFORM }));
    const slices = [
      slice('z', DEV, 0, { poolId: PLATFORM }),
      slice('a', DEV, 2, { poolId: PLATFORM }),
      slice('b', DEV, 2, { poolId: PLATFORM }),
    ];
    const notBefore = new Map([
      ['a', 1],
      ['b', 1],
    ]);

    const found = schedule(rows, [], slices, notBefore, pool(1));

    // The dates first, which is what the guard must not change: `z` occupies
    // nothing at day 0, and the pool of one still serialises `a` and `b`.
    expect(planned(found, 'z', DEV)).toMatchObject({
      earliestStart: 0,
      earliestFinish: 0,
      duration: 0,
    });
    expect(planned(found, 'a', DEV)).toMatchObject({ earliestStart: 1, earliestFinish: 3 });
    expect(planned(found, 'b', DEV)).toMatchObject({
      earliestStart: 3,
      earliestFinish: 5,
      boundBy: 'capacity',
    });
    // And nobody waited behind the block of no length: the blocking set names
    // `a`, which really did hold the slot, and nothing else.
    expect(blockersOf(planned(found, 'b', DEV))).toEqual(['a/role-dev']);
    // The instrumented reading of "reserves nothing", exact rather than an
    // upper bound: `a` searches an empty profile and steps over nothing, `b`
    // steps over `a`'s acquisition and then onto its release. A zero-length
    // reservation at day 0 would add one visit to each.
    expect(found.eventsVisited).toBe(2);
  });

  it('needs both the person and the slot, whichever binds', () => {
    // D2 inverted: a named slice consumes its **work item's** team slot as
    // well as its assignee. The two constraints compose and do not interact —
    // the slot is keyed on the work, the queue on the person.
    const rows = ['a', 'b'].map((id) => item(id, { serviceTeamId: PLATFORM }));
    const slices = [
      slice('a', DEV, 3, { personId: 'kat', poolId: PLATFORM }),
      slice('b', DEV, 3, { personId: 'sam', poolId: PLATFORM }),
    ];

    // A team of 1 with two different people on it: the pool binds, not the queue.
    const bounded = schedule(rows, [], slices, new Map(), pool(1));
    expect(planned(bounded, 'b', DEV)).toMatchObject({ earliestStart: 3, boundBy: 'capacity' });

    // The same plan on a team of 2 with **one** person: the queue binds.
    const queued = schedule(
      rows,
      [],
      [
        slice('a', DEV, 3, { personId: 'kat', poolId: PLATFORM }),
        slice('b', DEV, 3, { personId: 'kat', poolId: PLATFORM }),
      ],
      new Map(),
      pool(2),
    );
    expect(planned(queued, 'b', DEV)).toMatchObject({ earliestStart: 3, boundBy: 'person' });
  });

  it('names the person, not the pool, when the two land on the same day', () => {
    // The floor order, doing real work rather than standing against a future
    // third kind: a slice can carry both floors now. `capacity` sits after
    // `person`, so a tie keeps the reason listed first.
    //
    // `kat` finishes `a` at day 3 and the team of 1 releases at day 3 too, so
    // both floors are 3 and the person is owed the sentence.
    const rows = ['a', 'b'].map((id) => item(id, { serviceTeamId: PLATFORM }));
    const slices = [
      slice('a', DEV, 3, { personId: 'kat', poolId: PLATFORM }),
      slice('b', DEV, 2, { personId: 'kat', poolId: PLATFORM }),
    ];

    const found = schedule(rows, [], slices, new Map(), pool(1));

    expect(planned(found, 'b', DEV)).toMatchObject({ earliestStart: 3, boundBy: 'person' });
    expect(found.waitingForPerson).toBe(1);
    expect(found.waitingForCapacity).toBe(0);
  });

  it('leaves a sized team that never contends with no resource edge at all', () => {
    // The `hasResourceEdges` scoping, at the shape it is about: a team labelled
    // on every row and sized generously enough never to contend must emit no
    // edge, so the backward pass runs with the tight-path rule off exactly as
    // it does on a plan with no teams in it.
    //
    // This fixture asserts the **edges**; the last-bits half of the claim is
    // `schedule-identity.test.ts`'s `answers what it answered with a sized team
    // labelling every row`, over the thousand-plan corpus — a three-block
    // fixture cannot carry the drift the rule exists to keep out, and an
    // earlier version of this test was watched staying green with the scoping
    // deliberately widened.
    const rows = ['a', 'b', 'c'].map((id) => item(id, { serviceTeamId: PLATFORM }));
    const days = [1 / 3, 2 / 3, 1 / 6];
    const unlabelled = rows.map((row, at) => slice(row.id, DEV, days[at]));
    const pooled = rows.map((row, at) => slice(row.id, DEV, days[at], { poolId: PLATFORM }));

    const bare = schedule(rows, [], unlabelled);
    const sized = schedule(rows, [], pooled, new Map(), pool(10));

    for (const id of ['a', 'b', 'c']) {
      expect(planned(sized, id, DEV)).toEqual(planned(bare, id, DEV));
      expect(planned(sized, id, DEV).capacityPredecessorIds).toEqual([]);
    }
    expect(sized.waitingForCapacity).toBe(0);
  });
});

describe('float — the blocking set is the whole set', () => {
  it('reports no float on a block whose slack another block’s finish is holding', () => {
    // **The headline regression test.** codex's counterexample, verbatim:
    // pool of 2, width-1 blocks A and B holding both slots and ending on days
    // 5 and 7, and a width-2 block X that therefore starts on day 7 and ends
    // the project.
    //
    // With only B→X in the graph — the "one binding edge" this design
    // replaced — A appears free to slip for ever. It is not: A ending on day 8
    // pushes X, and with it the project. A row reported as having slack it has
    // none of is a false green, and it is the class of fault that killed the
    // first leveling algorithm.
    //
    // A runs 0→5 and X starts at 7, so A's true float is **2**.
    const rows = [
      item('A', { serviceTeamId: PLATFORM }),
      item('B', { serviceTeamId: PLATFORM }),
      item('X', { serviceTeamId: PLATFORM, maxParallel: 2 }),
    ];
    const slices = [
      slice('A', DEV, 5, { poolId: PLATFORM }),
      slice('B', DEV, 7, { poolId: PLATFORM }),
      slice('X', DEV, 6, { width: 2, poolId: PLATFORM }),
    ];

    const found = schedule(rows, [], slices, new Map(), pool(2));

    const x = planned(found, 'X', DEV);
    expect(x).toMatchObject({ earliestStart: 7, earliestFinish: 10, boundBy: 'capacity' });
    // Both A and B had to end for X to fit, so both are edged.
    expect(blockersOf(x)).toEqual(['A/role-dev', 'B/role-dev']);
    // The display referent is the latest finisher — B — and the set is larger
    // than one, which is what the hover says "and 1 other" about.
    expect(x.resourcePredecessorId).toBe(sliceKey('B', DEV));

    expect(planned(found, 'A', DEV).float).toBe(2);
    expect(planned(found, 'B', DEV).float).toBe(0);
    expect(planned(found, 'B', DEV).critical).toBe(true);
  });

  it('under-reports float rather than over-reporting it, and says so', () => {
    // The one-sided error, named. "At least one of these must move" is a
    // disjunction and a DAG cannot express one, so every member of the
    // blocking set is edged and the graph comes out at least as tight as
    // reality.
    //
    // Here: pool of 2 with A (0→2) and B (0→6), and a width-2 block X that
    // waits for 6. **Either** of them ending later than 6 would push X, so
    // neither may slip past 6, and A's reported float — 6-2 = 4 — is exactly
    // the disjunctive answer. This fixture is therefore the tight case, and it
    // is the tight case on purpose: it shows the extra edges cost nothing when
    // the constraint is not slack. The direction itself is asserted over every
    // slice of the plan below — no slice is ever reported movable when it is
    // not, and float is never negative, which is the other way this could
    // fail.
    const rows = [
      item('A', { serviceTeamId: PLATFORM }),
      item('B', { serviceTeamId: PLATFORM }),
      item('X', { serviceTeamId: PLATFORM, maxParallel: 2 }),
      // An unpooled tail, so the project finish is past X and there is real
      // slack in the plan for the claim to be about.
      item('tail'),
    ];
    const slices = [
      slice('A', DEV, 2, { poolId: PLATFORM }),
      slice('B', DEV, 6, { poolId: PLATFORM }),
      slice('X', DEV, 4, { width: 2, poolId: PLATFORM }),
      slice('tail', DEV, 12),
    ];

    const found = schedule(rows, [], slices, new Map(), pool(2));

    const x = planned(found, 'X', DEV);
    expect(x.earliestStart).toBe(6);
    expect(blockersOf(x)).toEqual(['A/role-dev', 'B/role-dev']);
    // A is edged even though B alone decided the window. Its late finish is
    // therefore X's late start, which is **at most** what a disjunctive
    // reading would give it — never more.
    const a = planned(found, 'A', DEV);
    expect(a.latestFinish).toBeLessThanOrEqual(x.latestStart);
    // The direction, over every slice: nothing is reported movable when it is
    // not. Negative float would be the other failure and is asserted away too.
    for (const one of found.slices.values()) {
      expect(one.float).toBeGreaterThanOrEqual(0);
      if (one.critical) expect(one.float).toBe(0);
    }
  });

  it('keeps the backward walk topological when pop order and start order are reversed', () => {
    // Termination and the backward pass do not rest on chronology. A capacity
    // edge points from a reservation **already placed** to the block being
    // placed, so the augmented graph is acyclic in **placement** order however
    // the two blocks sit in time — and `lateTimes` walks `order` backwards,
    // which is placement order.
    //
    // `first` is popped first (priority 1) and floored to day 4; `second` is
    // popped after it and starts at 0. The later-popped block starts first.
    const rows = [
      { ...item('first', { serviceTeamId: PLATFORM }), priority: 1 },
      { ...item('second', { serviceTeamId: PLATFORM }), priority: 2 },
    ];
    const slices = [
      slice('first', DEV, 3, { poolId: PLATFORM }),
      slice('second', DEV, 2, { poolId: PLATFORM }),
    ];
    const floors = new Map([['first', 4]]);

    const found = schedule(rows, [], slices, floors, pool(1));

    const first = planned(found, 'first', DEV);
    const second = planned(found, 'second', DEV);
    expect(first).toMatchObject({ earliestStart: 4, earliestFinish: 7 });
    // Popped second, started first — into the hole the floored block left.
    expect(second).toMatchObject({ earliestStart: 0, earliestFinish: 2 });
    // And the backward pass answered for both rather than throwing or leaving
    // a late time undefined.
    expect(first.latestFinish).toBe(7);
    expect(second.float).toBeGreaterThanOrEqual(0);
  });

  it('paints a compressed chain that ends the project red, drift and all', () => {
    // `critical-snap` composes untouched. Division by a width adds drift of
    // exactly the class the 1e-9 snap exists for, so this change makes the
    // snap more load-bearing and changes nothing about it.
    const rows = [
      item('a', { serviceTeamId: PLATFORM, maxParallel: 3 }),
      item('b', { serviceTeamId: PLATFORM }),
    ];
    const slices = [
      slice('a', DEV, (1 + 4 * 2 + 4) / 6, { width: 3, poolId: PLATFORM }),
      slice('b', DEV, (2 + 4 * 3 + 7) / 6, { poolId: PLATFORM }),
    ];

    const found = schedule(rows, [edge('a', 'b')], slices, new Map(), pool(3));

    expect(planned(found, 'a', DEV).float).toBe(0);
    expect(planned(found, 'a', DEV).critical).toBe(true);
    expect(planned(found, 'b', DEV).float).toBe(0);
    expect(planned(found, 'b', DEV).critical).toBe(true);
  });
});

describe('determinism and refusals', () => {
  it('answers the same for a shuffled copy of the same plan', () => {
    // The profile is a function of the placements, the placements are popped
    // in the total order `goesFirst` defines, and the window search is a
    // function of the aggregated profile alone. So the order the rows and
    // slices are handed over in cannot decide anything.
    const rows = ['a', 'b', 'c', 'd'].map((id) =>
      item(id, { serviceTeamId: PLATFORM, maxParallel: id === 'c' ? 2 : 1 }),
    );
    const slicesFor = (order: readonly WorkItem[]): Slice[] =>
      order.map((row) =>
        slice(row.id, DEV, row.id === 'c' ? 6 : 2, {
          width: row.id === 'c' ? 2 : 1,
          poolId: PLATFORM,
        }),
      );

    const straight = schedule(rows, [], slicesFor(rows), new Map(), pool(2));
    const shuffled = [rows[2], rows[0], rows[3], rows[1]];
    const jumbled = schedule(shuffled, [], slicesFor(shuffled), new Map(), pool(2));

    for (const id of ['a', 'b', 'c', 'd']) {
      expect(planned(jumbled, id, DEV)).toEqual(planned(straight, id, DEV));
    }
  });

  it('terminates on a plan whose every slice is on one full pool', () => {
    const rows = Array.from({ length: 30 }, (_, at) =>
      item(`w${String(at)}`, { serviceTeamId: PLATFORM }),
    );
    const slices = rows.map((row) => slice(row.id, DEV, 1, { poolId: PLATFORM }));

    const found = schedule(rows, [], slices, new Map(), pool(1));

    // Thirty one-day blocks through a pool of one: a queue thirty long.
    expect(planned(found, 'w29', DEV)).toMatchObject({ earliestStart: 29, earliestFinish: 30 });
    expect(found.waitingForCapacity).toBe(29);
  });

  it('refuses a pooled slice whose pool has no size', () => {
    // R5. The adapter sets `poolId` only for a team that has a size, so an
    // absent entry means the two readings came apart — and a default of
    // "unbounded" here would be a capacity constraint quietly not applied.
    const rows = [item('a', { serviceTeamId: PLATFORM })];
    const slices = [slice('a', DEV, 2, { poolId: PLATFORM })];

    expect(() => schedule(rows, [], slices, new Map(), new Map())).toThrow(
      /no size for pool team-platform/,
    );
  });

  it('refuses a block wider than the pool it draws from, before it searches at all', () => {
    // The `W <= N` clamp's negative, and it is a **bounded** failure rather
    // than a hang: a scan that kept looking for a window past the last event
    // would never come back.
    //
    // The assertion names **which** refusal fired, and that is the whole
    // difference between this being a gate and being a claim. There are two
    // guards on this property — the check before the search and the backstop
    // inside it — and while they said the same words, deleting the first left
    // this test green: the backstop caught the same plan after a full scan and
    // the test could not tell. Watched 2026-08-12, and the clause is the fix.
    const rows = [item('a', { serviceTeamId: PLATFORM, maxParallel: 4 })];
    const slices = [slice('a', DEV, 4, { width: 4, poolId: PLATFORM })];

    expect(() => schedule(rows, [], slices, new Map(), pool(2))).toThrow(
      /cannot fit pool team-platform.*refused before the search/s,
    );
  });

  it('still throws a cycle error on a cyclic graph, pools and all', () => {
    const rows = ['a', 'b'].map((id) => item(id, { serviceTeamId: PLATFORM }));
    const slices = rows.map((row) => slice(row.id, DEV, 2, { poolId: PLATFORM }));

    expect(() =>
      schedule(rows, [edge('a', 'b'), edge('b', 'a')], slices, new Map(), pool(1)),
    ).toThrow(/dependency cycle/);
  });
});

describe('the scan, instrumented', () => {
  it('visits a bounded number of pool events on a plan the size of a real one', () => {
    // A wall-clock assertion is not an R5 proof and is flaky in CI, so what is
    // gated is the work the stated complexity is a claim about: the scan is
    // `O(E)` per placement over the aggregated events of one pool, and a plan
    // of 200 work items × 3 roles on one pool of 4 has at most two events per
    // reserving block.
    //
    // The bound is derived rather than observed: 600 slices, each search
    // walking at most every event already written, is `600 * 2 * 600` in the
    // worst case. Asserting the derived bound is what makes this a claim about
    // the complexity; the observed figure is recorded in `verify.md`.
    const rows = Array.from({ length: 200 }, (_, at) =>
      item(`w${String(at)}`, { serviceTeamId: PLATFORM }),
    );
    const slices = rows.flatMap((row) => [
      slice(row.id, DEV, 2, { poolId: PLATFORM }),
      slice(row.id, QA, 1, { poolId: PLATFORM }),
      slice(row.id, 'role-review', 1, { poolId: PLATFORM }),
    ]);

    const found = schedule(rows, [], slices, new Map(), pool(4));

    const blocks = slices.length;
    expect(found.eventsVisited).toBeLessThanOrEqual(blocks * 2 * blocks);
    // And the plan really did contend, or the bound is about a scan that never
    // ran: 600 blocks through four slots cannot all start on day zero.
    expect(found.waitingForCapacity).toBeGreaterThan(0);
    expect(found.eventsVisited).toBeGreaterThan(0);
  });
});

describe('a width is people, and the engine refuses a slice that claims none', () => {
  // The boundary this change adds, and the one open P2 of PR #48's cross-review:
  // C2's validation is the only thing between a typed `0` and this arithmetic,
  // and a validation that is the *sole* guard is one schema edit away from not
  // being one. `durationOf` is `effort / width`, so a width of 0 is `Infinity`
  // days with effort and `NaN` without — and nothing downstream refuses either:
  // `windowFor` short-circuits on a zero width and reserves nothing,
  // `CapacityTooNarrowError` cannot fire because `0 > 0` is false, and the plan
  // comes back with dates no screen can draw and no sentence to explain them.
  it('refuses a slice claiming no people at all', () => {
    const rows = [item('a')];

    expect(() =>
      schedule(rows, [], [slice('a', DEV, 6, { width: 0 })], new Map(), new Map()),
    ).toThrow(/claims a width of 0/);
    // The unestimated twin, which fails the other way — `0 / 0` is `NaN`, and a
    // `NaN` date compares false against every bound it meets, so it does not
    // even sort.
    expect(() =>
      schedule(rows, [], [slice('a', DEV, null, { width: 0 })], new Map(), new Map()),
    ).toThrow(/claims a width of 0/);
  });

  it('refuses a width that is not a whole number of people', () => {
    // Half a person is not a plan, and `effort / 2.5` is a duration nobody
    // wrote. Injected apart from the `< 1` half above because neither probe can
    // see the other's clause.
    const rows = [item('a')];

    expect(() =>
      schedule(rows, [], [slice('a', DEV, 6, { width: 2.5 })], new Map(), new Map()),
    ).toThrow(/claims a width of 2.5/);
  });
});
