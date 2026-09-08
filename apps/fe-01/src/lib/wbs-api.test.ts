import { automaticColor } from '@wbs/domain/marker-color';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sentenceForRefusal } from './refusal';
import {
  type DirectoryEffect,
  directoryRefusalSentence,
  type DirectoryUsage,
  httpDirectoryApi,
  httpProjectApi,
  STEP_REFUSALS,
  type StepUsage,
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
    workItems: ids.map((id, position) => ({
      id,
      projectId,
      parentId: null,
      position,
      name: id,
      notes: '',
      frozenNumber: null,
      startNoEarlierThan: null,
      startNoEarlierThanReason: null,
      deadline: null,
      priority: null,
      serviceTeamId: null,
      serviceId: null,
      maxParallel: 1,
      revision: 0,
      teamIds: [],
      tagIds: [],
      serviceIds: [],
      typeIds: [],
      externalRefs: [],
      number: String(position + 1).padStart(3, '0'),
      estimates: {},
      rolledUp: false,
      actuals: {},
      progress: {},
      state: 'not_started',
      measures: {},
      dependsOn: [],
      finalDays: {},
      finalTotal: 0,
      schedule: {
        duration: 0,
        estimated: false,
        earliestStart: 0,
        earliestFinish: 0,
        latestStart: 0,
        latestFinish: 0,
        float: 0,
        critical: true,
      },
      dates: null,
      assignees: {},
      doesEveryStep: null,
    })),
    seq: 1,
    scheduleError: null,
    waitingForPerson: 0,
    waitingForCapacity: 0,
    slices: [],
    steps: [],
    assignedPeople: [],
    teamCapacities: [],
    priorityBands: [],
    estimateMethod: 'pert',
    pertWeights: { optimistic: 1, realistic: 4, pessimistic: 1 },
    estimateRounding: 'ceil',
    depReach: 'whole-item',
    startDate: null,
    projectRevision: 1,
    undoable: false,
    redoable: false,
  });

/** What be-01 answers a first, uncascaded removal of a step somebody is using. */
const IN_USE: StepUsage = {
  estimates: 2,
  actuals: 0,
  progress: 0,
  measures: 0,
  assignments: 1,
  assumedAssignees: [{ workItemId: 'w2', assumedNow: null, assumedAfter: 'p1' }],
};

const PROJECT = {
  id: 'p1',
  name: 'Plan',
  ownerId: 'owner',
  restricted: false,
  estimateMethod: 'pert',
  depReach: 'whole-item',
  pertWeights: { optimistic: 1, realistic: 4, pessimistic: 1 },
  estimateRounding: 'ceil',
  startDate: null,
  solutionRef: null,
  revision: 0,
  createdAt: 0,
  optimizationEnabled: false,
  scheduleEngine: 'fast',
  scheduleObjective: 'pri',
};

