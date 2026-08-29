import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type DirectoryEffect,
  directoryRefusalSentence,
  type DirectoryUsage,
  httpDirectoryApi,
  httpProjectApi,
  roleRefusalSentence,
  type RoleUsage,
} from './wbs-api';

/**
 * A Response as be-01 would really produce one.
 *
 * An empty body is passed as `null` rather than `''`: a 204 with a body is not
 * a response the constructor will build at all, and 204 is exactly what a
 * removal answers.
 */
const response = (status: number, body: string): Response =>
  new Response(body === '' ? null : body, { status });

/** A tree answer naming `ids` on project `projectId`, enough for the client to learn them. */
const TREE = (projectId: string, ids: string[]): string =>
  JSON.stringify({
    workItems: ids.map((id) => ({ id, projectId })),
    seq: 1,
    scheduleError: null,
    slices: [],
    roles: [],
    assignedPeople: [],
    teamCapacities: [],
    priorityBands: [],
    estimateMethod: 'pert',
    startDate: null,
    projectRevision: 1,
    undoable: false,
    redoable: false,
  });

/** What be-01 answers a first, uncascaded removal of a phase somebody is using. */
const IN_USE: RoleUsage = {
  estimates: 2,
  assignments: 1,
  assumedAssignees: [{ workItemId: 'w2', assumedNow: null, assumedAfter: 'p1' }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('removing a phase', () => {
  it('reads the counts out of the refusal rather than throwing the code', async () => {
    // The whole reason this call does not go through `send`: `send` throws the
    // `error` field and drops `inUse` with it, and `inUse` is what the
    // confirmation is made of.
    // Proof: the `in_use` branch deleted so the 409 falls through to the throw
    // below, this failed on `promise rejected "Error: in_use" instead of
    // resolving`. Watched, 2026-08-09.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(response(409, JSON.stringify({ error: 'in_use', inUse: IN_USE }))),
      ),
    );
    await expect(httpProjectApi('t').removeRole('p1', 'role-qa', false)).resolves.toEqual({
      ok: false,
      reason: 'in_use',
      inUse: IN_USE,
    });
  });

  it('throws a 409 that is not the refusal this client models', async () => {
    // There is no such answer from `roleController` today. The branch exists so
    // that if one ever arrives it is a failure somebody sees, rather than being
    // read as an `in_use` with no counts in it.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(409, JSON.stringify({ error: 'taken' })))),
    );
    await expect(httpProjectApi('t').removeRole('p1', 'role-qa', false)).rejects.toThrow('taken');
  });

  it('throws an in_use with no counts rather than confirming against nothing', async () => {
    // A body claiming the refusal without the numbers is a be-01 that has
    // changed shape. Confirming a cascade from an empty confirmation is exactly
    // the silent-default this repository refuses.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(409, JSON.stringify({ error: 'in_use' })))),
    );
    await expect(httpProjectApi('t').removeRole('p1', 'role-qa', false)).rejects.toThrow('in_use');
  });

  it('asks for the cascade only when it is given one', async () => {
    const fetched = vi.fn(() => Promise.resolve(response(204, '')));
    vi.stubGlobal('fetch', fetched);
    const api = httpProjectApi('t');
    await api.removeRole('p1', 'role-qa', false);
    await api.removeRole('p1', 'role-qa', true);
    expect(fetched.mock.calls.map((call) => call[0])).toEqual([
      '/api/projects/p1/roles/role-qa',
      '/api/projects/p1/roles/role-qa?cascade=true',
    ]);
  });

  it('answers a removal be-01 performed outright', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(204, ''))),
    );
    await expect(httpProjectApi('t').removeRole('p1', 'role-qa', false)).resolves.toEqual({
      ok: true,
    });
  });
});

