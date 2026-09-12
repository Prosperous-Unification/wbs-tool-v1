import { describe, expect, it } from 'bun:test';

import { canonicalScheduleInput, type ScheduleInput } from './canonical-schedule-input';
import type { PlannedRow } from './derive-numbers';
import { serializeSchedule } from './fast-golden-corpus';
import { schedule, type Slice } from './schedule';

/**
 * Task 1.3, first half. **Every mutation case here asserts two things**: that
 * the canonical bytes moved, and what `schedule()` did about the same edit.
 *
 * A canonicalization test that only compares two strings can pass while being
 * wrong in either direction. Too loose and it serves a stale schedule as current; too
 * strict and it evicts a cache on an edit that changes nothing, which is a
 * quiet performance bug nobody gets a red for. Running the engine in the same
 * `it` is what makes the difference visible, and it is cheap: these are
 * four-row plans.
 *
 * So the cases below come in three kinds, and the kind is stated per case:
 *
 * - **moves a placement** — canonical bytes differ AND the schedule differs.
 *   The pair the cache exists to keep apart.
 * - **deliberately stricter** — hash differs and the schedule is IDENTICAL
 *   today. Two of these, and both are load-bearing rather than sloppy: the
 *   fact is one a later edit turns into a placement, and hashing the resolved
 *   value instead would hide it.
 * - **must not move the canonical bytes** — bytes equal AND the schedule
 *   equal. The asymmetry in (c) lives or dies on these.
 *
 * 1.9's `parentId` reparenting and `stepId` identity swap are here; what is
 * still to land under 1.9 is 1.4's watched-red removal for **every** field 1.1
 * names, not only `reach` and the slice order. The deadline case is no longer
 * declared-pending: `run` now hands `schedule()` all seven arguments, so
 * `deadlines` is proved present in the string **and** exercised in the engine
 * rather than asserted inert against a call that never received it.
 */

const row = (
  id: string,
  parentId: string | null,
  position: number,
  priority: number | null,
): PlannedRow => ({ id, parentId, position, frozenNumber: null, priority });

const step = (
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
  poolIds: ['team'],
  ...extra,
});

/**
 * One plan, chosen so each mutation below has somewhere to move.
 *
 * `p` is a parent carrying a priority that binds nothing — every leaf under and
 * beside it carries its own, and `priorityByLeaf` takes the nearest ancestor
 * that has one (`schedule.ts:1447`). `a` has two steps, so the intra-item order
 * is a real order and `reach` has two arms to choose between. `b` waits for `a`,
 * which is what makes its floor and the pool size invisible until they clear
 * that edge — `c` is here for exactly that reason, unblocked and on the same
 * one-slot pool, so a floor above the predecessor and a second slot each have
 * somewhere to show.
 *
 * `c` was added after the first run: with `a → b` the only shape in the plan,
 * `the notBefore floor moved` and `the pool grew to two slots` both came back
 * with an IDENTICAL schedule and failed their own `not.toEqual` — 391 pass /
 * 2 fail at `b5e64717`. The hash was right in both; the fixture could not see
 * it, which is precisely what the second assertion is for.
 */
const BASE: ScheduleInput = {
  rows: [row('p', null, 10, 3), row('a', 'p', 1, 7), row('b', null, 20, 9), row('c', null, 30, 9)],
  edges: [{ predecessorId: 'a', successorId: 'b' }],
  slices: [step('a', 'design', 2), step('a', 'build', 3), step('b', null, 2), step('c', null, 2)],
  notBefore: new Map([['b', 1]]),
  poolSizes: new Map([['team', 1]]),
  reach: 'whole-item',
  deadlines: new Map(),
};

