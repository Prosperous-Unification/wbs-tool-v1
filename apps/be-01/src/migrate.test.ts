import { describe, expect, it } from 'bun:test';

import { buildApp } from './app';
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

describe('migrate lifecycle', () => {
  it('exposes 503 before migrations complete then 200 after', async () => {
    const state = { migrationsApplied: false };
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
      internalAuthSecret: 'x'.repeat(32),
      writes: testWrites(),
      get migrationsApplied() {
        return state.migrationsApplied;
      },
    });

    const pre = await app.handle(new Request('http://localhost/health'));
    expect(pre.status).toBe(503);

    state.migrationsApplied = true;
    const post = await app.handle(new Request('http://localhost/health'));
    expect(post.status).toBe(200);
  });
});
