import { builtByNonOwner } from '@wbs/domain';
import { describe, expect, it } from 'bun:test';

import { buildApp } from '../app';
import { ProjectService } from '../service/project.service';
import { inMemoryUsers, testAuthService } from '../testing/auth-fixture';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { testCalendarMarkerService } from '../testing/calendar-marker-fixture';
import { testCapacityService } from '../testing/capacity-fixture';
import { testDirectoryService } from '../testing/directory-fixture';
import { inMemoryServices } from '../testing/harness';
import { testHistoryService } from '../testing/history-fixture';
import { testPriorityBandService } from '../testing/priority-band-fixture';
import { testReplay } from '../testing/replay-fixture';
import { testSavedPlanService } from '../testing/saved-plan-fixture';
import { testStepService } from '../testing/step-fixture';
import { testWrites } from '../testing/writes-fixture';

function buildHarness() {
  const writes = testWrites();
  const plan = inMemoryServices();
  const { projects: projectStore, directory: directoryStore, measures: measureStore } = plan.stores;
  const app = buildApp({
    // **One** directory, shared with the work item service below. Two would
    // both look healthy while a person created through a `createPerson`
    // command was invisible to the assignment that names them — which is
    // exactly what this harness did until the write began reading the person
    // it writes.
    directory: testDirectoryService(directoryStore),
    capacity: testCapacityService(),
    priorityBands: testPriorityBandService(),
    history: testHistoryService(),
    calendarMarkers: testCalendarMarkerService(),
    auth: testAuthService(inMemoryUsers()),
    projects: new ProjectService({ projects: projectStore, broadcast: recordingBroadcaster() }),
    steps: testStepService(projectStore),
    workItems: plan.service,
    savedPlans: testSavedPlanService(),
    replay: testReplay().replay,
    probeDatabase: () => 'ok',
    internalAuthSecret: 'x'.repeat(32),
    writes,
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
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      }),
    );
  }

  // The measure store rides out with the harness because **nothing reads these
  // figures back through the API yet** — the tree payload carries them in
  // section 5, and until it does a route test that asserted through a read
  // would be asserting against a read that does not exist. Every other store
  // stays private, as it should: this one is temporary and section 5 takes it
  // out again.
  return { register, send, measures: measureStore, writes };
}

type Send = (
  path: string,
  token: string,
  init?: { method?: string; body?: string },
) => Promise<Response>;

async function setup() {
  const { register, send, measures, writes } = buildHarness();
  const token = await register('owner');
  const created = await send('/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({ name: 'Rewire the shed' }),
  });
  const body = (await created.json()) as {
    project: { id: string };
    steps: { id: string; name: string }[];
  };
  // The seeded steps' real ids. Estimates and assignees are refused for a step
  // the project does not hold, so a literal `step-dev` would be asserting
  // against a write production answers 404 to.
  const devId = body.steps.find((each) => each.name === 'Dev')?.id;
  const qaId = body.steps.find((each) => each.name === 'QA')?.id;
  if (devId === undefined || qaId === undefined) throw new Error('a project without its steps');
  return { token, send, measures, writes, projectId: body.project.id, devId, qaId };
}

/**
 * One plan command as a batch of one — the request every retired single-item
 * route became. The ids the old path carried are fields of the step.
 */
function command(
  send: Send,
  token: string,
  projectId: string,
  step: Record<string, unknown>,
): Promise<Response> {
  return send(`/api/projects/${projectId}/commands`, token, {
    method: 'POST',
    body: JSON.stringify({ commands: [step] }),
  });
}

/** One directory command as a batch of one, at the directory's own route. */
function directoryCommand(
  send: Send,
  token: string,
  step: Record<string, unknown>,
): Promise<Response> {
  return send('/api/directory/commands', token, {
    method: 'POST',
    body: JSON.stringify({ commands: [step] }),
  });
}

/**
 * The id a batch of one create minted. Throws on a refused batch, so a broken
 * setup names itself here rather than as a failed JSON read three assertions on.
 */
async function mintedId(res: Response): Promise<string> {
  const body = (await res.json()) as { results?: { id?: string }[] };
  const id = body.results?.[0]?.id;
  if (id === undefined) {
    throw new Error(`a create that minted no id: ${String(res.status)} ${JSON.stringify(body)}`);
  }
  return id;
}

async function addWorkItem(
  send: Send,
  token: string,
  projectId: string,
  fields: { parentId: string | null; afterId?: string | null; name: string },
): Promise<string> {
  return mintedId(
    await command(send, token, projectId, {
      kind: 'createWorkItem',
      parentId: fields.parentId,
      afterId: fields.afterId ?? null,
      name: fields.name,
    }),
  );
}

async function addToDirectory(
  send: Send,
  token: string,
  kind: 'createTeam' | 'createPerson' | 'createService',
  name: string,
): Promise<string> {
  return mintedId(await directoryCommand(send, token, { kind, name }));
}

/**
 * The tree's first row. The command route answers `results`, never the row the
 * retired `PATCH` echoed, so every field a write is supposed to have changed is
 * read back from here — the plan as the batch left it.
 */
async function firstRow(
  send: Send,
  token: string,
  projectId: string,
): Promise<Record<string, unknown>> {
  const tree = await send(`/api/projects/${projectId}/work-items`, token);
  const { workItems } = (await tree.json()) as { workItems: Record<string, unknown>[] };
  const first = workItems.at(0);
  if (first === undefined) throw new Error('an empty tree where a row was expected');
  return first;
}

