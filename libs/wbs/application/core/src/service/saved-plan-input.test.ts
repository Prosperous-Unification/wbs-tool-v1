import { canonicalisePlanInput } from '@wbs/domain';
import { describe, expect, it } from 'bun:test';

import type { PlanInputReads } from '../ports/saved-plan-capture-store';
import { planInputRowsOf } from './saved-plan-input';

/**
 * One capture's reads, as the seventeen stores hand them over.
 *
 * The directory halves are deliberately **wider than the plan**: `per-3` belongs
 * to no captured team and is assigned nothing, `team-9` is a team this project
 * never mentions, `svc-9` is delivered by nobody here, and `tag-z`, `t-epic` and
 * `bitbucket` are registry rows no item uses. All six are what the unfiltered
 * `listPeople`/`listTeams`/`listServices` reads bring back, and none may reach
 * the body.
 */
const reads = {
  project: {
    id: 'p1',
    name: 'Rewire the shed',
    ownerId: 'u1',
    restricted: false,
    estimateMethod: 'pert',
    depReach: 'whole-item',
    pertWeights: { optimistic: 1, realistic: 4, pessimistic: 1 },
    estimateRounding: 'ceil',
    startDate: '2026-09-07',
    scheduleEngine: 'fast',
    scheduleObjective: 'pri',
    optimizationEnabled: false,
    solutionRef: { slug: 'shed', url: 'https://shed' },
    revision: 12,
    createdAt: 1_756_000_000,
  },
  steps: [
    { id: 's1', projectId: 'p1', name: 'Build', position: 10 },
    { id: 's2', projectId: 'p1', name: 'Test', position: 20 },
  ],
  workItems: [
    {
      id: 'w1',
      projectId: 'p1',
      parentId: null,
      position: 10,
      name: 'Electrics',
      notes: '',
      frozenNumber: null,
      startNoEarlierThan: null,
      startNoEarlierThanReason: null,
      priority: 10,
      serviceTeamId: null,
      serviceId: null,
      maxParallel: 1,
      revision: 3,
      teamIds: ['team-1'],
      tagIds: ['tag-a'],
      serviceIds: ['svc-1'],
      typeIds: ['t-task', 't-spike'],
      /**
       * Two refs, in the order the read hands them over, and **no `position`
       * field** — `ExternalRef` is `{ id, systemId, url }`
       * (`repository/index.ts:481-485`) and a fixture that invents one describes
       * a row the store cannot produce. It did carry `position: 20` until
       * A-7 was settled, which the `as unknown as PlanInputReads` below let
       * through; the fold read it, and `be-01:typecheck` was the only thing that
       * ever said so.
       *
       * `jira` is second alphabetically and first here on purpose: the shown
       * order is the array's, and `canonicalisePlanInput` re-sorts by
       * `(externalSystemId, url)`, so a rank that tracked the sort rather than
       * the read would still look right on a one-ref item.
       */
      externalRefs: [
        { id: 'x1', systemId: 'jira', url: 'https://jira/SHED-2' },
        { id: 'x2', systemId: 'github', url: 'https://gh/shed/9' },
      ],
    },
  ],
  estimates: [{ workItemId: 'w1', stepId: 's1', optimistic: 1, realistic: 2, pessimistic: 5 }],
  actuals: [{ workItemId: 'w1', stepId: 's2', days: 3, recordedAt: 1_756_000_100 }],
  progress: [{ workItemId: 'w1', stepId: 's2', state: 'done', statedAt: 1_756_000_200 }],
  measures: [
    { workItemId: 'w1', stepId: 's1', metric: 'tokens', value: 1200, recordedAt: 1_756_000_300 },
  ],
  dependencies: [{ id: 'd1', projectId: 'p1', predecessorId: 'w1', successorId: 'w1' }],
  assignments: [{ workItemId: 'w1', stepId: 's1', personId: 'per-1' }],
  capacity: new Map([['team-2', 3]]),
  priorityBands: [{ startsAt: 1, label: 'Critical', defaultValue: 10 }],
  people: [
    { id: 'per-1', name: 'Ada', teamIds: ['team-1'] },
    { id: 'per-2', name: 'Bo', teamIds: ['team-2', 'team-9'] },
    { id: 'per-3', name: 'Cy', teamIds: ['team-9'] },
  ],
  teams: [
    { id: 'team-1', name: 'First fix', serviceIds: ['svc-1'] },
    { id: 'team-2', name: 'Second fix', serviceIds: ['svc-2'] },
    { id: 'team-9', name: 'Elsewhere', serviceIds: ['svc-9'] },
  ],
  services: [
    { id: 'svc-1', name: 'Wiring' },
    { id: 'svc-2', name: 'Testing' },
    { id: 'svc-9', name: 'Unrelated' },
  ],
  tags: [
    { id: 'tag-a', name: 'agreed' },
    { id: 'tag-z', name: 'unused' },
  ],
  workItemTypes: [
    { id: 't-task', name: 'Task' },
    { id: 't-spike', name: 'Spike' },
    { id: 't-epic', name: 'Epic' },
  ],
  externalSystems: [
    { id: 'jira', name: 'Jira' },
    { id: 'bitbucket', name: 'Bitbucket' },
  ],
} as unknown as PlanInputReads;

const ids = (rows: readonly { id: string }[]): string[] => rows.map((row) => row.id).sort();

