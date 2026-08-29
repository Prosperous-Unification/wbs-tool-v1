import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { buildApp } from './app';
import { openConnection } from './repository/db';
import { probeSchema } from './repository/health-probe';
import { runMigrations } from './repository/migrate';
import { testAuthService } from './testing/auth-fixture';
import { testCapacityService } from './testing/capacity-fixture';
import { testDirectoryService } from './testing/directory-fixture';
import { testHistoryService } from './testing/history-fixture';
import { testPriorityBandService } from './testing/priority-band-fixture';
import { testProjectService } from './testing/project-fixture';
import { testReplay } from './testing/replay-fixture';
import { testRoleService } from './testing/role-fixture';
import { testWorkItemService } from './testing/work-item-fixture';
import { testWrites } from './testing/writes-fixture';

const TEST_SECRET = 'x'.repeat(32);

describe('GET /health', () => {
  it('returns 200 with status:"ok" when ready', async () => {
    const app = buildApp({
      directory: testDirectoryService(),
      capacity: testCapacityService(),
      priorityBands: testPriorityBandService(),
      history: testHistoryService(),
      auth: testAuthService(),
      projects: testProjectService(),
      workItems: testWorkItemService(),
      roles: testRoleService(),
      replay: testReplay().replay,
      probeDatabase: () => 'ok',
      internalAuthSecret: TEST_SECRET,
      writes: testWrites(),
      migrationsApplied: true,
    });
    const res = await app.handle(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('returns 503 while migrations still running', async () => {
    const app = buildApp({
      directory: testDirectoryService(),
      capacity: testCapacityService(),
      priorityBands: testPriorityBandService(),
      history: testHistoryService(),
      auth: testAuthService(),
      projects: testProjectService(),
      workItems: testWorkItemService(),
      roles: testRoleService(),
      replay: testReplay().replay,
      probeDatabase: () => 'ok',
      internalAuthSecret: TEST_SECRET,
      writes: testWrites(),
      migrationsApplied: false,
    });
    const res = await app.handle(new Request('http://localhost/health'));
    expect(res.status).toBe(503);
  });
});

describe('/health tells the truth about the database', () => {
  it('is unhealthy when the schema the app needs is not there', async () => {
    // Open finding 4: the endpoint trusted an in-memory boolean, so a container
    // pointed at the wrong `DB_PATH`, or one whose migrations never ran, passed
    // the deploy's health gate and started taking traffic it could not serve.
    const dir = mkdtempSync(join(tmpdir(), 'wbs-health-'));
    try {
      const { db, close } = openConnection(join(dir, 'empty.db'));
      const app = buildApp({
        directory: testDirectoryService(),
        capacity: testCapacityService(),
        priorityBands: testPriorityBandService(),
        history: testHistoryService(),
        auth: testAuthService(),
        projects: testProjectService(),
        workItems: testWorkItemService(),
        roles: testRoleService(),
        replay: testReplay().replay,
        internalAuthSecret: TEST_SECRET,
        writes: testWrites(),
        migrationsApplied: true,
        probeDatabase: () => probeSchema(db),
      });

      const res = await app.handle(new Request('http://localhost/health'));

      expect(res.status).toBe(503);
      expect((await res.json()) as { status: string }).toMatchObject({ status: 'schema_missing' });
      close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is healthy against a migrated database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wbs-health-'));
    try {
      const path = join(dir, 'real.db');
      runMigrations(path, new URL('../drizzle', import.meta.url).pathname);
      const { db, close } = openConnection(path);
      const app = buildApp({
        directory: testDirectoryService(),
        capacity: testCapacityService(),
        priorityBands: testPriorityBandService(),
        history: testHistoryService(),
        auth: testAuthService(),
        projects: testProjectService(),
        workItems: testWorkItemService(),
        roles: testRoleService(),
        replay: testReplay().replay,
        internalAuthSecret: TEST_SECRET,
        writes: testWrites(),
        migrationsApplied: true,
        probeDatabase: () => probeSchema(db),
      });

      const res = await app.handle(new Request('http://localhost/health'));

      expect(res.status).toBe(200);
      close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is unhealthy when the probe itself throws', async () => {
    const app = buildApp({
      directory: testDirectoryService(),
      capacity: testCapacityService(),
      priorityBands: testPriorityBandService(),
      history: testHistoryService(),
      auth: testAuthService(),
      projects: testProjectService(),
      workItems: testWorkItemService(),
      roles: testRoleService(),
      replay: testReplay().replay,
      internalAuthSecret: TEST_SECRET,
      writes: testWrites(),
      migrationsApplied: true,
      probeDatabase: () => {
        throw new Error('database is locked');
      },
    });

    const res = await app.handle(new Request('http://localhost/health'));

    expect(res.status).toBe(503);
    expect((await res.json()) as { status: string }).toMatchObject({
      status: 'database_unreachable',
    });
  });
});