/**
 * Every canonical field, `deadlines` included, reaches the engine.
 *
 * `deadlines` was missing from this call while `schedule()` still took six
 * parameters, and TASK-267 slice 4 added the seventh without reaching here. For
 * as long as both were true the deadline case below asserted `toEqual` against
 * an engine that had never been shown a deadline — a check that could not fail,
 * which is the R5 failure the change's own notes name. Anything this helper
 * drops makes the whole `run(...)` half of every case below vacuous.
 */
const run = (input: ScheduleInput): unknown =>
  serializeSchedule(
    schedule(
      input.rows,
      input.edges,
      input.slices,
      input.notBefore,
      input.poolSizes,
      input.reach,
      input.deadlines,
    ),
  );

const movesAPlacement = (name: string, mutated: ScheduleInput): void => {
  it(`${name} — moves a placement, so the canonical bytes must move`, () => {
    expect(canonicalScheduleInput(mutated)).not.toBe(canonicalScheduleInput(BASE));
    expect(run(mutated)).not.toEqual(run(BASE));
  });
};

const mustNotMoveCanonical = (name: string, same: ScheduleInput): void => {
  it(`${name} — same schedule, so the canonical bytes must not move`, () => {
    expect(run(same)).toEqual(run(BASE));
    expect(canonicalScheduleInput(same)).toBe(canonicalScheduleInput(BASE));
  });
};

/**
 * A second base, for the one fact {@link BASE} structurally cannot see.
 *
 * `position` reaches a schedule only through `deriveNumbers`, and the number is
 * the **third of four** leveling tie-breaks (`schedule.ts:1902`) — so it decides
 * nothing unless two slices tie on priority, start and float first. Every leaf
 * in `BASE` carries its own priority, which is what makes its parent-priority
 * case work and what makes it blind here.
 *
 * This is the shape that isolates the tie, and it is the corpus case
 * `inverted-numbering-tie` in miniature: two leaves, no priority anywhere, one
 * pool slot between them, and the `rows` array declared in the opposite order to
 * `position` so the number and the plan's own order disagree. `node.at` is the
 * slice index **within** a work item (`schedule.ts:1813`), so with one slice
 * each both are 0 and the number is the only line in `goesFirst` that separates
 * them.
 */
const TIED: ScheduleInput = {
  rows: [row('x', null, 20, null), row('y', null, 10, null)],
  edges: [],
  slices: [step('x', null, 2), step('y', null, 2)],
  notBefore: new Map(),
  poolSizes: new Map([['team', 1]]),
  reach: 'whole-item',
  deadlines: new Map(),
};

/**
 * A third base, for `width`.
 *
 * Every slice in {@link BASE} sits on a pool of one, so widening one to 2 asks a
 * one-slot pool for two slots and the placement does not move — the case was
 * written against `BASE` first, came back byte-identical, and was removed rather
 * than repaired by also changing `poolSizes`, which would have made it two
 * mutations in one case. This base carries **no pools at all**, so `width`
 * reaches the schedule through the only other route it has: `durationOf`'s
 * `days / width` arm.
 */
const CHAINED: ScheduleInput = {
  rows: [row('x', null, 10, null), row('y', null, 20, null)],
  edges: [{ predecessorId: 'x', successorId: 'y' }],
  slices: [
    { workItemId: 'x', stepId: null, days: 4, personId: null, width: 1, poolIds: [] },
    { workItemId: 'y', stepId: null, days: 2, personId: null, width: 1, poolIds: [] },
  ],
  notBefore: new Map(),
  poolSizes: new Map(),
  reach: 'whole-item',
  deadlines: new Map(),
};

/**
 * A fourth base, for `poolIds` **widened from one pool to two**.
 *
 * The widening cannot be shown on {@link BASE} for the same reason `width`
 * could not: every slice there sits on the one pool `team`, so the only pool a
 * second entry could name is one no slice holds, and a pool nobody is queueing
 * for delays nothing. Giving it an occupant would mean editing `poolSizes` and
 * the slice list too, which is two more mutations in a case whose whole
 * discipline is one.
 *
 * So: two leaves, no edge between them, on **disjoint** one-slot pools. They
 * are simultaneous in the base — that is the fact the mutation destroys.
 * Widening `y` to also hold `alpha` puts both leaves in one queue of one, and
 * `jointWindowFor`'s multi-pool loop (`schedule.ts:928`) makes the later one
 * wait for the whole of the earlier. Nothing about the pools' sizes or their
 * membership changes; one slice asks for one more team.
 */
