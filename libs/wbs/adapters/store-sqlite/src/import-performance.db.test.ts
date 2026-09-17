import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PlanDocumentRequest } from '@wbs/contracts';
import {
  clockOf,
  ImportService,
  prepareImport,
  servicesOver,
  type TransactionalStores,
  type UnitOfWork,
} from '@wbs/core';
import { recordingBroadcaster } from '@wbs/core/testing/broadcast-fixture';
import { planDocumentFixture } from '@wbs/core/testing/plan-document-fixture';
import { fastScheduler } from '@wbs/core/testing/scheduler-fixture';
import { expect, test } from 'bun:test';

import { buildStores } from './build-stores';
import { openConnection } from './db';
import { OPEN, WriteCoordinator } from './gate';
import { runMigrations } from './migrate';
import { sqliteUnitOfWork } from './sqlite-unit-of-work';

const ACTOR = 'import-owner';
const ROWS = 500;
const MIGRATIONS = new URL('../../../../../apps/wbs/be-01/drizzle', import.meta.url).pathname;

function measuredDocument(): PlanDocumentRequest {
  const document = planDocumentFixture();
  const template = document.workItems.at(0);
  if (template === undefined) throw new Error('plan document fixture has no work item');
  document.settings.name = '500-row import measurement';
  document.workItems = Array.from({ length: ROWS }, (_, at) => ({
    ...structuredClone(template),
    id: `row-${String(at + 1)}`,
    position: (at + 1) * 10,
    name: `Measured row ${String(at + 1)}`,
    externalRefs: template.externalRefs.map((reference) => ({
      ...reference,
      id: `external-ref-${String(at + 1)}`,
    })),
  }));
  return document;
}

test('measures preparation and admitted SQLite work separately for exactly 500 rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-import-measurement-'));
  const path = join(dir, 'source.db');
  runMigrations(path, MIGRATIONS);
  const statements: string[] = [];
  let nativeTransactions = 0;
  const connection = openConnection(
    path,
    {
      logQuery(query) {
        statements.push(query);
      },
    },
    () => {
      nativeTransactions += 1;
    },
  );
  try {
    const coordinator = new WriteCoordinator();
    const stores = buildStores(connection.db, coordinator);
    const admittedStores = buildStores(connection.db, OPEN);
    const sourceUow = sqliteUnitOfWork(connection.db, coordinator, admittedStores);
    const stamp = { at: 1_757_851_200_000, by: ACTOR };
    await stores.users.create(
      { id: ACTOR, username: ACTOR, passwordHash: 'x', createdAt: stamp.at },
      stamp,
    );
    statements.length = 0;
    nativeTransactions = 0;

    const document = measuredDocument();
    const encoded = JSON.stringify(document);
    const inputBytes = new TextEncoder().encode(encoded).byteLength;
    const prepareStatementStart = statements.length;
    const prepareNativeStart = nativeTransactions;
    const prepareStarted = performance.now();
    const preparation = prepareImport(document, fastScheduler);
    const prepareMs = performance.now() - prepareStarted;
    const prepareDrizzleStatements = statements.length - prepareStatementStart;
    const prepareNativeTransactions = nativeTransactions - prepareNativeStart;
    expect(preparation.ok).toBe(true);
    if (!preparation.ok) throw new Error(`measurement refused at ${preparation.path}`);
    expect(preparation.value.workItems).toHaveLength(ROWS);
    expect(prepareDrizzleStatements).toBe(0);
    expect(prepareNativeTransactions).toBe(0);

    let admittedStarted = 0;
    let admittedMs = 0;
    let queuedStarted = 0;
    let queuedCompleted = 0;
    let queuedWrite: Promise<{ id: string; name: string }> | undefined;
    const measuredUow: UnitOfWork<TransactionalStores> = {
      async run(act) {
        admittedStarted = performance.now();
        const settled = await sourceUow.run(async (scope) => {
          queuedStarted = performance.now();
          queuedWrite = stores.directory
            .addTag({ id: 'queued-tag', name: 'Queued ordinary write' }, stamp)
            .then((written) => {
              queuedCompleted = performance.now();
              return written;
            });
          return await act(scope);
        });
        admittedMs = performance.now() - admittedStarted;
        return settled;
      },
    };
    const clock = clockOf({ now: () => stamp.at, newId: () => crypto.randomUUID() });
    const announcements = recordingBroadcaster();
    const imports = new ImportService({
      clock,
      scheduler: fastScheduler,
      uow: measuredUow,
      announcements,
      batchServices: (scope, broadcast) =>
        servicesOver(scope.stores, { clock, broadcast, scheduler: fastScheduler }),
    });

    const outcome = await imports.import(document, ACTOR);
    if (queuedWrite === undefined) throw new Error('ordinary write was not queued during import');
    const queuedTag = await queuedWrite;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(`measurement import refused at ${outcome.path}`);
    expect(outcome.rows).toBe(ROWS);
    expect(await stores.workItems.listByProject(outcome.projectId)).toHaveLength(ROWS);
    expect(queuedTag.name).toBe('Queued ordinary write');
    expect(queuedCompleted).toBeGreaterThanOrEqual(admittedStarted + admittedMs);

    const normalized = statements.map((statement) => statement.trim().toUpperCase());
    const beginAt = normalized.indexOf('BEGIN IMMEDIATE');
    const commitAt = normalized.indexOf('COMMIT', beginAt + 1);
    const queuedAt = normalized.findIndex(
      (statement, at) => at > commitAt && statement.startsWith('INSERT INTO "TAG"'),
    );
    // Proof: ignoring openConnection's Drizzle logger made beginAt equal -1 and
    // this production-path measurement fail before it could report a fake zero.
    expect(beginAt).toBeGreaterThanOrEqual(0);
    expect(commitAt).toBeGreaterThan(beginAt);
    expect(queuedAt).toBeGreaterThan(commitAt);
    const drizzleStatements = commitAt - beginAt + 1;
    // One project, bands, capacity, marker, team patch, person insert and subtree
    // transaction, then one label patch per row: 7 + 500 nested transactions.
    // Proof: omitting the native transaction observer reported 0 instead of 507,
    // hiding its 1,014 SAVEPOINT/RELEASE controls from the admitted total.
    expect(nativeTransactions).toBe(507);
    const nativeControls = nativeTransactions * 2;
    const admittedStatements = drizzleStatements + nativeControls;

    console.log(
      JSON.stringify({
        measurement: 'plan-json-import-500',
        rows: document.workItems.length,
        inputBytes,
        prepareMs: Number(prepareMs.toFixed(3)),
        prepareStatements: {
          drizzle: prepareDrizzleStatements,
          nativeControls: prepareNativeTransactions * 2,
          total: prepareDrizzleStatements + prepareNativeTransactions * 2,
        },
        admittedMs: Number(admittedMs.toFixed(3)),
        admittedStatements: {
          drizzle: drizzleStatements,
          nativeTransactionWrappers: nativeTransactions,
          nativeControls,
          total: admittedStatements,
        },
        queuedWrite: {
          completed: queuedCompleted > 0,
          elapsedMs: Number((queuedCompleted - queuedStarted).toFixed(3)),
          completedAfterAdmission: queuedCompleted >= admittedStarted + admittedMs,
        },
      }),
    );
  } finally {
    connection.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