describe('adding and renaming a phase', () => {
  it('sends the name and answers with the phase', async () => {
    const fetched = vi.fn(() =>
      Promise.resolve(response(200, JSON.stringify({ role: { id: 'r3', name: 'Design' } }))),
    );
    vi.stubGlobal('fetch', fetched);
    await expect(httpProjectApi('t').addRole('p1', 'Design')).resolves.toEqual({
      id: 'r3',
      name: 'Design',
    });
    expect(fetched.mock.calls[0]?.[0]).toBe('/api/projects/p1/roles');
    expect((fetched.mock.calls[0]?.[1] as RequestInit | undefined)?.body).toBe(
      JSON.stringify({ name: 'Design' }),
    );
  });

  it('throws be-01’s code for a duplicate, for the caller to phrase', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(409, JSON.stringify({ error: 'taken' })))),
    );
    await expect(httpProjectApi('t').renameRole('p1', 'r3', 'Dev')).rejects.toThrow('taken');
  });
});

describe('what a refused phase change says', () => {
  it('has a sentence for every code roleController answers with', () => {
    // The list is `statusFor` in `apps/be-01/src/controller/role.controller.ts`
    // plus `unknown_role`, which the estimate and assignee writes answer with
    // once a phase has gone. A code with no sentence would reach a toast as
    // itself, which is what this change exists to stop.
    for (const code of [
      'taken',
      'name_required',
      'in_use',
      'unknown_role',
      'not_found',
      'forbidden',
    ]) {
      const sentence = roleRefusalSentence(code);
      expect(sentence).not.toContain(code);
      expect(sentence.endsWith('.')).toBe(true);
    }
  });

  it('names the code it does not know rather than swallowing it', () => {
    // Not a default sentence with the code dropped: an unrecognised refusal is
    // something to report, and a message that hid it would leave nobody able to
    // say what be-01 answered.
    expect(roleRefusalSentence('http_502')).toContain('http_502');
  });
});

/**
 * A directory usage as be-01's `directory-usage.ts` really assembles one: both
 * halves present, a work item named by its derived number, and the flip that
 * ends with nobody.
 */
const USAGE: DirectoryUsage = {
  projects: [
    {
      id: 'pr1',
      name: 'Rollout',
      workItems: [
        {
          id: 'w7',
          number: '3.1',
          name: 'Design',
          effects: [
            { kind: 'assignment_dropped', role: { id: 'r1', name: 'Dev' } },
            { kind: 'assumed_assignee_changed', assumedNow: 'Kat', assumedAfter: null },
          ],
        },
      ],
    },
  ],
  members: [{ id: 'm1', name: 'Ada' }],
};

const stub = (answer: (path: string, init?: RequestInit) => Response) => {
  const fetched = vi.fn((path: string, init?: RequestInit) => Promise.resolve(answer(path, init)));
  vi.stubGlobal('fetch', fetched);
  return fetched;
};

describe('patching a work item team set', () => {
  it('sends the exact whole teamIds set without rewriting it to the legacy scalar', async () => {
    const fetched = stub((path) =>
      response(
        200,
        path.endsWith('/work-items')
          ? TREE('p1', ['w1'])
          : JSON.stringify({ results: [{ index: 0 }], undoable: true, redoable: false }),
      ),
    );
    const api = httpProjectApi('t');
    await api.tree('p1');
    await api.patch('w1', { teamIds: ['team-b', 'team-a'] });

    expect(fetched).toHaveBeenCalledTimes(2);
    expect(fetched.mock.calls[1]?.[0]).toBe('/api/projects/p1/commands');
    expect(fetched.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({
        commands: [
          { kind: 'patchWorkItem', patch: { teamIds: ['team-b', 'team-a'] }, workItemId: 'w1' },
        ],
      }),
    });
  });
});

