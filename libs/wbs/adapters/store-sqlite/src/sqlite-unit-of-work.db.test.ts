import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { unitOfWorkConformance, type UnitOfWorkFixture } from '@wbs/conformance';
import { ProjectService } from '@wbs/core';
import { recordingBroadcaster } from '@wbs/core/testing/broadcast-fixture';
import { testClock } from '@wbs/core/testing/clock-fixture';
import { afterEach, beforeEach, describe } from 'bun:test';

import { buildStores } from './build-stores';
import { openDrizzle } from './db';
import { OPEN, WriteCoordinator } from './gate';
import { runMigrations } from './migrate';
import { sqliteUnitOfWork } from './sqlite-unit-of-work';

const FOLDER = new URL('../../../apps/be-01/drizzle', import.meta.url).pathname;

let dir: string;
let fixture: UnitOfWorkFixture;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-uow-'));
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  const db = openDrizzle(path);
  const coordinator = new WriteCoordinator();
  // The composition the source makes: public stores over the coordinator, the
  // batch's over `OPEN` because `run` holds the turn for them.
  const publicStores = buildStores(db, coordinator);
  const admitted = buildStores(db, OPEN);

  const ownerId = crypto.randomUUID();
  const stamp = { at: 1, by: ownerId };
  await publicStores.users.create(
    { id: ownerId, username: 'owner', passwordHash: 'x', createdAt: 1 },
    stamp,
  );
  // Through the service, so the row this writes is the row production writes —
  // `NewProject` carries nine fields a literal here would have to keep in step.
  const created = await new ProjectService({
    clock: testClock,
    projects: publicStores.projects,
    broadcast: recordingBroadcaster(),
  }).create('Rewire the shed', ownerId);

  fixture = {
    uow: sqliteUnitOfWork(db, coordinator, admitted),
    // Read through the **public** stores, on the same connection: what the kit
    // asks is what a later request would see, not what the act believes.
    reader: publicStores,
    projectId: created.project.id,
    stamp,
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the SQLite unit of work', () => {
  unitOfWorkConformance(() => fixture);
});
