import { describe, expect, it } from 'vitest';

import type { WorkItemView } from '@/lib/wbs-api';
import { workItemView } from '@/testing/views';

import { planMove, zoneFor } from './drag-drop';

const row = (id: string, number: string, parentId: string | null, frozen = false): WorkItemView =>
  workItemView({ id, parentId, number, name: id, frozenNumber: frozen ? number : null });

/**
 * ```
 * 010  strip
 *   010.1  sockets
 *   010.2  lights
 *     010.2.1  wiring
 * 020  sand
 * 030  paint
 * ```
 */
const TREE: WorkItemView[] = [
  row('strip', '010', null),
  row('sockets', '010.1', 'strip'),
  row('lights', '010.2', 'strip'),
  row('wiring', '010.2.1', 'lights'),
  row('sand', '020', null),
  row('paint', '030', null),
];

describe('zoneFor', () => {
  it('reads the top quarter as above and the bottom quarter as below', () => {
    expect(zoneFor(0, 40)).toBe('above');
    expect(zoneFor(9, 40)).toBe('above');
    expect(zoneFor(31, 40)).toBe('below');
    expect(zoneFor(40, 40)).toBe('below');
  });

  it('reads the middle half as into, which is the biggest zone on purpose', () => {
    // Making a row a child is what people reach for when they drag an outline.
    // The two reorder zones are recoverable in one more drag if you miss.
    expect(zoneFor(10, 40)).toBe('into');
    expect(zoneFor(20, 40)).toBe('into');
    expect(zoneFor(30, 40)).toBe('into');
  });

  it('never divides by a zero height', () => {
    expect(zoneFor(0, 0)).toBe('into');
  });
});