describe('work item routes', () => {
  it('answers 400 for a ref nobody minted, and 404 for a row that is not there', async () => {
    // The one exception in `statusForRefusal`'s `unknown_*` family, and until
    // 2026-09-02 nothing asserted it: `unknown_ref` is a mistake **inside the
    // batch the caller wrote**, while every other `unknown_*` names something
    // that is not there. Both codes reach the same route through the same
    // ladder, so the two have to be asked for together.
    //
    // Proof: the `unknown_ref` arm deleted from `statusForRefusal`, watched
    // failing on `expect(received).toEqual(expected) · - 400 · + 404` — and
    // the whole store and unit tiers stayed green under that fault, which is
    // how an arm nobody asks about survives a rewrite. Observed 2026-09-02.
    const { token, send, projectId, devId } = await setup();

    const unmintedRef = await command(send, token, projectId, {
      kind: 'createWorkItem',
      parentRef: 'nobody-minted-this',
      afterId: null,
      name: 'Orphan',
    });
    const absentRow = await command(send, token, projectId, {
      kind: 'setEstimate',
      workItemId: 'no-such-row',
      stepId: devId,
      days: { optimistic: 1, realistic: 2, pessimistic: 3 },
    });

    expect([unmintedRef.status, absentRow.status]).toEqual([400, 404]);
    expect(await unmintedRef.json()).toEqual({
      error: 'unknown_ref',
      at: 0,
      kind: 'createWorkItem',
    });
  });

  it('applies a command batch, answering the id each ref became and the undo state', async () => {
    const { token, send, projectId, devId } = await setup();
    const res = await send(`/api/projects/${projectId}/commands`, token, {
      method: 'POST',
      body: JSON.stringify({
        commands: [
          { kind: 'createWorkItem', ref: 'strip', parentId: null, afterId: null, name: 'Strip' },
          { kind: 'createWorkItem', ref: 'sand', parentId: null, afterRef: 'strip', name: 'Sand' },
          {
            kind: 'setEstimate',
            workItemRef: 'sand',
            stepId: devId,
            days: { optimistic: 1, realistic: 2, pessimistic: 3 },
          },
          { kind: 'addDependency', workItemRef: 'sand', predecessorRef: 'strip' },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { index: number; ref?: string; id?: string }[];
      undoable: boolean;
      redoable: boolean;
    };
    expect(body.results.map((each) => [each.index, each.ref ?? null, typeof each.id])).toEqual([
      [0, 'strip', 'string'],
      [1, 'sand', 'string'],
      [2, null, 'undefined'],
      [3, null, 'undefined'],
    ]);
    expect(body.undoable).toBe(true);
    expect(body.redoable).toBe(false);

    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const rows = (await tree.json()) as { workItems: { number: string; name: string }[] };
    expect(rows.workItems.map((w) => [w.number, w.name])).toEqual([
      ['010', 'Strip'],
      ['020', 'Sand'],
    ]);
  });

  it('has no payload field named roleId', async () => {
    const { token, send, projectId, devId } = await setup();
    await send(`/api/projects/${projectId}/commands`, token, {
      method: 'POST',
      body: JSON.stringify({
        commands: [
          { kind: 'createWorkItem', ref: 'strip', parentId: null, afterId: null, name: 'Strip' },
          {
            kind: 'setEstimate',
            workItemRef: 'strip',
            stepId: devId,
            days: { optimistic: 1, realistic: 2, pessimistic: 3 },
          },
        ],
      }),
    });

    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const plan: unknown = await tree.json();

    /*
      Every key at every depth, because the wire is the contract and a single
      surviving `roleId` on one nested shape is the whole of what design D3
      refused to ship a compatibility layer for. The **values** are ids the
      project generated, so only the names are read.

      Proof: `scheduledSlices` in `work-item.service.ts` given the old spelling
      back — `.map(([id, placed]) => ({ id, roleId: placed.stepId, ...placed }))`.
      This failed on `expect(received).toEqual(expected)` with
      `+ [ "slices[0].roleId", "slices[1].roleId" ]`. Watched 2026-08-29.

      The **first** site tried was `slicesOf`'s own push, and that one passed:
      the payload's slices are rebuilt from the scheduler's placement, so a
      field added before the schedule never reaches the wire. A negative has to
      be injected where the fault would live.
    */
    const stale: string[] = [];
    const walk = (node: unknown, at: string): void => {
      if (Array.isArray(node)) {
        node.forEach((each, index) => {
          walk(each, `${at}[${String(index)}]`);
        });
        return;
      }
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        const here = at === '' ? key : `${at}.${key}`;
        if (/^(role|roles|roleId|roleIds)$/.test(key)) stale.push(here);
        // The estimate and actual records are keyed by a step's **id**, so
        // their keys are the project's uuids and not names to be read. Their
        // values still are.
        walk(value, here);
      }
    };
    walk(plan, '');

    expect(stale).toEqual([]);
    // And the payload really was walked, so the emptiness above is a reading
    // rather than a shape nobody entered.
    expect(JSON.stringify(plan)).toContain('stepId');
  });

  it('refuses a batch at the failing command, naming its index and kind, with nothing applied', async () => {
    const { token, send, projectId, writes } = await setup();
    const res = await send(`/api/projects/${projectId}/commands`, token, {
      method: 'POST',
      body: JSON.stringify({
        commands: [
          { kind: 'createWorkItem', ref: 'a', parentId: null, afterId: null, name: 'A' },
          {
            kind: 'setEstimate',
            workItemRef: 'a',
            stepId: 'no-such-step',
            days: { optimistic: 1, realistic: 2, pessimistic: 3 },
          },
        ],
      }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown_step', at: 1, kind: 'setEstimate' });
    // The stores here are the in-memory fixtures, which no transaction can
    // roll back; what this layer can prove is that the route opened one and
    // rolled it back. That the rollback takes the create with it is
    // `plan-commands.test.ts`'s, on real SQLite.
    expect(writes.transactions.calls).toEqual(['begin', 'rollback']);
  });

  it('applies a directory batch at its own route, no project in the path', async () => {
    const { token, send } = await setup();
    const res = await send('/api/directory/commands', token, {
      method: 'POST',
      body: JSON.stringify({ commands: [{ kind: 'createTag', ref: 't', name: 'regulatory' }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: { ref?: string; id?: string; entity?: unknown }[];
    };
    expect(body.results[0]?.ref).toBe('t');
    expect(body.results[0]?.entity).toMatchObject({ name: 'regulatory' });
    const tags = await send('/api/tags', token);
    expect(((await tags.json()) as { tags: { name: string }[] }).tags.map((t) => t.name)).toEqual([
      'regulatory',
    ]);
  });

  it('validates each command with the write’s own parser, refusing by index and code', async () => {
    // The single routes' hand parsers are the API's input validation, and a
    // batch goes through the same ones: a parent that is not an id, a priority
    // below one, a malformed estimate, a negative actual, an unknown delete
    // strategy, a team name that is not text — each refused as its route
    // refused it, with the command's index beside the code.
    // Proof: the per-kind dispatch replaced by the bare `kind` check, every
    // case below answered 200 or a service refusal instead. Watched,
    // 2026-08-29.
    const { token, send, projectId, devId } = await setup();
    const refused = async (step: Record<string, unknown>, error: string) => {
      const res = await command(send, token, projectId, step);
      expect(res.status, error).toBe(400);
      expect(await res.json(), error).toEqual({ error, at: 0, kind: step['kind'] });
    };
    await refused({ kind: 'createWorkItem', parentId: 5 }, 'parentId_must_be_id_or_null');
    await refused(
      { kind: 'patchWorkItem', workItemId: 'w', patch: { priority: 0 } },
      'priority_must_be_a_whole_number_from_1',
    );
    await refused(
      { kind: 'setEstimate', workItemId: 'w', stepId: devId, days: { optimistic: 'x' } },
      'invalid_estimate',
    );
    await refused(
      { kind: 'setActual', workItemId: 'w', stepId: devId, days: -1 },
      'invalid_actual',
    );
    await refused(
      { kind: 'deleteWorkItem', workItemId: 'w', strategy: 'nuke' },
      'unknown_strategy',
    );
    await refused({ kind: 'createTeam', name: 5 }, 'name_must_be_text');
    await refused(
      { kind: 'setCapacity', teamId: 't', size: 0 },
      'size_must_be_a_whole_number_from_1',
    );
    await refused({ kind: 'setPriorityBands', bands: [] }, 'bands_must_number_5');
  });

  it('refuses a batch that is not a list of known commands before applying any', async () => {
    // Proof: the cap dropped from the runner, the 201 case answered 200.
    // Watched, 2026-08-29.
    const { token, send, projectId } = await setup();
    const shape = await command(send, token, projectId, { kind: 'renameEverything' });
    expect(shape.status).toBe(400);
    expect(await shape.json()).toEqual({ error: 'unknown_kind', at: 0 });

    const derived = await command(send, token, projectId, {
      kind: 'createWorkItem',
      name: 'X',
      number: '010',
    });
    expect(derived.status).toBe(400);
    expect(await derived.json()).toEqual({
      error: 'number_is_derived',
      at: 0,
      kind: 'createWorkItem',
    });

    const many = await send(`/api/projects/${projectId}/commands`, token, {
      method: 'POST',
      body: JSON.stringify({
        commands: Array.from({ length: 201 }, (_, n) => ({
          kind: 'createWorkItem',
          name: `Row ${String(n)}`,
        })),
      }),
    });
    expect(many.status).toBe(400);
    expect(await many.json()).toEqual({
      error: 'too_many_commands',
      at: 200,
      kind: 'createWorkItem',
    });
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    expect(((await tree.json()) as { workItems: unknown[] }).workItems).toEqual([]);
  });

  it('creates a work item and reads it back numbered', async () => {
    const { token, send, projectId } = await setup();

    const created = await command(send, token, projectId, {
      kind: 'createWorkItem',
      parentId: null,
      afterId: null,
      name: 'Strip',
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
    const first = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    const second = await addWorkItem(send, token, projectId, { parentId: null, name: 'Sand' });
    // Through the directory route, because the assignment write reads the
    // person inside its own transaction and refuses an id the directory does
    // not hold.
    const personId = await addToDirectory(send, token, 'createPerson', 'Ada');
    for (const [id, days] of [
      [first, 3],
      [second, 2],
    ] as const) {
      const res = await send(`/api/projects/${projectId}/commands`, token, {
        method: 'POST',
        body: JSON.stringify({
          commands: [
            {
              kind: 'setEstimate',
              workItemId: id,
              stepId: devId,
              days: { optimistic: days, realistic: days, pessimistic: days },
            },
            { kind: 'setAssignee', workItemId: id, stepId: devId, personId },
          ],
        }),
      });
      expect(res.status).toBe(200);
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

    expect(body.waitingForPerson).toBe(2);
    // The slices leave the process, not merely the service: the route spreads
    // the tree, so this is what says the array survives serialisation to JSON
    // and the ids in it still refer to each other on the other side.
    const held = body.slices.filter((one) => one.boundBy === 'person');
    // Two work items, since `assumed-duration-schedules` (2026-08-29). One
    // assignment on a work item makes Ada its assumed assignee, so she does all
    // four slices, and the two `QA`s nobody estimated are two workdays each
    // rather than nothing: her day is `Strip` Dev 0→3, `Sand` Dev 3→5, `Sand`
    // QA 5→7, `Strip` QA 7→9. `Sand`'s Dev waits behind `Strip`'s exactly as it
    // did; `Strip`'s own QA is the one this change added to the queue.
    expect(held.map((one) => one.workItemId)).toEqual([first, second]);
    // Named rather than indexed: the assertion is about `Sand`'s Dev, which is
    // the slice the original claim was about, and an index would follow
    // whichever slice the payload happened to list first.
    const sandsDev = held.find((one) => one.workItemId === second);
    expect(sandsDev?.resourcePredecessorId).toBe(
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

    // Two batches, not one batch of two: a batch is one broadcast, and the
    // sequence counts broadcasts.
    await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    await addWorkItem(send, token, projectId, { parentId: null, name: 'Sand' });

    const after = await send(`/api/projects/${projectId}/work-items`, token);
    expect(((await after.json()) as { seq: number }).seq).toBe(1);
  });

  it('refuses an earliest start that is not a calendar day', async () => {
    // The column is text, so a stored non-day would throw on every later read
    // of the project. A 400 on one request is the cheap end of that.
    const { token, send, projectId } = await setup();
    const id = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });

    for (const bad of ['next tuesday', '2026-02-31', '06/08/2026', 7]) {
      const res = await command(send, token, projectId, {
        kind: 'patchWorkItem',
        workItemId: id,
        patch: { startNoEarlierThan: bad },
      });
      expect([res.status, JSON.stringify(bad)]).toEqual([400, JSON.stringify(bad)]);
    }
  });

  it('takes an earliest start and gives it back, and clears it', async () => {
    const { token, send, projectId } = await setup();
    const id = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });

    const set = await command(send, token, projectId, {
      kind: 'patchWorkItem',
      workItemId: id,
      patch: { startNoEarlierThan: '2026-08-12' },
    });
    expect(set.status).toBe(200);
    expect(await firstRow(send, token, projectId)).toMatchObject({
      startNoEarlierThan: '2026-08-12',
    });

    const cleared = await command(send, token, projectId, {
      kind: 'patchWorkItem',
      workItemId: id,
      patch: { startNoEarlierThan: null },
    });
    expect(cleared.status).toBe(200);
    expect(await firstRow(send, token, projectId)).toMatchObject({ startNoEarlierThan: null });
  });

  it('takes the words beside the date, and gives them back', async () => {
    // The sentence this whole change exists to make sayable: *"blocked until the
    // 12th, waiting on client sign-off"*, as one date and one reason and no new
    // state anywhere.
    const { token, send, projectId } = await setup();
    const id = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });

    const set = await command(send, token, projectId, {
      kind: 'patchWorkItem',
      workItemId: id,
      patch: {
        startNoEarlierThan: '2026-09-12',
        startNoEarlierThanReason: 'waiting on client sign-off',
      },
    });

    expect(set.status).toBe(200);
    expect(await firstRow(send, token, projectId)).toMatchObject({
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
    const id = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    const patch = (fields: Record<string, unknown>) =>
      command(send, token, projectId, { kind: 'patchWorkItem', workItemId: id, patch: fields });

    const orphan = await patch({ startNoEarlierThanReason: 'waiting on client sign-off' });
    expect(orphan.status).toBe(400);
    expect(await orphan.json()).toEqual({
      error: 'not_before_reason_needs_a_date',
      at: 0,
      kind: 'patchWorkItem',
    });

    await patch({
      startNoEarlierThan: '2026-09-12',
      startNoEarlierThanReason: 'waiting on client sign-off',
    });

    // The date pulled out from under the words: the request a client makes by
    // forgetting, and the one the Not before cell has to get right.
    const halfCleared = await patch({ startNoEarlierThan: null });
    expect(halfCleared.status).toBe(400);
    expect(await halfCleared.json()).toEqual({
      error: 'not_before_reason_needs_a_date',
      at: 0,
      kind: 'patchWorkItem',
    });

    const cleared = await patch({ startNoEarlierThan: null, startNoEarlierThanReason: null });
    expect(cleared.status).toBe(200);
    expect(await firstRow(send, token, projectId)).toMatchObject({
      startNoEarlierThan: null,
      startNoEarlierThanReason: null,
    });
  });

  it('refuses a reason that is not text, and one longer than a sentence', async () => {
    // The boundary checks, which are the only ones there are: the column is
    // `text` and SQLite counts no characters, so a paragraph pasted here would
    // be stored whole and cover the chart it was meant to explain.
    const { token, send, projectId } = await setup();
    const id = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    const patch = (fields: Record<string, unknown>) =>
      command(send, token, projectId, { kind: 'patchWorkItem', workItemId: id, patch: fields });
    await patch({ startNoEarlierThan: '2026-09-12' });

    for (const bad of [7, true, { text: 'waiting' }, ['waiting']]) {
      const res = await patch({ startNoEarlierThanReason: bad });
      expect([res.status, JSON.stringify(bad)]).toEqual([400, JSON.stringify(bad)]);
    }

    const tooLong = await patch({ startNoEarlierThanReason: 'x'.repeat(201) });
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({
      error: 'startNoEarlierThanReason_must_be_at_most_200_characters',
      at: 0,
      kind: 'patchWorkItem',
    });

    const atTheEdge = await patch({ startNoEarlierThanReason: 'x'.repeat(200) });
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
    const id = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    const patch = (fields: Record<string, unknown>) =>
      command(send, token, projectId, { kind: 'patchWorkItem', workItemId: id, patch: fields });
    await patch({ startNoEarlierThan: '2026-09-12' });

    const trimmed = await patch({ startNoEarlierThanReason: '  waiting on client sign-off  ' });
    expect(trimmed.status).toBe(200);
    expect(await firstRow(send, token, projectId)).toMatchObject({
      startNoEarlierThanReason: 'waiting on client sign-off',
    });

    for (const blank of ['', '   ', '\n\t']) {
      const res = await patch({ startNoEarlierThanReason: blank });
      expect([res.status, JSON.stringify(blank)]).toEqual([200, JSON.stringify(blank)]);
      expect(await firstRow(send, token, projectId)).toMatchObject({
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
    const id = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    const patch = (fields: Record<string, unknown>) =>
      command(send, token, projectId, { kind: 'patchWorkItem', workItemId: id, patch: fields });
    await patch({ priority: 3 });

    // No `NaN` and no infinity here: JSON has no literal for either, and
    // `JSON.stringify` sends `null` for both — which is a request to clear the
    // priority and is accepted. `Number.isSafeInteger` still refuses them for any
    // caller that is not a request body. `1e20` is the reachable end of the
    // same question: a number JSON carries and an integer column cannot.
    for (const bad of [0, -1, 1.5, '2', true, 1e20]) {
      const res = await patch({ priority: bad });
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

  it('takes teamIds as a bounded whole set, including empty and duplicate payloads', async () => {
    // Dropping the parser arm makes the first write return 200 while the tree
    // remains empty. Dropping the cap makes the eleven-id request return 404
    // for an unknown member instead of refusing the malformed payload here.
    const { token, send, projectId } = await setup();
    const id = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    const alpha = await addToDirectory(send, token, 'createTeam', 'Alpha');
    const beta = await addToDirectory(send, token, 'createTeam', 'Beta');
    const patch = (fields: Record<string, unknown>) =>
      command(send, token, projectId, { kind: 'patchWorkItem', workItemId: id, patch: fields });

    const set = await patch({ teamIds: [beta, alpha, beta] });
    expect(set.status).toBe(200);
    let tree = await send(`/api/projects/${projectId}/work-items`, token);
    let body = (await tree.json()) as { workItems: { teamIds: string[] }[] };
    expect(body.workItems[0]?.teamIds).toEqual([alpha, beta].sort());

    const cleared = await patch({ teamIds: [] });
    expect(cleared.status).toBe(200);
    tree = await send(`/api/projects/${projectId}/work-items`, token);
    body = (await tree.json()) as { workItems: { teamIds: string[] }[] };
    expect(body.workItems[0]?.teamIds).toEqual([]);

    for (const bad of [null, alpha, [alpha, 7], { id: alpha }]) {
      const res = await patch({ teamIds: bad });
      expect([res.status, JSON.stringify(bad)]).toEqual([400, JSON.stringify(bad)]);
      expect(await res.json()).toEqual({
        error: 'teamIds_must_be_a_list_of_ids',
        at: 0,
        kind: 'patchWorkItem',
      });
    }

    const overCap = await patch({ teamIds: Array.from({ length: 11 }, () => alpha) });
    expect(overCap.status).toBe(400);
    expect(await overCap.json()).toEqual({
      error: 'teamIds_must_be_at_most_10',
      at: 0,
      kind: 'patchWorkItem',
    });
  });

  it('refuses mixed team arms before either can change the row', async () => {
    // Removing only the mutual-exclusion guard changes this exact 400 to a
    // 200 and lets request order decide which spelling wins.
    const { token, send, projectId } = await setup();
    const id = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    const alpha = await addToDirectory(send, token, 'createTeam', 'Alpha');
    const beta = await addToDirectory(send, token, 'createTeam', 'Beta');
    const patch = (fields: Record<string, unknown>) =>
      command(send, token, projectId, { kind: 'patchWorkItem', workItemId: id, patch: fields });
    await patch({ serviceTeamId: alpha });

    const mixed = await patch({ teamIds: [beta], serviceTeamId: beta });
    expect(mixed.status).toBe(400);
    expect(await mixed.json()).toEqual({
      error: 'cannot_send_both_teamIds_and_serviceTeamId',
      at: 0,
      kind: 'patchWorkItem',
    });
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const { workItems } = (await tree.json()) as { workItems: { teamIds: string[] }[] };
    expect(workItems[0]?.teamIds).toEqual([alpha]);
  });

  it('answers 404 for an unknown teamIds member and leaves the set alone', async () => {
    const { token, send, projectId } = await setup();
    const id = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    const res = await command(send, token, projectId, {
      kind: 'patchWorkItem',
      workItemId: id,
      patch: { teamIds: [crypto.randomUUID()] },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown_team', at: 0, kind: 'patchWorkItem' });
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const { workItems } = (await tree.json()) as { workItems: { teamIds: string[] }[] };
    expect(workItems[0]?.teamIds).toEqual([]);
  });

  it('refuses a service that is not an id, and writes the one that is', async () => {
    // The parse guard: a non-string is **400** — the body is malformed and no
    // plan anywhere would take it. The other half, an id the directory no longer
    // holds, is 404 and has its own test below.
    const { token, send, projectId } = await setup();
    const id = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    const patch = (fields: Record<string, unknown>) =>
      command(send, token, projectId, { kind: 'patchWorkItem', workItemId: id, patch: fields });

    // A bare id is among them since task 10.2 and is the addition worth naming:
    // the field takes a **list**, so the string that used to be the only legal
    // value is now the client sending one id where a set belongs — accepted, it
    // would write a join row per character.
    for (const bad of [7, true, 'one-service-id', { id: 'a' }]) {
      const res = await patch({ serviceIds: bad });
      // The value is carried into the assertion so a failure names which of
      // them got through rather than reporting `400 !== 200` four times.
      expect([res.status, JSON.stringify(bad)]).toEqual([400, JSON.stringify(bad)]);
      expect(await res.json()).toEqual({
        error: 'serviceIds_must_be_a_list_of_ids',
        at: 0,
        kind: 'patchWorkItem',
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
    const serviceId = await addToDirectory(send, token, 'createService', 'Payments');
    const ok = await patch({ serviceIds: [serviceId] });
    expect(ok.status).toBe(200);
    // Read back off the tree: the command route answers `results`, never the
    // row — and when the retired `PATCH` did echo the row, its `service_id` was
    // the outgoing release's column, which this release no longer writes (task
    // 10.2). The tree is where the set lives, so the tree is what proves the
    // write.
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const { workItems: written } = (await tree.json()) as { workItems: { serviceIds: string[] }[] };
    expect(written[0]).toHaveProperty('serviceIds', [serviceId]);
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
    const id = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });

    const res = await command(send, token, projectId, {
      kind: 'patchWorkItem',
      workItemId: id,
      patch: { serviceIds: [crypto.randomUUID()] },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'unknown_service', at: 0, kind: 'patchWorkItem' });

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
    const id = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    const patch = (fields: Record<string, unknown>) =>
      command(send, token, projectId, { kind: 'patchWorkItem', workItemId: id, patch: fields });

    const teamId = await addToDirectory(send, token, 'createTeam', 'Platform');
    const owns = await addToDirectory(send, token, 'createService', 'Auth');
    const doesNotOwn = await addToDirectory(send, token, 'createService', 'Payments');
    const owned = await directoryCommand(send, token, {
      kind: 'patchTeam',
      teamId,
      patch: { serviceIds: [owns] },
    });
    expect(owned.status).toBe(200);

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
    const owning = await patch({ serviceTeamId: teamId, serviceIds: [owns] });

    expect(owning.status).toBe(200);
    expect(await mismatchOf(id)).toBe(false);

    const patched = await patch({ serviceIds: [doesNotOwn] });

    expect(patched.status).toBe(200);

    // And the mismatch is real in what came back, not merely unrefused: the row
    // reads back carrying the service its team does not own, and the rule says
    // so over the stored pair.
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const { workItems } = (await tree.json()) as {
      workItems: { id: string; teamIds: string[]; serviceIds: string[] }[];
    };

    expect(workItems.find((each) => each.id === id)).toMatchObject({
      serviceIds: [doesNotOwn],
      teamIds: [teamId],
    });
    expect(await mismatchOf(id)).toBe(true);
  });

  // C2's landmine test — `puts a capacity floor on the wire, which nothing this
  // change ships can draw` — lived here, and its landmine is spent: C3 (#57)
  // taught `floorWordsOf` the word, and `capacity-per-project` retired the
  // `PATCH /api/teams/:id/size` it reached the floor through. Its successor is
  // `capacity-body.test.ts`'s `puts a capacity floor on the wire, which
  // fe-01 has been able to draw since C3`, over the route that replaced it.

  it('refuses a parallelism that is not a whole number of 1 or more', async () => {
    // The floor is load-bearing rather than tidy. The engine's duration is
    // `effort / width` and `width` is clamped from this number, so a stored 0
    // is a plan of `Infinity` dates with nothing on screen to say why — and
    // this validation is the whole of what stands between the two.
    const { token, send, projectId } = await setup();
    const id = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    const patch = (fields: Record<string, unknown>) =>
      command(send, token, projectId, { kind: 'patchWorkItem', workItemId: id, patch: fields });
    await patch({ maxParallel: 3 });

    for (const bad of [0, -1, 1.5, '3', true, 1e20]) {
      const res = await patch({ maxParallel: bad });
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
    const infinite = await send(`/api/projects/${projectId}/commands`, token, {
      method: 'POST',
      body: `{"commands":[{"kind":"patchWorkItem","workItemId":"${id}","patch":{"maxParallel":1e999}}]}`,
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
    const id = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    const patch = (fields: Record<string, unknown>) =>
      command(send, token, projectId, { kind: 'patchWorkItem', workItemId: id, patch: fields });

    const refused = await patch({ maxParallel: 1001 });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: 'maxParallel_must_be_at_most_1000',
      at: 0,
      kind: 'patchWorkItem',
    });

    const allowed = await patch({ maxParallel: 1000 });
    expect(allowed.status).toBe(200);
  });

  it('takes a parallelism and gives it back, resets it, and leaves it alone', async () => {
    const { token, send, projectId } = await setup();
    const id = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    const patch = (fields: Record<string, unknown>) =>
      command(send, token, projectId, { kind: 'patchWorkItem', workItemId: id, patch: fields });

    const set = await patch({ maxParallel: 4 });
    expect(set.status).toBe(200);
    expect(await firstRow(send, token, projectId)).toMatchObject({ maxParallel: 4 });

    // A patch that names something else leaves it standing: absent is not the
    // same request as null.
    const renamed = await patch({ name: 'Strip out' });
    expect(renamed.status).toBe(200);
    expect(await firstRow(send, token, projectId)).toMatchObject({
      name: 'Strip out',
      maxParallel: 4,
    });

    // `null` **resets** where a priority's clears: 1 and unset are one fact.
    const reset = await patch({ maxParallel: null });
    expect(reset.status).toBe(200);
    expect(await firstRow(send, token, projectId)).toMatchObject({ maxParallel: 1 });
  });

  it('refuses a parallelism on a row that has children', async () => {
    // A row with children has no slices of its own — `slicesOf` skips it — so a
    // number stored there decides nothing and would sit on screen looking as
    // though it did.
    const { token, send, projectId } = await setup();
    const id = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    await addWorkItem(send, token, projectId, { parentId: id, name: 'Sand' });

    const refused = await command(send, token, projectId, {
      kind: 'patchWorkItem',
      workItemId: id,
      patch: { maxParallel: 3 },
    });

    // 400 rather than `rolled_up`'s 409: nothing is rolled up here — a parent's
    // parallelism is not the sum of its children's — and the cell for it is
    // read-only on every parent row, so a client sending one is sending a field
    // it was never offered.
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'has_children', at: 0, kind: 'patchWorkItem' });
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
    const id = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    await command(send, token, projectId, {
      kind: 'patchWorkItem',
      workItemId: id,
      patch: { maxParallel: 3 },
    });

    await addWorkItem(send, token, projectId, { parentId: id, name: 'Sand' });

    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const { workItems } = (await tree.json()) as {
      workItems: { id: string; maxParallel: number }[];
    };
    expect(workItems.find((each) => each.id === id)?.maxParallel).toBe(3);
  });

  it('takes a priority and gives it back, and clears it', async () => {
    const { token, send, projectId } = await setup();
    const id = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    const patch = (fields: Record<string, unknown>) =>
      command(send, token, projectId, { kind: 'patchWorkItem', workItemId: id, patch: fields });
    const set = await patch({ priority: 42 });
    expect(set.status).toBe(200);
    expect(await firstRow(send, token, projectId)).toMatchObject({ priority: 42 });

    // No ceiling: `1 to infinity` was the ask, and a number a planner picks is
    // not the system's to bound.
    const big = await patch({ priority: 1_000_000 });
    expect(big.status).toBe(200);
    expect(await firstRow(send, token, projectId)).toMatchObject({ priority: 1_000_000 });

    const cleared = await patch({ priority: null });
    expect(cleared.status).toBe(200);
    expect(await firstRow(send, token, projectId)).toMatchObject({ priority: null });
  });

  it('refuses a client that tries to choose the number', async () => {
    // Numbers are the system's to decide. Accepting one silently would let a
    // client write a label that the next derivation overwrites without warning.
    const { token, send, projectId } = await setup();

    const res = await command(send, token, projectId, {
      kind: 'createWorkItem',
      parentId: null,
      afterId: null,
      name: 'Strip',
      number: '999',
    });

    expect(res.status).toBe(400);
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    expect(((await tree.json()) as { workItems: unknown[] }).workItems).toEqual([]);
  });

  it('refuses deleting a parent without a strategy', async () => {
    const { token, send, projectId } = await setup();
    const parentId = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    await addWorkItem(send, token, projectId, { parentId, name: 'Sockets' });

    const res = await command(send, token, projectId, {
      kind: 'deleteWorkItem',
      workItemId: parentId,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'strategy_required',
      at: 0,
      kind: 'deleteWorkItem',
    });
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    expect(((await tree.json()) as { workItems: unknown[] }).workItems).toHaveLength(2);
  });

  it('renames through a patchWorkItem command', async () => {
    const { token, send, projectId } = await setup();
    const id = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });

    const res = await command(send, token, projectId, {
      kind: 'patchWorkItem',
      workItemId: id,
      patch: { name: 'Strip the old wiring' },
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
    const id = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });

    const res = await command(send, token, projectId, {
      kind: 'setEstimate',
      workItemId: id,
      stepId: devId,
      days: { optimistic: 1, realistic: 5, pessimistic: 3 },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_estimate', at: 0, kind: 'setEstimate' });
  });

  it('accepts an ordered estimate and rolls it into the parent', async () => {
    const { token, send, projectId, devId } = await setup();
    const parentId = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    const childId = await addWorkItem(send, token, projectId, { parentId, name: 'Sockets' });

    const res = await command(send, token, projectId, {
      kind: 'setEstimate',
      workItemId: childId,
      stepId: devId,
      days: { optimistic: 1, realistic: 2, pessimistic: 3 },
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
    const parentId = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    const sockets = await addWorkItem(send, token, projectId, { parentId, name: 'Sockets' });
    const boxes = await addWorkItem(send, token, projectId, { parentId, name: 'Back boxes' });
    const estimate = (workItemId: string, stepId: string, days: Record<string, number>) =>
      command(send, token, projectId, { kind: 'setEstimate', workItemId, stepId, days });
    const clear = (workItemId: string, stepId: string, as: string = token) =>
      command(send, as, projectId, { kind: 'clearEstimate', workItemId, stepId });
    return { token, send, projectId, parentId, sockets, boxes, devId, qaId, estimate, clear };
  }

  const estimatesOf = async (send: Send, token: string, projectId: string, name: string) => {
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const body = (await tree.json()) as {
      workItems: { name: string; estimates: Record<string, unknown> }[];
    };
    return body.workItems.find((w) => w.name === name)?.estimates;
  };

  it('refuses an unauthenticated caller and leaves the estimate alone', async () => {
    // The same guard every command carries. Without the assertion on the tree
    // afterwards this would pass against a route that answered 401 *after*
    // having already cleared the row.
    const { token, send, projectId, sockets, devId, estimate, clear } = await parentAndTwoLeaves();
    await estimate(sockets, devId, { optimistic: 1, realistic: 2, pessimistic: 3 });

    const res = await clear(sockets, devId, 'not-a-token');

    expect(res.status).toBe(401);
    expect(await estimatesOf(send, token, projectId, 'Sockets')).toEqual({
      [devId]: { optimistic: 1, realistic: 2, pessimistic: 3 },
    });
  });

  it('takes the trio out of the tree, and clearing it again is still a success', async () => {
    const { token, send, projectId, sockets, devId, estimate, clear } = await parentAndTwoLeaves();
    await estimate(sockets, devId, { optimistic: 1, realistic: 2, pessimistic: 3 });

    const first = await clear(sockets, devId);
    // Idempotent on purpose: two browsers can empty the same three boxes, and
    // "it is already gone" is the state that was asked for, not a conflict.
    const again = await clear(sockets, devId);

    expect([first.status, again.status]).toEqual([200, 200]);
    expect(await estimatesOf(send, token, projectId, 'Sockets')).toEqual({});
  });

  it('leaves the other step on the same work item alone', async () => {
    const { token, send, projectId, sockets, devId, qaId, estimate, clear } =
      await parentAndTwoLeaves();
    for (const stepId of [devId, qaId]) {
      await estimate(sockets, stepId, { optimistic: 1, realistic: 2, pessimistic: 3 });
    }

    await clear(sockets, devId);

    expect(await estimatesOf(send, token, projectId, 'Sockets')).toEqual({
      [qaId]: { optimistic: 1, realistic: 2, pessimistic: 3 },
    });
  });

  it('drops the parent’s rolled-up figure to what is left below it', async () => {
    // Nothing is stored on the parent — it is summed on read — so this is the
    // test that says the sum actually re-read. Two leaves, not one: a parent
    // whose only estimate vanished would also satisfy "the figure changed".
    const { token, send, projectId, sockets, boxes, devId, estimate, clear } =
      await parentAndTwoLeaves();
    await estimate(sockets, devId, { optimistic: 1, realistic: 2, pessimistic: 3 });
    await estimate(boxes, devId, { optimistic: 10, realistic: 20, pessimistic: 30 });
    expect(await estimatesOf(send, token, projectId, 'Strip')).toEqual({
      [devId]: { optimistic: 11, realistic: 22, pessimistic: 33 },
    });

    await clear(sockets, devId);

    expect(await estimatesOf(send, token, projectId, 'Strip')).toEqual({
      [devId]: { optimistic: 10, realistic: 20, pessimistic: 30 },
    });
  });

  it('answers this route’s own 404 for a work item that is not there', async () => {
    // The body, not just the status. Elysia answers an *unmatched* route with a
    // 404 of its own, so a status-only assertion here passed with the whole
    // DELETE route deleted — watched, and it is the reason this reads the body:
    // `{ error: 'not_found', at, kind }` can only have come from the runner.
    const { devId, clear } = await parentAndTwoLeaves();
    const res = await clear(crypto.randomUUID(), devId);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', at: 0, kind: 'clearEstimate' });
  });
});

describe('duplicating a work item', () => {
  const namesOf = async (send: Send, token: string, projectId: string) => {
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    return ((await tree.json()) as { workItems: { id: string; name: string }[] }).workItems;
  };

  it('answers the id of the copy, and the next tree read holds it', async () => {
    const { token, send, projectId } = await setup();
    const strip = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    await addWorkItem(send, token, projectId, { parentId: strip, name: 'Sockets' });

    const res = await command(send, token, projectId, {
      kind: 'duplicateWorkItem',
      workItemId: strip,
    });

    expect(res.status).toBe(200);
    const id = await mintedId(res);
    const rows = await namesOf(send, token, projectId);
    expect(rows.find((w) => w.id === id)?.name).toBe('Strip (copy)');
    expect(rows).toHaveLength(4);
  });

  it('refuses an unauthenticated caller, and copies nothing', async () => {
    // The tree afterwards, not only the status: without it this would pass
    // against a route that answered 401 having already written the copy.
    const { token, send, projectId } = await setup();
    const strip = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });

    const res = await command(send, 'not-a-token', projectId, {
      kind: 'duplicateWorkItem',
      workItemId: strip,
    });

    expect(res.status).toBe(401);
    expect(await namesOf(send, token, projectId)).toHaveLength(1);
  });

  it('answers this route’s own 404 for a work item that is not there', async () => {
    // The body, not the status alone: Elysia answers an unmatched route with a
    // 404 of its own, so a status-only assertion passes with the route deleted.
    const { token, send, projectId } = await setup();

    const res = await command(send, token, projectId, {
      kind: 'duplicateWorkItem',
      workItemId: crypto.randomUUID(),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', at: 0, kind: 'duplicateWorkItem' });
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
    const strip = await addWorkItem(send, owner, project.id, { parentId: null, name: 'Strip' });
    await send(`/api/projects/${project.id}`, owner, {
      method: 'PATCH',
      body: JSON.stringify({ restricted: true }),
    });

    const res = await command(send, stranger, project.id, {
      kind: 'duplicateWorkItem',
      workItemId: strip,
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden', at: 0, kind: 'duplicateWorkItem' });
    expect(await namesOf(send, owner, project.id)).toHaveLength(1);
  });
});

describe('dependency commands', () => {
  const dependsOnOf = async (send: Send, token: string, projectId: string, id: string) => {
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const body = (await tree.json()) as { workItems: { id: string; dependsOn: string[] }[] };
    return body.workItems.find((w) => w.id === id)?.dependsOn;
  };

  it('records a dependency and reports it with the tree', async () => {
    const { token, send, projectId } = await setup();
    const strip = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    const sand = await addWorkItem(send, token, projectId, { parentId: null, name: 'Sand' });

    const res = await command(send, token, projectId, {
      kind: 'addDependency',
      workItemId: sand,
      predecessorId: strip,
    });

    expect(res.status).toBe(200);
    expect(await dependsOnOf(send, token, projectId, sand)).toEqual([strip]);
  });

  it('answers 409 for a cycle and writes nothing', async () => {
    const { token, send, projectId } = await setup();
    const strip = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    const sand = await addWorkItem(send, token, projectId, { parentId: null, name: 'Sand' });
    await command(send, token, projectId, {
      kind: 'addDependency',
      workItemId: sand,
      predecessorId: strip,
    });

    const res = await command(send, token, projectId, {
      kind: 'addDependency',
      workItemId: strip,
      predecessorId: sand,
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'cycle', at: 0, kind: 'addDependency' });
    expect(await dependsOnOf(send, token, projectId, strip)).toEqual([]);
  });

  it('answers 409 for an edge onto an ancestor', async () => {
    const { token, send, projectId } = await setup();
    const parent = await addWorkItem(send, token, projectId, { parentId: null, name: 'Step' });
    const childId = await addWorkItem(send, token, projectId, { parentId: parent, name: 'Task' });

    const res = await command(send, token, projectId, {
      kind: 'addDependency',
      workItemId: childId,
      predecessorId: parent,
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'ancestor', at: 0, kind: 'addDependency' });
  });

  it('answers 400 when no predecessor is named', async () => {
    // Elysia strips unknown properties before the handler, so a typo'd field
    // name arrives as an absent one. The command is parsed by hand for that
    // reason, and a step naming neither `predecessorId` nor `predecessorRef`
    // is the runner's `missing_id`; this is the test that keeps it so.
    const { token, send, projectId } = await setup();
    const strip = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });

    const res = await command(send, token, projectId, {
      kind: 'addDependency',
      workItemId: strip,
      predecesorId: strip,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'missing_id', at: 0, kind: 'addDependency' });
  });

  it('removes a dependency', async () => {
    const { token, send, projectId } = await setup();
    const strip = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    const sand = await addWorkItem(send, token, projectId, { parentId: null, name: 'Sand' });
    await command(send, token, projectId, {
      kind: 'addDependency',
      workItemId: sand,
      predecessorId: strip,
    });

    const res = await command(send, token, projectId, {
      kind: 'removeDependency',
      workItemId: sand,
      predecessorId: strip,
    });

    expect(res.status).toBe(200);
    expect(await dependsOnOf(send, token, projectId, sand)).toEqual([]);
  });

  it('reports a schedule with the tree', async () => {
    const { token, send, projectId } = await setup();
    const strip = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });

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

describe('recording the days a step actually spent', () => {
  const actualsOf = async (send: Send, token: string, projectId: string, name: string) => {
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const body = (await tree.json()) as {
      workItems: { name: string; actuals: Record<string, number> }[];
    };
    return body.workItems.find((w) => w.name === name)?.actuals;
  };

  it('records the days and carries them on the tree, rolled into the parent', async () => {
    const { token, send, projectId, devId } = await setup();
    const strip = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    const sockets = await addWorkItem(send, token, projectId, { parentId: strip, name: 'Sockets' });

    const res = await command(send, token, projectId, {
      kind: 'setActual',
      workItemId: sockets,
      stepId: devId,
      days: 8,
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { results: unknown[] }).results).toEqual([{ index: 0 }]);
    expect(await actualsOf(send, token, projectId, 'Sockets')).toEqual({ [devId]: 8 });
    // Summed on the parent, never stored there.
    expect(await actualsOf(send, token, projectId, 'Strip')).toEqual({ [devId]: 8 });
  });

  it('refuses a body that is not a finite number of days, and one below zero', async () => {
    // `days: 0` is deliberately **not** here: recording zero is a person saying
    // the work took no days, and the command accepts it. Absence is
    // `clearActual`.
    const { token, send, projectId, devId } = await setup();
    const strip = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });

    for (const given of [{}, { days: '8' }, { days: -1 }, { days: null }]) {
      const label = JSON.stringify(given);
      const res = await command(send, token, projectId, {
        kind: 'setActual',
        workItemId: strip,
        stepId: devId,
        ...given,
      });
      expect([label, res.status]).toEqual([label, 400]);
      expect(await res.json()).toEqual({ error: 'invalid_actual', at: 0, kind: 'setActual' });
    }

    const zero = await command(send, token, projectId, {
      kind: 'setActual',
      workItemId: strip,
      stepId: devId,
      days: 0,
    });
    expect(zero.status).toBe(200);
    expect(await actualsOf(send, token, projectId, 'Strip')).toEqual({ [devId]: 0 });
  });

  it('refuses a row that has children with 409, and a step that is not there with 404', async () => {
    const { token, send, projectId, devId } = await setup();
    const strip = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    const sockets = await addWorkItem(send, token, projectId, { parentId: strip, name: 'Sockets' });

    const rolled = await command(send, token, projectId, {
      kind: 'setActual',
      workItemId: strip,
      stepId: devId,
      days: 4,
    });
    // On the **leaf**: the parent would answer `rolled_up` first, which is the
    // order `setEstimate` guards in, and a case that read 409 twice would say
    // nothing about the step check at all.
    const unknown = await command(send, token, projectId, {
      kind: 'setActual',
      workItemId: sockets,
      stepId: crypto.randomUUID(),
      days: 4,
    });

    expect([rolled.status, unknown.status]).toEqual([409, 404]);
    expect(await rolled.json()).toEqual({ error: 'rolled_up', at: 0, kind: 'setActual' });
    expect(await unknown.json()).toEqual({ error: 'unknown_step', at: 0, kind: 'setActual' });
  });

  it('refuses an unauthenticated caller on both verbs, and leaves the figure alone', async () => {
    // Without the read afterwards this passes against a route that answers 401
    // *after* having already written or cleared the row.
    const { token, send, projectId, devId } = await setup();
    const strip = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    await command(send, token, projectId, {
      kind: 'setActual',
      workItemId: strip,
      stepId: devId,
      days: 8,
    });

    const written = await command(send, 'not-a-token', projectId, {
      kind: 'setActual',
      workItemId: strip,
      stepId: devId,
      days: 99,
    });
    const cleared = await command(send, 'not-a-token', projectId, {
      kind: 'clearActual',
      workItemId: strip,
      stepId: devId,
    });

    expect([written.status, cleared.status]).toEqual([401, 401]);
    expect(await actualsOf(send, token, projectId, 'Strip')).toEqual({ [devId]: 8 });
  });

  it('clears back to absence, and clearing again is still a success', async () => {
    const { token, send, projectId, devId, qaId } = await setup();
    const strip = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    for (const stepId of [devId, qaId]) {
      await command(send, token, projectId, {
        kind: 'setActual',
        workItemId: strip,
        stepId,
        days: 5,
      });
    }

    const first = await command(send, token, projectId, {
      kind: 'clearActual',
      workItemId: strip,
      stepId: devId,
    });
    const again = await command(send, token, projectId, {
      kind: 'clearActual',
      workItemId: strip,
      stepId: devId,
    });

    expect([first.status, again.status]).toEqual([200, 200]);
    expect(((await first.json()) as { results: unknown[] }).results).toEqual([{ index: 0 }]);
    // The other step is untouched, and the cleared one is **absent** rather
    // than zero.
    expect(await actualsOf(send, token, projectId, 'Strip')).toEqual({ [qaId]: 5 });
  });

  it('answers this route’s own 404 for a work item that is not there', async () => {
    // The body, not just the status: Elysia answers an unmatched route with a
    // 404 of its own, so a status-only assertion passes with the route deleted.
    const { token, send, projectId, devId } = await setup();
    const res = await command(send, token, projectId, {
      kind: 'clearActual',
      workItemId: crypto.randomUUID(),
      stepId: devId,
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', at: 0, kind: 'clearActual' });
  });
});

describe('recording what a step’s work cost in tokens and hours', () => {
  /**
   * Read off the store, not off the tree: the payload carries these figures in
   * section 5 and does not yet. Without the `recordedAt` — the moment is the
   * clock's, and asserting it here would be asserting about `Date.now()`.
   */
  const stored = (rows: { workItemId: string; stepId: string; metric: string; value: number }[]) =>
    rows.map(({ workItemId, stepId, metric, value }) => ({ workItemId, stepId, metric, value }));

  it('records a figure in each unit against one pair, and clears one without touching the others', async () => {
    const { token, send, measures, projectId, devId } = await setup();
    const strip = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });

    for (const [metric, value] of [
      ['token_estimate', 400_000],
      ['token_actual', 512_345],
      ['hours_actual', 6],
    ] as const) {
      const res = await command(send, token, projectId, {
        kind: 'setMeasure',
        workItemId: strip,
        stepId: devId,
        metric,
        value,
      });
      expect([metric, res.status]).toEqual([metric, 200]);
      expect(((await res.json()) as { results: unknown[] }).results).toEqual([{ index: 0 }]);
    }

    // Three rows on one pair, each in its own unit — the whole point of the
    // metric on the command reaching the write, rather than one row overwritten
    // three times.
    expect(stored(await measures.listByProject(projectId))).toEqual([
      { workItemId: strip, stepId: devId, metric: 'token_estimate', value: 400_000 },
      { workItemId: strip, stepId: devId, metric: 'token_actual', value: 512_345 },
      { workItemId: strip, stepId: devId, metric: 'hours_actual', value: 6 },
    ]);

    const cleared = await command(send, token, projectId, {
      kind: 'clearMeasure',
      workItemId: strip,
      stepId: devId,
      metric: 'token_actual',
    });

    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as { results: unknown[] }).results).toEqual([{ index: 0 }]);
    expect(stored(await measures.listByProject(projectId))).toEqual([
      { workItemId: strip, stepId: devId, metric: 'token_estimate', value: 400_000 },
      { workItemId: strip, stepId: devId, metric: 'hours_actual', value: 6 },
    ]);
  });

  it('refuses a body that is not a finite figure, and one below zero', async () => {
    // `value: 0` is deliberately not in the list: recording zero says the work
    // cost nothing in this unit, and the command accepts it. Absence is
    // `clearMeasure`.
    const { token, send, measures, projectId, devId } = await setup();
    const strip = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });

    for (const given of [{}, { value: '400000' }, { value: -1 }, { value: null }, { tokens: 5 }]) {
      const label = JSON.stringify(given);
      const res = await command(send, token, projectId, {
        kind: 'setMeasure',
        workItemId: strip,
        stepId: devId,
        metric: 'token_actual',
        ...given,
      });
      expect([label, res.status]).toEqual([label, 400]);
      expect(await res.json()).toEqual({ error: 'invalid_measure', at: 0, kind: 'setMeasure' });
    }
    expect(await measures.listByProject(projectId)).toEqual([]);

    const zero = await command(send, token, projectId, {
      kind: 'setMeasure',
      workItemId: strip,
      stepId: devId,
      metric: 'token_actual',
      value: 0,
    });
    expect(zero.status).toBe(200);
    expect(stored(await measures.listByProject(projectId))).toEqual([
      { workItemId: strip, stepId: devId, metric: 'token_actual', value: 0 },
    ]);
  });

  it('answers 404 for a unit it does not keep, on both verbs, and stores nothing', async () => {
    // The refusal this command pair has and the actuals' does not. 404 rather
    // than 400 — the step names a unit, and this release keeps no such unit;
    // `statusForBatch` maps every `unknown_*` but `unknown_ref` there, beside
    // `unknown_step`. The clear half matters on its own: a clear of a metric
    // that does not exist is not the idempotent clear of a row that is not
    // there.
    const { token, send, measures, projectId, devId } = await setup();
    const strip = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });

    const written = await command(send, token, projectId, {
      kind: 'setMeasure',
      workItemId: strip,
      stepId: devId,
      metric: 'tokens_estimate',
      value: 12_000,
    });
    const cleared = await command(send, token, projectId, {
      kind: 'clearMeasure',
      workItemId: strip,
      stepId: devId,
      metric: 'story_points',
    });

    expect([written.status, cleared.status]).toEqual([404, 404]);
    expect(await written.json()).toEqual({ error: 'unknown_metric', at: 0, kind: 'setMeasure' });
    expect(await cleared.json()).toEqual({ error: 'unknown_metric', at: 0, kind: 'clearMeasure' });
    expect(await measures.listByProject(projectId)).toEqual([]);
  });

  it('refuses a row that has children with 409, and a step that is not there with 404', async () => {
    const { token, send, projectId, devId } = await setup();
    const strip = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    const sockets = await addWorkItem(send, token, projectId, { parentId: strip, name: 'Sockets' });

    const rolled = await command(send, token, projectId, {
      kind: 'setMeasure',
      workItemId: strip,
      stepId: devId,
      metric: 'token_actual',
      value: 900,
    });
    // On the leaf, for the actuals' reason: the parent answers `rolled_up`
    // first, so a case that read 409 twice would say nothing about the step.
    const unknown = await command(send, token, projectId, {
      kind: 'setMeasure',
      workItemId: sockets,
      stepId: crypto.randomUUID(),
      metric: 'token_actual',
      value: 900,
    });

    expect([rolled.status, unknown.status]).toEqual([409, 404]);
    expect(await rolled.json()).toEqual({ error: 'rolled_up', at: 0, kind: 'setMeasure' });
    expect(await unknown.json()).toEqual({ error: 'unknown_step', at: 0, kind: 'setMeasure' });
  });

  it('refuses an unauthenticated caller on both verbs, and leaves the figure alone', async () => {
    // Without the read afterwards this passes against a route that answers 401
    // *after* having written or cleared the row.
    const { token, send, measures, projectId, devId } = await setup();
    const strip = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    await command(send, token, projectId, {
      kind: 'setMeasure',
      workItemId: strip,
      stepId: devId,
      metric: 'token_actual',
      value: 512_345,
    });

    const written = await command(send, 'not-a-token', projectId, {
      kind: 'setMeasure',
      workItemId: strip,
      stepId: devId,
      metric: 'token_actual',
      value: 1,
    });
    const cleared = await command(send, 'not-a-token', projectId, {
      kind: 'clearMeasure',
      workItemId: strip,
      stepId: devId,
      metric: 'token_actual',
    });

    expect([written.status, cleared.status]).toEqual([401, 401]);
    expect(stored(await measures.listByProject(projectId))).toEqual([
      { workItemId: strip, stepId: devId, metric: 'token_actual', value: 512_345 },
    ]);
  });

  it('answers this route’s own 404 for a work item that is not there', async () => {
    // The body, not just the status: Elysia answers an unmatched route with a
    // 404 of its own, so a status-only assertion passes with the route deleted.
    const { token, send, projectId, devId } = await setup();
    const res = await command(send, token, projectId, {
      kind: 'clearMeasure',
      workItemId: crypto.randomUUID(),
      stepId: devId,
      metric: 'token_actual',
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', at: 0, kind: 'clearMeasure' });
  });
});

describe('saying where a step’s work has got to', () => {
  const rowOf = async (send: Send, token: string, projectId: string, name: string) => {
    const tree = await send(`/api/projects/${projectId}/work-items`, token);
    const body = (await tree.json()) as {
      workItems: { name: string; progress: Record<string, string>; state: string }[];
    };
    return body.workItems.find((w) => w.name === name);
  };

  it('states the step and carries it on the tree, folded into the parent', async () => {
    const { token, send, projectId, devId } = await setup();
    const strip = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    const sockets = await addWorkItem(send, token, projectId, { parentId: strip, name: 'Sockets' });

    const res = await command(send, token, projectId, {
      kind: 'setProgress',
      workItemId: sockets,
      stepId: devId,
      state: 'done',
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { results: unknown[] }).results).toEqual([{ index: 0 }]);
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

  it('refuses a state outside the two a step may be put in, not_started included', async () => {
    // `not_started` is refused with the nonsense, and that is the point: the way
    // to say it is `clearProgress`, because the absence of a row is how it is
    // spelled everywhere else in this tool.
    //
    // Proof: `isStepState` replaced by a `typeof state === 'string'` check in
    // `parseProgress`, and this fails with 200 for `{"state":"not_started"}` —
    // a value written into a column whose `CHECK` would then refuse it, turning
    // a 400 into a 500; watched 2026-08-18.
    const { token, send, projectId, devId } = await setup();
    const strip = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });

    for (const given of [
      {},
      { state: 'not_started' },
      { state: 'blocked' },
      { state: true },
      { state: null },
    ]) {
      const label = JSON.stringify(given);
      const res = await command(send, token, projectId, {
        kind: 'setProgress',
        workItemId: strip,
        stepId: devId,
        ...given,
      });
      expect([label, res.status]).toEqual([label, 400]);
      expect(await res.json()).toEqual({ error: 'invalid_progress', at: 0, kind: 'setProgress' });
    }

    expect(await rowOf(send, token, projectId, 'Strip')).toMatchObject({
      progress: {},
      state: 'not_started',
    });
  });

  it('refuses a row that has children with 409, and a step that is not there with 404', async () => {
    const { token, send, projectId, devId } = await setup();
    const strip = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    const sockets = await addWorkItem(send, token, projectId, { parentId: strip, name: 'Sockets' });

    const rolled = await command(send, token, projectId, {
      kind: 'setProgress',
      workItemId: strip,
      stepId: devId,
      state: 'done',
    });
    // On the **leaf**, for the actuals' reason: the parent answers `rolled_up`
    // first, and a case that read 409 twice would say nothing about the step
    // check at all.
    const unknown = await command(send, token, projectId, {
      kind: 'setProgress',
      workItemId: sockets,
      stepId: crypto.randomUUID(),
      state: 'done',
    });

    expect([rolled.status, unknown.status]).toEqual([409, 404]);
    expect(await rolled.json()).toEqual({ error: 'rolled_up', at: 0, kind: 'setProgress' });
    expect(await unknown.json()).toEqual({ error: 'unknown_step', at: 0, kind: 'setProgress' });
  });

  it('refuses an unauthenticated caller on both verbs, and leaves the statement alone', async () => {
    // Without the read afterwards this passes against a route that answers 401
    // *after* having already written or cleared the row.
    const { token, send, projectId, devId } = await setup();
    const strip = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    await command(send, token, projectId, {
      kind: 'setProgress',
      workItemId: strip,
      stepId: devId,
      state: 'done',
    });

    const written = await command(send, 'not-a-token', projectId, {
      kind: 'setProgress',
      workItemId: strip,
      stepId: devId,
      state: 'in_progress',
    });
    const cleared = await command(send, 'not-a-token', projectId, {
      kind: 'clearProgress',
      workItemId: strip,
      stepId: devId,
    });

    expect([written.status, cleared.status]).toEqual([401, 401]);
    expect(await rowOf(send, token, projectId, 'Strip')).toMatchObject({
      progress: { [devId]: 'done' },
    });
  });

  it('clears back to absence, and clearing again is still a success', async () => {
    const { token, send, projectId, devId, qaId } = await setup();
    const strip = await addWorkItem(send, token, projectId, { parentId: null, name: 'Strip' });
    for (const stepId of [devId, qaId]) {
      await command(send, token, projectId, {
        kind: 'setProgress',
        workItemId: strip,
        stepId,
        state: 'done',
      });
    }

    const first = await command(send, token, projectId, {
      kind: 'clearProgress',
      workItemId: strip,
      stepId: devId,
    });
    const again = await command(send, token, projectId, {
      kind: 'clearProgress',
      workItemId: strip,
      stepId: devId,
    });

    expect([first.status, again.status]).toEqual([200, 200]);
    expect(((await first.json()) as { results: unknown[] }).results).toEqual([{ index: 0 }]);
    // The other step is untouched and the cleared one is **absent** rather than
    // `not_started`.
    //
    // The row still reads `done`, and that is the rule rather than a leak: Dev
    // has no estimate and no recorded day on this row, so retracting the only
    // thing anybody ever said about it leaves Dev with no work here at all — and
    // `done` is unanimous across the steps that *have* work. A Dev estimate on
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
    const { token, send, projectId, devId } = await setup();
    const res = await command(send, token, projectId, {
      kind: 'clearProgress',
      workItemId: crypto.randomUUID(),
      stepId: devId,
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', at: 0, kind: 'clearProgress' });
  });
});
