import { describe, expect, it } from 'bun:test';

import { arrangeBySchedule } from './arrange-siblings';
import type { PlannedRow } from './derive-numbers';
import { FAST_GOLDEN_CASES } from './fast-golden-corpus';
import { schedule } from './schedule';

/**
 * Arranging is a **fixed point**: press it twice and the second press writes
 * nothing.
 *
 * The argument for it is short and not obviously complete, which is why this is
 * a property over real plans rather than a paragraph. After an arrangement the
 * earlier-starting sibling reads first, and tree order is `goesFirst`'s sixth
 * rule — so in every contention tie the slice that won keeps winning and the
 * schedule is unchanged. That reasoning covers a row's *first* slice. It says
 * nothing about a later slice of an earlier-starting row losing a tie to a
 * sibling that starts later, and moving a row changes the very tie-break the
 * argument leans on.
 *
 * So the claim is measured instead: arrange, reschedule through Fast over the
 * new positions, arrange again, and expect nothing to move. A counterexample is
 * a real finding about the design — it would mean a reader can press the
 * control twice and see the plan shuffle — and belongs in `verify.md` with its
 * case name rather than being papered over with a second pass.
 */

/**
 * Each sibling group in reverse, which is what gives the first press something
 * to do.
 *
 * **Measured, not assumed:** all eight corpus plans are written in schedule
 * order already, so run against them as authored the first press writes nothing
 * and the property below holds for eight plans nobody arranged. The
 * non-vacuity case at the bottom is what said so — `Expected: > 0 · Received:
 * 0`, 2026-09-11 — and this reversal is the fix. The plans are still the
 * corpus's own: same rows, same edges, same slices, same estimates; only the
 * order they were typed in differs, which is exactly the state a reader presses
 * this control in.
 */
function reversedWithinGroups(rows: readonly PlannedRow[]): PlannedRow[] {
  const byParent = new Map<string | null, PlannedRow[]>();
  for (const row of rows) {
    byParent.set(row.parentId, [...(byParent.get(row.parentId) ?? []), row]);
  }
  const at = new Map<string, number>();
  for (const group of byParent.values()) {
    const ordered = [...group].sort((left, right) => left.position - right.position);
    ordered.forEach((row, index) => {
      at.set(row.id, (ordered.length - index) * 10);
    });
  }
  return rows.map((row) => ({ ...row, position: at.get(row.id) ?? row.position }));
}

/** The rows as an arrangement leaves them, so the second pass sees a moved plan. */
function repositioned(rows: readonly PlannedRow[], at: ReadonlyMap<string, number>): PlannedRow[] {
  return rows.map((row) => ({ ...row, position: at.get(row.id) ?? row.position }));
}

describe('arranging a plan is a fixed point', () => {
  for (const each of FAST_GOLDEN_CASES) {
    it(`settles after one press — ${each.name}`, () => {
      const ask = (rows: readonly PlannedRow[]) =>
        schedule(
          rows,
          each.edges,
          each.slices,
          each.notBefore ?? new Map(),
          each.poolSizes ?? new Map(),
          each.reach ?? 'whole-item',
          new Map(),
        );

      const typed = reversedWithinGroups(each.rows);
      const first = arrangeBySchedule(typed, ask(typed).workItems);
      const moved = repositioned(
        typed,
        new Map(first.placements.map((placed) => [placed.id, placed.position])),
      );

      // Rescheduled over the **new** positions, which is the whole point: a
      // position is canonical schedule input and Fast's last tie-break reads
      // tree order, so the second pass is asking a question about a plan the
      // first press changed.
      const second = arrangeBySchedule(moved, ask(moved).workItems);

      expect(
        second.placements,
        `${each.name} moved again on a second press: ${JSON.stringify(second.placements)}`,
      ).toEqual([]);
    });
  }

  it('is not vacuous — the first press really does arrange these plans', () => {
    // Without this, plans that were already in schedule order would make every
    // case above true by writing nothing at all, twice — which is precisely
    // what the corpus **as authored** does. Run against `each.rows` rather than
    // the reversal, this answers `Expected: > 0 · Received: 0` for all eight,
    // watched 2026-09-11. That measurement is why `reversedWithinGroups`
    // exists, and this case is what keeps it honest.
    const arranged = FAST_GOLDEN_CASES.filter((each) => {
      const typed = reversedWithinGroups(each.rows);
      const found = schedule(
        typed,
        each.edges,
        each.slices,
        each.notBefore ?? new Map(),
        each.poolSizes ?? new Map(),
        each.reach ?? 'whole-item',
        new Map(),
      );
      return arrangeBySchedule(typed, found.workItems).placements.length > 0;
    });

    expect(arranged.length, 'no corpus plan is arranged even when reversed').toBeGreaterThan(0);
  });
});