describe('the directory client', () => {
  it('asks the reads at their paths and writes at the directory batch route', async () => {
    const fetched = stub((path) =>
      response(
        200,
        JSON.stringify(
          path.includes('/commands')
            ? { results: [{ index: 0, id: 'p1', entity: { id: 'p1', name: 'Kat' } }] }
            : path.includes('/people')
              ? { people: [] }
              : { teams: [] },
        ),
      ),
    );
    const api = httpDirectoryApi('t');
    await api.listPeople();
    await api.listTeams();
    await expect(api.addPerson('Kat', ['t1'])).resolves.toEqual({ id: 'p1', name: 'Kat' });

    expect(fetched.mock.calls.map((call) => call[0])).toEqual([
      '/api/people',
      '/api/teams',
      '/api/directory/commands',
    ]);
    expect(fetched.mock.calls[2]?.[1]?.body).toBe(
      JSON.stringify({ commands: [{ kind: 'createPerson', name: 'Kat', teamIds: ['t1'] }] }),
    );
    expect(fetched.mock.calls[2]?.[1]?.method).toBe('POST');
  });

  it('sends exactly the memberships it is given, and nothing about the name', async () => {
    const fetched = stub(() =>
      response(
        200,
        JSON.stringify({
          results: [{ index: 0, entity: { id: 'p1', name: 'Kat', teamIds: ['t1', 't2'] } }],
        }),
      ),
    );
    await httpDirectoryApi('t').patchPerson('p1', { teamIds: ['t1', 't2'] });

    expect(fetched.mock.calls[0]?.[0]).toBe('/api/directory/commands');
    expect(fetched.mock.calls[0]?.[1]?.method).toBe('POST');
    // No `name` key at all: an absent name leaves it alone at be-01, and a
    // `{ name: undefined }` would have to be told apart from the absence by
    // every layer below.
    expect(fetched.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        commands: [{ kind: 'patchPerson', personId: 'p1', patch: { teamIds: ['t1', 't2'] } }],
      }),
    );
  });

  it('reads the usage out of the refusal rather than throwing the code', async () => {
    stub(() => response(409, JSON.stringify({ error: 'in_use', usage: USAGE })));
    await expect(httpDirectoryApi('t').removePerson('p1', false)).resolves.toEqual({
      ok: false,
      reason: 'in_use',
      usage: USAGE,
    });
  });

  it('throws an in_use with no usage rather than confirming against nothing', async () => {
    stub(() => response(409, JSON.stringify({ error: 'in_use' })));
    await expect(httpDirectoryApi('t').removePerson('p1', false)).rejects.toThrow('in_use');
  });

  it('reads a tag usage, whose one effect is the arm only tags and services emit', async () => {
    // The defect this case exists for, found on dev 2026-08-21: the parse below
    // knew three of its own type's five arms, `label_removed` not among them,
    // so a tag that labels any row was refused whole — the generic
    // "could not be changed (in_use)" banner, no dialog, and therefore no way
    // to reach the `?cascade=true` second ask. An unremovable entry, from a
    // payload be-01 had assembled correctly.
    const tagged: DirectoryUsage = {
      projects: [
        {
          id: 'pr1',
          name: 'Rollout',
          workItems: [
            { id: 'w7', number: '3.1', name: 'Design', effects: [{ kind: 'label_removed' }] },
          ],
        },
      ],
      members: [],
    };
    stub(() => response(409, JSON.stringify({ error: 'in_use', usage: tagged })));
    await expect(httpDirectoryApi('t').removeTag('tag1', false)).resolves.toEqual({
      ok: false,
      reason: 'in_use',
      usage: tagged,
    });
  });

  it('reads a service usage, because one arm serves two dimensions', async () => {
    // `removeService`'s own jsdoc: be-01 answers a service's usage with
    // `label_removed` "like a tag's and not as the `label_nulled` a team's
    // does". Proving the fix on the tag alone would prove it on half the
    // removals that reach this arm.
    const served: DirectoryUsage = {
      projects: [
        {
          id: 'pr1',
          name: 'Rollout',
          workItems: [
            { id: 'w7', number: '3.1', name: 'Design', effects: [{ kind: 'label_removed' }] },
          ],
        },
      ],
      members: [],
    };
    stub(() => response(409, JSON.stringify({ error: 'in_use', usage: served })));
    await expect(httpDirectoryApi('t').removeService('svc1', false)).resolves.toEqual({
      ok: false,
      reason: 'in_use',
      usage: served,
    });
  });

  it('carries every arm of the effect type through the parse, one at a time', async () => {
    // A `Record` keyed by the union's own `kind` rather than a hand-written
    // list: a sixth arm added to `DirectoryEffect` fails the typecheck here
    // until it is given a payload, which is the check that was missing when
    // `label_removed` was added and the parse was not told. `capacity_released`
    // is in it because it was the *second* arm the guard did not know — a team
    // whose project carries a capacity would have been as unremovable as the
    // tag, and no case had ever sent one over the wire.
    //
    // One effect per payload, not five in a list: `every` passes a list whose
    // unknown arm sits beside a known one only if it knows them all, but a
    // failure would not say which arm was refused.
    const oneOfEach: Record<DirectoryEffect['kind'], DirectoryEffect> = {
      assignment_dropped: { kind: 'assignment_dropped', role: { id: 'r1', name: 'Dev' } },
      label_nulled: { kind: 'label_nulled' },
      label_removed: { kind: 'label_removed' },
      capacity_released: { kind: 'capacity_released', size: 4, fromId: 'w7' },
      assumed_assignee_changed: {
        kind: 'assumed_assignee_changed',
        assumedNow: 'Kat',
        assumedAfter: null,
      },
    };
    for (const effect of Object.values(oneOfEach)) {
      const usage: DirectoryUsage = {
        projects: [
          {
            id: 'pr1',
            name: 'Rollout',
            workItems: [{ id: 'w7', number: '3.1', name: 'Design', effects: [effect] }],
          },
        ],
        members: [],
      };
      stub(() => response(409, JSON.stringify({ error: 'in_use', usage })));
      await expect(httpDirectoryApi('t').removeTeam('t1', false)).resolves.toEqual({
        ok: false,
        reason: 'in_use',
        usage,
      });
    }
  });

  it('throws a usage missing its members rather than drawing an empty impact list', async () => {
    // The half that matters most: a team nothing but memberships points at is
    // refused **because** of those memberships, and a confirmation drawn from a
    // usage with no `members` key would show an empty list while people were
    // about to lose one.
    stub(() =>
      response(409, JSON.stringify({ error: 'in_use', usage: { projects: USAGE.projects } })),
    );
    await expect(httpDirectoryApi('t').removeTeam('t1', false)).rejects.toThrow('in_use');
  });

  it('throws a work item with no number rather than confirming against a row nobody can find', async () => {
    const noNumber = {
      projects: [
        { id: 'pr1', name: 'Rollout', workItems: [{ id: 'w7', name: 'Design', effects: [] }] },
      ],
      members: [],
    };
    stub(() => response(409, JSON.stringify({ error: 'in_use', usage: noNumber })));
    await expect(httpDirectoryApi('t').removePerson('p1', false)).rejects.toThrow('in_use');
  });

  it('carries the cascade on the command as it is given', async () => {
    const fetched = stub(() => response(200, JSON.stringify({ results: [{ index: 0 }] })));
    const api = httpDirectoryApi('t');
    await api.removePerson('p1', false);
    await api.removeTeam('t1', true);
    expect(fetched.mock.calls.map((call) => call[1]?.body)).toEqual([
      JSON.stringify({ commands: [{ kind: 'deletePerson', personId: 'p1', cascade: false }] }),
      JSON.stringify({ commands: [{ kind: 'deleteTeam', teamId: 't1', cascade: true }] }),
    ]);
  });

  it('answers a removal be-01 performed outright', async () => {
    stub(() => response(200, JSON.stringify({ results: [{ index: 0 }] })));
    await expect(httpDirectoryApi('t').removeTeam('t1', false)).resolves.toEqual({ ok: true });
  });

  it('throws a 2xx that carries no entry rather than putting nothing on the panel', async () => {
    stub(() => response(200, JSON.stringify({ results: [{ index: 0 }] })));
    await expect(httpDirectoryApi('t').patchTeam('t1', { name: 'Platform' })).rejects.toThrow(
      'unexpected_response',
    );
  });
});

