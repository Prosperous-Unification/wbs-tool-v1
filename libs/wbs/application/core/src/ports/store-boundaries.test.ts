import { describe, expect, it } from 'bun:test';

import type { EventLogStore, RecordedEvent } from './event-log-store';
import type { PlanInputReads, SavedPlanCaptureStore } from './saved-plan-capture-store';
import type { SavedPlanRow, SavedPlanStore } from './saved-plan-store';

function replayFrom(store: EventLogStore): Promise<readonly RecordedEvent[]> {
  return store.rangeSince('project:p1', -1);
}

describe('store ports', () => {
  it('admits an event-log consumer without a SQLite transaction method', async () => {
    const event: RecordedEvent = {
      subscription: 'project:p1',
      seq: 0,
      message: { type: 'project_changed' },
      createdAt: 1,
    };
    const store: EventLogStore = {
      recordEvent: () => Promise.resolve(event),
      rangeSince: () => Promise.resolve([event]),
      oldestSeq: () => Promise.resolve(0),
      latestSeq: () => Promise.resolve(0),
      pruneBeyond: () => Promise.resolve(0),
    };

    expect(await replayFrom(store)).toEqual([event]);
  });

  it('admits a saved-plan consumer without transaction-only helpers', async () => {
    const row: SavedPlanRow = {
      id: 'saved-1',
      projectId: 'project-1',
      name: 'Plan',
      createdBy: 'Ada',
      createdById: 'user-1',
      createdAt: 1,
      inputSchemaVersion: 1,
      inputBytes: 2,
      inputSha256: 'input',
      scheduleSchemaVersion: null,
      scheduleBytes: null,
      scheduleSha256: null,
      scheduleInputSha256: null,
      schedulerAlgorithmId: null,
      scheduleAbsentReason: 'pending',
    };
    const store: SavedPlanStore = {
      write: () => Promise.resolve({ outcome: 'written' }),
      readOf: () => Promise.resolve(null),
      listOf: () => Promise.resolve([row]),
      principalsOf: () => Promise.resolve(null),
      renameTo: () => Promise.resolve('touched'),
      deleteOf: () => Promise.resolve('touched'),
    };

    expect(await store.listOf('project-1')).toEqual([row]);
  });

  it('admits a capture consumer without a repository class', async () => {
    const reads: PlanInputReads = {
      project: {
        id: 'project-1',
        name: 'Plan',
        ownerId: 'user-1',
        restricted: false,
        estimateMethod: 'pert',
        depReach: 'whole-item',
        pertWeights: { optimistic: 1, realistic: 4, pessimistic: 1 },
        estimateRounding: 'ceil',
        startDate: null,
        scheduleEngine: 'fast',
        scheduleObjective: 'pri',
        optimizationEnabled: false,
        solutionRef: null,
      },
      steps: [],
      workItems: [],
      estimates: [],
      actuals: [],
      progress: [],
      measures: [],
      dependencies: [],
      assignments: [],
      capacity: new Map(),
      priorityBands: [],
      people: [],
      teams: [],
      services: [],
      tags: [],
      workItemTypes: [],
      externalSystems: [],
    };
    const capture: SavedPlanCaptureStore = {
      readPlanInput: () => Promise.resolve(reads),
    };

    expect(await capture.readPlanInput('project-1')).toBe(reads);
  });
});
