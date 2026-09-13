import { expect } from 'bun:test';

/**
 * How `fixtures/capacity-oracle-2026-08-13.json` is read after
 * `assumed-duration-schedules` (2026-08-29).
 *
 * That oracle is sixteen plans and the answer a be-01 at `050fd45` gave each of
 * them, and thirteen of the sixteen leave at least one work item/step pair
 * unestimated. Those pairs used to take no time; they now take
 * `ASSUMED_SLICE_WORKDAYS`, so the answers to those thirteen moved **by
 * design**, and a differential that re-recorded them would be a fixture made to
 * agree with the code.
 *
 * So the differential is narrowed the way `dep-waits-on-first-role` narrowed its
 * corpus: byte-identical where the two rules coincide, and a stated property
 * where they do not. Three things together, and each is weak on its own:
 *
 * 1. **The three fully-estimated plans stay byte-identical**, every field,
 *    through {@link isFullyEstimated}. A change that gave an *estimated* slice
 *    an assumed duration lands here.
 * 2. **`duration` and `estimated` stay byte-identical on all sixteen** — they
 *    are inside the compared document, never stripped. They are what the days
 *    column, the roll-up and the export read, and this change writes no
 *    estimate (design D2).
 * 3. **The placement is asserted to have actually moved**, through
 *    {@link countMovedDates}: a corpus in which nothing moved is a build where
 *    the assumption never reached the engine, and would make (1) and (2) green
 *    for the wrong reason.
 *
 * What is given up is the exact placement of the thirteen, and only that.
 */

/**
 * The fields a slice or a work item's schedule is allowed to have moved on a
 * plan holding an unestimated pair.
 *
 * `earliestStart`/`earliestFinish` because the assumption is a width; the four
 * backward-pass fields because they are measured against a project finish that
 * moved with it; `boundBy` and the two predecessor keys because they are the
 * leveller's record of who waited behind whom, and an unestimated slice that now
 * occupies a person really does change that queue — a slice that used to start
 * at day zero beside its predecessor now waits for it, and being told so is the
 * change working.
 *
 * `duration`, `effort`, `estimated`, `width`, `personId` and `capacityTeamId`
 * are **not** here. They are compared verbatim against the 2026-08-13 capture on
 * every one of the sixteen plans, and `capacityTeamId` is asserted against the
 * replayed plan's own labels besides.
 */
const MOVED_SCHEDULE_FIELDS = [
  'earliestStart',
  'earliestFinish',
  'latestStart',
  'latestFinish',
  'float',
  'critical',
  'boundBy',
  'resourcePredecessorId',
  'capacityPredecessorIds',
] as const;

interface CapturedTree {
  workItems: {
    id: string;
    schedule: Record<string, unknown>;
    dates: unknown;
    rolledUp?: boolean;
    finalDays?: Record<string, number>;
    finalTotal?: number;
  }[];
  slices: Record<string, unknown>[];
  waitingForPerson: number;
  waitingForCapacity: number;
}

/** Whether every leaf of `plan` carries an estimate for every step the project lists. */
export function isFullyEstimated(plan: {
  stepIds: readonly string[];
  rows: readonly { id: string; parentId: string | null; estimates: Record<string, unknown> }[];
}): boolean {
  const parents = new Set(plan.rows.map((row) => row.parentId));
  return plan.rows
    .filter((row) => !parents.has(row.id))
    .every((row) => plan.stepIds.every((stepId) => Object.hasOwn(row.estimates, stepId)));
}

const MOVED = new Set<string>(MOVED_SCHEDULE_FIELDS);

const withoutMovedFields = (held: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(held).filter(([field]) => !MOVED.has(field)));

/**
 * The same document with the placement taken out of it — the comparison used for
 * the thirteen plans that hold an unestimated pair.
 *
 * Applied to **both** sides, so what is left is still a whole-document
 * `toEqual`: the tree, the numbers, the roll-ups, every slice's identity,
 * `duration`, `effort` and `estimated`, and the two payload keys the oracle
 * predates. Only where each mark sits on the calendar is set aside, and
 * {@link expectOnlyPushedLater} is what holds that.
 */
export function withoutPlacement(tree: Record<string, unknown>): Record<string, unknown> {
  const held = tree as unknown as CapturedTree;
  return {
    ...tree,
    // Both counts are readings of the placement: a slice that now waits for its
    // assignee is a slice the reader is told about, which is the change
    // working.
    waitingForPerson: null,
    waitingForCapacity: null,
    workItems: held.workItems.map((row) => ({
      ...row,
      schedule: withoutMovedFields(row.schedule),
      // Set aside with the offsets it is computed from, never asserted as
      // equal: `datesOf` turns `earliestStart`/`earliestFinish` into a calendar
      // day and nothing else.
      dates: null,
    })),
    slices: held.slices.map(withoutMovedFields),
  };
}

