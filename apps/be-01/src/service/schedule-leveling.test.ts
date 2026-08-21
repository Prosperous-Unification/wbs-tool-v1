import { describe, expect, it } from 'bun:test';

import type { WorkItem } from '../repository';
import type { DependencyEdge, Schedule, ScheduledSlice, Slice } from './schedule';
import { schedule, sliceKey } from './schedule';

const DEV = 'role-dev';
const QA = 'role-qa';

let position = 0;
const item = (id: string, parentId: string | null = null): WorkItem => ({
  id,
  projectId: 'p1',
  parentId,
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
});

const edge = (predecessorId: string, successorId: string): DependencyEdge => ({
  predecessorId,
  successorId,
});

const slice = (
  workItemId: string,
  roleId: string,
  days: number | null,
  personId: string | null = null,
): Slice => ({ workItemId, roleId, days, personId, width: 1, poolId: null });

/** One slice's schedule, or a throw — a missing key is a broken fixture, not a null. */
const planned = (found: Schedule, workItemId: string, roleId: string): ScheduledSlice => {
  const one = found.slices.get(sliceKey(workItemId, roleId));
  if (one === undefined) throw new Error(`no slice for ${workItemId}/${roleId}`);
  return one;
};

/** Every pair of one person's slices that share a day — empty is the whole promise. */
function overlaps(found: Schedule): string[] {
  const byPerson = new Map<string, ScheduledSlice[]>();
  for (const one of found.slices.values()) {
    if (one.personId === null) continue;
    byPerson.set(one.personId, [...(byPerson.get(one.personId) ?? []), one]);
  }
  const clashes: string[] = [];
  for (const [personId, own] of byPerson) {
    for (const left of own) {
      for (const right of own) {
        if (left === right) continue;
        if (
          left.earliestStart < right.earliestFinish &&
          right.earliestStart < left.earliestFinish
        ) {
          clashes.push(`${personId}: ${left.workItemId} and ${right.workItemId}`);
        }
      }
    }
  }
  return clashes;
}

