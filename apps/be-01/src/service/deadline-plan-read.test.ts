import { beforeEach, describe, expect, it } from 'bun:test';

import type { DirectoryStore, ProjectStore, WriteStamp } from '../repository';
import { inMemoryServices } from '../testing/harness';
import { projectRow, testProjectService } from '../testing/project-fixture';
import type { OptimizedScheduleAsk, OptimizedScheduleRead } from './optimized-schedule-reader';
import { WorkItemService, type WorkItemServiceOptions } from './work-item.service';

/**
 * The read path that turns a **stored** deadline into the offset `schedule()`
 * reads — `work-item-deadline` tasks.md 5.4's storage half and 6.4.
 *
 * Slice 1 gave the column a migration, slices 2–5 gave the domain
 * `deadlineOffsetOf`, the effective fold and the lateness arithmetic, and slice
 * 6 made the column writable. Until this diff the plan read still handed
 * `schedule()` an empty map, so every one of those was reachable only from a
 * test: a date a user typed changed nothing they could see. These cases are
 * about that last seam and nothing else — **whose dates reach the engine**, not
 * what the engine does with them, which is
 * `libs/domain/src/schedule-deadline-order.test.ts`'s and
 * `libs/domain/src/leaf-constraints.test.ts`'s.
 *
 * **Every case that claims a deadline changed something reads the tree twice**,
 * once before the date exists and once after, and asserts the difference. A
 * single read asserting `lateBy === 2` would pass against a fixture that was
 * always late, which is the check-that-cannot-fail R5 names; the before-read is
 * what makes the deadline the cause. The two that read the **scheduling
 * outcome** once are the negative controls, each labelled as one where it
 * stands — the no-start-date one does call `tree()` twice, once for the plan
 * and once for the stored row, which is the pair it exists to hold together.
 *
 * Measured, not argued: with **both** newly threaded uses reverted to
 * `NO_DEADLINES` — the cache ask and the `schedule()` call — on h2puni at
 * `9d4542f5`, **5 of the 7 go red** and the two that survive are exactly those
 * controls. Reverting only the `schedule()` argument leaves a third green by
 * design: the cache-key case watches the ask, which is the other seam.
 */

const OWNER = 'owner-account';
const WROTE: WriteStamp = { at: 1, by: OWNER };
/**
 * A Monday, so `nextWorkday` leaves it alone and day zero is the project start
 * itself. A weekend start would put day zero on the following Monday and every
 * offset below would be an assertion about `nextWorkday` rather than about this
 * read.
 */
const START = '2026-03-02';

let projects: ProjectStore;
let directory: DirectoryStore;
let serviceOptions: WorkItemServiceOptions;
let service: WorkItemService;
let projectId: string;
let stepId: string;

beforeEach(async () => {
  const harness = inMemoryServices();
  ({ projects, directory } = harness.stores);
  serviceOptions = { ...harness.stores, broadcast: harness.broadcast };
  service = harness.service;
  stepId = crypto.randomUUID();
  const project = projectRow({
    id: crypto.randomUUID(),
    ownerId: OWNER,
    startDate: START,
    // The estimate reaches the schedule as the number the fixture states, so a
    // span below is a claim about the deadline rather than about PERT's
    // weights or about `ceil`.
    estimateMethod: 'realistic',
    estimateRounding: 'exact',
  });
  await projects.create(
    project,
    [{ id: stepId, projectId: project.id, name: 'Dev', position: 10 }],
    WROTE,
  );
  projectId = project.id;
});

/** A leaf on the plan, through the write path, carrying `days` of work. */
async function leaf(name: string, days: number, parentId: string | null = null): Promise<string> {
  const made = await service.create(projectId, OWNER, { parentId, afterId: null, name });
  if (!made.ok) throw new Error(`create failed: ${made.reason}`);
  const estimated = await service.setEstimate(made.value.id, OWNER, stepId, {
    optimistic: days,
    realistic: days,
    pessimistic: days,
  });
  if (!estimated.ok) throw new Error(`estimate failed: ${estimated.reason}`);
  return made.value.id;
}

/** A parent with no estimate of its own — its children carry the work. */
async function parent(name: string): Promise<string> {
  const made = await service.create(projectId, OWNER, { parentId: null, afterId: null, name });
  if (!made.ok) throw new Error(`create failed: ${made.reason}`);
  return made.value.id;
}

/** Sets or clears a deadline through the ordinary patch path, and refuses to guess. */
async function setDeadline(id: string, deadline: string | null): Promise<void> {
  const done = await service.patch(id, OWNER, { deadline });
  if (!done.ok) throw new Error(`patch failed: ${done.reason}`);
}

/** `lateBy` per work item name, as the payload carries it. */
async function lateness(probe: WorkItemService = service): Promise<Map<string, number | null>> {
  const tree = await probe.tree(projectId);
  if (tree === null) throw new Error('project vanished');
  const nameOf = new Map(tree.workItems.map((row) => [row.id, row.name]));
  return new Map(
    tree.slices.map((slice) => [nameOf.get(slice.workItemId) ?? slice.workItemId, slice.lateBy]),
  );
}

