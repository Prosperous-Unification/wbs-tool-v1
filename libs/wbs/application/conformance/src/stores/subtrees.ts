import type {
  Assignment,
  LabelledWorkItem,
  StoredActual,
  StoredDependency,
  StoredEstimate,
  StoredMeasure,
  StoredProgress,
  SubtreeCopy,
} from '@wbs/core';
import { labelledRow, workItemRow } from '@wbs/core/testing/work-item-fixture';
import { expect } from 'bun:test';

import type { CaseRegistration } from '../case-manifest';
import type { SeededPlan, SourceReaders } from '../source-declaration';
import { type OpenCase, storeCase } from './store-case';

export const SUBTREE_COPY_IDS = {
  root: 'subtree-copy-root',
  child: 'subtree-copy-child',
  dependency: 'subtree-copy-dependency',
} as const;

function sorted<T>(rows: T[], key: (row: T) => string): T[] {
  return rows.toSorted((left, right) => key(left).localeCompare(key(right)));
}

function assignmentKey(row: Assignment): string {
  return `${row.workItemId}\u0000${row.stepId}\u0000${row.personId}`;
}

function measureKey(row: StoredMeasure): string {
  return `${row.workItemId}\u0000${row.stepId}\u0000${row.metric}`;
}

function pairKey(row: { workItemId: string; stepId: string }): string {
  return `${row.workItemId}\u0000${row.stepId}`;
}

export interface SubtreePublicState {
  readonly workItems: readonly LabelledWorkItem[];
  readonly estimates: readonly StoredEstimate[];
  readonly actuals: readonly StoredActual[];
  readonly progress: readonly StoredProgress[];
  readonly measures: readonly StoredMeasure[];
  readonly dependencies: readonly StoredDependency[];
  readonly assignments: readonly Assignment[];
  readonly assignmentPeople: readonly { id: string; name: string }[];
}

export async function readSubtreePublicState(
  readers: SourceReaders,
  projectId: string,
): Promise<SubtreePublicState> {
  const [workItems, estimates, actuals, progress, measures, dependencies, assigned] =
    await Promise.all([
      readers.workItems.listByProject(projectId),
      readers.estimates.listByProject(projectId),
      readers.actuals.listByProject(projectId),
      readers.progress.listByProject(projectId),
      readers.measures.listByProject(projectId),
      readers.dependencies.listByProject(projectId),
      readers.directory.assignmentsInProject(projectId),
    ]);
  return {
    workItems: sorted(workItems, ({ id }) => id),
    estimates: sorted(estimates, pairKey),
    actuals: sorted(actuals, pairKey),
    progress: sorted(progress, pairKey),
    measures: sorted(measures, measureKey),
    dependencies: sorted(dependencies, ({ id }) => id),
    assignments: sorted(assigned.assignments, assignmentKey),
    assignmentPeople: sorted(assigned.people, ({ id }) => id),
  };
}

