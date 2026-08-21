import { builtByNonOwner } from '@wbs/domain';
import { describe, expect, it } from 'bun:test';

import { buildApp } from '../app';
import { ProjectService } from '../service/project.service';
import { WorkItemService } from '../service/work-item.service';
import { inMemoryActuals } from '../testing/actual-fixture';
import { inMemoryUsers, testAuthService } from '../testing/auth-fixture';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { inMemoryCapacity, testCapacityService } from '../testing/capacity-fixture';
import { inMemoryCommandJournal } from '../testing/command-journal-fixture';
import { inMemoryDependencies } from '../testing/dependency-fixture';
import { inMemoryDirectory, testDirectoryService } from '../testing/directory-fixture';
import { inMemoryEstimates } from '../testing/estimate-fixture';
import { testHistoryService } from '../testing/history-fixture';
import { inMemoryMeasures } from '../testing/measure-fixture';
import { inMemoryPriorityBands, testPriorityBandService } from '../testing/priority-band-fixture';
import { inMemoryProgress } from '../testing/progress-fixture';
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
  const actualStore = inMemoryActuals(workItemStore);
  const measureStore = inMemoryMeasures(workItemStore);
  const progressStore = inMemoryProgress(workItemStore);
  const dependencyStore = inMemoryDependencies();
  const app = buildApp({
    // **One** directory, shared with the work item service below. Two would
    // both look healthy while a person created through `/api/people` was
    // invisible to the assignment that names them — which is exactly what this
    // harness did until the write began reading the person it writes.
    directory: testDirectoryService(directoryStore),
    capacity: testCapacityService(),
    priorityBands: testPriorityBandService(),
    history: testHistoryService(),
    auth: testAuthService(inMemoryUsers()),
    projects: new ProjectService({ projects: projectStore }),
    roles: testRoleService(projectStore),
    workItems: new WorkItemService({
      workItems: workItemStore,
      projects: projectStore,
      estimates: estimateStore,
      actuals: actualStore,
      measures: measureStore,
      progress: progressStore,
      dependencies: dependencyStore,
      directory: directoryStore,
      capacity: inMemoryCapacity(),
      priorityBands: inMemoryPriorityBands(),
      subtrees: inMemorySubtrees({
        workItems: workItemStore,
        estimates: estimateStore,
        actuals: actualStore,
        measures: measureStore,
        progress: progressStore,
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

  // The measure store rides out with the harness because **nothing reads these
  // figures back through the API yet** — the tree payload carries them in
  // section 5, and until it does a route test that asserted through a read
  // would be asserting against a read that does not exist. Every other store
  // stays private, as it should: this one is temporary and section 5 takes it
  // out again.
  return { register, send, measures: measureStore };
}

async function setup() {
  const { register, send, measures } = buildHarness();
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
  return { token, send, measures, projectId: body.project.id, devId, qaId };
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

  it('takes the words beside the date, and gives them back', async () => {
    // The sentence this whole change exists to make sayable: *"blocked until the
    // 12th, waiting on client sign-off"*, as one date and one reason and no new
    // state anywhere.
    const { token, send, projectId } = await setup();
    const created = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    const { id } = (await created.json()) as { id: string };

    const set = await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({
        startNoEarlierThan: '2026-09-12',
        startNoEarlierThanReason: 'waiting on client sign-off',
      }),
    });

    expect(set.status).toBe(200);
    expect(
      (await set.json()) as { startNoEarlierThan: string; startNoEarlierThanReason: string },
    ).toMatchObject({
      startNoEarlierThan: '2026-09-12',
      startNoEarlierThanReason: 'waiting on client sign-off',
    });
  });

  it('refuses a reason with no date, and takes the pair away together', async () => {
    // Both halves of the pair rule through the route, because the status is half
    // the answer: 400 and not 409 — there is no state of the plan in which words
    // about a floor that is not there mean anything, so the request is malformed
    // rather than out of date.
    const { token, send, projectId } = await setup();
    const created = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    const { id } = (await created.json()) as { id: string };

    const orphan = await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ startNoEarlierThanReason: 'waiting on client sign-off' }),
    });
    expect(orphan.status).toBe(400);
    expect((await orphan.json()) as { error: string }).toEqual({
      error: 'not_before_reason_needs_a_date',
    });

    await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({
        startNoEarlierThan: '2026-09-12',
        startNoEarlierThanReason: 'waiting on client sign-off',
      }),
    });

    // The date pulled out from under the words: the request a client makes by
    // forgetting, and the one the Not before cell has to get right.
    const halfCleared = await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ startNoEarlierThan: null }),
    });
    expect(halfCleared.status).toBe(400);
    expect((await halfCleared.json()) as { error: string }).toEqual({
      error: 'not_before_reason_needs_a_date',
    });

    const cleared = await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ startNoEarlierThan: null, startNoEarlierThanReason: null }),
    });
    expect(cleared.status).toBe(200);
    expect(
      (await cleared.json()) as {
        startNoEarlierThan: string | null;
        startNoEarlierThanReason: string | null;
      },
    ).toMatchObject({ startNoEarlierThan: null, startNoEarlierThanReason: null });
  });

  it('refuses a reason that is not text, and one longer than a sentence', async () => {
    // The boundary checks, which are the only ones there are: the column is
    // `text` and SQLite counts no characters, so a paragraph pasted here would
    // be stored whole and cover the chart it was meant to explain.
    const { token, send, projectId } = await setup();
    const created = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    const { id } = (await created.json()) as { id: string };
    await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ startNoEarlierThan: '2026-09-12' }),
    });

    for (const bad of [7, true, { text: 'waiting' }, ['waiting']]) {
      const res = await send(`/api/work-items/${id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ startNoEarlierThanReason: bad }),
      });
      expect([res.status, JSON.stringify(bad)]).toEqual([400, JSON.stringify(bad)]);
    }

    const tooLong = await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ startNoEarlierThanReason: 'x'.repeat(201) }),
    });
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()) as { error: string }).toEqual({
      error: 'startNoEarlierThanReason_must_be_at_most_200_characters',
    });

    const atTheEdge = await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ startNoEarlierThanReason: 'x'.repeat(200) }),
    });
    expect(atTheEdge.status).toBe(200);
  });

  it('stores a blank reason as no reason at all, and trims the rest', async () => {
    // One spelling per fact. Emptying the field is how a reader takes the words
    // off, and a stored `''` would be a second spelling of "nobody has said"
    // that every reader would have to fold — and that the pair rule would then
    // refuse to let anybody clear the date beside.
    //
    // The blank arrives on a row that has a date, so what is being tested is the
    // normalisation and not the pair rule: `''` becoming `null` is legal here
    // either way.
    const { token, send, projectId } = await setup();
    const created = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    const { id } = (await created.json()) as { id: string };
    await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ startNoEarlierThan: '2026-09-12' }),
    });

    const trimmed = await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ startNoEarlierThanReason: '  waiting on client sign-off  ' }),
    });
    expect((await trimmed.json()) as { startNoEarlierThanReason: string }).toMatchObject({
      startNoEarlierThanReason: 'waiting on client sign-off',
    });

    for (const blank of ['', '   ', '\n\t']) {
      const res = await send(`/api/work-items/${id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ startNoEarlierThanReason: blank }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()) as { startNoEarlierThanReason: string | null }).toMatchObject({
        startNoEarlierThanReason: null,
      });
    }
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

  it('refuses a service that is not an id, and writes the one that is', async () => {
    // The parse guard: a non-string is **400** — the body is malformed and no
    // plan anywhere would take it. The other half, an id the directory no longer
    // holds, is 404 and has its own test below.
    const { token, send, projectId } = await setup();
    const created = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    const { id } = (await created.json()) as { id: string };

    // A bare id is among them since task 10.2 and is the addition worth naming:
    // the field takes a **list**, so the string that used to be the only legal
    // value is now the client sending one id where a set belongs — accepted, it
    // would write a join row per character.
    for (const bad of [7, true, 'one-service-id', { id: 'a' }]) {
      const res = await send(`/api/work-items/${id}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ serviceIds: bad }),
      });
      // The value is carried into the assertion so a failure names which of
      // them got through rather than reporting `400 !== 200` four times.
      expect([res.status, JSON.stringify(bad)]).toEqual([400, JSON.stringify(bad)]);
      expect((await res.json()) as { error: string }).toEqual({
        error: 'serviceIds_must_be_a_list_of_ids',
      });
    }

    // Nothing was written by any of them, and the field is on the wire at all —
    // an assertion of `toBeNull` alone would pass just as well against a route
    // that has never heard of it.
    const still = await send(`/api/projects/${projectId}/work-items`, token);
    const { workItems } = (await still.json()) as { workItems: { serviceIds: string[] }[] };
    expect(workItems[0]).toHaveProperty('serviceIds', []);

    // And a well-formed id goes through the parse, the service and the store to
    // the row: without it the four refusals above would pass over a route that
    // drops the field entirely. It caught exactly that — the in-memory fixture
    // merged every field but this one.
    //
    // The service is **created through the directory** rather than invented,
    // because since section 4 the store checks it: a random id is now the 404
    // the next test is about, and asserting a 200 on one would be asserting the
    // absence of the check.
    const made = await send('/api/services', token, {
      method: 'POST',
      body: JSON.stringify({ name: 'Payments' }),
    });
    const { service } = (await made.json()) as { service: { id: string } };
    const ok = await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ serviceIds: [service.id] }),
    });
    expect(ok.status).toBe(200);
    // Read back off the tree rather than off the response, and the change is
    // task 10.2's: `PATCH` answers with the **row**, and the row's `service_id`
    // is the outgoing release's column, which this release deliberately no
    // longer writes. The tree is where the set lives, so the tree is what proves
    // the write. Nothing on fe-01 reads the patch response — `api.patch` returns
    // void — so the stale echo misleads no client; it is named in the task log
    // as owed rather than fixed here.
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const { workItems: written } = (await tree.json()) as { workItems: { serviceIds: string[] }[] };
    expect(written[0]).toHaveProperty('serviceIds', [service.id]);
  });

  it('answers 404 for a service the directory does not hold, and writes nothing', async () => {
    // **Task 4.6, owed by section 3 and paid here.** `statusFor` maps
    // `unknown_service` onto 404 beside `unknown_team` and `unknown_tag`, and
    // until the directory could make a service that mapping was code no test
    // over this route ran: the in-memory work item store took any id at all, so
    // every patch naming a service came back 200. The refusal itself was already
    // proved over real SQLite in `undo.test.ts`; what was missing was the
    // **status** a client branches on, and this is it.
    const { token, send, projectId } = await setup();
    const created = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    const { id } = (await created.json()) as { id: string };

    const res = await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ serviceIds: [crypto.randomUUID()] }),
    });

    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({ error: 'unknown_service' });

    // 404 and **nothing written**: a refusal that had already emptied and
    // rewritten the join would leave the row delivering a service the directory
    // cannot name.
    const still = await send(`/api/projects/${projectId}/work-items`, token);
    const { workItems } = (await still.json()) as { workItems: { serviceIds: string[] }[] };
    expect(workItems[0]).toHaveProperty('serviceIds', []);
  });

  it('records a service the row’s team does not own, rather than refusing it', async () => {
    // **Task 5.4.** The mismatch signals never block a write, and "we decided
    // not to validate" is invisible in a diff — an absent refusal looks exactly
    // like a refusal nobody has written yet. So the decision is asserted from
    // the outside: the patch that creates a mismatch comes back **200**, and
    // the mismatch is then readable from what the route stored.
    //
    // Dany's reason, 2026-08-20 23:18: the point is to "flag where teams build
    // something they do not own". A plan that refuses to record it cannot flag
    // it, and a tool that refuses what happened is a tool people work around.
    const { token, send, projectId } = await setup();
    const created = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId: null, afterId: null, name: 'Strip' }),
    });
    const { id } = (await created.json()) as { id: string };

    const teamMade = await send('/api/teams', token, {
      method: 'POST',
      body: JSON.stringify({ name: 'Platform' }),
    });
    const { team } = (await teamMade.json()) as { team: { id: string } };
    const auth = await send('/api/services', token, {
      method: 'POST',
      body: JSON.stringify({ name: 'Auth' }),
    });
    const { service: owns } = (await auth.json()) as { service: { id: string } };
    const payments = await send('/api/services', token, {
      method: 'POST',
      body: JSON.stringify({ name: 'Payments' }),
    });
    const { service: doesNotOwn } = (await payments.json()) as { service: { id: string } };
    await send(`/api/teams/${team.id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ serviceIds: [owns.id] }),
    });

    /**
     * The domain rule, run over what the route stored and what the directory
     * answers — the same pair fe-01 will filter on, rather than a second copy
     * of the rule written here.
     */
    const mismatchOf = async (workItemId: string): Promise<boolean> => {
      const tree = await send(`/api/projects/${projectId}/work-items`, token);
      const { workItems } = (await tree.json()) as {
        workItems: { id: string; teamIds: string[]; serviceIds: string[] }[];
      };
      const stored = workItems.find((each) => each.id === workItemId);
      const teams = await send('/api/teams', token);
      const { teams: listed } = (await teams.json()) as {
        teams: { id: string; serviceIds: string[] }[];
      };
      // The fold is gone, which is what task 10.2 named this line for: the tree
      // carries `serviceIds` off the join, so the rule is handed the stored set
      // rather than a set of nought or one built out of a column here.
      return builtByNonOwner({
        serviceIds: stored?.serviceIds ?? [],
        teamIds: stored?.teamIds ?? [],
        ownedServicesByTeam: new Map(listed.map((each) => [each.id, each.serviceIds])),
      });
    };

    // The **owned** service first, so this case can tell a working ownership
    // map from an absent one. Without it, `builtByNonOwner` below answers true
    // whether the map came back right or came back empty — the over-broad
    // report chunk 5's usage red exposed, one route over.
    const owning = await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ serviceTeamId: team.id, serviceIds: [owns.id] }),
    });

    expect(owning.status).toBe(200);
    expect(await mismatchOf(id)).toBe(false);

    const patched = await send(`/api/work-items/${id}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ serviceIds: [doesNotOwn.id] }),
    });

    expect(patched.status).toBe(200);

    // And the mismatch is real in what came back, not merely unrefused: the row
    // reads back carrying the service its team does not own, and the rule says
    // so over the stored pair.
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const { workItems } = (await tree.json()) as {
      workItems: { id: string; teamIds: string[]; serviceIds: string[] }[];
    };

    expect(workItems.find((each) => each.id === id)).toMatchObject({
      serviceIds: [doesNotOwn.id],
      teamIds: [team.id],
    });
    expect(await mismatchOf(id)).toBe(true);
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

describe('recording the days a role actually spent', () => {
  const make = async (
    send: (p: string, t: string, i?: { method?: string; body?: string }) => Promise<Response>,
    token: string,
    projectId: string,
    name: string,
    parentId: string | null,
  ): Promise<string> => {
    const res = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId, afterId: null, name }),
    });
    return ((await res.json()) as { id: string }).id;
  };

  const actualsOf = async (
    send: (p: string, t: string, i?: { method?: string; body?: string }) => Promise<Response>,
    token: string,
    projectId: string,
    name: string,
  ) => {
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const body = (await tree.json()) as {
      workItems: { name: string; actuals: Record<string, number> }[];
    };
    return body.workItems.find((w) => w.name === name)?.actuals;
  };

  it('records the days and carries them on the tree, rolled into the parent', async () => {
    const { token, send, projectId, devId } = await setup();
    const strip = await make(send, token, projectId, 'Strip', null);
    const sockets = await make(send, token, projectId, 'Sockets', strip);

    const res = await send(`/api/work-items/${sockets}/actuals/${devId}`, token, {
      method: 'PUT',
      body: JSON.stringify({ days: 8 }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { recorded: boolean }).toEqual({ recorded: true });
    expect(await actualsOf(send, token, projectId, 'Sockets')).toEqual({ [devId]: 8 });
    // Summed on the parent, never stored there.
    expect(await actualsOf(send, token, projectId, 'Strip')).toEqual({ [devId]: 8 });
  });

  it('refuses a body that is not a finite number of days, and one below zero', async () => {
    // `days: 0` is deliberately **not** here: recording zero is a person saying
    // the work took no days, and the route accepts it. Absence is `DELETE`.
    const { token, send, projectId, devId } = await setup();
    const strip = await make(send, token, projectId, 'Strip', null);

    for (const body of ['{}', '{"days":"8"}', '{"days":-1}', '{"days":null}']) {
      const res = await send(`/api/work-items/${strip}/actuals/${devId}`, token, {
        method: 'PUT',
        body,
      });
      expect([body, res.status]).toEqual([body, 400]);
      expect((await res.json()) as { error: string }).toEqual({ error: 'invalid_actual' });
    }

    const zero = await send(`/api/work-items/${strip}/actuals/${devId}`, token, {
      method: 'PUT',
      body: JSON.stringify({ days: 0 }),
    });
    expect(zero.status).toBe(200);
    expect(await actualsOf(send, token, projectId, 'Strip')).toEqual({ [devId]: 0 });
  });

  it('refuses a row that has children with 409, and a role that is not there with 404', async () => {
    const { token, send, projectId, devId } = await setup();
    const strip = await make(send, token, projectId, 'Strip', null);
    const sockets = await make(send, token, projectId, 'Sockets', strip);

    const rolled = await send(`/api/work-items/${strip}/actuals/${devId}`, token, {
      method: 'PUT',
      body: JSON.stringify({ days: 4 }),
    });
    // On the **leaf**: the parent would answer `rolled_up` first, which is the
    // order `setEstimate` guards in, and a case that read 409 twice would say
    // nothing about the role check at all.
    const unknown = await send(`/api/work-items/${sockets}/actuals/${crypto.randomUUID()}`, token, {
      method: 'PUT',
      body: JSON.stringify({ days: 4 }),
    });

    expect([rolled.status, unknown.status]).toEqual([409, 404]);
    expect((await rolled.json()) as { error: string }).toEqual({ error: 'rolled_up' });
    expect((await unknown.json()) as { error: string }).toEqual({ error: 'unknown_role' });
  });

  it('refuses an unauthenticated caller on both verbs, and leaves the figure alone', async () => {
    // Without the read afterwards this passes against a route that answers 401
    // *after* having already written or cleared the row.
    const { token, send, projectId, devId } = await setup();
    const strip = await make(send, token, projectId, 'Strip', null);
    await send(`/api/work-items/${strip}/actuals/${devId}`, token, {
      method: 'PUT',
      body: JSON.stringify({ days: 8 }),
    });

    const written = await send(`/api/work-items/${strip}/actuals/${devId}`, 'not-a-token', {
      method: 'PUT',
      body: JSON.stringify({ days: 99 }),
    });
    const cleared = await send(`/api/work-items/${strip}/actuals/${devId}`, 'not-a-token', {
      method: 'DELETE',
    });

    expect([written.status, cleared.status]).toEqual([401, 401]);
    expect(await actualsOf(send, token, projectId, 'Strip')).toEqual({ [devId]: 8 });
  });

  it('clears back to absence, and clearing again is still a success', async () => {
    const { token, send, projectId, devId, qaId } = await setup();
    const strip = await make(send, token, projectId, 'Strip', null);
    for (const roleId of [devId, qaId]) {
      await send(`/api/work-items/${strip}/actuals/${roleId}`, token, {
        method: 'PUT',
        body: JSON.stringify({ days: 5 }),
      });
    }

    const first = await send(`/api/work-items/${strip}/actuals/${devId}`, token, {
      method: 'DELETE',
    });
    const again = await send(`/api/work-items/${strip}/actuals/${devId}`, token, {
      method: 'DELETE',
    });

    expect([first.status, again.status]).toEqual([200, 200]);
    expect((await first.json()) as { cleared: boolean }).toEqual({ cleared: true });
    // The other role is untouched, and the cleared one is **absent** rather
    // than zero.
    expect(await actualsOf(send, token, projectId, 'Strip')).toEqual({ [qaId]: 5 });
  });

  it('answers this route’s own 404 for a work item that is not there', async () => {
    // The body, not just the status: Elysia answers an unmatched route with a
    // 404 of its own, so a status-only assertion passes with the route deleted.
    const { token, send, devId } = await setup();
    const res = await send(`/api/work-items/${crypto.randomUUID()}/actuals/${devId}`, token, {
      method: 'DELETE',
    });

    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({ error: 'not_found' });
  });
});

describe('recording what a role’s work cost in tokens and hours', () => {
  const make = async (
    send: (p: string, t: string, i?: { method?: string; body?: string }) => Promise<Response>,
    token: string,
    projectId: string,
    name: string,
    parentId: string | null,
  ): Promise<string> => {
    const res = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId, afterId: null, name }),
    });
    return ((await res.json()) as { id: string }).id;
  };

  /**
   * Read off the store, not off the tree: the payload carries these figures in
   * section 5 and does not yet. Without the `recordedAt` — the moment is the
   * clock's, and asserting it here would be asserting about `Date.now()`.
   */
  const stored = (rows: { workItemId: string; roleId: string; metric: string; value: number }[]) =>
    rows.map(({ workItemId, roleId, metric, value }) => ({ workItemId, roleId, metric, value }));

  it('records a figure in each unit against one pair, and clears one without touching the others', async () => {
    const { token, send, measures, projectId, devId } = await setup();
    const strip = await make(send, token, projectId, 'Strip', null);

    for (const [metric, value] of [
      ['token_estimate', 400_000],
      ['token_actual', 512_345],
      ['hours_actual', 6],
    ] as const) {
      const res = await send(`/api/work-items/${strip}/measures/${metric}/${devId}`, token, {
        method: 'PUT',
        body: JSON.stringify({ value }),
      });
      expect([metric, res.status]).toEqual([metric, 200]);
      expect((await res.json()) as { recorded: boolean }).toEqual({ recorded: true });
    }

    // Three rows on one pair, each in its own unit — the whole point of the
    // metric in the path reaching the write, rather than one row overwritten
    // three times.
    expect(stored(await measures.listByProject(projectId))).toEqual([
      { workItemId: strip, roleId: devId, metric: 'token_estimate', value: 400_000 },
      { workItemId: strip, roleId: devId, metric: 'token_actual', value: 512_345 },
      { workItemId: strip, roleId: devId, metric: 'hours_actual', value: 6 },
    ]);

    const cleared = await send(`/api/work-items/${strip}/measures/token_actual/${devId}`, token, {
      method: 'DELETE',
    });

    expect(cleared.status).toBe(200);
    expect((await cleared.json()) as { cleared: boolean }).toEqual({ cleared: true });
    expect(stored(await measures.listByProject(projectId))).toEqual([
      { workItemId: strip, roleId: devId, metric: 'token_estimate', value: 400_000 },
      { workItemId: strip, roleId: devId, metric: 'hours_actual', value: 6 },
    ]);
  });

  it('refuses a body that is not a finite figure, and one below zero', async () => {
    // `value: 0` is deliberately not in the list: recording zero says the work
    // cost nothing in this unit, and the route accepts it. Absence is `DELETE`.
    const { token, send, measures, projectId, devId } = await setup();
    const strip = await make(send, token, projectId, 'Strip', null);

    for (const body of [
      '{}',
      '{"value":"400000"}',
      '{"value":-1}',
      '{"value":null}',
      '{"tokens":5}',
    ]) {
      const res = await send(`/api/work-items/${strip}/measures/token_actual/${devId}`, token, {
        method: 'PUT',
        body,
      });
      expect([body, res.status]).toEqual([body, 400]);
      expect((await res.json()) as { error: string }).toEqual({ error: 'invalid_measure' });
    }
    expect(await measures.listByProject(projectId)).toEqual([]);

    const zero = await send(`/api/work-items/${strip}/measures/token_actual/${devId}`, token, {
      method: 'PUT',
      body: JSON.stringify({ value: 0 }),
    });
    expect(zero.status).toBe(200);
    expect(stored(await measures.listByProject(projectId))).toEqual([
      { workItemId: strip, roleId: devId, metric: 'token_actual', value: 0 },
    ]);
  });

  it('answers 404 for a unit it does not keep, on both verbs, and stores nothing', async () => {
    // The refusal this route pair has and the actuals' does not. 404 rather
    // than 400 — the path names a unit, and this release keeps no such unit.
    // The DELETE half matters on its own: a clear of a metric that does not
    // exist is not the idempotent clear of a row that is not there.
    const { token, send, measures, projectId, devId } = await setup();
    const strip = await make(send, token, projectId, 'Strip', null);

    const written = await send(
      `/api/work-items/${strip}/measures/tokens_estimate/${devId}`,
      token,
      {
        method: 'PUT',
        body: JSON.stringify({ value: 12_000 }),
      },
    );
    const cleared = await send(`/api/work-items/${strip}/measures/story_points/${devId}`, token, {
      method: 'DELETE',
    });

    expect([written.status, cleared.status]).toEqual([404, 404]);
    expect((await written.json()) as { error: string }).toEqual({ error: 'unknown_metric' });
    expect((await cleared.json()) as { error: string }).toEqual({ error: 'unknown_metric' });
    expect(await measures.listByProject(projectId)).toEqual([]);
  });

  it('refuses a row that has children with 409, and a role that is not there with 404', async () => {
    const { token, send, projectId, devId } = await setup();
    const strip = await make(send, token, projectId, 'Strip', null);
    const sockets = await make(send, token, projectId, 'Sockets', strip);

    const rolled = await send(`/api/work-items/${strip}/measures/token_actual/${devId}`, token, {
      method: 'PUT',
      body: JSON.stringify({ value: 900 }),
    });
    // On the leaf, for the actuals' reason: the parent answers `rolled_up`
    // first, so a case that read 409 twice would say nothing about the role.
    const unknown = await send(
      `/api/work-items/${sockets}/measures/token_actual/${crypto.randomUUID()}`,
      token,
      { method: 'PUT', body: JSON.stringify({ value: 900 }) },
    );

    expect([rolled.status, unknown.status]).toEqual([409, 404]);
    expect((await rolled.json()) as { error: string }).toEqual({ error: 'rolled_up' });
    expect((await unknown.json()) as { error: string }).toEqual({ error: 'unknown_role' });
  });

  it('refuses an unauthenticated caller on both verbs, and leaves the figure alone', async () => {
    // Without the read afterwards this passes against a route that answers 401
    // *after* having written or cleared the row.
    const { token, send, measures, projectId, devId } = await setup();
    const strip = await make(send, token, projectId, 'Strip', null);
    await send(`/api/work-items/${strip}/measures/token_actual/${devId}`, token, {
      method: 'PUT',
      body: JSON.stringify({ value: 512_345 }),
    });

    const written = await send(
      `/api/work-items/${strip}/measures/token_actual/${devId}`,
      'not-a-token',
      { method: 'PUT', body: JSON.stringify({ value: 1 }) },
    );
    const cleared = await send(
      `/api/work-items/${strip}/measures/token_actual/${devId}`,
      'not-a-token',
      { method: 'DELETE' },
    );

    expect([written.status, cleared.status]).toEqual([401, 401]);
    expect(stored(await measures.listByProject(projectId))).toEqual([
      { workItemId: strip, roleId: devId, metric: 'token_actual', value: 512_345 },
    ]);
  });

  it('answers this route’s own 404 for a work item that is not there', async () => {
    // The body, not just the status: Elysia answers an unmatched route with a
    // 404 of its own, so a status-only assertion passes with the route deleted.
    const { token, send, devId } = await setup();
    const res = await send(
      `/api/work-items/${crypto.randomUUID()}/measures/token_actual/${devId}`,
      token,
      { method: 'DELETE' },
    );

    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({ error: 'not_found' });
  });
});

describe('saying where a role’s work has got to', () => {
  const make = async (
    send: (p: string, t: string, i?: { method?: string; body?: string }) => Promise<Response>,
    token: string,
    projectId: string,
    name: string,
    parentId: string | null,
  ): Promise<string> => {
    const res = await send(`/api/projects/${projectId}/work-items`, token, {
      method: 'POST',
      body: JSON.stringify({ parentId, afterId: null, name }),
    });
    return ((await res.json()) as { id: string }).id;
  };

  const rowOf = async (
    send: (p: string, t: string, i?: { method?: string; body?: string }) => Promise<Response>,
    token: string,
    projectId: string,
    name: string,
  ) => {
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const body = (await tree.json()) as {
      workItems: { name: string; progress: Record<string, string>; state: string }[];
    };
    return body.workItems.find((w) => w.name === name);
  };

  it('states the role and carries it on the tree, folded into the parent', async () => {
    const { token, send, projectId, devId } = await setup();
    const strip = await make(send, token, projectId, 'Strip', null);
    const sockets = await make(send, token, projectId, 'Sockets', strip);

    const res = await send(`/api/work-items/${sockets}/progress/${devId}`, token, {
      method: 'PUT',
      body: JSON.stringify({ state: 'done' }),
    });

    expect(res.status).toBe(200);
    expect((await res.json()) as { stated: boolean }).toEqual({ stated: true });
    expect(await rowOf(send, token, projectId, 'Sockets')).toMatchObject({
      progress: { [devId]: 'done' },
      state: 'done',
    });
    // Folded on the parent, never stored there.
    expect(await rowOf(send, token, projectId, 'Strip')).toMatchObject({
      progress: { [devId]: 'done' },
      state: 'done',
    });
  });

  it('refuses a state outside the two a role may be put in, not_started included', async () => {
    // `not_started` is refused with the nonsense, and that is the point: the way
    // to say it is `DELETE`, because the absence of a row is how it is spelled
    // everywhere else in this tool.
    //
    // Proof: `isRoleState` replaced by a `typeof state === 'string'` check in
    // `parseProgress`, and this fails with 200 for `{"state":"not_started"}` —
    // a value written into a column whose `CHECK` would then refuse it, turning
    // a 400 into a 500; watched 2026-08-18.
    const { token, send, projectId, devId } = await setup();
    const strip = await make(send, token, projectId, 'Strip', null);

    for (const body of [
      '{}',
      '{"state":"not_started"}',
      '{"state":"blocked"}',
      '{"state":true}',
      '{"state":null}',
    ]) {
      const res = await send(`/api/work-items/${strip}/progress/${devId}`, token, {
        method: 'PUT',
        body,
      });
      expect([body, res.status]).toEqual([body, 400]);
      expect((await res.json()) as { error: string }).toEqual({ error: 'invalid_progress' });
    }

    expect(await rowOf(send, token, projectId, 'Strip')).toMatchObject({
      progress: {},
      state: 'not_started',
    });
  });

  it('refuses a row that has children with 409, and a role that is not there with 404', async () => {
    const { token, send, projectId, devId } = await setup();
    const strip = await make(send, token, projectId, 'Strip', null);
    const sockets = await make(send, token, projectId, 'Sockets', strip);

    const rolled = await send(`/api/work-items/${strip}/progress/${devId}`, token, {
      method: 'PUT',
      body: JSON.stringify({ state: 'done' }),
    });
    // On the **leaf**, for the actuals' reason: the parent answers `rolled_up`
    // first, and a case that read 409 twice would say nothing about the role
    // check at all.
    const unknown = await send(
      `/api/work-items/${sockets}/progress/${crypto.randomUUID()}`,
      token,
      {
        method: 'PUT',
        body: JSON.stringify({ state: 'done' }),
      },
    );

    expect([rolled.status, unknown.status]).toEqual([409, 404]);
    expect((await rolled.json()) as { error: string }).toEqual({ error: 'rolled_up' });
    expect((await unknown.json()) as { error: string }).toEqual({ error: 'unknown_role' });
  });

  it('refuses an unauthenticated caller on both verbs, and leaves the statement alone', async () => {
    // Without the read afterwards this passes against a route that answers 401
    // *after* having already written or cleared the row.
    const { token, send, projectId, devId } = await setup();
    const strip = await make(send, token, projectId, 'Strip', null);
    await send(`/api/work-items/${strip}/progress/${devId}`, token, {
      method: 'PUT',
      body: JSON.stringify({ state: 'done' }),
    });

    const written = await send(`/api/work-items/${strip}/progress/${devId}`, 'not-a-token', {
      method: 'PUT',
      body: JSON.stringify({ state: 'in_progress' }),
    });
    const cleared = await send(`/api/work-items/${strip}/progress/${devId}`, 'not-a-token', {
      method: 'DELETE',
    });

    expect([written.status, cleared.status]).toEqual([401, 401]);
    expect(await rowOf(send, token, projectId, 'Strip')).toMatchObject({
      progress: { [devId]: 'done' },
    });
  });

  it('clears back to absence, and clearing again is still a success', async () => {
    const { token, send, projectId, devId, qaId } = await setup();
    const strip = await make(send, token, projectId, 'Strip', null);
    for (const roleId of [devId, qaId]) {
      await send(`/api/work-items/${strip}/progress/${roleId}`, token, {
        method: 'PUT',
        body: JSON.stringify({ state: 'done' }),
      });
    }

    const first = await send(`/api/work-items/${strip}/progress/${devId}`, token, {
      method: 'DELETE',
    });
    const again = await send(`/api/work-items/${strip}/progress/${devId}`, token, {
      method: 'DELETE',
    });

    expect([first.status, again.status]).toEqual([200, 200]);
    expect((await first.json()) as { cleared: boolean }).toEqual({ cleared: true });
    // The other role is untouched and the cleared one is **absent** rather than
    // `not_started`.
    //
    // The row still reads `done`, and that is the rule rather than a leak: Dev
    // has no estimate and no recorded day on this row, so retracting the only
    // thing anybody ever said about it leaves Dev with no work here at all — and
    // `done` is unanimous across the roles that *have* work. A Dev estimate on
    // the row makes the same clear read `in_progress`, which is the case in
    // `service/progress.test.ts`.
    expect(await rowOf(send, token, projectId, 'Strip')).toMatchObject({
      progress: { [qaId]: 'done' },
      state: 'done',
    });
  });

  it('answers this route’s own 404 for a work item that is not there', async () => {
    // The body, not just the status: Elysia answers an unmatched route with a
    // 404 of its own, so a status-only assertion passes with the route deleted.
    const { token, send, devId } = await setup();
    const res = await send(`/api/work-items/${crypto.randomUUID()}/progress/${devId}`, token, {
      method: 'DELETE',
    });

    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({ error: 'not_found' });
  });
});
