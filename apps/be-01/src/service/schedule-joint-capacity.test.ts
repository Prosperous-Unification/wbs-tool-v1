import { describe, expect, it } from 'bun:test';

import type { WorkItem } from '../repository';
import type { PoolSizes, Schedule, ScheduledSlice, Slice } from './schedule';
import { schedule, sliceKey } from './schedule';

/**
 * The joint window search: a block labelled with several teams spends slots in
 * **every** one of them, so it starts at the earliest instant all of them have
 * room and takes a slot from each (Dany, 2026-08-13, decision 3).
 *
 * Beside `schedule-capacity.test.ts` rather than inside it, because that file
 * is the single-pool engine and every claim in it stays true: `windowFor` is
 * untouched by this change, and a set of one is that search verbatim. The
 * identity half of *this* change — that a set of one schedules byte for byte as
 * it did — is `schedule-identity.test.ts`'s thousand-plan differential and
 * `capacity-migration-identity.test.ts`'s sixteen-plan replay, both of which
 * this change extended rather than duplicated.
 *
 * The teams are named so the two orders a reader might confuse are always
 * visibly apart: `team-alpha` sorts before `team-beta`, and the fixtures below
 * deliberately put the right answer on whichever of them the *wrong* rule would
 * not choose.
 */

const DEV = 'role-dev';
const ALPHA = 'team-alpha';
const BETA = 'team-beta';

let position = 0;
const item = (
  id: string,
  overrides: Partial<Pick<WorkItem, 'parentId' | 'maxParallel' | 'priority'>> = {},
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
  maxParallel: 1,
  revision: 0,
  ...overrides,
});

/**
 * One slice, with the two facts the caller resolves written out — the contract
 * `schedule-capacity.test.ts`'s own fixture states, under a set of pools.
 */
const slice = (
  workItemId: string,
  days: number | null,
  extra: Partial<Pick<Slice, 'personId' | 'width' | 'poolIds'>> = {},
): Slice => ({
  workItemId,
  roleId: DEV,
  days,
  personId: null,
  width: 1,
  poolIds: [],
  ...extra,
});

/** One slice's schedule, or a throw — a missing key is a broken fixture, not a null. */
const planned = (found: Schedule, workItemId: string): ScheduledSlice => {
  const one = found.slices.get(sliceKey(workItemId, DEV));
  if (one === undefined) throw new Error(`no slice for ${workItemId}`);
  return one;
};

/** The blocking set as readable work item ids, so a failure names rows. */
const blockersOf = (one: ScheduledSlice): string[] =>
  one.capacityPredecessorIds.map((key) => key.replace(`\u0000${DEV}`, '')).sort();

const pools = (alpha: number, beta: number): PoolSizes =>
  new Map([
    [ALPHA, alpha],
    [BETA, beta],
  ]);