export function subtreeSeedRecords(seed: SeededPlan) {
  const [firstItemId, removalItemId] = seed.workItemIds[0];
  const [otherItemId, otherSuccessorId] = seed.workItemIds[1];
  const [devStepId, qaStepId] = seed.stepIds[0];
  const otherStepId = seed.stepIds[1][0];
  return {
    estimates: [
      { workItemId: removalItemId, stepId: devStepId, optimistic: 1, realistic: 2, pessimistic: 3 },
      { workItemId: firstItemId, stepId: qaStepId, optimistic: 4, realistic: 5, pessimistic: 6 },
      { workItemId: otherItemId, stepId: otherStepId, optimistic: 7, realistic: 8, pessimistic: 9 },
    ] satisfies StoredEstimate[],
    actuals: [
      { workItemId: removalItemId, stepId: devStepId, days: 2, recordedAt: 111 },
      { workItemId: firstItemId, stepId: qaStepId, days: 3, recordedAt: 112 },
      { workItemId: otherItemId, stepId: otherStepId, days: 4, recordedAt: 113 },
    ] satisfies StoredActual[],
    progress: [
      { workItemId: removalItemId, stepId: devStepId, state: 'done', statedAt: 121 },
      { workItemId: firstItemId, stepId: qaStepId, state: 'in_progress', statedAt: 122 },
      { workItemId: otherItemId, stepId: otherStepId, state: 'done', statedAt: 123 },
    ] satisfies StoredProgress[],
    measures: [
      {
        workItemId: removalItemId,
        stepId: devStepId,
        metric: 'token_estimate',
        value: 101,
        recordedAt: 131,
      },
      {
        workItemId: removalItemId,
        stepId: devStepId,
        metric: 'token_actual',
        value: 102,
        recordedAt: 132,
      },
      {
        workItemId: removalItemId,
        stepId: devStepId,
        metric: 'hours_actual',
        value: 103,
        recordedAt: 133,
      },
      {
        workItemId: removalItemId,
        stepId: qaStepId,
        metric: 'hours_actual',
        value: 104,
        recordedAt: 134,
      },
      {
        workItemId: firstItemId,
        stepId: qaStepId,
        metric: 'token_estimate',
        value: 105,
        recordedAt: 135,
      },
      {
        workItemId: firstItemId,
        stepId: qaStepId,
        metric: 'token_actual',
        value: 107,
        recordedAt: 137,
      },
      {
        workItemId: otherItemId,
        stepId: otherStepId,
        metric: 'token_actual',
        value: 106,
        recordedAt: 136,
      },
    ] satisfies StoredMeasure[],
    assignments: [
      { workItemId: removalItemId, stepId: devStepId, personId: seed.personIds[0] },
      { workItemId: otherItemId, stepId: otherStepId, personId: seed.personIds[1] },
    ] satisfies Assignment[],
    dependencies: [
      {
        id: 'subtree-seed-touching',
        projectId: seed.projectIds[0],
        predecessorId: firstItemId,
        successorId: removalItemId,
      },
      {
        id: 'subtree-seed-surviving',
        projectId: seed.projectIds[0],
        predecessorId: removalItemId,
        successorId: firstItemId,
      },
      {
        id: 'subtree-seed-other-project',
        projectId: seed.projectIds[1],
        predecessorId: otherItemId,
        successorId: otherSuccessorId,
      },
    ] satisfies StoredDependency[],
  };
}

export function completeSubtreeCopy(seed: SeededPlan): SubtreeCopy {
  const [firstItemId, removalItemId] = seed.workItemIds[0];
  const [devStepId, qaStepId] = seed.stepIds[0];
  return {
    rows: [
      workItemRow({
        id: SUBTREE_COPY_IDS.root,
        projectId: seed.projectIds[0],
        parentId: null,
        position: 20,
        name: 'Copied root',
        notes: 'all fields travel',
        frozenNumber: '030',
        startNoEarlierThan: '2026-09-15',
        startNoEarlierThanReason: 'contract start',
        deadline: '2026-09-30',
        priority: 2,
        serviceTeamId: seed.teamIds[0],
        serviceId: seed.serviceIds[0],
        maxParallel: 2,
      }),
      workItemRow({
        id: SUBTREE_COPY_IDS.child,
        projectId: seed.projectIds[0],
        parentId: SUBTREE_COPY_IDS.root,
        position: 10,
        name: 'Copied child',
        notes: 'parent exists first',
        serviceTeamId: seed.teamIds[0],
      }),
    ].map((row, index) => ({
      ...row,
      teamIds: index === 0 ? [...seed.teamIds] : [seed.teamIds[0]],
    })),
    respaced: [{ id: removalItemId, position: 40 }],
    reparented: [{ id: firstItemId, parentId: SUBTREE_COPY_IDS.root, position: 30 }],
    estimates: [
      {
        workItemId: SUBTREE_COPY_IDS.child,
        stepId: devStepId,
        optimistic: 10,
        realistic: 20,
        pessimistic: 30,
      },
    ],
    actuals: [{ workItemId: SUBTREE_COPY_IDS.child, stepId: qaStepId, days: 5, recordedAt: 211 }],
    progress: [
      { workItemId: SUBTREE_COPY_IDS.root, stepId: devStepId, state: 'in_progress', statedAt: 212 },
    ],
    measures: [
      {
        workItemId: SUBTREE_COPY_IDS.child,
        stepId: devStepId,
        metric: 'token_estimate',
        value: 201,
        recordedAt: 213,
      },
      {
        workItemId: SUBTREE_COPY_IDS.child,
        stepId: devStepId,
        metric: 'token_actual',
        value: 202,
        recordedAt: 214,
      },
      {
        workItemId: SUBTREE_COPY_IDS.child,
        stepId: devStepId,
        metric: 'hours_actual',
        value: 203,
        recordedAt: 215,
      },
    ],
    assignments: [
      { workItemId: SUBTREE_COPY_IDS.child, stepId: qaStepId, personId: seed.personIds[1] },
    ],
    dependencies: [
      {
        id: SUBTREE_COPY_IDS.dependency,
        projectId: seed.projectIds[0],
        predecessorId: SUBTREE_COPY_IDS.root,
        successorId: SUBTREE_COPY_IDS.child,
      },
    ],
    removedEstimates: [{ workItemId: removalItemId, stepId: devStepId }],
    removedActuals: [{ workItemId: removalItemId, stepId: devStepId }],
    removedProgress: [{ workItemId: removalItemId, stepId: devStepId }],
    removedMeasures: [
      { workItemId: removalItemId, stepId: devStepId, metric: 'token_estimate' },
      { workItemId: firstItemId, stepId: qaStepId, metric: 'token_actual' },
      { workItemId: removalItemId, stepId: qaStepId, metric: 'hours_actual' },
    ],
  };
}

