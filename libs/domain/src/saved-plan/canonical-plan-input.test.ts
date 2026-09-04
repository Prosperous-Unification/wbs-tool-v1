import { describe, expect, it } from 'bun:test';
import fc from 'fast-check';

import {
  CANONICAL_PLAN_INPUT_SCHEMA_VERSION,
  canonicalisePlanInput,
  type CanonicalPlanInput,
  type PlanInputRows,
  serialiseCanonicalPlanInput,
} from './canonical-plan-input';
import { planFixtureRows as rows, reversed } from './plan-fixture';

describe('canonicalisePlanInput', () => {
  it('serializes identically whatever order the rows arrived in', () => {
    const left = serialiseCanonicalPlanInput(canonicalisePlanInput(rows));
    const right = serialiseCanonicalPlanInput(canonicalisePlanInput(reversed(rows)));

    expect(right).toBe(left);
  });

  it('stamps the schema version the body carries', () => {
    expect(canonicalisePlanInput(rows).schemaVersion).toBe(CANONICAL_PLAN_INPUT_SCHEMA_VERSION);
  });

  it('keeps no key the closed field list does not name', () => {
    // A read row carrying an audit column, a write counter and a refresh cursor
    // — the three classes the JSDoc rules out. None may reach the bytes.
    const contaminated = {
      ...rows,
      project: {
        ...rows.project,
        revision: 41,
        createdAt: 1_756_000_000,
        updatedAt: 1_756_000_001,
        createdBy: 'u9',
      },
      workItems: rows.workItems.map((row) => ({ ...row, revision: 7 })),
      latestSeq: 918,
    } as unknown as PlanInputRows;

    const bytes = serialiseCanonicalPlanInput(canonicalisePlanInput(contaminated));

    expect(bytes).toBe(serialiseCanonicalPlanInput(canonicalisePlanInput(rows)));
    for (const leaked of ['revision', 'createdAt', 'updatedAt', 'createdBy', 'latestSeq']) {
      expect(bytes).not.toContain(leaked);
    }
  });

  /**
   * The whole type set, not one of it. `typeId: string | null` held exactly one
   * id and this fixture row states two, so a singular field silently keeps
   * whichever the fold reached for — and `workItemTypes`, whose contract is
   * "every work-item-type id the captured items use", is enumerated from this.
   */
  it('stores every work-item type a row states, not one of them', () => {
    const [typed] = canonicalisePlanInput(rows).workItems.filter((row) => row.id === 'w2');

    expect(typed.typeIds).toEqual(['t-spike', 't-task']);
  });

  /**
   * An external ref is identified by its `url`; `work_item_external_ref` has no
   * `external_id` column. Sorting by a field the row cannot supply compares
   * `undefined` with `undefined`, which leaves arrival order in the bytes — so
   * this asserts the *sorted* order rather than only that both fields survive.
   */
  it('orders external refs by system then url, and keeps the shown position', () => {
    const [linked] = canonicalisePlanInput(rows).workItems.filter((row) => row.id === 'w2');

    expect(linked.externalRefs).toEqual([
      { externalSystemId: 'gh', url: 'https://gh/17', position: 10 },
      { externalSystemId: 'jira', url: 'https://jira/SHED-2', position: 20 },
    ]);
  });

  /**
   * A measure is per (work item, **step**, metric). Without `stepId` the two
   * `tokens` rows on `w2` are one key, and a fold has to pick which step's
   * figure the record keeps — the plan says 1200 for Build and 300 for Test.
   */
  it('keeps one measure per step, not one per item and metric', () => {
    expect(canonicalisePlanInput(rows).measures).toEqual([
      { workItemId: 'w2', stepId: 's1', metric: 'hours', value: 8 },
      { workItemId: 'w2', stepId: 's1', metric: 'tokens', value: 1200 },
      { workItemId: 'w2', stepId: 's2', metric: 'tokens', value: 300 },
    ]);
  });

  /**
   * An assignment is per (work item, **step**, person), and the scheduler reads
   * it that way — `schedulePlanInput` folds these rows into
   * `workItemId -> { [stepId]: personId }` before the person floor is applied.
   * Two people on two steps of `w2` is the pair a `(workItemId, personId)` key
   * could not have rebuilt.
   */
  it('keeps who does which step, not merely who is on the item', () => {
    expect(canonicalisePlanInput(rows).assignments).toEqual([
      { workItemId: 'w1', stepId: 's1', personId: 'per-1' },
      { workItemId: 'w2', stepId: 's1', personId: 'per-2' },
      { workItemId: 'w2', stepId: 's2', personId: 'per-1' },
    ]);
  });

  /**
   * The watched negative for 1.3. A canonicaliser that stops sorting work items
   * still returns a perfectly well-typed value, so the only thing that can
   * catch it is the byte comparison above — proved here by running that
   * comparison against a copy with exactly that one sort removed.
   */
  it('the byte comparison is what catches a dropped sort', () => {
    const withoutWorkItemSort = (values: PlanInputRows): CanonicalPlanInput => ({
      ...canonicalisePlanInput(values),
      workItems: values.workItems,
    });

    const left = JSON.stringify(withoutWorkItemSort(rows));
    const right = JSON.stringify(withoutWorkItemSort(reversed(rows)));

    expect(right).not.toBe(left);
  });
});

