import type { TransactionalStores, WriteStamp } from '@wbs/core';
import { workItemRow } from '@wbs/core/testing/work-item-fixture';
import { afterEach, describe, expect, it } from 'bun:test';

import { projectRow } from './project-fixture';
import { openMemorySource } from './source';

const OWNER = 'targeted-memory-owner';
const PROJECT_A = 'targeted-memory-a';
const PROJECT_B = 'targeted-memory-b';
const STEP_A = 'targeted-memory-step-a';
const STEP_B = 'targeted-memory-step-b';
const ROW_A = 'targeted-memory-row-a';
const ROW_B = 'targeted-memory-row-b';
const STAMP: WriteStamp = { at: 1, by: OWNER };

let source: ReturnType<typeof openMemorySource> | undefined;

afterEach(async () => {
  await source?.close();
  source = undefined;
});

async function openSeededStores(): Promise<TransactionalStores> {
  source = openMemorySource();
  const stores = source.stores;
  await stores.users.create({ id: OWNER, username: OWNER, passwordHash: 'x', createdAt: 1 }, STAMP);
  await stores.projects.create(
    projectRow({ id: PROJECT_A, ownerId: OWNER }),
    [{ id: STEP_A, projectId: PROJECT_A, name: 'A', position: 10 }],
    STAMP,
  );
  await stores.projects.create(
    projectRow({ id: PROJECT_B, ownerId: OWNER }),
    [{ id: STEP_B, projectId: PROJECT_B, name: 'B', position: 10 }],
    STAMP,
  );
  await stores.steps.add({ id: STEP_A, projectId: PROJECT_A, name: 'A' }, STAMP);
  await stores.steps.add({ id: STEP_B, projectId: PROJECT_B, name: 'B' }, STAMP);
  await stores.workItems.insert(workItemRow({ id: ROW_A, projectId: PROJECT_A }), [], STAMP);
  await stores.workItems.insert(workItemRow({ id: ROW_B, projectId: PROJECT_B }), [], STAMP);
  return stores;
}

async function seedAll(
  stores: TransactionalStores,
  workItemId: string,
  stepId: string,
): Promise<void> {
  await stores.estimates.set(
    { workItemId, stepId, optimistic: 1, realistic: 2, pessimistic: 3 },
    STAMP,
  );
  await stores.actuals.set({ workItemId, stepId, days: 1, recordedAt: 1 }, STAMP);
  await stores.progress.set({ workItemId, stepId, state: 'in_progress', statedAt: 1 }, STAMP);
  await stores.measures.set(
    { workItemId, stepId, metric: 'token_estimate', value: 1, recordedAt: 1 },
    STAMP,
  );
}

function expectReferenceRejections(
  stores: TransactionalStores,
  projectId: string,
  workItemId: string,
  pattern: RegExp,
): void {
  expect(stores.estimates.listByWorkItems(projectId, [workItemId])).rejects.toThrow(pattern);
  expect(stores.actuals.listByWorkItems(projectId, [workItemId])).rejects.toThrow(pattern);
  expect(stores.progress.listByWorkItems(projectId, [workItemId])).rejects.toThrow(pattern);
  expect(stores.measures.listByWorkItems(projectId, [workItemId])).rejects.toThrow(pattern);
}