function withoutRevisions(state: SubtreePublicState) {
  return {
    workItems: state.workItems.map(({ revision: _revision, ...row }) => row),
    estimates: [...state.estimates],
    actuals: [...state.actuals],
    progress: [...state.progress],
    measures: [...state.measures],
    dependencies: [...state.dependencies],
    assignments: [...state.assignments],
    assignmentPeople: [...state.assignmentPeople],
  };
}

function revisionsOf(state: SubtreePublicState) {
  return state.workItems.map(({ id, revision }) => ({ id, revision }));
}

function expectedAfter(seed: SeededPlan): Omit<SubtreePublicState, 'workItems'> & {
  workItems: Omit<LabelledWorkItem, 'revision'>[];
} {
  const seeded = subtreeSeedRecords(seed);
  const copy = completeSubtreeCopy(seed);
  const [firstItemId, removalItemId] = seed.workItemIds[0];
  const devStepId = seed.stepIds[0][0];
  const firstProjectIds = new Set<string>(seed.workItemIds[0]);
  const baseRows = seed.workItemIds[0].map((id, index) =>
    labelledRow({
      ...workItemRow({
        id,
        projectId: seed.projectIds[0],
        name: `Work ${String(index + 1)}`,
        parentId: id === firstItemId ? SUBTREE_COPY_IDS.root : null,
        position: id === firstItemId ? 30 : 40,
      }),
    }),
  );
  const copiedRows = copy.rows.map(({ teamIds = [], ...row }) =>
    labelledRow({
      ...row,
      teamIds,
    }),
  );
  return {
    workItems: sorted([...baseRows, ...copiedRows], ({ id }) => id).map(
      ({ revision: _revision, ...row }) => row,
    ),
    estimates: sorted(
      [
        ...seeded.estimates.filter(
          (row) =>
            firstProjectIds.has(row.workItemId) &&
            pairKey(row) !== `${removalItemId}\u0000${devStepId}`,
        ),
        ...copy.estimates,
      ],
      pairKey,
    ),
    actuals: sorted(
      [
        ...seeded.actuals.filter(
          (row) =>
            firstProjectIds.has(row.workItemId) &&
            pairKey(row) !== `${removalItemId}\u0000${devStepId}`,
        ),
        ...copy.actuals,
      ],
      pairKey,
    ),
    progress: sorted(
      [
        ...seeded.progress.filter(
          (row) =>
            firstProjectIds.has(row.workItemId) &&
            pairKey(row) !== `${removalItemId}\u0000${devStepId}`,
        ),
        ...copy.progress,
      ],
      pairKey,
    ),
    measures: sorted(
      [
        ...seeded.measures.filter(
          (row) =>
            firstProjectIds.has(row.workItemId) &&
            !copy.removedMeasures.some(
              (removed) =>
                removed.workItemId === row.workItemId &&
                removed.stepId === row.stepId &&
                removed.metric === row.metric,
            ),
        ),
        ...copy.measures,
      ],
      measureKey,
    ),
    dependencies: sorted(
      [
        ...seeded.dependencies.filter(({ projectId }) => projectId === seed.projectIds[0]),
        ...copy.dependencies,
      ],
      ({ id }) => id,
    ),
    assignments: sorted(
      [
        ...seeded.assignments.filter(({ workItemId }) => workItemId !== seed.workItemIds[1][0]),
        ...copy.assignments,
      ],
      assignmentKey,
    ),
    assignmentPeople: sorted(
      [
        { id: seed.personIds[0], name: 'Person 1' },
        { id: seed.personIds[1], name: 'Person 2' },
      ],
      ({ id }) => id,
    ),
  };
}

