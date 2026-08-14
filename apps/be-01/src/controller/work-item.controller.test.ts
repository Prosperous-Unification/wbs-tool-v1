import { describe, expect, it } from 'bun:test';

import { buildApp } from '../app';
import { ProjectService } from '../service/project.service';
import { WorkItemService } from '../service/work-item.service';
import { inMemoryUsers, testAuthService } from '../testing/auth-fixture';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { inMemoryCapacity, testCapacityService } from '../testing/capacity-fixture';
import { inMemoryPriorityBands, testPriorityBandService } from '../testing/priority-band-fixture';
import { inMemoryCommandJournal } from '../testing/command-journal-fixture';
import { inMemoryDependencies } from '../testing/dependency-fixture';
import { inMemoryDirectory, testDirectoryService } from '../testing/directory-fixture';
import { inMemoryEstimates } from '../testing/estimate-fixture';
import { inMemoryProjects } from '../testing/project-fixture';
import { testReplay } from '../testing/replay-fixture';
import { testRoleService } from '../testing/role-fixture';
import { inMemorySubtrees } from '../testing/subtree-fixture';
import { inMemoryWorkItems } from '../testing/work-item-fixture';

function buildHarness() {
  const projectStore = inMemoryProjects();
  const directoryStore = inMemoryDirectory();
  const workItemStore = inMemoryWorkItems(directoryStore);
  const estimateStore = inMemoryEstimates(workItemStore);
  const dependencyStore = inMemoryDependencies();
  const app = buildApp({
    // **One** directory, shared with the work item service below. Two would
    // both look healthy while a person created through `/api/people` was
    // invisible to the assignment that names them — which is exactly what this
    // harness did until the write began reading the person it writes.
    directory: testDirectoryService(directoryStore),
    capacity: testCapacityService(),
    priorityBands: testPriorityBandService(),
    auth: testAuthService(inMemoryUsers()),
    projects: new ProjectService({ projects: projectStore }),
    roles: testRoleService(projectStore),
    workItems: new WorkItemService({
      workItems: workItemStore,
      projects: projectStore,
      estimates: estimateStore,
      dependencies: dependencyStore,
      directory: directoryStore,
      capacity: inMemoryCapacity(),
      priorityBands: inMemoryPriorityBands(),
      subtrees: inMemorySubtrees({
        workItems: workItemStore,
        estimates: estimateStore,
        dependencies: dependencyStore,
        directory: directoryStore,
      }),
      journal: inMemoryCommandJournal(),
      broadcast: recordingBroadcaster(),
    }),
    replay: testReplay().replay,
    probeDatabase: () => 'ok',
    internalAuthSecret: 'x'.repeat(32),
    migrationsApplied: true,
  });

  async function register(username: string): Promise<string> {
    const res = await app.handle(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: 'correct-horse' }),
      }),
    );
    return ((await res.json()) as { token: string }).token;
  }

  function send(
    path: string,
    token: string,
    init: { method?: string; body?: string } = {},
  ): Promise<Response> {
    return app.handle(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', 'x-wbs-token': token },
      }),
    );
  }

  return { register, send };
}

async function setup() {
  const { register, send } = buildHarness();
  const token = await register('owner');
  const created = await send('/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({ name: 'Rewire the shed' }),
  });
  const body = (await created.json()) as {
    project: { id: string };
    roles: { id: string; name: string }[];
  };
  // The seeded roles' real ids. Estimates and assignees are refused for a role
  // the project does not hold, so a literal `role-dev` would be asserting
  // against a write production answers 404 to.
  const devId = body.roles.find((each) => each.name === 'Dev')?.id;
  const qaId = body.roles.find((each) => each.name === 'QA')?.id;
  if (devId === undefined || qaId === undefined) throw new Error('a project without its roles');
  return { token, send, projectId: body.project.id, devId, qaId };
}

