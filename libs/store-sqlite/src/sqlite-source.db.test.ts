import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sourceConformance, type SourceUnderTest } from '@wbs/conformance';
import { ProjectService } from '@wbs/core';
import { recordingBroadcaster } from '@wbs/core/testing/broadcast-fixture';
import { testClock } from '@wbs/core/testing/clock-fixture';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildStores } from './build-stores';
import { openConnection } from './db';
import { OPEN } from './gate';
import { runMigrations } from './migrate';

const FOLDER = new URL('../../../apps/be-01/drizzle', import.meta.url).pathname;

/**
 * The SQLite source under the kits, opened fresh per case.
 *
 * One connection per case rather than one per file: the kit's cases write, and
 * a case reading rows another case wrote would be asserting about an order
 * nobody declared. `runMigrations` is the cost of that, and it is small.
 */
let dirs: string[] = [];
let latest: SourceUnderTest | null = null;

const open = (): SourceUnderTest => {
  const held = latest;
  if (held === null) throw new Error('the source was read before it was opened');
  return held;
};

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-sqlite-source-'));
  dirs.push(dir);
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  const connection = openConnection(path);
  // Over `OPEN`: the kit is one caller at a time, so there is no turn to take
  // and taking one would only add a microtask to every case.
  const stores = buildStores(connection.db, OPEN);
  const ownerId = crypto.randomUUID();
  const stamp = { at: 1, by: ownerId };
  await stores.users.create(
    { id: ownerId, username: 'owner', passwordHash: 'x', createdAt: 1 },
    stamp,
  );
  const created = await new ProjectService({
    clock: testClock,
    projects: stores.projects,
    broadcast: recordingBroadcaster(),
  }).create('Rewire the shed', ownerId);
  const stepId = created.steps.at(0)?.id;
  if (stepId === undefined) throw new Error('the project was created without its starting steps');
  latest = { stores, projectId: created.project.id, ownerId, stamp, stepId };
});

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  latest = null;
});

const report = sourceConformance({ name: 'SQLite' }, open);

describe('the SQLite source is certified for every port it has', () => {
  it('runs every case, and skips none', () => {
    // The source the product runs on offers everything, so a skip here is a
    // regression rather than a lag: D29's allowance is the **memory** source's.
    // Proof: `'estimates.set:unknown_step'` added to this source's `notOffered`
    // failed this on `Expected: [] · Received: [ "estimates.set:unknown_step" ]`,
    // and `bun test` printed the case as skipped by name. Watched 2026-09-08.
    expect(report.skipped).toEqual([]);
    expect(report.ran.length).toBeGreaterThan(0);
  });
});