const PARALLEL: ScheduleInput = {
  rows: [row('x', null, 10, null), row('y', null, 20, null)],
  edges: [],
  slices: [
    { workItemId: 'x', stepId: null, days: 2, personId: null, width: 1, poolIds: ['alpha'] },
    { workItemId: 'y', stepId: null, days: 2, personId: null, width: 1, poolIds: ['beta'] },
  ],
  notBefore: new Map(),
  poolSizes: new Map([
    ['alpha', 1],
    ['beta', 1],
  ]),
  reach: 'whole-item',
  deadlines: new Map(),
};

/**
 * A fifth base, for 1.9's `parentId` reparenting.
 *
 * `parentId` is the one field in (a) that reaches a placement without being
 * read by the placement at all: it decides **which leaves an authored edge
 * expands to**. The edge here is authored on the parent `P`, and under
 * `whole-item` reach it lands on every leaf `P` owns — so moving a leaf into
 * `P` hands it a predecessor it never named, and moving one out takes one away.
 *
 * Nothing else in the row may change, which is why the base carries no
 * priorities and no pools: an inherited priority or a shared queue would give
 * the reparenting a second route to the same placement and the case would stop
 * being about leaf expansion.
 */
const NESTED: ScheduleInput = {
  rows: [
    row('P', null, 10, null),
    row('q', 'P', 10, null),
    row('r', null, 20, null),
    row('s', null, 30, null),
  ],
  edges: [{ predecessorId: 'r', successorId: 'P' }],
  slices: [
    { workItemId: 'q', stepId: null, days: 2, personId: null, width: 1, poolIds: [] },
    { workItemId: 'r', stepId: null, days: 2, personId: null, width: 1, poolIds: [] },
    { workItemId: 's', stepId: null, days: 2, personId: null, width: 1, poolIds: [] },
  ],
  notBefore: new Map(),
  poolSizes: new Map(),
  reach: 'whole-item',
  deadlines: new Map(),
};