describe('targeted memory readers reject malformed trusted state', () => {
  it('names a missing work-item reference in all four satellite families', async () => {
    const stores = await openSeededStores();
    await seedAll(stores, 'missing-work-item', STEP_A);

    // Proof: joining through listByIds filtered every malformed row to an empty answer.
    expectReferenceRejections(
      stores,
      PROJECT_A,
      'missing-work-item',
      /invalid work-item reference/,
    );
  });

  it('filters a valid cross-project work-item in all four satellite families', async () => {
    const stores = await openSeededStores();
    await seedAll(stores, ROW_B, STEP_B);

    // Proof: validating ownership before filtering threw for each valid project-B row.
    expect(await stores.estimates.listByWorkItems(PROJECT_A, [ROW_B])).toEqual([]);
    expect(await stores.actuals.listByWorkItems(PROJECT_A, [ROW_B])).toEqual([]);
    expect(await stores.progress.listByWorkItems(PROJECT_A, [ROW_B])).toEqual([]);
    expect(await stores.measures.listByWorkItems(PROJECT_A, [ROW_B])).toEqual([]);
  });

  it('names a cross-project step in all four satellite families', async () => {
    const stores = await openSeededStores();
    await seedAll(stores, ROW_A, STEP_B);

    // Proof: the ordering fallback treated an absent project step as position zero.
    expectReferenceRejections(stores, PROJECT_A, ROW_A, /invalid step reference/);
  });

  it('names a missing step in all four satellite families', async () => {
    const stores = await openSeededStores();
    await seedAll(stores, ROW_A, 'missing-step');

    // Proof: the ordering fallback treated a missing stored step as position zero.
    expectReferenceRejections(stores, PROJECT_A, ROW_A, /invalid step reference/);
  });

  it('rejects invalid values and timestamps in each satellite shape', async () => {
    const stores = await openSeededStores();
    await stores.estimates.set(
      { workItemId: ROW_A, stepId: STEP_A, optimistic: Number.NaN, realistic: 2, pessimistic: 3 },
      STAMP,
    );
    await stores.actuals.set(
      { workItemId: ROW_A, stepId: STEP_A, days: Number.NaN, recordedAt: 1 },
      STAMP,
    );
    await stores.progress.set(
      // This test crosses the trusted-state boundary with a deliberately malformed stored value.
      { workItemId: ROW_A, stepId: STEP_A, state: 'broken', statedAt: 1 } as never,
      STAMP,
    );
    await stores.measures.set(
      // This test crosses the trusted-state boundary with a deliberately malformed stored value.
      { workItemId: ROW_A, stepId: STEP_A, metric: 'broken', value: 1, recordedAt: 1 } as never,
      STAMP,
    );

    // Proof: without the four family validators these malformed stored values all resolved.
    expect(stores.estimates.listByWorkItems(PROJECT_A, [ROW_A])).rejects.toThrow(
      /invalid day value/,
    );
    expect(stores.actuals.listByWorkItems(PROJECT_A, [ROW_A])).rejects.toThrow(/invalid day value/);
    expect(stores.progress.listByWorkItems(PROJECT_A, [ROW_A])).rejects.toThrow(/invalid state/);
    expect(stores.measures.listByWorkItems(PROJECT_A, [ROW_A])).rejects.toThrow(/invalid metric/);
    // This test crosses the trusted-state boundary to remove the malformed composite key.
    await stores.measures.remove(ROW_A, STEP_A, 'broken' as never, STAMP);

    await stores.actuals.set(
      { workItemId: ROW_A, stepId: STEP_A, days: 1, recordedAt: Number.POSITIVE_INFINITY },
      STAMP,
    );
    await stores.progress.set(
      { workItemId: ROW_A, stepId: STEP_A, state: 'done', statedAt: Number.NEGATIVE_INFINITY },
      STAMP,
    );
    await stores.measures.set(
      {
        workItemId: ROW_A,
        stepId: STEP_A,
        metric: 'token_actual',
        value: Number.NaN,
        recordedAt: 1,
      },
      STAMP,
    );
    // Proof: without finite-time/value validation these three targeted reads all resolved.
    expect(stores.actuals.listByWorkItems(PROJECT_A, [ROW_A])).rejects.toThrow(
      /invalid recorded time/,
    );
    expect(stores.progress.listByWorkItems(PROJECT_A, [ROW_A])).rejects.toThrow(
      /invalid stated time/,
    );
    expect(stores.measures.listByWorkItems(PROJECT_A, [ROW_A])).rejects.toThrow(/invalid value/);

    await stores.measures.set(
      {
        workItemId: ROW_A,
        stepId: STEP_A,
        metric: 'token_actual',
        value: 1,
        recordedAt: Number.POSITIVE_INFINITY,
      },
      STAMP,
    );
    // Proof: without the measure timestamp check this non-finite stored time resolved.
    expect(stores.measures.listByWorkItems(PROJECT_A, [ROW_A])).rejects.toThrow(
      /invalid recorded time/,
    );
  });
});