export interface MissingSubtreeRecords {
  readonly dependencyIds?: readonly string[];
  readonly measureKeys?: readonly string[];
  readonly progressKeys?: readonly string[];
}

function expectedWithMissing(seed: SeededPlan, missing: MissingSubtreeRecords) {
  const expected = expectedAfter(seed);
  const missingDependencyIds = new Set(missing.dependencyIds ?? []);
  const missingMeasureKeys = new Set(missing.measureKeys ?? []);
  const missingProgressKeys = new Set(missing.progressKeys ?? []);
  return {
    workItems: [...expected.workItems],
    estimates: [...expected.estimates],
    actuals: [...expected.actuals],
    progress: expected.progress.filter((row) => !missingProgressKeys.has(pairKey(row))),
    dependencies: expected.dependencies.filter(({ id }) => !missingDependencyIds.has(id)),
    measures: expected.measures.filter((row) => !missingMeasureKeys.has(measureKey(row))),
    assignments: [...expected.assignments],
    assignmentPeople: [...expected.assignmentPeople],
  };
}

function assertCompleteRevisions(actual: SubtreePublicState, seed: SeededPlan): void {
  const revisions = revisionsOf(actual);
  expect([
    [
      { id: SUBTREE_COPY_IDS.child, revision: 0 },
      { id: SUBTREE_COPY_IDS.root, revision: 0 },
      { id: seed.workItemIds[0][0], revision: 0 },
      { id: seed.workItemIds[0][1], revision: 0 },
    ],
    [
      { id: SUBTREE_COPY_IDS.child, revision: 0 },
      { id: SUBTREE_COPY_IDS.root, revision: 0 },
      { id: seed.workItemIds[0][0], revision: 9 },
      { id: seed.workItemIds[0][1], revision: 11 },
    ],
  ]).toContainEqual(revisions);
}

/** Compares one public snapshot with the complete independently built subtree state. */
export function assertCompleteState(
  actual: SubtreePublicState,
  seed: SeededPlan,
  missing: MissingSubtreeRecords = {},
): void {
  // Proof: routing copied dependencies to isolated adapter-owned storage on
  // either source removes the complete `subtree-copy-dependency` record here.
  // Proof: pair-wide removal loses an unrequested sibling metric's complete
  // `{workItemId, stepId, metric, value, recordedAt}` row here.
  // Proof: before memory restored explicit structural team sets, this failed
  // with team-b missing from the root and the child's teamIds received as [].
  expect(withoutRevisions(actual)).toEqual(expectedWithMissing(seed, missing));
  assertCompleteRevisions(actual, seed);
}

/** Accepts only explicitly enumerated complete post-write prerequisite states. */
export function assertCompleteStateAlternative(
  actual: SubtreePublicState,
  seed: SeededPlan,
  alternatives: readonly MissingSubtreeRecords[],
): void {
  expect(alternatives.map((missing) => expectedWithMissing(seed, missing))).toContainEqual(
    withoutRevisions(actual),
  );
  assertCompleteRevisions(actual, seed);
}