/** The day each named work item's slice starts on. */
async function starts(): Promise<Map<string, number>> {
  const tree = await service.tree(projectId);
  if (tree === null) throw new Error('project vanished');
  const nameOf = new Map(tree.workItems.map((row) => [row.id, row.name]));
  return new Map(
    tree.slices.map((slice) => [
      nameOf.get(slice.workItemId) ?? slice.workItemId,
      slice.earliestStart,
    ]),
  );
}

/** The stored date, read back off the row rather than off the plan. */
async function storedDeadline(id: string): Promise<string | null> {
  const tree = await service.tree(projectId);
  return tree?.workItems.find((row) => row.id === id)?.deadline ?? null;
}

/**
 * A reader that records the `ScheduleInput` the optimized cache is asked about
 * and serves nothing, so the read falls through to Fast.
 *
 * That input **is** the cache key (`canonical-schedule-input.ts`), which is why
 * 6.4 needs no machinery of its own: an edit invalidates the cache exactly when
 * it moves this object. Borrowed from `optimized-plan-read.test.ts`, which
 * proves the seam itself.
 */
function recordingReader(): {
  asks: OptimizedScheduleAsk[];
  read: (ask: OptimizedScheduleAsk) => OptimizedScheduleRead;
} {
  const asks: OptimizedScheduleAsk[] = [];
  return {
    asks,
    read: (ask: OptimizedScheduleAsk) => {
      asks.push(ask);
      return {
        inputHash: 'deadline-probe-input-hash',
        generation: null,
        contractVersion: '7+deadline-probe',
        budgetMs: 60_000,
        variants: { pri: { state: 'idle' }, time: { state: 'idle' } },
        selectedSchedule: null,
      };
    },
  };
}