describe('leveling — a person does one thing at a time', () => {
  it('runs two work items assigned to one person one after the other', () => {
    const rows = [item('a'), item('b')];
    const slices = [slice('a', DEV, 3, 'kat'), slice('b', DEV, 2, 'kat')];

    const found = schedule(rows, [], slices);

    expect(planned(found, 'a', DEV)).toMatchObject({ earliestStart: 0, earliestFinish: 3 });
    expect(planned(found, 'b', DEV)).toMatchObject({ earliestStart: 3, earliestFinish: 5 });
    expect(overlaps(found)).toEqual([]);
  });

  it('leaves two work items assigned to different people alone', () => {
    const rows = [item('a'), item('b')];
    const slices = [slice('a', DEV, 3, 'kat'), slice('b', DEV, 2, 'bo')];

    const found = schedule(rows, [], slices);

    expect(planned(found, 'a', DEV).earliestStart).toBe(0);
    expect(planned(found, 'b', DEV).earliestStart).toBe(0);
  });

  it('gives the queue to the slice the plan needs first', () => {
    // `b` cannot start before day 4, so `a` — which can start at once — takes
    // the person first, whatever order the rows arrive in.
    const rows = [item('a'), item('b'), item('gate')];
    const slices = [
      slice('b', DEV, 2, 'kat'),
      slice('gate', DEV, 4, null),
      slice('a', DEV, 2, 'kat'),
    ];

    const found = schedule(rows, [edge('gate', 'b')], slices);

    expect(planned(found, 'a', DEV)).toMatchObject({ earliestStart: 0, earliestFinish: 2 });
    expect(planned(found, 'b', DEV)).toMatchObject({ earliestStart: 4, earliestFinish: 6 });
  });

  it('gives the queue to the slice that can start soonest, before the one with less slack', () => {
    // `held` cannot start before day 3 and has no slack; `free` can start at
    // once and has three days of it. Least-slack-first would put `held` in the
    // queue first, leave `kat` idle for three days and push `free` out to 5→7,
    // finishing the project two days later than it needs to. Soonest-first is
    // the outer rule for exactly that reason — and `held` is `010` to `free`'s
    // `020`, so no other part of the priority would put `free` first either.
    const rows = [item('held'), item('free')];
    const slices = [slice('free', DEV, 2, 'kat'), slice('held', DEV, 2, 'kat')];

    const found = schedule(rows, [], slices, new Map([['held', 3]]));

    expect(planned(found, 'free', DEV)).toMatchObject({ earliestStart: 0, earliestFinish: 2 });
    expect(planned(found, 'held', DEV)).toMatchObject({ earliestStart: 3, earliestFinish: 5 });
  });

  it('gives the queue to the slice with less slack when both can start at once', () => {
    // Same earliest start, so the tie is broken on float: `a` is the longer of
    // the two and therefore the one the project is waiting on.
    const rows = [item('short'), item('long')];
    const slices = [slice('short', DEV, 1, 'kat'), slice('long', DEV, 4, 'kat')];

    const found = schedule(rows, [], slices);

    expect(planned(found, 'long', DEV)).toMatchObject({ earliestStart: 0, earliestFinish: 4 });
    expect(planned(found, 'short', DEV)).toMatchObject({ earliestStart: 4, earliestFinish: 5 });
  });

  it('breaks a remaining tie on the work item number, then on role order', () => {
    // Identical in every way that matters to the plan, so the tree order
    // decides — and the same plan therefore schedules the same way twice.
    // Numbered `010` and `020` by their positions, and handed over in the other
    // order, so the tie can only be broken by the number.
    const rows = [item('first'), item('second')];
    rows.reverse();
    const slices = [slice('second', DEV, 2, 'kat'), slice('first', DEV, 2, 'kat')];

    const found = schedule(rows, [], slices);

    expect(planned(found, 'first', DEV).earliestStart).toBe(0);
    expect(planned(found, 'second', DEV).earliestStart).toBe(2);
  });

  it('waits for the dependency and the person at once, whichever is later', () => {
    const rows = [item('a'), item('b'), item('gate')];
    const slices = [
      slice('a', DEV, 5, 'kat'),
      slice('gate', DEV, 2, null),
      slice('b', DEV, 1, 'kat'),
    ];

    const found = schedule(rows, [edge('gate', 'b')], slices);

    // The dependency clears on day 2 and `kat` on day 5.
    expect(planned(found, 'b', DEV)).toMatchObject({
      earliestStart: 5,
      earliestFinish: 6,
      boundBy: 'person',
    });
  });

  it('queues every role of a work item one person covers', () => {
    // The assumed assignee is a queue of one, which is the whole point of it:
    // `kat` doing both roles of `b` cannot start either while she is on `a`.
    const rows = [item('a'), item('b')];
    const slices = [slice('a', DEV, 3, 'kat'), slice('b', DEV, 1, 'kat'), slice('b', QA, 2, 'kat')];

    const found = schedule(rows, [], slices);

    expect(planned(found, 'b', DEV)).toMatchObject({ earliestStart: 3, earliestFinish: 4 });
    expect(planned(found, 'b', QA)).toMatchObject({ earliestStart: 4, earliestFinish: 6 });
    expect(overlaps(found)).toEqual([]);
  });

  it('gives a slice nobody has estimated no place in the queue', () => {
    // `a`'s QA is a slice with nothing in it. Queued behind `kat`'s other work
    // it would sit at day 5 and take `a`'s finish out to 5 with it, reporting a
    // work item that ends on day 3 as ending on day 5 — for a role nobody has
    // put a number against. Nobody is busy for zero days.
    const rows = [item('a'), item('b')];
    const slices = [
      slice('a', DEV, 3, 'kat'),
      slice('a', QA, null, 'kat'),
      slice('b', DEV, 2, 'kat'),
    ];

    const found = schedule(rows, [], slices);

    expect(planned(found, 'a', QA)).toMatchObject({ earliestStart: 3, earliestFinish: 3 });
    expect(found.workItems.get('a')?.earliestFinish).toBe(3);
    expect(planned(found, 'b', DEV)).toMatchObject({ earliestStart: 3, earliestFinish: 5 });
  });

  it('says what is holding a slice, and which slice its person was busy with', () => {
    const rows = [item('a'), item('b')];
    const slices = [slice('a', DEV, 3, 'kat'), slice('b', DEV, 2, 'kat')];

    const found = schedule(rows, [], slices);

    expect(planned(found, 'a', DEV)).toMatchObject({
      boundBy: 'projectStart',
      personId: 'kat',
      resourcePredecessorId: null,
    });
    const waiting = planned(found, 'b', DEV);
    expect(waiting.boundBy).toBe('person');
    expect(waiting.personId).toBe('kat');
    expect(waiting.resourcePredecessorId).toBe(sliceKey('a', DEV));
  });

  it('names the predecessor, not the person, when the two land on the same day', () => {
    // `kat` is free exactly when the dependency clears, so nobody is waiting
    // for her — and a plan that said they were would count this row into "N
    // tasks wait for a person".
    const rows = [item('a'), item('b')];
    const slices = [slice('a', DEV, 3, 'kat'), slice('b', DEV, 2, 'kat')];

    const found = schedule(rows, [edge('a', 'b')], slices);

    expect(planned(found, 'b', DEV)).toMatchObject({
      earliestStart: 3,
      boundBy: 'predecessor',
      resourcePredecessorId: null,
    });
  });

  it('names the role before it when a work item waits on its own earlier role', () => {
    const rows = [item('a')];
    const slices = [slice('a', DEV, 3, null), slice('a', QA, 2, null)];

    const found = schedule(rows, [], slices);

    expect(planned(found, 'a', QA)).toMatchObject({ earliestStart: 3, boundBy: 'roleOrder' });
  });

  it('names the manual floor when that is what pushed a slice', () => {
    const rows = [item('a')];
    const slices = [slice('a', DEV, 3, null)];

    const found = schedule(rows, [], slices, new Map([['a', 4]]));

    expect(planned(found, 'a', DEV)).toMatchObject({ earliestStart: 4, boundBy: 'notBefore' });
  });
});