function expectedSeedProject(seed: SeededPlan, projectIndex: 0 | 1) {
  const projectId = seed.projectIds[projectIndex];
  const ids = new Set<string>(seed.workItemIds[projectIndex]);
  const seeded = subtreeSeedRecords(seed);
  return {
    workItems: sorted(
      seed.workItemIds[projectIndex].map((id, index) =>
        labelledRow({
          ...workItemRow({ id, projectId, name: `Work ${String(index + 1)}` }),
        }),
      ),
      ({ id }) => id,
    ).map(({ revision: _revision, ...row }) => row),
    estimates: sorted(
      seeded.estimates.filter(({ workItemId }) => ids.has(workItemId)),
      pairKey,
    ),
    actuals: sorted(
      seeded.actuals.filter(({ workItemId }) => ids.has(workItemId)),
      pairKey,
    ),
    progress: sorted(
      seeded.progress.filter(({ workItemId }) => ids.has(workItemId)),
      pairKey,
    ),
    measures: sorted(
      seeded.measures.filter(({ workItemId }) => ids.has(workItemId)),
      measureKey,
    ),
    dependencies: sorted(
      seeded.dependencies.filter((edge) => edge.projectId === projectId),
      ({ id }) => id,
    ),
    assignments: sorted(
      seeded.assignments.filter(({ workItemId }) => ids.has(workItemId)),
      assignmentKey,
    ),
    assignmentPeople: [
      {
        id: seed.personIds[projectIndex],
        name: `Person ${String(projectIndex + 1)}`,
      },
    ],
  };
}

export function assertSeedState(
  actual: SubtreePublicState,
  seed: SeededPlan,
  projectIndex: 0 | 1,
): void {
  expect(withoutRevisions(actual)).toEqual(expectedSeedProject(seed, projectIndex));
  const memory = seed.workItemIds[projectIndex].map((id) => ({ id, revision: 0 }));
  const sqlite =
    projectIndex === 0
      ? [
          { id: seed.workItemIds[0][0], revision: 7 },
          { id: seed.workItemIds[0][1], revision: 10 },
        ]
      : [
          { id: seed.workItemIds[1][0], revision: 6 },
          { id: seed.workItemIds[1][1], revision: 1 },
        ];
  expect([memory, sqlite]).toContainEqual(revisionsOf(actual));
}

/** Shared whole-copy and terminal-rejection cases for {@link SubtreeStore}. */
export function subtreeRegistrations(open: OpenCase<'subtrees'>): readonly CaseRegistration[] {
  return [
    storeCase(
      'subtrees',
      'subtrees.insertSubtree:complete-copy',
      open,
      async ({ port, readers, seed }) => {
        const before = await Promise.all(
          seed.projectIds.map((projectId) => readSubtreePublicState(readers, projectId)),
        );
        assertSeedState(before[0], seed, 0);
        assertSeedState(before[1], seed, 1);
        await port.insertSubtree(structuredClone(completeSubtreeCopy(seed)), seed.stamps[1]);
        assertCompleteState(await readSubtreePublicState(readers, seed.projectIds[0]), seed);
        expect(await readSubtreePublicState(readers, seed.projectIds[1])).toEqual(before[1]);
      },
    ),
    storeCase(
      'subtrees',
      'subtrees.insertSubtree:late-failure',
      open,
      async ({ port, readers, seed, scenario }) => {
        if (scenario.kind !== 'late-write' || scenario.point !== 'subtree-final-satellite') {
          throw new Error('subtree late-failure case requires the final-satellite scenario');
        }
        const before = await Promise.all(
          seed.projectIds.map((projectId) => readSubtreePublicState(readers, projectId)),
        );
        assertSeedState(before[0], seed, 0);
        assertSeedState(before[1], seed, 1);
        scenario.arm();
        const rejected = port.insertSubtree(
          structuredClone(completeSubtreeCopy(seed)),
          seed.stamps[1],
        );
        expect(rejected).rejects.toThrow('subtree-final-satellite');
        await rejected.catch(() => undefined);
        expect(scenario.reached()).toBe(true);
        // Proof: bypassing memory staging or SQLite's transaction leaves the
        // exact copied rows and satellites in this complete public-state diff.
        expect(
          await Promise.all(
            seed.projectIds.map((projectId) => readSubtreePublicState(readers, projectId)),
          ),
        ).toEqual(before);
      },
    ),
  ];
}