describe('a block labelled with two teams waits for both of them', () => {
  it('starts when the later pool frees a slot, not when the earlier one does', () => {
    // Alpha is held to day 5 and Beta to day 2. A block that spends both may
    // not start at 2 — Alpha has nothing to give it there — so it starts at 5,
    // and the sentence names Alpha.
    //
    // Proof: the fixpoint's `window.start > best` written as `<`, so the
    // candidate follows the *earliest* pool — "either pool will do", which is
    // the other reading of a set — and this failed with `earliestStart` 0 and
    // `boundBy: 'projectStart'` where 5 and `capacity` were owed: a block
    // running while both its pools were full. 3 pass / 5 fail; watched
    // 2026-08-14.
    const rows = [
      item('holds-alpha', { priority: 1 }),
      item('holds-beta', { priority: 1 }),
      item('both', { priority: 2 }),
    ];
    const slices = [
      slice('holds-alpha', 5, { poolIds: [ALPHA] }),
      slice('holds-beta', 2, { poolIds: [BETA] }),
      slice('both', 1, { poolIds: [ALPHA, BETA] }),
    ];

    const found = schedule(rows, [], slices, new Map(), pools(1, 1));

    const both = planned(found, 'both');
    expect(both).toMatchObject({
      earliestStart: 5,
      earliestFinish: 6,
      boundBy: 'capacity',
      capacityTeamId: ALPHA,
    });
    // The earlier pool's own answer, named so the failure reads as what it is.
    expect(both.earliestStart).not.toBe(2);
  });

  it('names whichever team ran out, not the first of the set', () => {
    // The same plan with the two holds swapped. Nothing about the block or the
    // order of its `poolIds` changes; the team the sentence names does.
    //
    // Proof: `capacityTeamId` read as `poolIds[0]` whenever the search bound
    // anything — the narrowing this field exists to prevent, and the one the
    // chart would otherwise make from the row's own labels — and this failed
    // with `"team-alpha"` where `"team-beta"` was owed: a date explained by a
    // team that had room. 6 pass / 2 fail; watched 2026-08-14.
    const rows = [
      item('holds-alpha', { priority: 1 }),
      item('holds-beta', { priority: 1 }),
      item('both', { priority: 2 }),
    ];
    const slices = [
      slice('holds-alpha', 2, { poolIds: [ALPHA] }),
      slice('holds-beta', 5, { poolIds: [BETA] }),
      slice('both', 1, { poolIds: [ALPHA, BETA] }),
    ];

    const found = schedule(rows, [], slices, new Map(), pools(1, 1));

    expect(planned(found, 'both')).toMatchObject({
      earliestStart: 5,
      boundBy: 'capacity',
      capacityTeamId: BETA,
    });
  });

  it('takes a slot from every pool it names, so both are busy behind it', () => {
    // Decision 3 itself: three teams on a five-day slice block five days in
    // each of the three pools, not five days split between them. Watched from
    // the other side — one block on both pools, then a single-pool block behind
    // each of them, and neither may start until the joint block has finished.
    //
    // Proof: `reserve` narrowed to `poolIds.slice(0, 1)` — the shape of
    // spending one team's days and none of the other's — and this failed on
    // `after-beta` coming back at `earliestStart` 0 where 3 was owed,
    // `boundBy: 'projectStart'` and nothing waiting for Beta at all. 7 pass /
    // 1 fail; watched 2026-08-14.
    const rows = [
      item('both', { priority: 1 }),
      item('after-alpha', { priority: 2 }),
      item('after-beta', { priority: 2 }),
    ];
    const slices = [
      slice('both', 3, { poolIds: [ALPHA, BETA] }),
      slice('after-alpha', 1, { poolIds: [ALPHA] }),
      slice('after-beta', 1, { poolIds: [BETA] }),
    ];

    const found = schedule(rows, [], slices, new Map(), pools(1, 1));

    expect(planned(found, 'both').earliestStart).toBe(0);
    for (const id of ['after-alpha', 'after-beta']) {
      expect(planned(found, id)).toMatchObject({
        earliestStart: 3,
        boundBy: 'capacity',
        capacityTeamId: id === 'after-alpha' ? ALPHA : BETA,
      });
    }
  });

  it('edges every reservation either pool stepped over, and reports no float it has not got', () => {
    // The blocking set is the union across the pools **and across the rounds**,
    // not the last scan's: at the answer every pool fits, so the final round
    // records nothing at all. What the rounds record is why the block could not
    // start where it was asked to, which is the set of reservations that had to
    // end.
    //
    // Alpha holds to 5, Beta to 2, the joint block therefore starts at 5. Both
    // holds are edged, and the error is one-sided in the direction the design
    // argues: `holds-beta` could in truth slip to 5 without moving anything,
    // and is reported tighter than that. Never looser.
    //
    // Proof: the blocking union taken from `binding`'s own sets instead of
    // accumulated across the rounds, which is the final round's scans and
    // therefore empty — and this failed on `expect(blockersOf(both))` with
    // `[]` received where both holds were owed: a slice claiming a capacity
    // wait and edging nothing, so every blocker reads as free to slip.
    // 7 pass / 1 fail; watched 2026-08-14.
    const rows = [
      item('holds-alpha', { priority: 1 }),
      item('holds-beta', { priority: 1 }),
      item('both', { priority: 2 }),
      // An unpooled tail, so the project finish is past the block and there is
      // real slack in the plan for the float claim to be about.
      item('tail', { priority: 3 }),
    ];
    const slices = [
      slice('holds-alpha', 5, { poolIds: [ALPHA] }),
      slice('holds-beta', 2, { poolIds: [BETA] }),
      slice('both', 1, { poolIds: [ALPHA, BETA] }),
      slice('tail', 20),
    ];

    const found = schedule(rows, [], slices, new Map(), pools(1, 1));

    const both = planned(found, 'both');
    expect(blockersOf(both)).toEqual(['holds-alpha', 'holds-beta']);
    // The display referent is the latest finisher of the whole set, and it is a
    // slice of this plan rather than a key nothing answers to.
    expect(both.resourcePredecessorId).toBe(sliceKey('holds-alpha', DEV));
    expect(found.slices.has(both.resourcePredecessorId ?? '')).toBe(true);
    // Both edges are real edges: neither hold may finish after the block starts.
    for (const id of ['holds-alpha', 'holds-beta']) {
      expect(planned(found, id).latestFinish).toBeLessThanOrEqual(both.latestStart);
    }
    // The direction, over every slice: nothing is ever reported movable when it
    // is not, and float is never negative.
    for (const one of found.slices.values()) {
      expect(one.float).toBeGreaterThanOrEqual(0);
      if (one.critical) expect(one.float).toBe(0);
    }
  });

  it('breaks a tie between two pools on the blocker the reader is looking at', () => {
    // Both pools free a slot at day 4, so both bound the block. Beta's blocking
    // set holds a reservation running to day 10; Alpha's runs to 4. The team
    // named is Beta — the one whose blocking set holds the latest finisher,
    // which is the display referent's own rule, so the team the sentence names
    // and the slice the arrow points at are answers to one question.
    //
    // `team-alpha` sorts first, so a tie broken on the id alone would answer
    // Alpha here. That is the point of the fixture.
    //
    // Proof: the tie taken on the pool id alone — the latest-finisher clause
    // dropped, leaving `capacityTeamId === null || pool.poolId <
    // capacityTeamId` — and this failed with `"team-alpha"` where
    // `"team-beta"` was owed, naming a team whose blocker the chart's arrow
    // does not point at. 7 pass / 1 fail; watched 2026-08-14.
    const rows = [
      item('alpha-hold', { priority: 1 }),
      item('beta-long', { priority: 1 }),
      item('beta-short', { priority: 1 }),
      item('both', { priority: 2 }),
    ];
    const slices = [
      slice('alpha-hold', 4, { poolIds: [ALPHA] }),
      slice('beta-long', 10, { poolIds: [BETA] }),
      slice('beta-short', 4, { poolIds: [BETA] }),
      slice('both', 1, { poolIds: [ALPHA, BETA] }),
    ];

    // Beta holds two at once, so its two reservations sit side by side and the
    // block waits for the shorter of them to release.
    const found = schedule(rows, [], slices, new Map(), pools(1, 2));

    const both = planned(found, 'both');
    expect(both).toMatchObject({ earliestStart: 4, boundBy: 'capacity', capacityTeamId: BETA });
    // The referent is in the named team's blocking set, which is the coherence
    // the tie rule buys.
    expect(both.resourcePredecessorId).toBe(sliceKey('beta-long', DEV));
    expect(blockersOf(both)).toEqual(['alpha-hold', 'beta-long', 'beta-short']);
  });

  it('re-asks every pool from the instant another pool pushed it to', () => {
    // **The fixpoint's own reason to exist, and it took an injection to find
    // that nothing else in the suite needed it.** A single round — ask each
    // pool once from the plan floor, take the latest answer — is right only
    // when moving to that answer cannot make another pool say no. Here it does.
    //
    // Alpha is busy 0→3. Beta is free at 0 and busy 3→6, because `b-late` is
    // floored to day 3 by a manual date. Round one: Alpha answers 3, Beta
    // answers 0, so the candidate moves to 3 — and at 3 Beta is now full.
    // Round two: Beta answers 6. Round three: both fit, and 6 is the answer.
    // A one-round search returns **3**, placing the block on top of `b-late`.
    //
    // Proof: `jointWindowFor`'s loop replaced by one pass over the pools from
    // the floor, keeping the binding condition so the placement's invariant
    // stays quiet, and this failed with `earliestStart` 3 where 6 was owed and
    // `capacityTeamId: "team-alpha"` where Beta was owed — a block running
    // beside a reservation that already held its only slot. The whole of
    // `src/service` was **489 pass / 0 fail** under the same fault before this
    // test existed; watched 2026-08-14.
    const rows = [
      item('a-early', { priority: 1 }),
      item('b-late', { priority: 1 }),
      item('both', { priority: 2 }),
    ];
    const slices = [
      slice('a-early', 3, { poolIds: [ALPHA] }),
      slice('b-late', 3, { poolIds: [BETA] }),
      slice('both', 1, { poolIds: [ALPHA, BETA] }),
    ];

    const found = schedule(rows, [], slices, new Map([['b-late', 3]]), pools(1, 1));

    // The premise: Beta really is free at day 0 and busy from 3.
    expect(planned(found, 'b-late')).toMatchObject({ earliestStart: 3, earliestFinish: 6 });
    const both = planned(found, 'both');
    expect(both).toMatchObject({
      earliestStart: 6,
      boundBy: 'capacity',
      capacityTeamId: BETA,
    });
    // The one-round answer, named so a regression reads as what it is.
    expect(both.earliestStart).not.toBe(3);
    // Both rounds' scans are in the set: Alpha's hold pushed the candidate to
    // 3, Beta's hold pushed it from 3 to 6, and each is a reservation that had
    // to end.
    expect(blockersOf(both)).toEqual(['a-early', 'b-late']);
  });

  it('names no team on a slice no pool held up', () => {
    // The invariant `capacityTeamId` shares with `capacityPredecessorIds`: a
    // team named on a block nothing held up is a wait that is not there, in the
    // same way an arrow drawn for a resource edge that did not bind would be.
    // Asserted where a pool exists and simply has room, which is the case a
    // "set it whenever there are pools" reading would get wrong.
    //
    // Proof: `binding = reached` moved above the fixpoint's `return`, so the
    // final round's set — every pool, each of them fitting — survives instead
    // of being discarded, and this failed inside the placement on `first
    // role-dev names team-alpha with no pool binding it`: the invariant that
    // replaced the gate, catching a team named on a block nothing held up.
    // 3 pass / 5 fail; watched 2026-08-14.
    const rows = [item('first', { priority: 1 }), item('second', { priority: 2 })];
    const slices = [
      slice('first', 2, { poolIds: [ALPHA, BETA] }),
      slice('second', 2, { poolIds: [ALPHA, BETA] }),
    ];

    const found = schedule(rows, [], slices, new Map(), pools(2, 2));

    // Both fit side by side, so neither waits for anything.
    for (const id of ['first', 'second']) {
      expect(planned(found, id)).toMatchObject({
        earliestStart: 0,
        boundBy: 'projectStart',
        capacityTeamId: null,
        capacityPredecessorIds: [],
      });
    }
  });

  it('refuses a block wider than the narrowest of its pools, and says which one', () => {
    // `CapacityTooNarrowError` exists to say the caller's clamp and these sizes
    // came apart. With several pools the two readings have several chances to
    // disagree, so the message must name **which** pool or the invariant is
    // unactionable at exactly the moment it fires (design brief §7 risk 7).
    //
    // Unreachable from any plan: `poolsFor` clamps the width to the minimum
    // stated size, which is what `work-item.service.test.ts`'s `takes the
    // narrowest stated size` pins. This is that invariant asserted from the
    // engine's side.
    const rows = [item('wide', { maxParallel: 3 })];
    const slices = [slice('wide', 3, { width: 3, poolIds: [ALPHA, BETA] })];

    expect(() => schedule(rows, [], slices, new Map(), pools(4, 1))).toThrow(
      `a block of width 3 cannot fit pool ${BETA}, which holds 1`,
    );
  });

  it('visits a bounded number of events, and the bound is the fixpoint’s own', () => {
    // The complexity claim, restated for the joint search. One round asks each
    // pool for a window; a round that does not finish moves the candidate
    // strictly forward onto an instant some pool's event list holds, and the
    // union of those lists holds at most `2 × blocks × pools` of them. So the
    // rounds are bounded, each round visits at most one pool's events per pool,
    // and the product is the bound below. Instrumentation rather than a
    // wall-clock assertion, for `Schedule.eventsVisited`'s own reason.
    const blocks = 12;
    const rows = Array.from({ length: blocks }, (_, at) => item(`b${String(at)}`));
    const slices = rows.map((row) => slice(row.id, 2, { poolIds: [ALPHA, BETA] }));

    const found = schedule(rows, [], slices, new Map(), pools(1, 1));

    const events = 2 * blocks;
    const poolCount = 2;
    expect(found.eventsVisited).toBeLessThanOrEqual(poolCount * (events * poolCount + 1) * events);
    // And it did real work — a bound a zero would satisfy proves nothing.
    expect(found.eventsVisited).toBeGreaterThan(0);
    // The plan itself is the serial one: one slot in each pool, twelve blocks
    // of two days, so the last of them ends on day 24.
    expect(planned(found, `b${String(blocks - 1)}`).earliestFinish).toBe(events);
  });
});