describe('canonicalScheduleInput', () => {
  /**
   * The check-that-cannot-fail guard, R5. `JSON.stringify` renders a `Map` as
   * `{}`, so a canonicalizer that passed `notBefore`, `poolSizes` or
   * `deadlines` straight through would hash three empty objects and every plan
   * with the same rows would collide. These read the values rather than the
   * shape.
   */
  it('puts every one of the seven arguments in the string, maps included', () => {
    const canonical = canonicalScheduleInput({
      ...BASE,
      deadlines: new Map([['b', 9]]),
    });
    expect(canonical).toContain('"notBefore":[["b",1]]');
    expect(canonical).toContain('"poolSizes":[["team",1]]');
    expect(canonical).toContain('"deadlines":[["b",9]]');
    expect(canonical).toContain('"reach":"whole-item"');
    expect(canonical).toContain('"frozenNumber":null');
    expect(canonical).not.toContain('{}');
  });

  describe('mutations that move a placement', () => {
    movesAPlacement('two slices of one work item swapped', {
      ...BASE,
      slices: [
        step('a', 'build', 3),
        step('a', 'design', 2),
        step('b', null, 2),
        step('c', null, 2),
      ],
    });

    /**
     * `null` is "nobody has estimated this" and spends
     * {@link ASSUMED_SLICE_WORKDAYS}; `0` is "estimated, and it is nothing" and
     * spends no time and no slot. A canonical form that let `??` collapse them
     * would serve one plan's schedule for the other.
     */
    movesAPlacement('days null is not days zero', {
      ...BASE,
      slices: [
        step('a', 'design', null),
        step('a', 'build', 3),
        step('b', null, 2),
        step('c', null, 2),
      ],
    });

    movesAPlacement('depReach flipped to anchor-slice', { ...BASE, reach: 'anchor-slice' });

    movesAPlacement('the notBefore floor moved above the predecessor', {
      ...BASE,
      notBefore: new Map([['b', 9]]),
    });

    movesAPlacement('the pool grew to two slots', {
      ...BASE,
      poolSizes: new Map([['team', 2]]),
    });

    /**
     * A named assignee is a queue of one, and it is a floor the pool does not
     * supply: `c` and `a`'s build sit on opposite sides of the plan's only edge,
     * so nothing keeps them off each other until one person holds both.
     */
    movesAPlacement('one person put on two slices that did not share one', {
      ...BASE,
      slices: [
        step('a', 'design', 2),
        step('a', 'build', 3, { personId: 'kat' }),
        step('b', null, 2),
        step('c', null, 2, { personId: 'kat' }),
      ],
    });

    movesAPlacement('an estimate changed', {
      ...BASE,
      slices: [
        step('a', 'design', 2),
        step('a', 'build', 4),
        step('b', null, 2),
        step('c', null, 2),
      ],
    });

    movesAPlacement('an authored edge added', {
      ...BASE,
      edges: [
        { predecessorId: 'a', successorId: 'b' },
        { predecessorId: 'c', successorId: 'a' },
      ],
    });

    /**
     * The two edges below are **redirections**, not additions, and 1.9's
     * watched-red sweep is what put them here: with `an authored edge added` as
     * the only edge case, deleting `predecessorId` from the canonical string
     * left the whole suite green at 22 pass / 0 fail, and so did deleting
     * `successorId`. An added edge lengthens the array, so the hash moves on the
     * array's *length* whichever half of the pair is missing — the case could
     * not see which end of the edge it was proving.
     *
     * A redirection holds the edge count at one and moves a single end, so each
     * removal collides the base with its own mutation.
     */
    movesAPlacement('an edge redirected to a different successor', {
      ...BASE,
      edges: [{ predecessorId: 'a', successorId: 'c' }],
    });

    movesAPlacement('an edge redirected from a different predecessor', {
      ...BASE,
      edges: [{ predecessorId: 'c', successorId: 'b' }],
    });

    /**
     * `position`, on {@link TIED}, because it reaches a placement only through
     * the number tie-break. The proof is the swap: make the number order agree
     * with the array order instead of contradicting it, and the slice that was
     * going first stops going first.
     */
    it('position swapped between two tied leaves — moves a placement, so the canonical bytes must move', () => {
      const mutated: ScheduleInput = {
        ...TIED,
        rows: [row('x', null, 10, null), row('y', null, 20, null)],
      };
      expect(canonicalScheduleInput(mutated)).not.toBe(canonicalScheduleInput(TIED));
      expect(run(mutated)).not.toEqual(run(TIED));
    });

    /**
     * `width`, on {@link CHAINED}, through `durationOf`'s `days / width` arm:
     * 4 days across a width of 2 is two, so `y` — which waits for `x` — starts
     * at 2 rather than at 4. No pool is involved, which is the point: the
     * `BASE` version of this case asked a one-slot pool for two slots and moved
     * nothing.
     */
    it('the width of one slice widened — moves a placement, so the canonical bytes must move', () => {
      const mutated: ScheduleInput = {
        ...CHAINED,
        slices: [
          { workItemId: 'x', stepId: null, days: 4, personId: null, width: 2, poolIds: [] },
          { workItemId: 'y', stepId: null, days: 2, personId: null, width: 1, poolIds: [] },
        ],
      };
      expect(canonicalScheduleInput(mutated)).not.toBe(canonicalScheduleInput(CHAINED));
      expect(run(mutated)).not.toEqual(run(CHAINED));
    });

    /**
     * 1.9's `parentId` reparenting, on {@link NESTED}. `s` moves from the root
     * into `P`, and every other field of every row stays byte-identical — no
     * position, priority, slice or edge is touched.
     *
     * What moves is the **leaf expansion**: the authored edge `r → P` reaches
     * whatever leaves `P` owns, so `s` inherits a predecessor it never named.
     */
    it('a leaf reparented under the edge’s successor — moves a placement, so the canonical bytes must move', () => {
      const mutated: ScheduleInput = {
        ...NESTED,
        rows: [
          row('P', null, 10, null),
          row('q', 'P', 10, null),
          row('r', null, 20, null),
          row('s', 'P', 30, null),
        ],
      };
      expect(canonicalScheduleInput(mutated)).not.toBe(canonicalScheduleInput(NESTED));
      expect(run(mutated)).not.toEqual(run(NESTED));
    });

    /**
     * 1.9's `stepId` identity swap, and it is a different fact from the
     * intra-item **order** swap at the top of this block. The order there moves
     * the durations; here the array order and the durations both stay exactly
     * as they were and only the two labels exchange places.
     *
     * A schedule is keyed by `sliceKey` — `workItemId` NUL `stepId` — so this
     * moves every placement the caller can name: `design` was the two-day block
     * at the front and is now the three-day block behind `build`. A canonical
     * form that dropped `stepId` would hand out one cache key for two plans
     * that disagree about which step is where.
     */
    it('two stepIds of one work item exchanged — moves a placement, so the canonical bytes must move', () => {
      const mutated: ScheduleInput = {
        ...BASE,
        slices: [
          step('a', 'build', 2),
          step('a', 'design', 3),
          step('b', null, 2),
          step('c', null, 2),
        ],
      };
      expect(canonicalScheduleInput(mutated)).not.toBe(canonicalScheduleInput(BASE));
      expect(run(mutated)).not.toEqual(run(BASE));
    });

    /**
     * `poolIds` widened from one pool to two, on {@link PARALLEL}. The
     * companion to the unchanged-hash `poolIds` case below: reordering the set
     * and repeating a member must not move the hash, and adding a member the
     * slice did not hold must.
     *
     * The widened slice does not merely acquire a second team — it joins that
     * team's queue, and `alpha` already has an occupant. `x` and `y` stop being
     * simultaneous.
     */
    it('poolIds widened from one pool to two — moves a placement, so the canonical bytes must move', () => {
      const mutated: ScheduleInput = {
        ...PARALLEL,
        slices: [
          { workItemId: 'x', stepId: null, days: 2, personId: null, width: 1, poolIds: ['alpha'] },
          {
            workItemId: 'y',
            stepId: null,
            days: 2,
            personId: null,
            width: 1,
            poolIds: ['beta', 'alpha'],
          },
        ],
      };
      expect(canonicalScheduleInput(mutated)).not.toBe(canonicalScheduleInput(PARALLEL));
      expect(run(mutated)).not.toEqual(run(PARALLEL));
    });

    /**
     * The seventh argument, and it is no longer declared-pending.
     *
     * The case used to sit below among the deliberately-stricter mutations,
     * reading "a deadline, which the engine cannot yet read (TASK-241)" and
     * asserting `toEqual`, on the stated ground that `schedule()` took six
     * parameters. TASK-267 slice 4 added the seventh and slice 5 gave it two
     * readers — the leveler's slack ordering (`schedule.ts:2400`) and the
     * `missed` count each scheduled slice reports (`schedule.ts:2565`) — so that
     * ground expired. Its own comment named this move, and it is the measured
     * one: with `deadlines` reaching `schedule()`, `b`'s day-3 date against its
     * day-6 finish comes back a different serialized schedule.
     */
    movesAPlacement('a deadline the engine now reads', {
      ...BASE,
      deadlines: new Map([['b', 3]]),
    });
  });

  /**
   * The one case here that is deliberately **not** one-mutation-per-fact, and
   * 1.9's watched-red sweep is the reason it exists.
   *
   * `rows[].id` and `slices[].workItemId` are the two fields the sweep could
   * not redden on their own — 24 pass / 0 fail each — and they are **mutually
   * redundant**, provably rather than accidentally:
   *
   * - the rows entry is sorted by `id`, so once the id **set** is known the
   *   payload sequence names its owners by position;
   * - `schedule()` refuses a leaf with no slice at all (`no slice for work item
   *   z`, probed directly), so the slice-bearing work items are **exactly** the
   *   leaves, and the groups are sorted by the same ids;
   * - every non-leaf id appears as some child's `parentId`.
   *
   * So with `id` present the group labels are recoverable, and with the labels
   * present the ids are. Neither can be given an isolated red, and pretending
   * otherwise with a case that quietly moves a second field would be worse than
   * saying so.
   *
   * What they carry **jointly** is the one edit that touches nothing else: a
   * work item's identity. `c` becomes `d` at the same position, priority,
   * parent and estimate — the whole plan's arithmetic is unchanged and every
   * date is where it was, but a schedule is keyed by `sliceKey`, so the row a
   * caller reads under `c` is now under `d`. Removing either field alone leaves
   * this case green; removing both collides it.
   */
  it('a work item renamed, which only id and workItemId together can see', () => {
    const mutated: ScheduleInput = {
      ...BASE,
      rows: [
        row('p', null, 10, 3),
        row('a', 'p', 1, 7),
        row('b', null, 20, 9),
        row('d', null, 30, 9),
      ],
      slices: [
        step('a', 'design', 2),
        step('a', 'build', 3),
        step('b', null, 2),
        step('d', null, 2),
      ],
    };
    expect(canonicalScheduleInput(mutated)).not.toBe(canonicalScheduleInput(BASE));
    expect(run(mutated)).not.toEqual(run(BASE));
  });

  describe('mutations the canonical form is deliberately stricter about than today’s engine', () => {
    /**
     * `frozenNumber`, which since ADR 0023 cannot move a placement at all.
     *
     * It could until then, and this case sat above among the mutations that
     * do. Two anchors contradicting `position` — `x` at position 20 frozen
     * `005`, `y` at position 10 frozen `010` — come back exactly as written,
     * so `x` read first, and `goesFirst`'s third rule handed it the tie. That
     * rule asks {@link treeOrder} now, which reads `position`; a frozen number
     * is a name, and the two plans below schedule identically.
     *
     * It stays in the canonical form regardless, and this is the safe
     * direction to be wrong in: a field hashed that no longer moves a
     * placement costs a re-solve, while a field left out of the key serves a
     * stale schedule against an edit it cannot see. It is also still an input
     * to what a reader *sees* — `deriveNumbers` reports it verbatim, and two
     * plans differing only here are different plans on screen.
     */
    it('two frozen numbers that contradict position, which no longer reorder anything', () => {
      const mutated: ScheduleInput = {
        ...TIED,
        rows: [
          { id: 'x', parentId: null, position: 20, frozenNumber: '005', priority: null },
          { id: 'y', parentId: null, position: 10, frozenNumber: '010', priority: null },
        ],
      };
      expect(run(mutated)).toEqual(run(TIED));
      expect(canonicalScheduleInput(mutated)).not.toBe(canonicalScheduleInput(TIED));
    });

    /**
     * The as-written priority on a parent that binds no leaf. Every leaf
     * carries its own priority, so `priorityByLeaf` never reaches `p` and the
     * schedule is byte-identical — and it stays that way only until somebody
     * clears `a`'s priority or moves a work item under `p`. Hashing the
     * resolved leaf priority instead would leave every cached row for this
     * project matching its key across an edit that changes what the project
     * means.
     */
    it('a parent’s as-written priority, which binds no leaf today', () => {
      const mutated: ScheduleInput = {
        ...BASE,
        rows: [
          row('p', null, 10, 4),
          row('a', 'p', 1, 7),
          row('b', null, 20, 9),
          row('c', null, 30, 9),
        ],
      };
      expect(run(mutated)).toEqual(run(BASE));
      expect(canonicalScheduleInput(mutated)).not.toBe(canonicalScheduleInput(BASE));
    });

    /**
     * 7.1's **as-authored** key, and the one pair that can tell it apart from
     * the leaf expansion.
     *
     * `p`'s only leaf is `a`, so `leafDeadlinesOf` folds a date written on the
     * parent and the same date written on the leaf to the identical `{a: 3}`.
     * The engine cannot tell them apart, and the `toEqual` records that it does
     * not try to. Hashing the expansion would therefore hand both plans one
     * cache key — and they are different plans, because the next edit separates
     * them: move `b` under `p` and the parent-authored date binds `b` as well,
     * while the leaf-authored one still binds only `a`. That is the edit
     * `canonical-schedule-input.ts` says hashing the expansion would hide, and
     * it is the direction that works: reparenting `a` **out** would not
     * separate them, because `indexTree` makes a childless `p` its own leaf
     * (`schedule.ts:396`) and the date would bind `p` — corrected here from the
     * chunk-2 peer seat's Minor. Same schedule, different hash: the
     * "deliberately stricter" category this file's header names.
     */
    it('a deadline authored on the parent rather than on its only leaf — one expansion, two plans', () => {
      const onParent: ScheduleInput = { ...BASE, deadlines: new Map([['p', 3]]) };
      const onLeaf: ScheduleInput = { ...BASE, deadlines: new Map([['a', 3]]) };

      expect(run(onParent)).toEqual(run(onLeaf));
      expect(canonicalScheduleInput(onParent)).not.toBe(canonicalScheduleInput(onLeaf));
    });
  });

  describe('facts that must not move the canonical bytes', () => {
    /**
     * The (c) asymmetry, and the reason it is not a rounding error. The global
     * slice order is whatever `WorkItemRepo.listByProject` returned and it has
     * no `ORDER BY`, so hashing it made one unchanged project hash two ways
     * between reads. Grouping by work item and ordering the groups is what
     * makes this stable; preserving each group's own order is what keeps the
     * swap case above red.
     */
    mustNotMoveCanonical('the global slice order across work items', {
      ...BASE,
      slices: [
        step('c', null, 2),
        step('b', null, 2),
        step('a', 'design', 2),
        step('a', 'build', 3),
      ],
    });

    mustNotMoveCanonical('the rows array reordered into the same tree', {
      ...BASE,
      rows: [
        row('c', null, 30, 9),
        row('b', null, 20, 9),
        row('p', null, 10, 3),
        row('a', 'p', 1, 7),
      ],
    });

    /** `poolIds` is a set: `jointWindowFor` waits for the same pools either way. */
    mustNotMoveCanonical('poolIds reordered, and a duplicate in them', {
      ...BASE,
      slices: [
        step('a', 'design', 2, { poolIds: ['team', 'team'] }),
        step('a', 'build', 3),
        step('b', null, 2),
        step('c', null, 2),
      ],
    });
  });

  /**
   * The engine's own refusals, not a second copy of them. A canonicalizer that
   * accepted input `schedule()` throws on would hand out a cache key for a call
   * that cannot run, and the first thing anybody would do with that key is
   * write a row under it.
   */
  it('refuses a slice for something that is not a leaf, exactly as schedule() does', () => {
    const orphaned: ScheduleInput = { ...BASE, slices: [step('p', null, 2)] };
    expect(() => canonicalScheduleInput(orphaned)).toThrow(/not a leaf/);
    expect(() => run(orphaned)).toThrow(/not a leaf/);
  });
});
