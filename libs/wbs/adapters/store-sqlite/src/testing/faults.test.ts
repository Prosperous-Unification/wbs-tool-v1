import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineFault, recordFaultProof } from '@wbs/conformance';
import type { NewJournalEntry, PlanEvent, SavedPlanWrite, SubtreeCopy } from '@wbs/core';
import { workItemRow } from '@wbs/core/testing/work-item-fixture';
import { projectRow } from '@wbs/store-memory/project-fixture';
import { describe, expect, it } from 'bun:test';

import * as publicSqlite from '../index';
import { runMigrations } from '../migrate';
import { openSqliteSourceWithFault, sqliteLateWriteControl } from './faults';

const MIGRATIONS = new URL('../../../../apps/be-01/drizzle', import.meta.url).pathname;
const stamp = { at: 1, by: 'owner' };
const entry = (id: string): NewJournalEntry => ({
  id,
  projectId: 'p1',
  userId: 'owner',
  kind: 'estimate',
  payload: {},
  inverse: {},
  preconditions: {},
  createdAt: 1,
});
const event = (id: string): PlanEvent => ({
  id: `event-${id}`,
  projectId: 'p1',
  userId: 'owner',
  kind: 'estimate',
  label: id,
  workItemId: null,
  stepId: null,
  before: null,
  after: null,
  createdAt: 1,
});
const savedPlan = (id: string): SavedPlanWrite => ({
  id,
  projectId: 'p1',
  name: id,
  createdBy: 'Owner',
  createdById: 'owner',
  createdAt: 1,
  input: { schemaVersion: 1, bytes: 'input', sha256: 'input-hash' },
  schedule: {
    present: true,
    body: { schemaVersion: 1, bytes: 'schedule', sha256: 'schedule-hash' },
    inputSha256: 'input-hash',
    algorithmId: 'test',
  },
});
const subtree = (id: string): SubtreeCopy => ({
  rows: [workItemRow({ id, projectId: 'p1' })],
  respaced: [],
  reparented: [],
  estimates: [{ workItemId: id, stepId: 'step-1', optimistic: 1, realistic: 2, pessimistic: 3 }],
  actuals: [],
  progress: [],
  measures: [],
  assignments: [],
  dependencies: [],
  removedEstimates: [],
  removedActuals: [],
  removedProgress: [],
  removedMeasures: [],
});

function productionConstructionCannotDisableSubtreeAtomicity(
  db: Parameters<typeof publicSqlite.buildStores>[0],
): void {
  // @ts-expect-error the ordinary catalog has no subtree atomicity argument
  publicSqlite.buildStores(db, publicSqlite.OPEN, undefined, false);
  // @ts-expect-error the ordinary repository has no subtree atomicity argument
  new publicSqlite.SubtreeRepository(db, publicSqlite.OPEN, undefined, false);
}