describe('work item routes', () => {
  it('creates a work item and reads it back numbered', async () => {
    const { token, send, projectId } = await setup();

    const created = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    expect(created.status).toBe(200);

    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const body = (await tree.json()) as { workItems: { number: string; name: string }[] };
    expect(body.workItems.map((w) => [w.number, w.name])).toEqual([['010', 'Strip']]);
  });

  it('tells the reader how much of the plan is waiting for a person', async () => {
    // The schedule header's "N tasks wait for a person" reads this. It rides on
    // the tree because that is the read that happens after every change which
    // could move it — and it has to leave be-01 to be of any use, which is what
    // this asserts and the service tests cannot.
    const { token, send, projectId, devId } = await setup();
    const idOf = async (name: string): Promise<string> => {
      const created = await send(`/api/projects/${projectId}/work-items`, token, {
        method: 'POST',
        body: JSON.stringify({ parentId: null, afterId: null, name }),
      });
      return ((await created.json()) as { id: string }).id;
    };
    const first = await idOf('Strip');
    const second = await idOf('Sand');
    // Through the route, because the assignment write reads the person inside
    // its own transaction and refuses an id the directory does not hold.
    const added = await send('/api/people', token, {
      method: 'POST',
      body: JSON.stringify({ name: 'Ada' }),
    });
    const { person } = (await added.json()) as { person: { id: string } };
    for (const [id, days] of [
      [first, 3],
      [second, 2],
    ] as const) {
      await send(`/api/work-items/${id}/estimates/${devId}`, token, {
        method: 'PUT',
        body: JSON.stringify({ optimistic: days, realistic: days, pessimistic: days }),
      });
      await send(`/api/work-items/${id}/assignees/${devId}`, token, {
        method: 'PUT',
        body: JSON.stringify({ personId: person.id }),
      });
    }

    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const body = (await tree.json()) as {
      waitingForPerson: number;
      workItems: { name: string; schedule: { earliestStart: number } }[];
      slices: {
        id: string;
        workItemId: string;
        boundBy: string;
        resourcePredecessorId: string | null;
      }[];
    };

    expect(body.waitingForPerson).toBe(1);
    // The slices leave the process, not merely the service: the route spreads
    // the tree, so this is what says the array survives serialisation to JSON
    // and the ids in it still refer to each other on the other side.
    const held = body.slices.filter((one) => one.boundBy === 'person');
    expect(held.map((one) => one.workItemId)).toEqual([second]);
    expect(held[0]?.resourcePredecessorId).toBe(
      body.slices.find((one) => one.workItemId === first && one.boundBy === 'projectStart')?.id ??
        null,
    );
    // In tree order, which is the reverse of the order they were added: each
    // was created with no `afterId` and therefore in front of the other.
    expect(body.workItems.map((w) => [w.name, w.schedule.earliestStart])).toEqual([
      ['Sand', 3],
      ['Strip', 0],
    ]);
  });

  it('reports the sequence the tree was read at', async () => {
    // The client subscribes after this read, so without a sequence it has no
    // baseline to resume from and an edit landing between the two is lost.
    const { token, send, projectId } = await setup();

    const fresh = await send(`/api/projects/${projectId}/work-items`, token);
    expect(((await fresh.json()) as { seq: number }).seq).toBe(-1);

    await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Sand' }),
    });

    const after = await send(`/api/projects/${projectId}/work-items`, token);
    expect(((await after.json()) as { seq: number }).seq).toBe(1);
  });

  it('refuses an earliest start that is not a calendar day', async () => {
    // The column is text, so a stored non-day would throw on every later read
    // of the project. A 400 on one request is the cheap end of that.
    const { token, send, projectId } = await setup();
    const created = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    const { id } = (await created.json()) as { id: string };

    for (const bad of ['next tuesday', '2026-02-31', '06/08/2026', 7]) {
      const res = await send(`/api/work-items/${id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ startNoEarlierThan: bad }),
      });
      expect([res.status, JSON.stringify(bad)]).toEqual([400, JSON.stringify(bad)]);
    }
  });

  it('takes an earliest start and gives it back, and clears it', async () => {
    const { token, send, projectId } = await setup();
    const created = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    const { id } = (await created.json()) as { id: string };

    const set = await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ startNoEarlierThan: '2026-08-12' }),
    });
    expect(set.status).toBe(200);
    expect((await set.json()) as { startNoEarlierThan: string }).toMatchObject({
      startNoEarlierThan: '2026-08-12',
    });

    const cleared = await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ startNoEarlierThan: null }),
    });
    expect((await cleared.json()) as { startNoEarlierThan: string | null }).toMatchObject({
      startNoEarlierThan: null,
    });
  });

  it('refuses a priority that is not a whole number of 1 or more', async () => {
    // The column is an integer and the leveller reads it as a priority, so a 0, a
    // negative or a fraction is a number nobody could have meant — and a priority
    // nothing else in the system would ever question. Refused here, where the
    // request is still one request, rather than found later in a queue order
    // nobody can explain.
    const { token, send, projectId } = await setup();
    const created = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    const { id } = (await created.json()) as { id: string };
    await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ priority: 3 }),
    });

    // No `NaN` and no infinity here: JSON has no literal for either, and
    // `JSON.stringify` sends `null` for both — which is a request to clear the
    // priority and is accepted. `Number.isSafeInteger` still refuses them for any
    // caller that is not a request body. `1e20` is the reachable end of the
    // same question: a number JSON carries and an integer column cannot.
    for (const bad of [0, -1, 1.5, '2', true, 1e20]) {
      const res = await send(`/api/work-items/${id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ priority: bad }),
      });
      // The value is carried into the assertion so a failure names which of
      // them got through, rather than reporting `400 !== 200` seven times.
      expect([res.status, String(bad)]).toEqual([400, String(bad)]);
    }

    // Nothing was written by any of them: the work item still holds the priority it
    // had before the refusals.
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const { workItems } = (await tree.json()) as { workItems: { priority: number | null }[] };
    expect(workItems[0]?.priority).toBe(3);
  });

  // C2's landmine test — `puts a capacity floor on the wire, which nothing this
  // change ships can draw` — lived here, and its landmine is spent: C3 (#57)
  // taught `floorWordsOf` the word, and `capacity-per-project` retired the
  // `PATCH /api/teams/:id/size` it reached the floor through. Its successor is
  // `capacity.controller.test.ts`'s `puts a capacity floor on the wire, which
  // fe-01 has been able to draw since C3`, over the route that replaced it.

  it('refuses a parallelism that is not a whole number of 1 or more', async () => {
    // The floor is load-bearing rather than tidy. The engine's duration is
    // `effort / width` and `width` is clamped from this number, so a stored 0
    // is a plan of `Infinity` dates with nothing on screen to say why — and
    // this validation is the whole of what stands between the two.
    const { token, send, projectId } = await setup();
    const created = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    const { id } = (await created.json()) as { id: string };
    await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ maxParallel: 3 }),
    });

    for (const bad of [0, -1, 1.5, '3', true, 1e20]) {
      const res = await send(`/api/work-items/${id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ maxParallel: bad }),
      });
      // The value rides into the assertion so a failure names which of them got
      // through rather than reporting `400 !== 200` six times.
      expect([res.status, String(bad)]).toEqual([400, String(bad)]);
    }

    // `1e999` written straight into the body rather than through
    // `JSON.stringify`, which turns an `Infinity` into `null` — a request to
    // reset, and a perfectly legal one. `JSON.parse` does not: it reads the
    // literal as `Infinity`, and `Number.isSafeInteger(Infinity)` is false.
    // **This case cannot see the ceiling** — that is what `1001` below is for,
    // and writing only this one is how a range check that cannot fail has
    // shipped here before.
    const infinite = await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: '{"maxParallel":1e999}',
    });
    expect(infinite.status).toBe(400);

    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const { workItems } = (await tree.json()) as { workItems: { maxParallel: number }[] };
    expect(workItems[0]?.maxParallel).toBe(3);
  });

  it('refuses a parallelism above what a plan can mean', async () => {
    // A thousand is a product limit and is honest about being one. Injected
    // apart from the integer guard above because neither probe can see the
    // other's line: `1e999` is refused by `Number.isSafeInteger` whether or not
    // a ceiling exists, and `1001` passes the integer guard cleanly.
    const { token, send, projectId } = await setup();
    const created = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    const { id } = (await created.json()) as { id: string };

    const refused = await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ maxParallel: 1001 }),
    });
    expect(refused.status).toBe(400);
    expect((await refused.json()) as { error: string }).toEqual({
      error: 'maxParallel_must_be_at_most_1000',
    });

    const allowed = await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ maxParallel: 1000 }),
    });
    expect(allowed.status).toBe(200);
  });

  it('takes a parallelism and gives it back, resets it, and leaves it alone', async () => {
    const { token, send, projectId } = await setup();
    const created = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    const { id } = (await created.json()) as { id: string };

    const set = await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ maxParallel: 4 }),
    });
    expect(set.status).toBe(200);
    expect((await set.json()) as { maxParallel: number }).toMatchObject({ maxParallel: 4 });

    // A patch that names something else leaves it standing: absent is not the
    // same request as null.
    const renamed = await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Strip out' }),
    });
    expect((await renamed.json()) as { maxParallel: number }).toMatchObject({ maxParallel: 4 });

    // `null` **resets** where a priority's clears: 1 and unset are one fact.
    const reset = await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ maxParallel: null }),
    });
    expect((await reset.json()) as { maxParallel: number }).toMatchObject({ maxParallel: 1 });
  });

  it('refuses a parallelism on a row that has children', async () => {
    // A row with children has no slices of its own — `slicesOf` skips it — so a
    // number stored there decides nothing and would sit on screen looking as
    // though it did.
    const { token, send, projectId } = await setup();
    const created = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    const { id } = (await created.json()) as { id: string };
    await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: id, afterId: null, name: 'Sand' }),
    });

    const refused = await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ maxParallel: 3 }),
    });

    // 400 rather than `rolled_up`'s 409: nothing is rolled up here — a parent's
    // parallelism is not the sum of its children's — and the cell for it is
    // read-only on every parent row, so a client sending one is sending a field
    // it was never offered.
    expect(refused.status).toBe(400);
    expect((await refused.json()) as { error: string }).toEqual({ error: 'has_children' });
    // And nothing was written: a refusal that answered 400 having stored the
    // number anyway would be the worse half of the same bug.
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const { workItems } = (await tree.json()) as {
      workItems: { id: string; maxParallel: number }[];
    };
    expect(workItems.find((each) => each.id === id)?.maxParallel).toBe(1);
  });

  it('leaves an inert parallelism standing on a leaf that gains a child', async () => {
    // The other direction of the same rule, and deliberately **not** a cascade:
    // the write was legal when it was made, and rewriting somebody's number
    // because a row moved beneath it would be this tool editing a field nobody
    // asked it to. The number stops deciding anything and C3's cell says so.
    const { token, send, projectId } = await setup();
    const created = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    const { id } = (await created.json()) as { id: string };
    await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ maxParallel: 3 }),
    });

    await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: id, afterId: null, name: 'Sand' }),
    });

    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const { workItems } = (await tree.json()) as {
      workItems: { id: string; maxParallel: number }[];
    };
    expect(workItems.find((each) => each.id === id)?.maxParallel).toBe(3);
  });

  it('takes a priority and gives it back, and clears it', async () => {
    const { token, send, projectId } = await setup();
    const created = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    const { id } = (await created.json()) as { id: string };
    const set = await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ priority: 42 }),
    });
    expect(set.status).toBe(200);
    expect((await set.json()) as { priority: number }).toMatchObject({ priority: 42 });

    // No ceiling: `1 to infinity` was the ask, and a number a planner picks is
    // not the system's to bound.
    const big = await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ priority: 1_000_000 }),
    });
    expect((await big.json()) as { priority: number }).toMatchObject({ priority: 1_000_000 });

    const cleared = await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ priority: null }),
    });
    expect((await cleared.json()) as { priority: number | null }).toMatchObject({
      priority: null,
    });
  });

  it('refuses a client that tries to choose the number', async () => {
    // Numbers are the system's to decide. Accepting one silently would let a
    // client write a label that the next derivation overwrites without warning.
    const { token, send, projectId } = await setup();

    const res = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip', number: '999' }),
    });

    expect(res.status).toBe(400);
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    expect(((await tree.json()) as { workItems: unknown[] }).workItems).toEqual([]);
  });

  it('refuses deleting a parent without a strategy', async () => {
    const { token, send, projectId } = await setup();
    const parent = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    const parentId = ((await parent.json()) as { id: string }).id;
    await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId, afterId: null, name: 'Sockets' }),
    });

    const res = await send(`/api/work-items/${parentId}`, token, { method: 'DELETE' });

    expect(res.status).toBe(400);
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    expect(((await tree.json()) as { workItems: unknown[] }).workItems).toHaveLength(2);
  });

  it('renames through PATCH', async () => {
    const { token, send, projectId } = await setup();
    const created = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    const id = ((await created.json()) as { id: string }).id;

    const res = await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Strip the old wiring' }),
    });

    expect(res.status).toBe(200);
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const body = (await tree.json()) as { workItems: { name: string }[] };
    expect(body.workItems[0]?.name).toBe('Strip the old wiring');
  });

  it('refuses an out-of-order estimate at be-01, with no front end involved', async () => {
    // Called directly, so fe-01's copy of the schema is not in the path. This is
    // what proves the two tiers are independently guarded rather than be-01
    // trusting a client that shares its validation library.
    const { token, send, projectId, devId } = await setup();
    const created = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    const id = ((await created.json()) as { id: string }).id;

    const res = await send(`/api/work-items/${id}/estimates/${devId}`, token, {
      method: 'PUT',
      body: JSON.stringify({ optimistic: 1, realistic: 5, pessimistic: 3 }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({ error: 'invalid_estimate' });
  });

  it('accepts an ordered estimate and rolls it into the parent', async () => {
    const { token, send, projectId, devId } = await setup();
    const parent = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    const parentId = ((await parent.json()) as { id: string }).id;
    const child = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId, afterId: null, name: 'Sockets' }),
    });
    const childId = ((await child.json()) as { id: string }).id;

    const res = await send(`/api/work-items/${childId}/estimates/${devId}`, token, {
      method: 'PUT',
      body: JSON.stringify({ optimistic: 1, realistic: 2, pessimistic: 3 }),
    });

    expect(res.status).toBe(200);
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const body = (await tree.json()) as {
      workItems: { name: string; rolledUp: boolean; estimates: Record<string, unknown> }[];
    };
    const strip = body.workItems.find((w) => w.name === 'Strip');
    expect(strip?.rolledUp).toBe(true);
    expect(strip?.estimates[devId]).toEqual({
      optimistic: 1,
      realistic: 2,
      pessimistic: 3,
    } as never);
  });

  it('refuses an unauthenticated caller', async () => {
    const { send, projectId } = await setup();
    const res = await send(`/api/projects/${projectId}/work-items`, 'not-a-token');
    expect(res.status).toBe(401);
  });
});

describe('clearing an estimate', () => {
  /** A leaf under a parent, with the parent's id, so a roll-up is observable. */
  async function parentAndTwoLeaves() {
    const { token, send, projectId, devId, qaId } = await setup();
    const make = async (name: string, parentId: string | null): Promise<string> => {
      const res = await send(`/api/projects/${projectId}/work-items`, token, {
        method: 'POST',
        body: JSON.stringify({ parentId, afterId: null, name }),
      });
      return ((await res.json()) as { id: string }).id;
    };
    const parentId = await make('Strip', null);
    const sockets = await make('Sockets', parentId);
    const boxes = await make('Back boxes', parentId);
    return { token, send, projectId, parentId, sockets, boxes, devId, qaId };
  }

  const estimatesOf = async (
    send: (p: string, t: string, i?: { method?: string; body?: string }) => Promise<Response>,
    token: string,
    projectId: string,
    name: string,
  ) => {
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const body = (await tree.json()) as {
      workItems: { name: string; estimates: Record<string, unknown> }[];
    };
    return body.workItems.find((w) => w.name === name)?.estimates;
  };

  it('refuses an unauthenticated caller and leaves the estimate alone', async () => {
    // The same guard the PUT carries. Without the assertion on the tree
    // afterwards this would pass against a route that answered 401 *after*
    // having already cleared the row.
    const { token, send, projectId, sockets, devId } = await parentAndTwoLeaves();
    await send(`/api/work-items/${sockets}/estimates/${devId}`, token, {
      method: 'PUT',
      body: JSON.stringify({ optimistic: 1, realistic: 2, pessimistic: 3 }),
    });

    const res = await send(`/api/work-items/${sockets}/estimates/${devId}`, 'not-a-token', {
      method: 'DELETE',
    });

    expect(res.status).toBe(401);
    expect(await estimatesOf(send, token, projectId, 'Sockets')).toEqual({
      [devId]: { optimistic: 1, realistic: 2, pessimistic: 3 },
    });
  });

  it('takes the trio out of the tree, and clearing it again is still a success', async () => {
    const { token, send, projectId, sockets, devId } = await parentAndTwoLeaves();
    await send(`/api/work-items/${sockets}/estimates/${devId}`, token, {
      method: 'PUT',
      body: JSON.stringify({ optimistic: 1, realistic: 2, pessimistic: 3 }),
    });

    const first = await send(`/api/work-items/${sockets}/estimates/${devId}`, token, {
      method: 'DELETE',
    });
    // Idempotent on purpose: two browsers can empty the same three boxes, and
    // "it is already gone" is the state that was asked for, not a conflict.
    const again = await send(`/api/work-items/${sockets}/estimates/${devId}`, token, {
      method: 'DELETE',
    });

    expect([first.status, again.status]).toEqual([200, 200]);
    expect(await estimatesOf(send, token, projectId, 'Sockets')).toEqual({});
  });

  it('leaves the other role on the same work item alone', async () => {
    const { token, send, projectId, sockets, devId, qaId } = await parentAndTwoLeaves();
    for (const roleId of [devId, qaId]) {
      await send(`/api/work-items/${sockets}/estimates/${roleId}`, token, {
        method: 'PUT',
        body: JSON.stringify({ optimistic: 1, realistic: 2, pessimistic: 3 }),
      });
    }

    await send(`/api/work-items/${sockets}/estimates/${devId}`, token, { method: 'DELETE' });

    expect(await estimatesOf(send, token, projectId, 'Sockets')).toEqual({
      [qaId]: { optimistic: 1, realistic: 2, pessimistic: 3 },
    });
  });

  it('drops the parent’s rolled-up figure to what is left below it', async () => {
    // Nothing is stored on the parent — it is summed on read — so this is the
    // test that says the sum actually re-read. Two leaves, not one: a parent
    // whose only estimate vanished would also satisfy "the figure changed".
    const { token, send, projectId, sockets, boxes, devId } = await parentAndTwoLeaves();
    await send(`/api/work-items/${sockets}/estimates/${devId}`, token, {
      method: 'PUT',
      body: JSON.stringify({ optimistic: 1, realistic: 2, pessimistic: 3 }),
    });
    await send(`/api/work-items/${boxes}/estimates/${devId}`, token, {
      method: 'PUT',
      body: JSON.stringify({ optimistic: 10, realistic: 20, pessimistic: 30 }),
    });
    expect(await estimatesOf(send, token, projectId, 'Strip')).toEqual({
      [devId]: { optimistic: 11, realistic: 22, pessimistic: 33 },
    });

    await send(`/api/work-items/${sockets}/estimates/${devId}`, token, { method: 'DELETE' });

    expect(await estimatesOf(send, token, projectId, 'Strip')).toEqual({
      [devId]: { optimistic: 10, realistic: 20, pessimistic: 30 },
    });
  });

  it('answers this route’s own 404 for a work item that is not there', async () => {
    // The body, not just the status. Elysia answers an *unmatched* route with a
    // 404 of its own, so a status-only assertion here passed with the whole
    // DELETE route deleted — watched, and it is the reason this reads the body:
    // `{ error: 'not_found' }` can only have come from the handler.
    const { token, send, devId } = await parentAndTwoLeaves();
    const res = await send(`/api/work-items/${crypto.randomUUID()}/estimates/${devId}`, token, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({ error: 'not_found' });
  });
});

describe('duplicating a work item', () => {
  const add = async (
    send: (p: string, t: string, i?: { method?: string; body?: string }) => Promise<Response>,
    token: string,
    projectId: string,
    name: string,
    parentId: string | null = null,
  ) => {
    const res = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId, afterId: null, name }),
    });
    return ((await res.json()) as { id: string }).id;
  };

  const namesOf = async (
    send: (p: string, t: string, i?: { method?: string; body?: string }) => Promise<Response>,
    token: string,
    projectId: string,
  ) => {
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    return ((await tree.json()) as { workItems: { id: string; name: string }[] }).workItems;
  };

  it('answers the id of the copy, and the next tree read holds it', async () => {
    const { token, send, projectId } = await setup();
    const strip = await add(send, token, projectId, 'Strip');
    await add(send, token, projectId, 'Sockets', strip);

    const res = await send(`/api/work-items/${strip}/duplicate`, token, { method: 'POST' });

    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const rows = await namesOf(send, token, projectId);
    expect(rows.find((w) => w.id === id)?.name).toBe('Strip (copy)');
    expect(rows).toHaveLength(4);
  });

  it('refuses an unauthenticated caller, and copies nothing', async () => {
    // The tree afterwards, not only the status: without it this would pass
    // against a route that answered 401 having already written the copy.
    const { token, send, projectId } = await setup();
    const strip = await add(send, token, projectId, 'Strip');

    const res = await send(`/api/work-items/${strip}/duplicate`, 'not-a-token', {
      method: 'POST',
    });

    expect(res.status).toBe(401);
    expect(await namesOf(send, token, projectId)).toHaveLength(1);
  });

  it('answers this route’s own 404 for a work item that is not there', async () => {
    // The body, not the status alone: Elysia answers an unmatched route with a
    // 404 of its own, so a status-only assertion passes with the route deleted.
    const { token, send } = await setup();

    const res = await send(`/api/work-items/${crypto.randomUUID()}/duplicate`, token, {
      method: 'POST',
    });

    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({ error: 'not_found' });
  });

  it('answers 403 to an account that may not edit a restricted project', async () => {
    const { register, send } = buildHarness();
    const owner = await register('owner');
    const stranger = await register('stranger');
    const create = await send('/api/projects', owner, {
      method: 'POST',
      body: JSON.stringify({ name: 'Restricted' }),
    });
    const { project } = (await create.json()) as { project: { id: string } };
    const strip = await add(send, owner, project.id, 'Strip');
    await send(`/api/projects/${project.id}`, owner, {
      method: 'PATCH',
      body: JSON.stringify({ restricted: true }),
    });

    const res = await send(`/api/work-items/${strip}/duplicate`, stranger, { method: 'POST' });

    expect(res.status).toBe(403);
    expect(await namesOf(send, owner, project.id)).toHaveLength(1);
  });
});

describe('dependency routes', () => {
  const add = async (
    send: (p: string, t: string, i?: { method?: string; body?: string }) => Promise<Response>,
    token: string,
    projectId: string,
    name: string,
  ) => {
    const res = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name }),
    });
    return ((await res.json()) as { id: string }).id;
  };

  it('records a dependency and reports it with the tree', async () => {
    const { token, send, projectId } = await setup();
    const strip = await add(send, token, projectId, 'Strip');
    const sand = await add(send, token, projectId, 'Sand');

    const res = await send(`/api/work-items/${sand}/dependencies`, token, {
      method: 'POST',
      body: JSON.stringify({ predecessorId: strip }),
    });

    expect(res.status).toBe(200);
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const body = (await tree.json()) as { workItems: { id: string; dependsOn: string[] }[] };
    expect(body.workItems.find((w) => w.id === sand)?.dependsOn).toEqual([strip]);
  });

  it('answers 409 for a cycle and writes nothing', async () => {
    const { token, send, projectId } = await setup();
    const strip = await add(send, token, projectId, 'Strip');
    const sand = await add(send, token, projectId, 'Sand');
    await send(`/api/work-items/${sand}/dependencies`, token, {
      method: 'POST',
      body: JSON.stringify({ predecessorId: strip }),
    });

    const res = await send(`/api/work-items/${strip}/dependencies`, token, {
      method: 'POST',
      body: JSON.stringify({ predecessorId: sand }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({ error: 'cycle' });
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const body = (await tree.json()) as { workItems: { id: string; dependsOn: string[] }[] };
    expect(body.workItems.find((w) => w.id === strip)?.dependsOn).toEqual([]);
  });

  it('answers 409 for an edge onto an ancestor', async () => {
    const { token, send, projectId } = await setup();
    const parent = await add(send, token, projectId, 'Phase');
    const child = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: parent, afterId: null, name: 'Task' }),
    });
    const childId = ((await child.json()) as { id: string }).id;

    const res = await send(`/api/work-items/${childId}/dependencies`, token, {
      method: 'POST',
      body: JSON.stringify({ predecessorId: parent }),
    });

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toEqual({ error: 'ancestor' });
  });

  it('answers 400 when no predecessor is named', async () => {
    // Elysia strips unknown properties before the handler, so a typo\'d field
    // name arrives as an absent one. The route parses its own body for that
    // reason, and this is the test that keeps it doing so.
    const { token, send, projectId } = await setup();
    const strip = await add(send, token, projectId, 'Strip');

    const res = await send(`/api/work-items/${strip}/dependencies`, token, {
      method: 'POST',
      body: JSON.stringify({ predecesorId: strip }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toEqual({ error: 'predecessor_required' });
  });

  it('removes a dependency', async () => {
    const { token, send, projectId } = await setup();
    const strip = await add(send, token, projectId, 'Strip');
    const sand = await add(send, token, projectId, 'Sand');
    await send(`/api/work-items/${sand}/dependencies`, token, {
      method: 'POST',
      body: JSON.stringify({ predecessorId: strip }),
    });

    const res = await send(`/api/work-items/${sand}/dependencies/${strip}`, token, {
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const body = (await tree.json()) as { workItems: { id: string; dependsOn: string[] }[] };
    expect(body.workItems.find((w) => w.id === sand)?.dependsOn).toEqual([]);
  });

  it('reports a schedule with the tree', async () => {
    const { token, send, projectId } = await setup();
    const strip = await add(send, token, projectId, 'Strip');

    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const body = (await tree.json()) as {
      workItems: { id: string; schedule: { earliestStart: number; estimated: boolean } }[];
    };

    expect(body.workItems.find((w) => w.id === strip)?.schedule).toMatchObject({
      earliestStart: 0,
      estimated: false,
    });
  });
});