beforeEach(() => {
  vi.stubGlobal('location', { origin: 'http://wbs.test' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('removing a step', () => {
  it('reads the counts out of the refusal rather than throwing the code', async () => {
    // The whole reason this call models one refusal instead of throwing it:
    // `inUse` is what the confirmation is made of.
    // Proof: the `in_use` branch deleted so the 409 falls through to the throw
    // below, this failed on `promise rejected "Error: in_use" instead of
    // resolving`. Watched, 2026-08-09.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(response(409, JSON.stringify({ error: 'in_use', inUse: IN_USE }))),
      ),
    );
    await expect(httpProjectApi('t').removeStep('p1', 'step-qa', false)).resolves.toEqual({
      ok: false,
      reason: 'in_use',
      inUse: IN_USE,
    });
  });

  it('throws a 409 that is not the refusal this client models', async () => {
    // There is no such answer from `stepController` today. The branch exists so
    // that if one ever arrives it is a failure somebody sees, rather than being
    // read as an `in_use` with no counts in it.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(409, JSON.stringify({ error: 'taken' })))),
    );
    await expect(httpProjectApi('t').removeStep('p1', 'step-qa', false)).rejects.toThrow(
      'invalid_response',
    );
  });

  it('throws an in_use with no counts rather than confirming against nothing', async () => {
    // A body claiming the refusal without the numbers is a be-01 that has
    // changed shape. Confirming a cascade from an empty confirmation is exactly
    // the silent-default this repository refuses.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(409, JSON.stringify({ error: 'in_use' })))),
    );
    await expect(httpProjectApi('t').removeStep('p1', 'step-qa', false)).rejects.toThrow(
      'invalid_response',
    );
  });

  it('asks for the cascade only when it is given one', async () => {
    const fetched = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(response(204, '')),
    );
    vi.stubGlobal('fetch', fetched);
    const api = httpProjectApi('t');
    await api.removeStep('p1', 'step-qa', false);
    await api.removeStep('p1', 'step-qa', true);
    expect(fetched.mock.calls.map((call) => call[0])).toEqual([
      '/api/projects/p1/steps/step-qa',
      '/api/projects/p1/steps/step-qa?cascade=true',
    ]);
  });

  it('answers a removal be-01 performed outright', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(204, ''))),
    );
    await expect(httpProjectApi('t').removeStep('p1', 'step-qa', false)).resolves.toEqual({
      ok: true,
    });
  });
});

describe('adding and renaming a step', () => {
  it('sends the name and answers with the step', async () => {
    const fetched = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(
        response(
          200,
          JSON.stringify({ step: { id: 'r3', projectId: 'p1', name: 'Design', position: 0 } }),
        ),
      ),
    );
    vi.stubGlobal('fetch', fetched);
    await expect(httpProjectApi('t').addStep('p1', 'Design')).resolves.toEqual({
      id: 'r3',
      name: 'Design',
    });
    expect(fetched.mock.calls[0]?.[0]).toBe('/api/projects/p1/steps');
    expect(fetched.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ name: 'Design' }));
  });

  it('throws be-01’s code for a duplicate, for the caller to phrase', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(409, JSON.stringify({ error: 'taken' })))),
    );
    await expect(httpProjectApi('t').renameStep('p1', 'r3', 'Dev')).rejects.toMatchObject({
      message: 'taken',
      problem: {
        kind: 'refusal',
        operation: 'patchApiProjectsByIdStepsByStepId',
        refusal: { error: 'taken' },
      },
    });
  });
});