describe('SQLite conformance fault controls', () => {
  it('keeps the non-atomic subtree mutant outside the ordinary public barrel', () => {
    expect(typeof productionConstructionCannotDisableSubtreeAtomicity).toBe('function');
    // Proof: exporting the mutant factory from index changed this to true and
    // let ordinary adapter imports opt out of subtree transactions.
    expect('createNonAtomicSubtreeMutantForTesting' in publicSqlite).toBe(false);
  });
  it('arms a named transaction write point per run', () => {
    const control = sqliteLateWriteControl('saved-plan-schedule-body');

    // Proof: removing the arm guard failed here on `Expected: false; Received: true`.
    expect(control.reachTransactionWrite('saved-plan-schedule-body')).toBe(false);
    control.arm();

    expect(control.reachTransactionWrite('saved-plan-schedule-body')).toBe(true);
    expect(control.reached()).toBe(true);
    // Proof: removing the one-shot guard let this second arm return undefined.
    expect(() => {
      control.arm();
    }).toThrow('already armed');
  });

  it('does not accept a different transaction phase', () => {
    const control = sqliteLateWriteControl<'journal-history-insert' | 'saved-plan-schedule-body'>(
      'saved-plan-schedule-body',
    );
    control.arm();

    // Proof: ignoring phase identity returned true for journal-history-insert.
    expect(control.reachTransactionWrite('journal-history-insert')).toBe(false);
    expect(control.reached()).toBe(false);
  });

  it('reports a different transaction phase through the proof recorder', async () => {
    const fault = defineFault({
      id: 'break:savedPlans.write:late-body-failure:saved-plan-split-write',
      caseId: 'savedPlans.write:late-body-failure',
      createControl: () =>
        sqliteLateWriteControl<'journal-history-insert' | 'saved-plan-schedule-body'>(
          'saved-plan-schedule-body',
        ),
      mutate: (subject: object) => subject,
    });
    const proof = await recordFaultProof(fault, {
      assertion: 'saved-plan bodies remain atomic',
      setup: (run) => Promise.resolve(run),
      exercise: (run) => {
        run.control.reachTransactionWrite('journal-history-insert');
        return Promise.resolve();
      },
      assert: () => Promise.reject(new Error('unrelated journal assertion')),
    });

    // Proof: ignoring phase identity returned `observed` from the unrelated
    // journal assertion through the production proof recorder.
    expect(proof.kind).toBe('phase-failed');
  });

  it('reaches a journal late write inside the real SQLite transaction', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sqlite-fault-'));
    const dbPath = join(directory, 'source.db');
    runMigrations(dbPath, MIGRATIONS);
    const control = sqliteLateWriteControl('journal-history-insert');
    const source = openSqliteSourceWithFault({ dbPath }, control);
    try {
      await source.stores.users.create(
        { id: 'owner', username: 'owner', passwordHash: 'x', createdAt: 1 },
        stamp,
      );
      await source.stores.projects.create(
        projectRow({ id: 'p1', ownerId: 'owner' }),
        [{ id: 'step-1', projectId: 'p1', name: 'Dev', position: 10 }],
        stamp,
      );
      await source.stores.journal.append(entry('sentinel'), event('sentinel'));
      control.arm();

      const write = source.stores.journal.append(entry('faulted'), event('faulted'));
      // Proof: disconnecting this transaction seam resolved the write instead of rejecting.
      expect(write).rejects.toThrow('injected SQLite fault at journal-history-insert');
      await write.catch(() => undefined);

      expect(control.reached()).toBe(true);
      // Proof: moving the barrier after the transaction added `faulted` here.
      expect((await source.stores.journal.entriesFor('p1', 'owner')).map(({ id }) => id)).toEqual([
        'sentinel',
      ]);
      expect((await source.stores.planEvents.listFor('p1', {})).map(({ id }) => id)).toEqual([
        'event-sentinel',
      ]);
      const restored = openSqliteSourceWithFault(
        { dbPath },
        sqliteLateWriteControl('journal-history-insert'),
      );
      await restored.stores.journal.append(entry('restored'), event('restored'));
      expect((await restored.stores.journal.entriesFor('p1', 'owner')).map(({ id }) => id)).toEqual(
        ['sentinel', 'restored'],
      );
      await restored.close();
    } finally {
      await source.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reaches the final subtree write inside the real SQLite transaction', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sqlite-fault-'));
    const dbPath = join(directory, 'source.db');
    runMigrations(dbPath, MIGRATIONS);
    const control = sqliteLateWriteControl('subtree-final-satellite');
    const source = openSqliteSourceWithFault({ dbPath }, control);
    try {
      await source.stores.users.create(
        { id: 'owner', username: 'owner', passwordHash: 'x', createdAt: 1 },
        stamp,
      );
      await source.stores.projects.create(
        projectRow({ id: 'p1', ownerId: 'owner' }),
        [{ id: 'step-1', projectId: 'p1', name: 'Dev', position: 10 }],
        stamp,
      );
      await source.stores.subtrees.insertSubtree(subtree('sentinel'), stamp);
      expect(await source.stores.estimates.listByProject('p1')).toEqual([
        ...subtree('sentinel').estimates,
      ]);
      control.arm();

      const write = source.stores.subtrees.insertSubtree(subtree('faulted'), stamp);
      // Proof: disconnecting this transaction seam resolved the write instead of rejecting.
      expect(write).rejects.toThrow('injected SQLite fault at subtree-final-satellite');
      await write.catch(() => undefined);

      expect(control.reached()).toBe(true);
      // Proof: moving the barrier before the estimate write returned [] here.
      expect(control.observedSatelliteKeys()).toEqual(['faulted:step-1']);
      // Proof: moving the barrier after the transaction added `faulted` here.
      expect((await source.stores.workItems.listByProject('p1')).map(({ id }) => id)).toEqual([
        'sentinel',
      ]);
      expect(await source.stores.estimates.listByProject('p1')).toEqual([
        ...subtree('sentinel').estimates,
      ]);
      const restored = openSqliteSourceWithFault(
        { dbPath },
        sqliteLateWriteControl('subtree-final-satellite'),
      );
      await restored.stores.subtrees.insertSubtree(subtree('restored'), stamp);
      expect((await restored.stores.workItems.listByProject('p1')).map(({ id }) => id)).toEqual([
        'restored',
        'sentinel',
      ]);
      expect(await restored.stores.estimates.listByProject('p1')).toEqual([
        ...subtree('restored').estimates,
        ...subtree('sentinel').estimates,
      ]);
      await restored.close();
    } finally {
      await source.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reaches the schedule body inside the real SQLite saved-plan transaction', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sqlite-fault-'));
    const dbPath = join(directory, 'source.db');
    runMigrations(dbPath, MIGRATIONS);
    const control = sqliteLateWriteControl('saved-plan-schedule-body');
    const source = openSqliteSourceWithFault({ dbPath }, control);
    try {
      await source.stores.users.create(
        { id: 'owner', username: 'owner', passwordHash: 'x', createdAt: 1 },
        stamp,
      );
      await source.stores.projects.create(projectRow({ id: 'p1', ownerId: 'owner' }), [], stamp);
      await source.history.savedPlans.write(savedPlan('sentinel'), () => Promise.resolve(null));
      control.arm();

      const write = source.history.savedPlans.write(savedPlan('faulted'), () =>
        Promise.resolve(null),
      );
      // Proof: disconnecting this saved-plan transaction seam resolved instead of rejecting.
      expect(write).rejects.toThrow('injected SQLite fault at saved-plan-schedule-body');
      await write.catch(() => undefined);

      expect(control.reached()).toBe(true);
      // Proof: committing before the barrier added `faulted` to this list.
      expect((await source.history.savedPlans.listOf('p1')).map(({ id }) => id)).toEqual([
        'sentinel',
      ]);
      const restored = openSqliteSourceWithFault(
        { dbPath },
        sqliteLateWriteControl('saved-plan-schedule-body'),
      );
      await restored.history.savedPlans.write(savedPlan('restored'), () => Promise.resolve(null));
      expect((await restored.history.savedPlans.listOf('p1')).map(({ id }) => id)).toEqual([
        'restored',
        'sentinel',
      ]);
      await restored.close();
    } finally {
      await source.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
