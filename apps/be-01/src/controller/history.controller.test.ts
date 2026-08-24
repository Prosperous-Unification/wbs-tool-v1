import { beforeEach, describe, expect, it } from 'bun:test';

import { buildApp } from '../app';
import type { PlanEvent, Project, ProjectStore } from '../repository';
import { inMemoryUsers, testAuthService } from '../testing/auth-fixture';
import { testCapacityService } from '../testing/capacity-fixture';
import { testDirectoryService } from '../testing/directory-fixture';
import { inMemoryPlanEvents, testHistoryService } from '../testing/history-fixture';
import { testPriorityBandService } from '../testing/priority-band-fixture';
import { inMemoryProjects, testProjectService } from '../testing/project-fixture';
import { testReplay } from '../testing/replay-fixture';
import { testRoleService } from '../testing/role-fixture';
import { testWorkItemService } from '../testing/work-item-fixture';

const PROJECT = 'p1';

function event(id: string, over: Partial<PlanEvent> = {}): PlanEvent {
  return {
    id,
    projectId: PROJECT,
    userId: 'owner',
    kind: 'estimate',
    label: `estimate ${id}`,
    workItemId: 'w1',
    roleId: 'r1',
    before: { do: 'clear_estimate', workItemId: 'w1', roleId: 'r1' },
    after: { do: 'set_estimate', workItemId: 'w1', roleId: 'r1', days: { o: 1, r: 2, p: 3 } },
    createdAt: 1_000,
    ...over,
  };
}

/**
 * `GET /api/projects/:id/history`.
 *
 * The filter parsing is the whole of this route's own behaviour — the read is the
 * store's and the absent-project answer is the service's — so that is what these
 * cases are about, plus the two answers a client branches on.
 */
describe('one plan’s history, over HTTP', () => {
  let app: ReturnType<typeof buildApp>;
  let projects: ProjectStore;
  let token: string;

  beforeEach(async () => {
    const users = inMemoryUsers();
    const auth = testAuthService(users);
    projects = inMemoryProjects(users);
    const project: Project = {
      id: PROJECT,
      name: 'Rewire the shed',
      ownerId: 'owner',
      restricted: false,
      estimateMethod: 'pert',
      startDate: null,
      revision: 0,
      createdAt: 1,
    };
    await projects.create(project, []);
    const events = inMemoryPlanEvents([
      event('set', { createdAt: 1_000 }),
      event('cleared', { kind: 'clear_estimate', createdAt: 2_000 }),
      event('renamed', { kind: 'patch', workItemId: 'w2', roleId: null, createdAt: 3_000 }),
      event('frozen', { kind: 'freeze', workItemId: null, roleId: null, createdAt: 4_000 }),
    ]);
    app = buildApp({
      auth,
      projects: testProjectService(projects),
      roles: testRoleService(),
      workItems: testWorkItemService(),
      directory: testDirectoryService(),
      capacity: testCapacityService(),
      priorityBands: testPriorityBandService(),
      history: testHistoryService(projects, events),
      replay: testReplay().replay,
      probeDatabase: () => 'ok',
      internalAuthSecret: 'x'.repeat(32),
      migrationsApplied: true,
    });
    // Registered through the route, so the account the token names is the one
    // `userFromHeaders` resolves — the harness `project.controller.test.ts` uses,
    // and for its reason.
    const registered = await app.handle(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: 'correct-horse' }),
      }),
    );
    token = ((await registered.json()) as { token: string }).token;
  });

  async function get(query: string, withToken = token) {
    const response = await app.handle(
      new Request(`http://localhost/api/projects/${PROJECT}/history${query}`, {
        headers: withToken === '' ? {} : { authorization: `Bearer ${withToken}` },
      }),
    );
    return { status: response.status, body: (await response.json()) as { events?: PlanEvent[] } };
  }

  it('answers the whole history, newest first', async () => {
    const { status, body } = await get('');
    expect(status).toBe(200);
    expect(body.events?.map((each) => each.id)).toEqual(['frozen', 'renamed', 'cleared', 'set']);
  });

  it('narrows to one work item when asked', async () => {
    const { body } = await get('?workItemId=w1');
    expect(body.events?.map((each) => each.id)).toEqual(['cleared', 'set']);
  });

  it('takes a comma-separated list of kinds, which is the estimate history in one request', async () => {
    // Dany's sentence, as one request: `?kind=estimate,clear_estimate`. Two
    // requests would leave the client merging and re-sorting two answers taken at
    // two moments.
    //
    // Proof: the `split(',')` in `filterFrom` replaced by `[query['kind']]`, and
    // this failed on `expected [] to equal [ "cleared", "set" ]` — a kind named
    // `estimate,clear_estimate` matching nothing at all. Watched 2026-08-17.
    const { body } = await get('?kind=estimate,clear_estimate');
    expect(body.events?.map((each) => each.id)).toEqual(['cleared', 'set']);
  });

  it('reads a kind parameter that names nothing as no filter, not as no history', async () => {
    // `?kind=` is a client that built a query string from an empty box. Answering
    // nothing would tell it the plan has no history, which is a different and
    // wrong sentence.
    //
    // Proof: the `filter((each) => each !== '')` removed from `filterFrom`, and
    // this failed on `expected [] to have a length of 4` — every plan with an
    // empty filter box reading as a plan nobody has ever edited. Watched 2026-08-17.
    const { body } = await get('?kind=');
    expect(body.events).toHaveLength(4);
    const trimmed = await get('?kind= , ');
    expect(trimmed.body.events).toHaveLength(4);
  });

  it('answers nothing for a kind nothing was recorded under, rather than refusing it', async () => {
    // The column is a string so H2's `actual` needs no migration, so there is no
    // closed set to refuse a name against — and a client asking about a kind this
    // release does not write yet is asking a question with a true empty answer.
    const { status, body } = await get('?kind=actual');
    expect(status).toBe(200);
    expect(body.events).toEqual([]);
  });

  it('refuses without a token, and 404s a project that is not there', async () => {
    expect((await get('', '')).status).toBe(401);

    const response = await app.handle(
      new Request('http://localhost/api/projects/no-such-plan/history', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(404);
    // Not an empty history: a plan somebody just deleted and a plan nobody has
    // edited must not look the same to a client.
    expect(await response.json()).toEqual({ error: 'not_found' });
  });
});