describe('planMove', () => {
  it('makes the dragged row the target’s last child', () => {
    expect(planMove(TREE, 'paint', 'strip', 'into')).toEqual({
      ok: true,
      parentId: 'strip',
      afterId: 'lights',
    });
  });

  it('makes a childless row a parent', () => {
    expect(planMove(TREE, 'paint', 'sand', 'into')).toEqual({
      ok: true,
      parentId: 'sand',
      afterId: null,
    });
  });

  it('places a row immediately before a later sibling', () => {
    expect(planMove(TREE, 'paint', 'sand', 'above')).toEqual({
      ok: true,
      parentId: null,
      afterId: 'strip',
    });
  });

  it('places a row first when dropped above the first of its group', () => {
    expect(planMove(TREE, 'paint', 'strip', 'above')).toEqual({
      ok: true,
      parentId: null,
      afterId: null,
    });
  });

  it('moves a row into another branch when dropped below one of its rows', () => {
    expect(planMove(TREE, 'paint', 'sockets', 'below')).toEqual({
      ok: true,
      parentId: 'strip',
      afterId: 'sockets',
    });
  });

  it('never names the dragged row as its own predecessor', () => {
    // The row being moved is out of the group while the drop point is worked
    // out. Leaving it in produces `afterId === draggedId` whenever someone aims
    // just past the row they picked up — which is a move the server would place
    // relative to a row that is no longer there.
    for (const target of TREE) {
      for (const zone of ['above', 'into', 'below'] as const) {
        const plan = planMove(TREE, 'sand', target.id, zone);
        if (plan.ok) expect(plan.afterId).not.toBe('sand');
      }
    }
  });

  it('drops into a branch that is collapsed on screen, using the whole tree', () => {
    expect(planMove(TREE, 'paint', 'lights', 'into')).toEqual({
      ok: true,
      parentId: 'lights',
      afterId: 'wiring',
    });
  });

  it('plans a frozen row’s move like any other', () => {
    // The inverse of the case that stood here until ADR 0023, kept rather than
    // deleted: it expected `{ ok: false, reason: 'frozen' }`, pre-empting a
    // refusal be-01 no longer makes.
    const frozen = TREE.map((r) => (r.id === 'paint' ? row('paint', '030', null, true) : r));

    expect(planMove(frozen, 'paint', 'strip', 'into')).toEqual({
      ok: true,
      parentId: 'strip',
      afterId: 'lights',
    });
  });

  it('refuses a drop onto the row being dragged', () => {
    expect(planMove(TREE, 'strip', 'strip', 'into')).toEqual({ ok: false, reason: 'cycle' });
    expect(planMove(TREE, 'strip', 'strip', 'above')).toEqual({ ok: false, reason: 'cycle' });
  });

  it('refuses a drop anywhere inside the dragged row’s own subtree', () => {
    // All three zones: `above` and `below` a descendant put the row under that
    // descendant's parent, which is also inside the subtree.
    for (const zone of ['above', 'into', 'below'] as const) {
      expect(planMove(TREE, 'strip', 'wiring', zone)).toEqual({ ok: false, reason: 'cycle' });
    }
  });

  it('refuses a drop that resolves to where the row already is', () => {
    // Below the sibling directly above it and above the sibling directly below
    // it are the same position, and it is the one the row already holds. Both
    // spellings have to be caught, because a person aiming at either gets it.
    expect(planMove(TREE, 'sand', 'strip', 'below')).toEqual({ ok: false, reason: 'unchanged' });
    expect(planMove(TREE, 'sand', 'paint', 'above')).toEqual({ ok: false, reason: 'unchanged' });

    // An only child dropped into its own parent is also going nowhere.
    expect(planMove(TREE, 'wiring', 'lights', 'into')).toEqual({
      ok: false,
      reason: 'unchanged',
    });
  });

  it('refuses a drop on a row that is not in the tree', () => {
    // Unknown is not OK: a target the list does not contain is a bug in the
    // caller, not a move to guess at.
    expect(planMove(TREE, 'paint', 'ghost', 'into')).toEqual({ ok: false, reason: 'not_found' });
    expect(planMove(TREE, 'ghost', 'paint', 'into')).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('planMove — cross-review findings', () => {
  it('drops below an open parent as its first child, where the line was drawn', () => {
    // agy, medium. With `strip` expanded, the row under it on screen is
    // `sockets`. Someone aiming at that gap means "first child of strip".
    // Placing it after the whole branch put it three rows from the marker.
    expect(planMove(TREE, 'paint', 'strip', 'below', true)).toEqual({
      ok: true,
      parentId: 'strip',
      afterId: null,
    });
  });

  it('drops below a collapsed parent as its next sibling', () => {
    // Closed, the row under it on screen really is its next sibling.
    expect(planMove(TREE, 'paint', 'strip', 'below', false)).toEqual({
      ok: true,
      parentId: null,
      afterId: 'strip',
    });
  });

  it('is unchanged when dropped below an open parent it already leads', () => {
    expect(planMove(TREE, 'sockets', 'strip', 'below', true)).toEqual({
      ok: false,
      reason: 'unchanged',
    });
  });

  it('never resolves to a parent inside the dragged row’s own subtree', () => {
    // The server's rule, checked directly rather than argued for. be-01 refuses
    // a move whose resolved `parentId` descends from the row being moved; this
    // asserts no plan this function emits can ever be one.
    const parentOf = new Map(TREE.map((r) => [r.id, r.parentId]));
    const descends = (candidate: string | null, ancestor: string): boolean => {
      let cursor = candidate;
      while (cursor !== null) {
        if (cursor === ancestor) return true;
        cursor = parentOf.get(cursor) ?? null;
      }
      return false;
    };

    for (const dragged of TREE) {
      for (const target of TREE) {
        for (const zone of ['above', 'into', 'below'] as const) {
          for (const open of [true, false]) {
            const plan = planMove(TREE, dragged.id, target.id, zone, open);
            if (plan.ok) expect(descends(plan.parentId, dragged.id)).toBe(false);
          }
        }
      }
    }
  });
});