describe('what a refused step change says', () => {
  it('has a sentence for every code stepController answers with', () => {
    // The list is `statusFor` in `apps/be-01/src/controller/step.controller.ts`
    // plus `unknown_step`, which the estimate and assignee writes answer with
    // once a step has gone. A code with no sentence would reach a toast as
    // itself, which is what this change exists to stop.
    for (const code of [
      'taken',
      'name_required',
      'in_use',
      'unknown_step',
      'not_found',
      'forbidden',
    ]) {
      const sentence = sentenceForRefusal(STEP_REFUSALS, code);
      expect(sentence).not.toContain(code);
      expect(sentence.endsWith('.')).toBe(true);
    }
  });

  it('names the code it does not know rather than swallowing it', () => {
    // Not a default sentence with the code dropped: an unrecognised refusal is
    // something to report, and a message that hid it would leave nobody able to
    // say what be-01 answered.
    expect(sentenceForRefusal(STEP_REFUSALS, 'http_502')).toContain('http_502');
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
            { kind: 'assignment_dropped', step: { id: 'r1', name: 'Dev' } },
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
    await api.patchWorkItem('w1', { teamIds: ['team-b', 'team-a'] });

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

describe('setting the estimate arithmetic', () => {
  it('patches the weights and the rounding in one request', async () => {
    // One `PATCH`, not two: the weights and the rounding are one arithmetic,
    // and two requests would take the plan through an intermediate answer
    // nobody asked for — every figure in it recomputed twice.
    const fetched = stub(() => response(200, JSON.stringify({ project: PROJECT })));
    const api = httpProjectApi('t');

    await api.setEstimateArithmetic('p1', {
      pertWeights: { optimistic: 1, realistic: 1, pessimistic: 1 },
      estimateRounding: 'floor',
    });

    expect(fetched).toHaveBeenCalledTimes(1);
    expect(fetched.mock.calls[0]?.[0]).toBe('/api/projects/p1');
    expect(fetched.mock.calls[0]?.[1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({
        pertWeights: { optimistic: 1, realistic: 1, pessimistic: 1 },
        estimateRounding: 'floor',
      }),
    });
  });

  it('sends only what it was given, so a rounding change leaves the weights alone', async () => {
    // be-01 writes the three weight columns as a triple or not at all, so a
    // body carrying `pertWeights: undefined` would be a different request from
    // one that omits it — `JSON.stringify` drops the key, and this is what says
    // so out loud.
    const fetched = stub(() => response(200, JSON.stringify({ project: PROJECT })));
    const api = httpProjectApi('t');

    await api.setEstimateArithmetic('p1', { estimateRounding: 'exact' });

    expect(fetched.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ estimateRounding: 'exact' }),
    });
  });

  it('reads the arithmetic the plan was computed with off the tree', () => {
    // The wire's own claim, in the shape the client describes: a face that
    // wants to say "4 days, PERT 1/4/1, rounded up" reads all three from the
    // payload it drew the figures from.
    const tree = JSON.parse(TREE('p1', ['w1'])) as {
      pertWeights: unknown;
      estimateRounding: unknown;
    };

    expect(tree.pertWeights).toEqual({ optimistic: 1, realistic: 4, pessimistic: 1 });
    expect(tree.estimateRounding).toBe('ceil');
  });
});

describe('the directory client', () => {
  it('rejects a malformed known response field before a screen can consume it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(response(200, JSON.stringify({ teams: [{ id: 7, name: 'Wiring' }] }))),
      ),
    );

    await expect(httpDirectoryApi('t').listTeams()).rejects.toMatchObject({
      message: 'invalid_response',
      problem: {
        kind: 'failure',
        operation: 'getApiTeams',
        failure: { code: 'invalid_response' },
      },
    });
  });

  it('rejects malformed modeled refusal detail at the shared client boundary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          response(409, JSON.stringify({ error: 'in_use', at: 0, kind: 'deleteTag' })),
        ),
      ),
    );

    await expect(httpDirectoryApi('t').removeTag('t1', false)).rejects.toMatchObject({
      message: 'invalid_response',
      problem: { kind: 'failure', failure: { code: 'invalid_response' } },
    });
  });

  it('asks the reads at their paths and writes at the directory batch route', async () => {
    const fetched = stub((path) =>
      response(
        200,
        JSON.stringify(
          path.includes('/commands')
            ? {
                results: [
                  {
                    index: 0,
                    id: 'p1',
                    entity: { id: 'p1', name: 'Kat', kind: 'person' },
                  },
                ],
              }
            : path.includes('/people')
              ? { people: [] }
              : { teams: [] },
        ),
      ),
    );
    const api = httpDirectoryApi('t');
    await api.listPeople();
    await api.listTeams();
    await expect(api.addPerson('Kat', ['t1'])).resolves.toEqual({
      id: 'p1',
      name: 'Kat',
      kind: 'person',
    });

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
          results: [
            {
              index: 0,
              entity: {
                id: 'p1',
                name: 'Kat',
                kind: 'person',
                teamIds: ['t1', 't2'],
              },
            },
          ],
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
    stub(() =>
      response(409, JSON.stringify({ error: 'in_use', at: 0, kind: 'deletePerson', usage: USAGE })),
    );
    await expect(httpDirectoryApi('t').removePerson('p1', false)).resolves.toEqual({
      ok: false,
      reason: 'in_use',
      usage: USAGE,
    });
  });

  it('throws an in_use with no usage rather than confirming against nothing', async () => {
    stub(() => response(409, JSON.stringify({ error: 'in_use' })));
    await expect(httpDirectoryApi('t').removePerson('p1', false)).rejects.toThrow(
      'invalid_response',
    );
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
    stub(() =>
      response(409, JSON.stringify({ error: 'in_use', at: 0, kind: 'deleteTag', usage: tagged })),
    );
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
    stub(() =>
      response(
        409,
        JSON.stringify({ error: 'in_use', at: 0, kind: 'deleteService', usage: served }),
      ),
    );
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
      assignment_dropped: { kind: 'assignment_dropped', step: { id: 'r1', name: 'Dev' } },
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
      stub(() =>
        response(409, JSON.stringify({ error: 'in_use', at: 0, kind: 'deleteTeam', usage })),
      );
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
    await expect(httpDirectoryApi('t').removeTeam('t1', false)).rejects.toThrow('invalid_response');
  });

  it('throws a work item with no number rather than confirming against a row nobody can find', async () => {
    const noNumber = {
      projects: [
        { id: 'pr1', name: 'Rollout', workItems: [{ id: 'w7', name: 'Design', effects: [] }] },
      ],
      members: [],
    };
    stub(() =>
      response(
        409,
        JSON.stringify({ error: 'in_use', at: 0, kind: 'deletePerson', usage: noNumber }),
      ),
    );
    await expect(httpDirectoryApi('t').removePerson('p1', false)).rejects.toThrow(
      'invalid_response',
    );
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
    stub(() =>
      response(409, JSON.stringify({ error: 'taken', at: 0, kind: 'patchPerson', name: 'Kat' })),
    );
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

describe('setting project optimization', () => {
  it('patches the shared flag, engine, and objective at the project route', async () => {
    const fetched = stub(() => response(200, JSON.stringify({ project: PROJECT })));
    const api = httpProjectApi('t');

    await api.setOptimizationSettings('p1', {
      optimizationEnabled: true,
      scheduleEngine: 'optimized',
      scheduleObjective: 'time',
    });

    expect(fetched).toHaveBeenCalledTimes(1);
    expect(fetched.mock.calls[0]?.[0]).toBe('/api/projects/p1');
    expect(fetched.mock.calls[0]?.[1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({
        optimizationEnabled: true,
        scheduleEngine: 'optimized',
        scheduleObjective: 'time',
      }),
    });
  });
});

/** The JSON a request carried, or an empty string — `RequestInit.body` is wider than string. */
const bodyOf = (init: RequestInit | undefined): string =>
  typeof init?.body === 'string' ? init.body : '';

/** A batch answer with one plain result and the undo state a write returns. */
const APPLIED = JSON.stringify({ results: [{ index: 0 }], undoable: true, redoable: false });

/** The fetch stub, answering `body` to everything and keeping every call. */
function stubbed(status: number, body: string) {
  const fetched = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(response(status, body)),
  );
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
    await api.patchWorkItem('w1', { name: 'Strip it' });

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
    await expect(httpProjectApi('t').patchWorkItem('nobody', { name: 'X' })).rejects.toThrow(
      'unknown_work_item',
    );
  });

  it('posts exactly one command for every plan write, of the kind the write stands for', async () => {
    const fetched = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>((url: string) =>
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
      [
        () => api.createWorkItem('p1', { parentId: null, afterId: null, name: 'A' }),
        'createWorkItem',
      ],
      [() => api.patchWorkItem('w1', { notes: 'n' }), 'patchWorkItem'],
      [() => api.moveWorkItem('w1', null, 'w2'), 'moveWorkItem'],
      [() => api.duplicateWorkItem('w1'), 'duplicateWorkItem'],
      [() => api.removeWorkItem('w1', { strategy: 'cascade' }), 'deleteWorkItem'],
      [() => api.setEstimate('w1', 'r1', days), 'setEstimate'],
      [() => api.clearEstimate('w1', 'r1'), 'clearEstimate'],
      [() => api.assignPerson('w1', 'r1', 'k'), 'setAssignee'],
      [() => api.addDependency('w2', 'w1'), 'addDependency'],
      [() => api.removeDependency('w2', 'w1'), 'removeDependency'],
      [() => api.freezeProject('p1'), 'freezeProject'],
      [() => api.unfreezeProject('p1'), 'unfreezeProject'],
      [() => api.unfreezeWorkItem('w1'), 'unfreezeWorkItem'],
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
    await expect(
      api.createWorkItem('p1', { parentId: null, afterId: null, name: 'B' }),
    ).resolves.toEqual({
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

describe('reads asked for twice at once', () => {
  it('leaves concurrent read ownership to the coordinator', async () => {
    let settle: (value: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => {
      settle = resolve;
    });
    const fetched = vi.fn(async () => (await held).clone());
    vi.stubGlobal('fetch', fetched);
    const api = httpProjectApi('t');

    const first = api.listTeams();
    const second = api.listTeams();
    expect(fetched.mock.calls).toHaveLength(2);

    settle(
      response(200, JSON.stringify({ teams: [{ id: 'team1', name: 'Wiring', serviceIds: [] }] })),
    );
    expect(await first).toEqual(await second);
  });

  /** A completed read never supplies the answer to a later request. */
  it('asks again once the first has landed', async () => {
    const fetched = vi.fn(() => Promise.resolve(response(200, JSON.stringify({ teams: [] }))));
    vi.stubGlobal('fetch', fetched);
    const api = httpProjectApi('t');

    await api.listTeams();
    await api.listTeams();

    expect(fetched.mock.calls).toHaveLength(2);
  });

  /** Two writes to one path are two requests, even when their bodies match. */
  it('never shares a write', async () => {
    let settle: (value: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => {
      settle = resolve;
    });
    const fetched = vi.fn(() => held);
    vi.stubGlobal('fetch', fetched);
    const api = httpProjectApi('t');

    const first = api.openProject('p1');
    const second = api.openProject('p1');
    await vi.waitFor(() => {
      expect(fetched.mock.calls).toHaveLength(2);
    });

    settle(response(204, ''));
    await first;
    await second;
  });
});

describe('the calendar-marker client', () => {
  /**
   * What the route *answers*, which is never the unresolved shape: `answered()`
   * in `calendar-marker.routes.ts` resolves a stored `null` to the automatic
   * colour before sending, so a fixture spelling `color: null` here would be a
   * response be-01 cannot produce (task 284). The request bodies below keep
   * their `null` — that is a client asking for automatic, and it is correct.
   */
  const MARKER = {
    id: 'm1',
    projectId: 'p1',
    date: '2026-08-19',
    name: 'Launch',
    color: automaticColor('m1'),
    createdAt: 0,
  };

  it('reads the markers off the project route the panel draws from', async () => {
    const fetched = stub(() => response(200, JSON.stringify({ markers: [MARKER] })));

    await expect(httpProjectApi('t').listCalendarMarkers('p1')).resolves.toEqual([MARKER]);

    expect(fetched.mock.calls[0]?.[0]).toBe('/api/projects/p1/calendar-markers');
  });

  it('sends the client-named id as `markerId`, which is the only name the route reads', async () => {
    // The one place the wire name and the domain name differ: the path already
    // spends `id` on the project, so the create body calls the marker's own id
    // `markerId` and `calendar-marker.routes.ts` maps it back. A client
    // that sent `id` would have its id silently ignored and be answered a
    // marker under a different one — which is exactly the collision
    // `openapi-tools.ts` refuses to ship a tool for.
    const fetched = stub(() => response(201, JSON.stringify({ marker: MARKER })));

    await expect(
      httpProjectApi('t').createCalendarMarker('p1', {
        markerId: 'm1',
        date: '2026-08-19',
        name: 'Launch',
        color: null,
      }),
    ).resolves.toEqual(MARKER);

    expect(fetched.mock.calls[0]?.[0]).toBe('/api/projects/p1/calendar-markers');
    expect(fetched.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ markerId: 'm1', date: '2026-08-19', name: 'Launch', color: null }),
    });
  });

  it('renames with a body naming the name alone, because one naming both is refused', async () => {
    // be-01's `PATCH` takes exactly one of the two: a body carrying both asks
    // for two writes the store applies one at a time, so it answers 422 rather
    // than partially apply. A rename that also sent the marker's current colour
    // would therefore never land at all.
    const fetched = stub(() =>
      response(200, JSON.stringify({ marker: { ...MARKER, name: 'Ship' } })),
    );

    await expect(httpProjectApi('t').renameCalendarMarker('p1', 'm1', 'Ship')).resolves.toEqual({
      ...MARKER,
      name: 'Ship',
    });

    expect(fetched.mock.calls[0]?.[0]).toBe('/api/projects/p1/calendar-markers/m1');
    expect(fetched.mock.calls[0]?.[1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ name: 'Ship' }),
    });
  });

  it('puts a marker back on the automatic colour by sending `null`, not by omitting it', async () => {
    // `JSON.stringify` drops an `undefined` member entirely, so a recolour
    // written as `{ color: theChoiceOrUndefined }` would send `{}` for
    // "automatic" — a body naming neither name nor colour, which is the 422
    // arm. `null` is a stated choice and the only way to say it on this wire.
    const fetched = stub(() => response(200, JSON.stringify({ marker: MARKER })));

    await httpProjectApi('t').recolorCalendarMarker('p1', 'm1', null);

    expect(fetched.mock.calls[0]?.[1]).toMatchObject({
      method: 'PATCH',
      body: JSON.stringify({ color: null }),
    });
  });

  it('reads a removal answered 204 without a body rather than parsing nothing', async () => {
    const fetched = stub(() => response(204, ''));

    await expect(httpProjectApi('t').deleteCalendarMarker('p1', 'm1')).resolves.toBeUndefined();

    expect(fetched.mock.calls[0]?.[0]).toBe('/api/projects/p1/calendar-markers/m1');
    expect(fetched.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE' });
  });
});

describe('read ownership across API lifetimes', () => {
  it('rejects a malformed optimization variant before the tree reaches its screen', async () => {
    const tree = JSON.parse(TREE('p1', [])) as { optimization?: unknown };
    tree.optimization = {
      enabled: true,
      engine: 'optimized',
      objective: 'pri',
      inputHash: 'input',
      generation: 1,
      contractVersion: '7+test',
      budgetMs: 60_000,
      displayed: 'fast',
      variants: {
        pri: { state: 'failed', reason: 'unknown' },
        time: { state: 'idle' },
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(200, JSON.stringify(tree)))),
    );

    await expect(httpProjectApi('t').tree('p1')).rejects.toMatchObject({
      message: 'invalid_response',
      problem: { kind: 'failure', failure: { code: 'invalid_response' } },
    });
  });

  it('rejects a malformed external-reference id before the tree reaches its screen', async () => {
    const tree = JSON.parse(TREE('p1', ['w1'])) as {
      workItems: { externalRefs: unknown[] }[];
    };
    tree.workItems[0]?.externalRefs.push({
      id: 7,
      systemId: 'sys-jira',
      url: 'https://jira.example.test/browse/WBS-7',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(200, JSON.stringify(tree)))),
    );

    await expect(httpProjectApi('t').tree('p1')).rejects.toMatchObject({
      message: 'invalid_response',
      problem: { kind: 'failure', failure: { code: 'invalid_response' } },
    });
  });

  it('does not lend a pre-edit tree response to a later API owner', async () => {
    let release!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetched = vi
      .fn()
      .mockReturnValueOnce(oldResponse)
      .mockResolvedValue(response(200, TREE('p1', ['new-row'])));
    vi.stubGlobal('fetch', fetched);
    const oldRead = httpProjectApi('old-session').tree('p1');
    const newRead = httpProjectApi('new-session').tree('p1');
    release(response(200, TREE('p1', ['old-row'])));
    const [before, after] = await Promise.all([oldRead, newRead]);
    expect(before.workItems.map((row) => row.id)).toEqual(['old-row']);
    expect(after.workItems.map((row) => row.id)).toEqual(['new-row']);
    expect(fetched).toHaveBeenCalledTimes(2);
  });
});