/**
 * The window a charged figure may differ by and still be the same number: the
 * one {@link snapWorkdays} uses, eight orders of magnitude below a sixth of a
 * day.
 */
const REASSOCIATION = 1e-9;

/**
 * The same document with every **parent's** charged days snapped to
 * {@link REASSOCIATION}.
 *
 * Applied to both sides, and it exists for one arithmetic fact.
 * `estimate-weights-and-rounding` (2026-08-30) made a parent's `finalDays` the
 * sum of its descendants' charged figures where it used to be the parent's
 * rolled-up triple combined once. Under `exact` — the arm these oracles replay
 * on — the two are the same number in real arithmetic and differ in the last
 * bit of a double: one row in the 2026-08-13 corpus reads `8.166666666666668`
 * where the capture recorded `8.166666666666666`.
 *
 * Only a rolled-up row is touched, and only these two fields. A leaf's figure is
 * one combine either way and is still compared verbatim, as are every duration,
 * every offset and every date — so a plan that genuinely moved cannot pass
 * through this: 1e-9 of a day is 0.09 milliseconds.
 */
export function withSnappedRollUps(tree: Record<string, unknown>): Record<string, unknown> {
  const held = tree as unknown as CapturedTree;
  const snap = (days: number): number => Math.round(days / REASSOCIATION) * REASSOCIATION;
  return {
    ...tree,
    workItems: held.workItems.map((row) =>
      row.rolledUp !== true
        ? row
        : {
            ...row,
            finalDays: Object.fromEntries(
              Object.entries(row.finalDays ?? {}).map(([stepId, days]) => [stepId, snap(days)]),
            ),
            finalTotal: snap(row.finalTotal ?? 0),
          },
    ),
  };
}

/**
 * How many of this plan's starts and finishes are not the number the capture
 * recorded — the non-vacuity behind {@link withoutPlacement}.
 *
 * A count and **not** a direction. "An assumed duration can only push work
 * later" is false, and measured to be: with the assumption on, `p14-g2-l1
 * step-0` starts on day 6 where the capture has it on day 11. Leveling ranks its
 * queue by the unlevelled float, the assumption changes that float, and a slice
 * whose rank rose takes the person earlier. That is the leveller working as
 * designed and it is why this asserts that the placement moved rather than which
 * way.
 *
 * It also checks that both documents describe the same marks: every slice and
 * every row of the capture is present, by id, exactly once.
 *
 * Proof: `durationOf`'s assumed arm removed, so an unestimated slice is zero
 * days again, and this failed at the caller's `expect(moved).toBeGreaterThan(0)`
 * — `expected 0 to be greater than 0`; watched 2026-08-29.
 */
export function countMovedDates(
  answer: Record<string, unknown>,
  tree: Record<string, unknown>,
): number {
  const was = answer as unknown as CapturedTree;
  const now = tree as unknown as CapturedTree;
  let moved = 0;

  const compare = (id: string, before: Record<string, unknown>, after: Record<string, unknown>) => {
    for (const field of ['earliestStart', 'earliestFinish'] as const) {
      const from = before[field];
      const to = after[field];
      if (typeof from !== 'number' || typeof to !== 'number') {
        throw new Error(`${id}.${field} is not a number on both sides`);
      }
      if (to !== from) moved += 1;
    }
  };

  // `slice['id']` and not `slice.id`: a slice here is the captured JSON's own
  // `Record<string, unknown>`, so the key comes from an index signature and
  // `strictTypeChecked` refuses the dotted read.
  const idOf = (slice: Record<string, unknown>): string => String(slice['id']);
  const wasSlices = new Map(was.slices.map((slice) => [idOf(slice), slice]));
  expect(now.slices).toHaveLength(was.slices.length);
  for (const slice of now.slices) {
    const before = wasSlices.get(idOf(slice));
    if (before === undefined) throw new Error(`slice ${idOf(slice)} is not in the capture`);
    compare(idOf(slice), before, slice);
  }

  const wasRows = new Map(was.workItems.map((row) => [row.id, row]));
  expect(now.workItems).toHaveLength(was.workItems.length);
  for (const row of now.workItems) {
    const before = wasRows.get(row.id);
    if (before === undefined) throw new Error(`work item ${row.id} is not in the capture`);
    compare(row.id, before.schedule, row.schedule);
  }
  return moved;
}