describe('what a refused directory change says', () => {
  it('answers the taken refusal with the name that survived, not the one that was typed', async () => {
    // be-01 trims, so ` Kat ` collides with `Kat` and answers `name: 'Kat'`.
    // A sentence built from the local draft — which still holds the untrimmed
    // spelling — would quote a name the directory does not hold, and this is
    // what makes that impossible to pass vacuously.
    stub(() => response(409, JSON.stringify({ error: 'taken', name: 'Kat' })));
    const refusal = await httpDirectoryApi('t').patchPerson('p2', { name: ' Kat ' });

    expect(refusal).toEqual({ ok: false, reason: 'taken', survivingName: 'Kat' });
    if (refusal.ok) throw new Error('the refusal was read as a success');
    const sentence = directoryRefusalSentence(refusal);
    expect(sentence).toContain('“Kat”');
    expect(sentence).not.toContain('“ Kat ”');
  });

  it('has a sentence for every code the directory routes answer with', () => {
    // The list is `statusFor` and `DirectoryRefusal` in
    // `apps/be-01/src/service/directory.service.ts`, plus the one this client
    // raises itself. A code with no sentence would reach the page as itself.
    for (const code of [
      'name_required',
      'not_found',
      'nothing_to_change',
      'unknown_team',
      'unexpected_response',
    ]) {
      const sentence = directoryRefusalSentence({ reason: 'refused', code });
      expect(sentence).not.toContain(code);
      expect(sentence.endsWith('.')).toBe(true);
    }
  });

  it('names the code it does not know rather than rendering nothing', () => {
    // Proof: the `default` arm replaced by `return ''`, this failed on
    // `expected '' to contain 'http_502'` — an unknown refusal reaching the
    // page as an empty alert. Watched 2026-08-09.
    expect(directoryRefusalSentence({ reason: 'refused', code: 'http_502' })).toContain('http_502');
  });
});

