import { describe, expect, it } from 'bun:test';

import { buildApp } from '../app';
import { testAuthService } from '../testing/auth-fixture';
import { testCapacityService } from '../testing/capacity-fixture';
import { testDirectoryService } from '../testing/directory-fixture';
import { testHistoryService } from '../testing/history-fixture';
import { testPriorityBandService } from '../testing/priority-band-fixture';
import { testProjectService } from '../testing/project-fixture';
import { testReplay } from '../testing/replay-fixture';
import { testRoleService } from '../testing/role-fixture';
import { testWorkItemService } from '../testing/work-item-fixture';
import { testWrites } from '../testing/writes-fixture';

const SECRET = 'test-secret-must-be-32-chars-at-least-!';

function buildHarness() {
  const { log, buffer, replay } = testReplay();
  const app = buildApp({
    directory: testDirectoryService(),
    capacity: testCapacityService(),
    priorityBands: testPriorityBandService(),
    history: testHistoryService(),
    auth: testAuthService(),
    projects: testProjectService(),
    workItems: testWorkItemService(),
    roles: testRoleService(),
    writes: testWrites(),
    migrationsApplied: true,
    internalAuthSecret: SECRET,
    replay,
    probeDatabase: () => 'ok',
  });

  function post(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return app.handle(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    );
  }

  const authed = { 'x-internal-auth': SECRET, 'x-client-id': 'u-1', 'x-connection-id': 'c-1' };
  return { log, buffer, post, authed };
}

describe('POST /internal/forward', () => {
  it('rejects without X-Internal-Auth', async () => {
    const { post } = buildHarness();
    const res = await post('/internal/forward', { message: { type: 'ping' }, trace_id: 't' });
    expect(res.status).toBe(401);
  });

  it('acks with auth + valid body', async () => {
    const { post, authed } = buildHarness();
    const res = await post(
      '/internal/forward',
      { message: { type: 'ping' }, trace_id: 't-1' },
      authed,
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { ack: boolean }).toMatchObject({ ack: true });
  });

  it('records no event and pushes nothing', async () => {
    // The ack is deliberate, not a stub: every mutation in this product is an
    // HTTP call, so a message arriving over the socket has nothing to change.
    // This is what stops the ack drifting into a silent write path.
    const { post, authed, log } = buildHarness();

    await post('/internal/forward', { message: { type: 'ping' }, trace_id: 't-1' }, authed);

    expect(await log.latestSeq('project:anything')).toBe(-1);
  });

  it('returns 400 on missing trace_id', async () => {
    const { post, authed } = buildHarness();
    const res = await post('/internal/forward', { message: { type: 'ping' } }, authed);
    expect(res.status).toBe(400);
  });
});

describe('POST /internal/resume', () => {
  it('replays the recorded events after the requested sequence', async () => {
    const { post, authed, log } = buildHarness();
    await log.record('project:a', { type: 'tree_replaced', workItems: [] });
    await log.record('project:a', { type: 'work_items_changed', workItems: [] });

    const res = await post(
      '/internal/resume',
      { resume_points: { 'project:a': 0 }, trace_id: 't-1' },
      authed,
    );

    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({
      'project:a': {
        status: 'replaying',
        events: [{ seq: 1, message: { type: 'work_items_changed', workItems: [] } }],
      },
    });
  });

  it('denies a subscription it cannot serve from the start requested', async () => {
    // The stub this replaced answered `replaying` for every subscription, which
    // is what a client with a sequence the server has never issued would have
    // been told — silently, and forever.
    const { post, authed } = buildHarness();

    const res = await post(
      '/internal/resume',
      { resume_points: { 'project:never-seen': 4 }, trace_id: 't-1' },
      authed,
    );

    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({
      'project:never-seen': { status: 'denied', reason: 'out_of_range' },
    });
  });

  it('rejects without X-Internal-Auth', async () => {
    const { post } = buildHarness();
    const res = await post('/internal/resume', { resume_points: {}, trace_id: 't' });
    expect(res.status).toBe(401);
  });
});