/**
 * The transport half of the pin that `READS_THE_FULL_SCOPE_MAKES` makes at the
 * `ProjectApi` boundary, in `optimization-integration.test.tsx`.
 *
 * That one wraps the methods with a recording proxy, so it counts a call
 * ENTERING `tree` and cannot see inside it: a `tree` that quietly issued a
 * second HTTP request — a variant fetch behind the plan read — would still
 * record exactly one `tree/1` and leave both of its cases green. Sol raised it
 * as a regression-pin gap twice on TASK-324, and it was true both times.
 *
 * The two are one claim in two places and neither replaces the other. The
 * method-level multiset says WHICH reads a full-scope invalidation performs;
 * this one says each of those reads costs exactly one request, over the real
 * `httpProjectApi` and a fake `fetch`. Break either half and only that half
 * goes red, which is how they stay readable as separate facts.
 *
 * Sorted on both sides for the same reason the multiset is: what is being
 * pinned is which requests happen and how many, not the order the nine are
 * issued in.
 */
const FULL_SCOPE_PUTS_ON_THE_WIRE = [
  'GET /api/projects/p1/work-items',
  'GET /api/projects/p1',
  'GET /api/projects/p1/calendar-markers',
  'GET /api/teams',
  'GET /api/tags',
  'GET /api/services',
  'GET /api/work-item-types',
  'GET /api/external-systems',
  'GET /api/people',
];