describe('canonicalisePlanInput round trip', () => {
  /**
   * Generated plans rather than the fixture: the round trip must hold for row
   * counts and orderings nobody wrote down, which is where a sort that ties on
   * an unstable key shows up.
   */
  const arbitraryRows = fc
    .record({
      ids: fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), {
        minLength: 1,
        maxLength: 8,
      }),
      tagIds: fc.uniqueArray(fc.string({ minLength: 1, maxLength: 4 }), { maxLength: 4 }),
      teamIds: fc.uniqueArray(fc.string({ minLength: 1, maxLength: 4 }), { maxLength: 4 }),
      startDate: fc.option(fc.constant('2026-09-07'), { nil: null }),
    })
    .map(({ ids, tagIds, teamIds, startDate }): PlanInputRows => {
      const named = (id: string) => ({ id, name: `name ${id}` });
      return {
        project: { ...rows.project, startDate },
        workItems: ids.map((id, index) => ({
          id,
          parentId: index === 0 ? null : (ids[0] ?? null),
          position: (index + 1) * 10,
          name: `item ${id}`,
          notes: '',
          typeIds: [],
          tagIds,
          externalRefs: [],
          priority: index,
          maxParallel: 1,
          frozenNumber: null,
          serviceTeamId: teamIds[0] ?? null,
          serviceId: null,
          startNoEarlierThan: null,
          startNoEarlierThanReason: null,
        })),
        steps: [{ id: 's1', name: 'Build', position: 10 }],
        stepValues: ids.map((id) => ({
          workItemId: id,
          stepId: 's1',
          optimistic: 1,
          realistic: 2,
          pessimistic: 3,
          derived: 2,
          actual: null,
          progress: 'in_progress',
        })),
        measures: [],
        dependencies: [],
        assignments: [],
        people: [],
        teams: teamIds.map(named),
        services: [],
        personTeams: [],
        teamServices: [],
        workItemTeams: [],
        workItemServices: [],
        priorityBands: rows.priorityBands,
        capacity: teamIds.map((teamId) => ({ teamId, people: 1 })),
        tags: tagIds.map(named),
        workItemTypes: [],
        externalSystems: [],
      };
    });

  it('canonicalise, serialize, parse, canonicalise again — identical bytes', () => {
    fc.assert(
      fc.property(arbitraryRows, (values) => {
        const once = serialiseCanonicalPlanInput(canonicalisePlanInput(values));
        const parsed = JSON.parse(once) as PlanInputRows;
        const twice = serialiseCanonicalPlanInput(canonicalisePlanInput(parsed));

        expect(twice).toBe(once);
      }),
      { numRuns: 200 },
    );
  });
});
