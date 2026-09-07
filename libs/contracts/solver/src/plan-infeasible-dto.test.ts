import { indexTree, leafDeadlinesOf } from '@wbs/domain';
import type { ScheduleInput } from '@wbs/domain/canonical-schedule-input';
import { describe, expect, it } from 'bun:test';

import {
  decodePlanInfeasible,
  encodePlanInfeasible,
  planInfeasibleResultOf,
} from './plan-infeasible-dto';

const INPUT: ScheduleInput = {
  rows: [
    { id: 'parent', parentId: null, position: 10, frozenNumber: null, priority: null },
    { id: 'a', parentId: 'parent', position: 10, frozenNumber: null, priority: null },
    { id: 'b', parentId: 'parent', position: 20, frozenNumber: null, priority: null },
  ],
  edges: [],
  slices: [
    { workItemId: 'a', stepId: 'dev', days: 1, personId: null, width: 1, poolIds: [] },
    { workItemId: 'b', stepId: 'dev', days: 1, personId: null, width: 1, poolIds: [] },
  ],
  notBefore: new Map(),
  poolSizes: new Map(),
  reach: 'whole-item',
  deadlines: new Map([
    ['parent', 8],
    ['b', 5],
  ]),
};

/**
 * The ancestor-bound-leaf case tasks.md 8.7 names as *the* test, and its
 * control in the same fixture.
 *
 * `late` carries its own date **later** than the ancestor's, so the date that
 * actually bound it is the parent's and the parent is what the payload must
 * name — a payload showing `late`'s own day 12 sends the user to edit a field
 * whose every value below 12 changes nothing while the parent still says 5.
 * `own` is the other direction with the same two owners in play: its own day 3
 * is tighter than the parent's 5, so the leaf binds itself. One assertion that
 * always answered "the ancestor" would pass the first row and fail this one.
 */
const ANCESTOR_BOUND: ScheduleInput = {
  rows: [
    { id: 'parent', parentId: null, position: 10, frozenNumber: null, priority: null },
    { id: 'late', parentId: 'parent', position: 10, frozenNumber: null, priority: null },
    { id: 'own', parentId: 'parent', position: 20, frozenNumber: null, priority: null },
  ],
  edges: [],
  slices: [
    { workItemId: 'late', stepId: 'dev', days: 1, personId: null, width: 1, poolIds: [] },
    { workItemId: 'own', stepId: 'dev', days: 1, personId: null, width: 1, poolIds: [] },
  ],
  notBefore: new Map(),
  poolSizes: new Map(),
  reach: 'whole-item',
  deadlines: new Map([
    ['parent', 5],
    ['late', 12],
    ['own', 3],
  ]),
};

describe('plan-infeasible cache DTO', () => {
  it('records one effective deadline per bound leaf and preserves its owner', () => {
    const result = planInfeasibleResultOf(INPUT);

    expect(result).toEqual({
      items: [
        { ownerWorkItemId: 'parent', boundWorkItemId: 'a', effectiveDeadlineOffset: 8 },
        { ownerWorkItemId: 'b', boundWorkItemId: 'b', effectiveDeadlineOffset: 5 },
      ],
    });
    expect(decodePlanInfeasible(encodePlanInfeasible(result))).toEqual(result);
  });

  it('names the ancestor that owns the binding date, not the leaf carrying a later one', () => {
    const result = planInfeasibleResultOf(ANCESTOR_BOUND);

    expect(result).toEqual({
      items: [
        { ownerWorkItemId: 'parent', boundWorkItemId: 'late', effectiveDeadlineOffset: 5 },
        { ownerWorkItemId: 'own', boundWorkItemId: 'own', effectiveDeadlineOffset: 3 },
      ],
    });
  });

  /**
   * The certificate's offsets are the engine's own fold read back, not a
   * second opinion. `leafDeadlinesOf` is what `buildSolverRequest` hands the
   * solver and what `schedule()` computes `lateBy` against, so a payload whose
   * day differs from it would point at a date no constraint was built from.
   * Both fixtures are checked, because the divergence that matters is on the
   * rows where two owners compete.
   */
  it('agrees with the engine fold on every leaf it names', () => {
    for (const input of [INPUT, ANCESTOR_BOUND]) {
      const folded = leafDeadlinesOf(input.deadlines, indexTree(input.rows));
      const named = planInfeasibleResultOf(input).items;

      expect(named.map((item) => item.boundWorkItemId).sort()).toEqual([...folded.keys()].sort());
      for (const item of named) {
        // The fold on the left: it is the source, and the certificate is the copy
        // under test. It is also the only side whose type admits `undefined`.
        expect(folded.get(item.boundWorkItemId)).toBe(item.effectiveDeadlineOffset);
      }
    }
  });

  it('rejects malformed items and duplicate bound work items', () => {
    expect(() =>
      decodePlanInfeasible({
        dtoVersion: 1,
        items: [{ ownerWorkItemId: 'a', boundWorkItemId: 'b', effectiveDeadlineOffset: '5' }],
      }),
    ).toThrow(/effectiveDeadlineOffset/);
    expect(() =>
      decodePlanInfeasible({
        dtoVersion: 1,
        items: [{ ownerWorkItemId: 'a', boundWorkItemId: 'b', effectiveDeadlineOffset: -2 }],
      }),
    ).toThrow(/effectiveDeadlineOffset/);
    expect(
      decodePlanInfeasible({
        dtoVersion: 1,
        items: [{ ownerWorkItemId: 'a', boundWorkItemId: 'b', effectiveDeadlineOffset: -1 }],
      }),
    ).toEqual({
      items: [{ ownerWorkItemId: 'a', boundWorkItemId: 'b', effectiveDeadlineOffset: -1 }],
    });
    expect(() =>
      decodePlanInfeasible({
        dtoVersion: 1,
        items: [
          { ownerWorkItemId: 'a', boundWorkItemId: 'b', effectiveDeadlineOffset: 5 },
          { ownerWorkItemId: 'parent', boundWorkItemId: 'b', effectiveDeadlineOffset: 8 },
        ],
      }),
    ).toThrow(/duplicate boundWorkItemId b/);
  });
});