describe('leveling — the plan the previous algorithm got wrong', () => {
  /**
   * The counterexample that replaced v1's algorithm, as a fixture.
   *
   * v1 computed the critical path, broke the overlaps it could see at those
   * times, and re-ran the forward pass **once**. Here `kat` holds three slices.
   * At critical-path times `p` (0→4) and `q` (0→2) overlap and `r` (5→7, behind
   * a five-day gate) overlaps neither. Breaking the first overlap moves `q` to
   * 4→6 — into `r`, an overlap that did not exist when the overlaps were
   * looked for, and that one re-run never looks again.
   *
   * Serial generation cannot produce it: `r` is placed after `q`, so its floor
   * is where `q` actually landed.
   */
  const rows = [item('p'), item('q'), item('r'), item('gate')];
  const slices = [
    slice('p', DEV, 4, 'kat'),
    slice('q', DEV, 2, 'kat'),
    slice('r', DEV, 2, 'kat'),
    slice('gate', DEV, 5, null),
  ];
  const edges = [edge('gate', 'r')];

  it('is a plan the old fault would have shown on: the pushed slice lands on a later one', () => {
    // The fixture is as capable of being harmless as the engine is of being
    // wrong. Without leveling, `q` sits at 0→2 and `r` at 5→7 — no overlap to
    // see — and `p`'s queue is what moves `q` onto `r`.
    const unleveled = schedule(
      rows,
      edges,
      slices.map((one) => ({ ...one, personId: null })),
    );

    expect(planned(unleveled, 'q', DEV)).toMatchObject({ earliestStart: 0, earliestFinish: 2 });
    expect(planned(unleveled, 'r', DEV)).toMatchObject({ earliestStart: 5, earliestFinish: 7 });
    expect(planned(unleveled, 'p', DEV)).toMatchObject({ earliestStart: 0, earliestFinish: 4 });
  });

  it('does not re-overlap a person downstream of a dependency push', () => {
    const found = schedule(rows, edges, slices);

    expect(planned(found, 'p', DEV)).toMatchObject({ earliestStart: 0, earliestFinish: 4 });
    expect(planned(found, 'q', DEV)).toMatchObject({ earliestStart: 4, earliestFinish: 6 });
    // 6, not 5: the gate clears on day 5 and `kat` on day 6.
    expect(planned(found, 'r', DEV)).toMatchObject({
      earliestStart: 6,
      earliestFinish: 8,
      boundBy: 'person',
      resourcePredecessorId: sliceKey('q', DEV),
    });
    expect(overlaps(found)).toEqual([]);
  });
});