describe('what a full-scope read puts on the wire', () => {
  it('spends exactly one request per read, so a second one inside a method is red', async () => {
    // Answered by path rather than in call order: the nine run concurrently, so
    // a positional `mockResolvedValueOnce` chain would bind an answer to
    // whichever request happened to be third and turn an ordering change into a
    // shape failure somewhere else.
    const bodies: Record<string, string | undefined> = {
      '/api/projects/p1/work-items': TREE('p1', []),
      '/api/projects/p1': JSON.stringify({ project: PROJECT, steps: [] }),
      '/api/projects/p1/calendar-markers': '{"markers":[]}',
      '/api/teams': '{"teams":[]}',
      '/api/tags': '{"tags":[]}',
      '/api/services': '{"services":[]}',
      '/api/work-item-types': '{"workItemTypes":[]}',
      '/api/external-systems': '{"externalSystems":[]}',
      '/api/people': '{"people":[]}',
    };
    const requests: string[] = [];
    const fetched = stub((path, init) => {
      requests.push(`${init?.method ?? 'GET'} ${path}`);
      const body = bodies[path.split('?')[0] ?? path];
      // An unlisted path is a request this pin does not know about; 404 so that
      // it cannot pass as a plausible empty answer.
      return response(body === undefined ? 404 : 200, body ?? '{}');
    });
    // All nine on the object a socket-driven refresh is actually handed.
    // `httpProjectApi` builds its own `httpDirectoryApi` and spreads those six
    // methods into what it returns (`wbs-api.ts:2197`, `:2237-2239`), so calling
    // them on a separately constructed directory would exercise the shared
    // implementations while missing the wiring: remap the spread to send
    // `listTags` to `directory.listServices` — type-compatible — and a pin over
    // an independent directory stays green while a real refresh asks for
    // `/api/services` twice and never asks for `/api/tags`.
    const project = httpProjectApi('t');

    // Settled rather than awaited: an unlisted path has to surface as an extra
    // entry in `requests` naming it, and not as the response-validation
    // rejection its 404 would raise first. The reads are still required to have
    // succeeded — that assertion just comes after the multiset.
    const settled = await Promise.allSettled([
      project.tree('p1'),
      project.steps('p1'),
      project.listCalendarMarkers('p1'),
      project.listTeams(),
      project.listTags(),
      project.listServices(),
      project.listWorkItemTypes(),
      project.listExternalSystems(),
      project.listPeople(),
    ]);

    expect([...requests].sort()).toEqual([...FULL_SCOPE_PUTS_ON_THE_WIRE].sort());
    expect(fetched).toHaveBeenCalledTimes(FULL_SCOPE_PUTS_ON_THE_WIRE.length);
    expect(settled.filter((read) => read.status === 'rejected')).toEqual([]);
  });

  /**
   * The case above is unconditional by construction: one fresh client, one
   * unoptimized tree, one pass. A request that is CONDITIONAL therefore slips
   * past it — Sol's mutant on TASK-342 round 2 adds a second
   * `getApiProjectsByIdWork-items` inside `httpProjectApi.tree` guarded by
   * `tree.optimization !== undefined`, or by that client having already
   * completed one tree read, and both the case above and the two method-level
   * cases in `optimization-integration.test.tsx` — which use `fakeProjectApi`
   * and never reach the wire — stay green while a real optimized project sends
   * ten requests for one full-scope refresh.
   *
   * Both guards are exercised here rather than in a third file. The branch is
   * selected by the parsed tree body and by client lifetime, and nothing in
   * socket delivery, `createPlanRefresh` or invalidation timing participates in
   * selecting it, so an end-to-end socket fixture would buy this same assertion
   * at several times the cost and with more ways to go flaky. Keeping it beside
   * `FULL_SCOPE_PUTS_ON_THE_WIRE` also keeps the claim readable as two places
   * rather than three.
   */
  it('spends the same nine on an optimized project, and again on the same client', async () => {
    const optimized = JSON.parse(TREE('p1', [])) as Record<string, unknown>;
    optimized['optimization'] = {
      enabled: true,
      engine: 'optimized',
      objective: 'pri',
      inputHash: 'same-input',
      generation: 1,
      contractVersion: '1.5+test',
      budgetMs: 60_000,
      displayed: 'pri',
      variants: { pri: { state: 'ready' }, time: { state: 'idle' } },
      comparison: { deltaDays: -2, sameOrder: true },
    };
    const bodies: Record<string, string | undefined> = {
      '/api/projects/p1/work-items': JSON.stringify(optimized),
      '/api/projects/p1': JSON.stringify({ project: PROJECT, steps: [] }),
      '/api/projects/p1/calendar-markers': '{"markers":[]}',
      '/api/teams': '{"teams":[]}',
      '/api/tags': '{"tags":[]}',
      '/api/services': '{"services":[]}',
      '/api/work-item-types': '{"workItemTypes":[]}',
      '/api/external-systems': '{"externalSystems":[]}',
      '/api/people': '{"people":[]}',
    };
    let requests: string[] = [];
    stub((path, init) => {
      requests.push(`${init?.method ?? 'GET'} ${path}`);
      const body = bodies[path.split('?')[0] ?? path];
      return response(body === undefined ? 404 : 200, body ?? '{}');
    });
    const project = httpProjectApi('t');
    const fullScope = (): Promise<PromiseSettledResult<unknown>[]> =>
      Promise.allSettled([
        project.tree('p1'),
        project.steps('p1'),
        project.listCalendarMarkers('p1'),
        project.listTeams(),
        project.listTags(),
        project.listServices(),
        project.listWorkItemTypes(),
        project.listExternalSystems(),
        project.listPeople(),
      ]);

    const first = await fullScope();

    expect([...requests].sort()).toEqual([...FULL_SCOPE_PUTS_ON_THE_WIRE].sort());

    // Cleared rather than summed, so the second refresh is measured on its own.
    // Summing would still go red under a second-read-only guard — nineteen
    // actual against eighteen expected — so this is about the failure being
    // readable, not about catching it at all: an aggregate mismatch names
    // neither pass, while a cleared log points at the refresh that grew.
    requests = [];
    const second = await fullScope();

    expect([...requests].sort()).toEqual([...FULL_SCOPE_PUTS_ON_THE_WIRE].sort());
    expect([...first, ...second].filter((read) => read.status === 'rejected')).toEqual([]);
  });
});