describe('planInputRowsOf', () => {
  it('carries the project settings the dates come from, and its solution ref split in two', () => {
    expect(planInputRowsOf(reads).project).toEqual({
      id: 'p1',
      name: 'Rewire the shed',
      restricted: false,
      ownerId: 'u1',
      solutionSlug: 'shed',
      solutionUrl: 'https://shed',
      estimateMethod: 'pert',
      depReach: 'whole-item',
      estimateRounding: 'ceil',
      startDate: '2026-09-07',
      pertWeightOptimistic: 1,
      pertWeightRealistic: 4,
      pertWeightPessimistic: 1,
    });
  });

  /**
   * The outer join. `s1` has an estimate and no actual; `s2` has an actual and
   * progress and no estimate. A walk over the estimates would lose the second
   * row entirely, which is an ordinary early plan, not an edge case.
   */
  it('emits a row for every pair any of the three reads mentions', () => {
    const values = planInputRowsOf(reads).stepValues;

    expect(values.map((row) => row.stepId).sort()).toEqual(['s1', 's2']);
    expect(values.find((row) => row.stepId === 's1')).toEqual({
      workItemId: 'w1',
      stepId: 's1',
      optimistic: 1,
      realistic: 2,
      pessimistic: 5,
      // (1 + 4*2 + 5) / 6 under the 1/4/1 weights, unrounded.
      derived: 14 / 6,
      actual: null,
      progress: null,
    });
    expect(values.find((row) => row.stepId === 's2')).toEqual({
      workItemId: 'w1',
      stepId: 's2',
      optimistic: null,
      realistic: null,
      pessimistic: null,
      derived: null,
      actual: 3,
      progress: 'done',
    });
  });

  /**
   * The shown order survives as a **rank over the read's own array**, dense from
   * 0. The read carries no position to copy and does not need one: both readers
   * order by the column and the only writer numbers the deduplicated list it
   * inserts from 0 (`work-item.ts:641-658`), so the index is that column.
   */
  it('turns external ref rows into canonical links, ranked in the order they were read', () => {
    expect(planInputRowsOf(reads).workItems[0]?.externalRefs).toEqual([
      { externalSystemId: 'jira', url: 'https://jira/SHED-2', position: 0 },
      { externalSystemId: 'github', url: 'https://gh/shed/9', position: 1 },
    ]);
  });

  it("spreads a row's team and service sets into the two junction collections", () => {
    const values = planInputRowsOf(reads);

    expect(values.workItemTeams).toEqual([{ workItemId: 'w1', teamId: 'team-1' }]);
    expect(values.workItemServices).toEqual([{ workItemId: 'w1', serviceId: 'svc-1' }]);
  });

  /**
   * The narrowing, which is the whole reason the directory reads are unfiltered.
   * `team-2` is captured because the capacity map names it and nothing else
   * would; `team-9` is not named by this plan at all.
   */
  it('keeps the teams the plan names — through work items and through capacity', () => {
    expect(ids(planInputRowsOf(reads).teams)).toEqual(['team-1', 'team-2']);
  });

  /**
   * `per-2` is assigned nothing and is captured anyway, because `team-2` is and
   * an unassigned member of a captured team is otherwise a stored id with no
   * name. `per-3` belongs only to `team-9` and is nobody's here.
   */
  it('keeps the assigned people plus every member of a captured team', () => {
    expect(ids(planInputRowsOf(reads).people)).toEqual(['per-1', 'per-2']);
  });

  /**
   * A-8: a captured person's membership of an **uncaptured** team is dropped.
   * `per-2` is in `team-2` and `team-9`; keeping the second would drag
   * `team-9`'s name in, then its other members, and the bound would not be one.
   */
  it('narrows person_team to the captured teams, not to every team a person is in', () => {
    expect(planInputRowsOf(reads).personTeams).toEqual([
      { personId: 'per-1', teamId: 'team-1' },
      { personId: 'per-2', teamId: 'team-2' },
    ]);
  });

  it('keeps the services the items deliver and the ones a captured team does', () => {
    const values = planInputRowsOf(reads);

    expect(ids(values.services)).toEqual(['svc-1', 'svc-2']);
    expect(values.teamServices).toEqual([
      { teamId: 'team-1', serviceId: 'svc-1' },
      { teamId: 'team-2', serviceId: 'svc-2' },
    ]);
  });

  /**
   * The registries by value, narrowed to the ids the items use. `tag-z`,
   * `t-epic` and `bitbucket` exist in the directory and in no captured item.
   */
  it('keeps only the registry rows the captured items reference', () => {
    const values = planInputRowsOf(reads);

    expect(ids(values.tags)).toEqual(['tag-a']);
    expect(ids(values.workItemTypes)).toEqual(['t-spike', 't-task']);
    expect(ids(values.externalSystems)).toEqual(['jira']);
  });

  /**
   * The seam. This fold sorts nothing — `canonicalisePlanInput` owns ordering —
   * so the proof it produces a *canonicalisable* value is that folding it twice,
   * from two orderings of the same reads, gives one canonical value.
   */
  it('hands over a value the canonicaliser makes order-independent', () => {
    const flipped = {
      ...reads,
      workItems: [...reads.workItems].map((row) => ({
        ...row,
        typeIds: [...row.typeIds].reverse(),
      })),
      people: [...reads.people].reverse(),
      teams: [...reads.teams].reverse(),
      services: [...reads.services].reverse(),
    } as PlanInputReads;

    expect(canonicalisePlanInput(planInputRowsOf(flipped))).toEqual(
      canonicalisePlanInput(planInputRowsOf(reads)),
    );
  });
});
