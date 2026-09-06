import type {
  PersonView,
  PlanRead,
  ProjectListEntry,
  SliceView,
  WorkItemView,
} from '@/lib/wbs-api';
import { DEFAULT_PERT_WEIGHTS_VIEW } from '@/lib/wbs-api';

/**
 * The views be-01 answers with, built whole, for tests that arrange a plan
 * without a fake API in front of it.
 *
 * Nine suites wrote these literals by hand and every one of them had drifted —
 * `drag-drop.test.ts` and `wbs-rows.test.ts` were each missing thirteen fields
 * of `WorkItemView`, `plan-export.test.ts` a `SliceView`'s `capacityTeamId`,
 * `directory-page.test.tsx` a `PersonView`'s `kind` in five places. Nothing
 * said so: no `typecheck` target in this repository compiled a test file until
 * 2026-09-02.
 *
 * Unlike {@link fakeApi}, which models the plan's **behaviour**, these are one
 * row's shape and nothing else: the defaults are the emptiest legal answer, so
 * a test states only the fields its case is about.
 */
export function workItemView(overrides: Partial<WorkItemView> = {}): WorkItemView {
  return {
    id: 'w1',
    parentId: null,
    revision: 0,
    number: '010',
    name: 'Rewire the shed',
    notes: '',
    frozenNumber: null,
    rolledUp: false,
    estimates: {},
    dependsOn: [],
    finalDays: {},
    finalTotal: 0,
    dates: null,
    startNoEarlierThan: null,
    startNoEarlierThanReason: null,
    deadline: null,
    priority: null,
    maxParallel: 1,
    teamIds: [],
    serviceTeamId: null,
    assignees: {},
    doesEveryStep: null,
    schedule: {
      duration: 0,
      estimated: false,
      earliestStart: 0,
      earliestFinish: 0,
      latestStart: 0,
      latestFinish: 0,
      float: 0,
      critical: false,
    },
    ...overrides,
  };
}

/** One scheduled slice, {@link workItemView}'s shape and for its reason. */
export function sliceView(overrides: Partial<SliceView> = {}): SliceView {
  return {
    id: 's1',
    workItemId: 'w1',
    stepId: null,
    personId: null,
    duration: 0,
    estimated: false,
    earliestStart: 0,
    earliestFinish: 0,
    latestStart: 0,
    latestFinish: 0,
    float: 0,
    critical: false,
    boundBy: 'projectStart',
    resourcePredecessorId: null,
    capacityTeamId: null,
    width: 1,
    effort: 0,
    capacityPredecessorIds: [],
    ...overrides,
  };
}

/**
 * One person in the directory.
 *
 * `kind` is stated rather than defaulted at the render, which is the whole
 * reason it is a required field of {@link PersonView} — see its JSDoc.
 */
export function personView(overrides: Partial<PersonView> = {}): PersonView {
  return { id: 'p1', name: 'Kat', kind: 'person', teamIds: [], ...overrides };
}

/**
 * One whole read of a plan — every field be-01 sends, at its emptiest.
 *
 * Five suites answer `tree()` from an inline fake, and each wrote this object
 * out; every one of them was missing `pertWeights`, `estimateRounding`,
 * `depReach` and more, added to {@link PlanRead} after the copies were made. A
 * fake that leaves a field out hands the table `undefined` where production
 * never does — which is why `teamCapacities: []` carries a comment in
 * `page-shortcuts.test.tsx` saying exactly that, three fields before the ones
 * that had gone missing.
 */
export function planRead(overrides: Partial<PlanRead> = {}): PlanRead {
  return {
    workItems: [],
    seq: 1,
    scheduleError: null,
    slices: [],
    steps: [],
    assignedPeople: [],
    teamCapacities: [],
    priorityBands: [],
    estimateMethod: 'pert',
    pertWeights: DEFAULT_PERT_WEIGHTS_VIEW,
    estimateRounding: 'ceil',
    depReach: 'whole-item',
    startDate: null,
    projectRevision: 0,
    undoable: false,
    redoable: false,
    ...overrides,
  };
}

/**
 * One row of the project picker's list.
 *
 * `ownerName`, `startDate` and `createdAt` were added to
 * {@link ProjectListEntry} after two suites wrote this literal out, and both
 * copies still lacked all three — a list entry production cannot produce.
 */
export function projectListEntry(overrides: Partial<ProjectListEntry> = {}): ProjectListEntry {
  return {
    id: 'p1',
    name: 'Rewire the shed',
    restricted: false,
    lastOpenedAt: null,
    ownerName: 'kat',
    startDate: null,
    createdAt: 1,
    ...overrides,
  };
}