/** The JSON a request carried, or an empty string — `RequestInit.body` is wider than string. */
const bodyOf = (init: RequestInit | undefined): string =>
  typeof init?.body === 'string' ? init.body : '';

/** A batch answer with one plain result and the undo state a write returns. */
const APPLIED = JSON.stringify({ results: [{ index: 0 }], undoable: true, redoable: false });

/** The fetch stub, answering `body` to everything and keeping every call. */
function stubbed(status: number, body: string) {
  const fetched = vi.fn(() => Promise.resolve(response(status, body)));
  vi.stubGlobal('fetch', fetched);
  return {
    calls: () =>
      fetched.mock.calls.map((call) => {
        const [url, init] = call as [string, RequestInit | undefined];
        return { url, method: init?.method ?? 'GET', body: init?.body };
      }),
  };
}

describe('the browser writes through command batches (plan-commands)', () => {
  it('sends a rename as one commands request carrying one patchWorkItem', async () => {
    // The route is the project’s, and `patch` is given a work item id: the
    // client knows the project from the tree it read that row in.
    const fetched = vi.fn((url: string) =>
      Promise.resolve(response(200, url.endsWith('/work-items') ? TREE('p1', ['w1']) : APPLIED)),
    );
    vi.stubGlobal('fetch', fetched);
    const api = httpProjectApi('t');
    await api.tree('p1');
    await api.patch('w1', { name: 'Strip it' });

    const [, write] = fetched.mock.calls as [unknown, [string, RequestInit]];
    expect(write[0]).toBe('/api/projects/p1/commands');
    expect(write[1].method).toBe('POST');
    expect(JSON.parse(bodyOf(write[1]))).toEqual({
      commands: [{ kind: 'patchWorkItem', workItemId: 'w1', patch: { name: 'Strip it' } }],
    });
  });

  it('refuses to write to a row no tree has shown it, rather than guessing a project', async () => {
    // Proof: the projects map made to answer the first project it ever saw,
    // this failed on `expected …rejects.toThrow('unknown_work_item')`. Watched,
    // 2026-08-29.
    stubbed(200, APPLIED);
    await expect(httpProjectApi('t').patch('nobody', { name: 'X' })).rejects.toThrow(
      'unknown_work_item',
    );
  });

  it('posts exactly one command for every plan write, of the kind the write stands for', async () => {
    const fetched = vi.fn((url: string) =>
      Promise.resolve(
        response(
          200,
          url.endsWith('/work-items')
            ? TREE('p1', ['w1', 'w2'])
            : JSON.stringify({
                results: [{ index: 0, id: 'new' }],
                undoable: true,
                redoable: false,
              }),
        ),
      ),
    );
    vi.stubGlobal('fetch', fetched);
    const api = httpProjectApi('t');
    await api.tree('p1');
    const days = { optimistic: 1, realistic: 2, pessimistic: 3 };
    const writes: [() => Promise<unknown>, string][] = [
      [() => api.create('p1', { parentId: null, afterId: null, name: 'A' }), 'createWorkItem'],
      [() => api.patch('w1', { notes: 'n' }), 'patchWorkItem'],
      [() => api.move('w1', null, 'w2'), 'moveWorkItem'],
      [() => api.duplicate('w1'), 'duplicateWorkItem'],
      [() => api.remove('w1', { strategy: 'cascade' }), 'deleteWorkItem'],
      [() => api.setEstimate('w1', 'r1', days), 'setEstimate'],
      [() => api.clearEstimate('w1', 'r1'), 'clearEstimate'],
      [() => api.assign('w1', 'r1', 'k'), 'setAssignee'],
      [() => api.addDependency('w2', 'w1'), 'addDependency'],
      [() => api.removeDependency('w2', 'w1'), 'removeDependency'],
      [() => api.freeze('p1'), 'freezeProject'],
      [() => api.unfreezeProject('p1'), 'unfreezeProject'],
      [() => api.unfreeze('w1'), 'unfreezeWorkItem'],
      [() => api.setTeamCapacity('p1', 'team1', 3), 'setCapacity'],
      [() => api.setPriorityBands('p1', []), 'setPriorityBands'],
    ];
    for (const [write, kind] of writes) {
      const before = fetched.mock.calls.length;
      await write();
      const made = fetched.mock.calls.slice(before) as [string, RequestInit][];
      expect(
        made.map(([url]) => url),
        kind,
      ).toEqual(['/api/projects/p1/commands']);
      const body = JSON.parse(bodyOf(made[0]?.[1])) as { commands: { kind: string }[] };
      expect(
        body.commands.map((each) => each.kind),
        kind,
      ).toEqual([kind]);
    }
    // And the create answers the id the batch minted, as the route did.
    await expect(api.create('p1', { parentId: null, afterId: null, name: 'B' })).resolves.toEqual({
      id: 'new',
    });
  });

  it('writes the directory at its own route, answering the entry the batch produced', async () => {
    stubbed(
      200,
      JSON.stringify({
        results: [{ index: 0, ref: undefined, id: 't1', entity: { id: 't1', name: 'regulatory' } }],
      }),
    );
    const api = httpDirectoryApi('t');
    await expect(api.addTag('regulatory')).resolves.toEqual({ id: 't1', name: 'regulatory' });
    const { calls } = stubbed(
      200,
      JSON.stringify({ results: [{ index: 0, entity: { id: 't1', name: 'legal' } }] }),
    );
    await expect(api.renameTag('t1', 'legal')).resolves.toEqual({
      ok: true,
      entry: { id: 't1', name: 'legal' },
    });
    expect(calls()[0]).toMatchObject({ url: '/api/directory/commands', method: 'POST' });
    expect(JSON.parse(bodyOf({ body: calls()[0]?.body }))).toEqual({
      commands: [{ kind: 'patchTag', tagId: 't1', name: 'legal' }],
    });
  });

  it('models a taken name and an in-use removal off the batch refusal, as before', async () => {
    stubbed(409, JSON.stringify({ error: 'taken', at: 0, kind: 'patchTag', name: 'legal' }));
    await expect(httpDirectoryApi('t').renameTag('t1', 'legal')).resolves.toEqual({
      ok: false,
      reason: 'taken',
      survivingName: 'legal',
    });
    const usage = { projects: [], members: [] };
    stubbed(409, JSON.stringify({ error: 'in_use', at: 0, kind: 'deleteTag', usage }));
    const removal = await httpDirectoryApi('t').removeTag('t1', false);
    expect(removal.ok).toBe(false);
    if (!removal.ok) expect(removal.reason).toBe('in_use');
  });
});