describe('the plan read and stored deadlines', () => {
  it('reports a stored deadline as late by the workdays the plan missed it by', async () => {
    // Proof: `deadlines` in `work-item.service.ts` replaced by `NO_DEADLINES`
    // and the second read comes back `null` — the row reported **on time**,
    // which is the answer the whole feature exists to stop giving.
    const rewire = await leaf('Rewire', 5);
    expect(await lateness()).toEqual(new Map([['Rewire', null]]));

    // Wednesday of the first week: day zero is Monday, so the offset is 2. A
    // five-day slice starting at day zero is still on workday 4, so it is late
    // by two — `lastWorkdayOf(0, 5) − 2`, the one arithmetic in `on-time.ts`.
    await setDeadline(rewire, '2026-03-04');

    expect(await lateness()).toEqual(new Map([['Rewire', 2]]));
  });

  it('leaves a met deadline unreported, so the number is the miss and not the date', async () => {
    // The other half of the case above, and not a restatement of it: a stored
    // date that reaches the engine and is **met** must come back `null`. A
    // read that reported every deadlined row late would pass the first case.
    //
    // It is a **negative control and says so**: it is one of the two cases in
    // this file that stay green with the read reverted to `NO_DEADLINES` (5 of
    // 7 red, measured on h2puni at `9d4542f5`), because an unwired read also
    // answers `null`. Its work is done beside the case above, which is the one
    // that detects the wiring.
    const rewire = await leaf('Rewire', 2);

    // Friday, offset 4. A two-day slice at day zero is still on workday 1.
    await setDeadline(rewire, '2026-03-06');

    expect(await lateness()).toEqual(new Map([['Rewire', null]]));
  });

  it('moves the ready set: the dated slice takes the person first', async () => {
    // Two leaves, one person, one step: the queue Fast levels. The control is
    // the plan's own order — `create` with no `afterId` puts the newer row
    // first, so `Rewire` holds the person from day zero and `Strip` waits three
    // days behind it. A date on `Strip` gives it the tighter slack and it takes
    // the person instead. This is the case that says the offsets reached the
    // **comparator** and not only the report — the lateness cases above stay
    // green under a read that hands `schedule()` the map and never orders by
    // it, because a late row is late wherever it sits.
    await directory.addPerson({ id: 'ada', name: 'Ada' }, [], WROTE);
    const strip = await leaf('Strip', 3);
    const rewire = await leaf('Rewire', 3);
    for (const id of [strip, rewire]) {
      const assigned = await service.assign(id, OWNER, stepId, 'ada');
      if (!assigned.ok) throw new Error(`assign failed: ${assigned.reason}`);
    }
    expect(await starts()).toEqual(
      new Map([
        ['Rewire', 0],
        ['Strip', 3],
      ]),
    );

    await setDeadline(strip, '2026-03-06');

    expect(await starts()).toEqual(
      new Map([
        ['Strip', 0],
        ['Rewire', 3],
      ]),
    );
  });

  it('carries a parent deadline down to the leaves under it, keyed as authored', async () => {
    // The read hands `schedule()` the map **as authored** — parents included,
    // not pre-expanded — and `leafDeadlinesOf` inside the engine owns the fold.
    // Proof: the row filter narrowed to leaves (`hasChildren` consulted here)
    // and this fails on two `null`s, because the only dated row on the plan is
    // the one that never gets a slice.
    const wiring = await parent('Wiring');
    await leaf('Sockets', 4, wiring);
    await leaf('Switches', 4, wiring);
    expect(await lateness()).toEqual(
      new Map([
        ['Sockets', null],
        ['Switches', null],
      ]),
    );

    // Written on the parent, which holds no slice of its own. Offset 2; both
    // leaves run four days from day zero and are still on workday 3.
    await setDeadline(wiring, '2026-03-04');

    expect(await lateness()).toEqual(
      new Map([
        ['Sockets', 1],
        ['Switches', 1],
      ]),
    );
  });

  it('reports a project start moved past a stored deadline late by the whole span', async () => {
    // tasks.md 5.4, and the one state the write path cannot produce: 6.1
    // refuses a deadline that is already before day zero, so the only way a
    // row reaches this is the project moving underneath a date that was legal
    // when it was typed. It is **legitimate input**, not malformed — the read
    // is not refused and the stored value is not rewritten.
    const rewire = await leaf('Rewire', 2);
    await setDeadline(rewire, '2026-03-04');
    expect(await lateness()).toEqual(new Map([['Rewire', null]]));

    // The project starts a week later than it did, **through the layer that
    // could refuse it**. `ProjectStore.update` is the repository and can only
    // report a vanished row, so a move driven through it would stay green even
    // if the request path rejected every start that passes a stored deadline —
    // which is half of what this item claims. `ProjectService.update` is where
    // a refusal would live: it is the layer that already refuses
    // `bad_start_date` and `bad_pert_weights`, and it is asked nothing about
    // deadlines. Found by the round-1 Sol seat, which read the assertion rather
    // than the claim.
    const moved = await testProjectService(projects).update(projectId, OWNER, {
      startDate: '2026-03-09',
    });
    expect(moved.ok).toBe(true);

    // `UNMEETABLE_DEADLINE_OFFSET` is `-1`, so a two-day slice standing on
    // workday 1 is late by 2 — every workday it stands on plus the one it
    // owed. Proof: the entry dropped instead of resolved and this reads
    // `null`, the row reported on time; clamped to `0` and it reads `1`.
    expect(await lateness()).toEqual(new Map([['Rewire', 2]]));
    // The date the user typed is still the date the row holds.
    expect(await storedDeadline(rewire)).toBe('2026-03-04');
  });

  it('applies no deadline to a project with no start date, and still stores the date', async () => {
    // The `NO_DEADLINES` branch itself, and the other case that stays green
    // under the revert above — necessarily, since the revert makes every
    // project take this branch. What it pins is the pair: the date is applied
    // to nothing **and** is still stored.
    //
    // The same rule the floors beside it take:
    // with no day zero there is nothing to count workdays from, so the dates
    // are read and applied to nothing. The row keeps what was written on it —
    // the plan being off the calendar is not a reason to lose a user's input.
    const rewire = await leaf('Rewire', 5);
    const moved = await projects.update(projectId, { startDate: null }, WROTE);
    if (moved === null) throw new Error('project vanished');

    await setDeadline(rewire, '2026-03-04');

    expect(await lateness()).toEqual(new Map([['Rewire', null]]));
    expect(await storedDeadline(rewire)).toBe('2026-03-04');
  });

  it('puts the resolved offsets in the input the optimized cache is keyed on', async () => {
    // tasks.md 6.4 with no machinery of its own: the cache key is the whole
    // `ScheduleInput` the read hands `schedule()`, so a deadline edit
    // invalidates the cached plan exactly when it moves this map — the same
    // way a priority or a floor edit does.
    //
    // Asserted on the ask rather than on a cached row because that is where the
    // claim lives: `readOptimizedPair` hashes what it is handed here, and
    // whether it then misses is 4.1–4.8's, proved against real SQLite.
    const rewire = await leaf('Rewire', 5);
    // The cache is only consulted for a project on the optimized engine, which
    // is the seam `optimized-plan-read.test.ts` owns; this case rides it to
    // read the input rather than to assert anything about the branch.
    const on = await projects.update(
      projectId,
      { optimizationEnabled: true, scheduleEngine: 'optimized' },
      WROTE,
    );
    if (on === null) throw new Error('project vanished');
    const before = recordingReader();
    await new WorkItemService({ ...serviceOptions, optimized: before.read }).tree(projectId);
    expect(before.asks.map((ask) => [...ask.input.deadlines])).toEqual([[]]);

    await setDeadline(rewire, '2026-03-04');

    const after = recordingReader();
    await new WorkItemService({ ...serviceOptions, optimized: after.read }).tree(projectId);
    // Keyed by the work item's own id and holding the resolved **offset**, not
    // the calendar date: a date in the key would make the hash depend on the
    // project's start twice (`canonical-schedule-input.ts` (d) and (g)).
    expect(after.asks.map((ask) => [...ask.input.deadlines])).toEqual([[[rewire, 2]]]);
  });
});