describe('leveling — slack and critical through people', () => {
  it('counts the person behind a slice as a reason it cannot slip', () => {
    // `b` has a day of slack against the dependency graph alone. It has none
    // once `kat` is counted: slipping it slips `c`, and `c` ends the project.
    const rows = [item('a'), item('b'), item('c')];
    const slices = [slice('a', DEV, 2, null), slice('b', DEV, 2, 'kat'), slice('c', DEV, 3, 'kat')];

    const found = schedule(rows, [edge('a', 'c')], slices);

    expect(planned(found, 'b', DEV)).toMatchObject({ earliestStart: 0, earliestFinish: 2 });
    expect(planned(found, 'c', DEV)).toMatchObject({ earliestStart: 2, earliestFinish: 5 });
    expect(planned(found, 'b', DEV).float).toBe(0);
    expect(planned(found, 'b', DEV).critical).toBe(true);
  });

  it('reports the least slack of a work item whose slices a person pushed apart', () => {
    // `w`'s `QA` is held off by `kat` until she has finished `hog`, leaving a
    // gap inside the row. Its ends no longer describe one continuous piece of
    // work, so the row's slack is the least of its slices' rather than the
    // difference between its own start and its own late start.
    const rows = [item('hog'), item('w'), item('tail')];
    const slices = [
      slice('hog', DEV, 6, 'kat'),
      slice('w', DEV, 1, null),
      slice('w', QA, 2, 'kat'),
      slice('tail', DEV, 1, null),
    ];

    const found = schedule(rows, [edge('w', 'tail')], slices);

    expect(planned(found, 'w', DEV)).toMatchObject({ earliestStart: 0, earliestFinish: 1 });
    expect(planned(found, 'w', QA)).toMatchObject({ earliestStart: 6, earliestFinish: 8 });
    const row = found.workItems.get('w');
    expect(row?.float).toBe(0);
    expect(row?.critical).toBe(true);
    // `tail` is pinned here because this fixture has an edge in it and nothing
    // was watching where the edge landed: `tail` ran from day 8 under the
    // whole-item rule and runs from day 1 under the anchor rule, and the test
    // stayed green through the move. It waits on `w`'s `Dev` — `w`'s first
    // estimated slice, done on day 1 — while `w`'s `QA` sits in kat's queue
    // until day 6, five days after the row it no longer holds.
    //
    // Proof: `anchorNode` in `schedule.ts` set to the leaf's last node — the
    // whole-item rule — and this failed on `earliestStart` `Expected: 1,
    // Received: 8`; watched 2026-08-11.
    expect(planned(found, 'tail', DEV)).toMatchObject({
      earliestStart: 1,
      earliestFinish: 2,
      boundBy: 'predecessor',
    });
  });
});

describe('leveling — the anchor and the queue', () => {
  it('holds a successor to the anchor a person pushed, not to the anchor the plan alone would have', () => {
    // `kat` does `hog` (0→6, the longest path there is, so hers first) and then
    // `lead`'s `Dev`, which is `lead`'s anchor and cannot start before she is
    // free: 6→8. The plan alone would have put that anchor at 0→2 and released
    // `sub` on day 2. It is released on day 8 — the **levelled** anchor finish
    // — and `boundBy` says the dependency, not the person: `sub` is nobody's
    // work.
    //
    // Proof: `anchorNode` set to the leaf's last node — the whole-item rule —
    // and this failed on `sub` `earliestStart` `Expected: 8, Received: 11`,
    // the day `lead`'s QA finished; watched 2026-08-11.
    const rows = [item('hog'), item('lead'), item('sub')];
    const slices = [
      slice('hog', DEV, 6, 'kat'),
      slice('lead', DEV, 2, 'kat'),
      slice('lead', QA, 3, null),
      slice('sub', DEV, 1, null),
    ];

    const found = schedule(rows, [edge('lead', 'sub')], slices);

    expect(planned(found, 'lead', DEV)).toMatchObject({
      earliestStart: 6,
      earliestFinish: 8,
      boundBy: 'person',
      resourcePredecessorId: sliceKey('hog', DEV),
    });
    expect(planned(found, 'sub', DEV)).toMatchObject({
      earliestStart: 8,
      earliestFinish: 9,
      boundBy: 'predecessor',
    });
    // `lead`'s QA runs beside `sub` rather than before it — the whole point of
    // the anchor rule, and here it is a person who set the day they share.
    expect(planned(found, 'lead', QA)).toMatchObject({ earliestStart: 8, earliestFinish: 11 });
    expect(overlaps(found)).toEqual([]);
  });

  it('queues a predecessor’s later role against its own successor’s work', () => {
    // The contention the anchor rule created and nothing could produce before
    // it: `kat` holds both `lead`'s `QA` and `sub`'s `Dev`, and under the
    // whole-item rule `lead`'s QA always ran first because `sub` could not
    // start until it had. Now they are eligible on the same day — `lead`'s
    // anchor releases `sub` on day 2, and `lead`'s QA is free from day 2 too —
    // so the leveller has to choose, and the loser records whom it waited for.
    //
    // The tie goes to `lead`'s QA on the critical-path ranking, so `sub` is the
    // one that queues: 5→6, `boundBy` the person, behind `lead/role-qa`.
    //
    // Proof: `anchorNode` set to the leaf's last node — the whole-item rule —
    // and this failed on `boundBy` `person` → `predecessor` and
    // `resourcePredecessorId` `lead/role-qa` → `null`, on the same day 5. That
    // is the finding exactly: under the old rule this contention could not
    // exist, and the days alone would not have shown it. Watched 2026-08-11.
    const rows = [item('lead'), item('sub')];
    const slices = [
      slice('lead', DEV, 2, null),
      slice('lead', QA, 3, 'kat'),
      slice('sub', DEV, 1, 'kat'),
    ];

    const found = schedule(rows, [edge('lead', 'sub')], slices);

    expect(planned(found, 'lead', QA)).toMatchObject({ earliestStart: 2, earliestFinish: 5 });
    expect(planned(found, 'sub', DEV)).toMatchObject({
      earliestStart: 5,
      earliestFinish: 6,
      boundBy: 'person',
      resourcePredecessorId: sliceKey('lead', QA),
    });
    expect(overlaps(found)).toEqual([]);
    expect(found.waitingForPerson).toBe(1);
  });
});

