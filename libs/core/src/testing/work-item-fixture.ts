import { POSITION_STEP } from '@wbs/domain';

import type { LabelledWorkItem, WorkItem } from '../index';

/**
 * A `WorkItem` row carrying every field the schema requires.
 *
 * Nine suites built this row by hand and four of them predate
 * `startNoEarlierThanReason`, which nothing noticed: no `typecheck` target in
 * this repository compiled a test file until 2026-09-02. `position` is
 * `POSITION_STEP`, where `placeSibling` puts a first child, so a row this
 * builds and a row production writes sort alike.
 */
export function workItemRow(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: crypto.randomUUID(),
    projectId: 'project',
    parentId: null,
    position: POSITION_STEP,
    name: 'Rewire the shed',
    notes: '',
    frozenNumber: null,
    startNoEarlierThan: null,
    startNoEarlierThanReason: null,
    deadline: null,
    priority: null,
    serviceTeamId: null,
    serviceId: null,
    maxParallel: 1,
    revision: 0,
    ...overrides,
  };
}

/**
 * A `LabelledWorkItem`: the row plus every label dimension a read answers.
 *
 * The labels default to empty, which is _unstated_ — the state that inherits —
 * rather than "deliberately none"; see `effectiveTeamsOf` in `@wbs/domain` for
 * the walk that distinction drives.
 */
export function labelledRow(overrides: Partial<LabelledWorkItem> = {}): LabelledWorkItem {
  return {
    ...workItemRow(),
    teamIds: [],
    tagIds: [],
    serviceIds: [],
    typeIds: [],
    externalRefs: [],
    ...overrides,
  };
}