describe('leveling — slack against a person, in thirds of a day', () => {
  /** A PERT third: the durations real plans are full of, and integers are not. */
  const THIRD = 4 / 3;

  it('reports a queue that ends the project as critical, exactly', () => {
    // `kat` does `a` and then `b`, and that queue is the longest path there is.
    // Both slices are therefore critical and have no slack.
    //
    // The late starts are asserted verbatim because they are the only place the
    // tight-path rule's answer still shows. `float` is reported through
    // `slackOf`, which snaps a ±1e-15 difference to zero, so it comes back `0`
    // and `critical` comes back `true` whether or not the rule ran — the red
    // this test is here to catch has to be read off `latestStart`, which the
    // engine reports as it computed it.
    const rows = [item('a'), item('b')];
    const slices = [slice('a', DEV, THIRD, 'kat'), slice('b', DEV, 1, 'kat')];

    const found = schedule(rows, [], slices);

    expect(planned(found, 'b', DEV).earliestStart).toBe(THIRD);
    expect(planned(found, 'a', DEV).latestStart).toBe(0);
    expect(planned(found, 'b', DEV).latestStart).toBe(THIRD);
    expect(planned(found, 'a', DEV).float).toBe(0);
    expect(planned(found, 'a', DEV).critical).toBe(true);
    expect(planned(found, 'b', DEV).float).toBe(0);
    expect(planned(found, 'b', DEV).critical).toBe(true);
    expect(found.workItems.get('b')?.critical).toBe(true);
  });

  it('leaves a slice beside that queue with the slack it has, and no red', () => {
    // What the tight-path rule promises is that a slice which **cannot move**
    // reports exactly zero. `c` can move, and its slack is a subtraction from a
    // project finish that is itself a third of a day — so it is asserted to the
    // day rather than to the bit, which is all anybody reads off a slack column.
    const rows = [item('a'), item('b'), item('c')];
    const slices = [
      slice('a', DEV, THIRD, 'kat'),
      slice('b', DEV, 1, 'kat'),
      slice('c', DEV, 1, null),
    ];

    const found = schedule(rows, [], slices);

    expect(planned(found, 'c', DEV).critical).toBe(false);
    expect(planned(found, 'c', DEV).float).toBeCloseTo(THIRD, 12);
  });
});

describe('leveling — how much of the plan is queueing', () => {
  it('counts nothing when nobody is assigned', () => {
    const rows = [item('a'), item('b')];
    const slices = [slice('a', DEV, 3, null), slice('b', DEV, 2, null)];

    expect(schedule(rows, [], slices).waitingForPerson).toBe(0);
  });

  it('counts the work items a person is the reason for, once each', () => {
    const rows = [item('a'), item('b'), item('c')];
    const slices = [
      slice('a', DEV, 3, 'kat'),
      slice('b', DEV, 1, 'kat'),
      slice('b', QA, 1, 'kat'),
      slice('c', DEV, 1, null),
    ];

    const found = schedule(rows, [], slices);

    // `b`'s `Dev` waits for `kat`; its `QA` waits for its own `Dev`, which is
    // not a person waiting — and the work item is counted once either way.
    expect(found.waitingForPerson).toBe(1);
  });
});
