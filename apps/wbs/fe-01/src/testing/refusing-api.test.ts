import { describe, expect, it, vi } from 'vitest';

import { fakeProjectApi } from './fake-project-api';
import { refusingApi } from './refusing-api';
import { planRead, workItemView } from './views';

describe('refusingApi contract boundary', () => {
  it('validates a directly stated tree rather than exempting every tree answer', async () => {
    const api = refusingApi({
      tree: () => Promise.resolve({ ...planRead(), seq: 'next' } as never),
    });

    await expect(api.tree('p1')).rejects.toThrow('fake_invalid_response');
  });

  it('does not normalize a null optional tree list as an absent compatibility field', async () => {
    const api = refusingApi({
      tree: () =>
        Promise.resolve(planRead({ workItems: [workItemView({ tagIds: null } as never)] })),
    });

    await expect(api.tree('p1')).rejects.toThrow('fake_invalid_response');
  });

  it('starts a direct marker mutation immediately with its normalized facade input', async () => {
    const received: unknown[] = [];
    const api = refusingApi({
      createCalendarMarker: (projectId, marker) => {
        received.push({ projectId, marker });
        return Promise.resolve({ id: 'marker-1', ...marker, color: '#123456' });
      },
    });

    const created = api.createCalendarMarker('p1', {
      date: '2026-09-07',
      name: 'Cut',
      color: undefined,
    });

    expect(received).toEqual([{ projectId: 'p1', marker: { date: '2026-09-07', name: 'Cut' } }]);
    await expect(created).resolves.toEqual({
      id: 'marker-1',
      date: '2026-09-07',
      name: 'Cut',
      color: '#123456',
    });
  });

  it('refuses a normalized-away required marker field before mutation', async () => {
    const renameCalendarMarker = vi.fn(() =>
      Promise.resolve({ id: 'marker-1', date: '2026-09-07', name: 'Cut', color: '#123456' }),
    );
    const api = refusingApi({ renameCalendarMarker });

    await expect(api.renameCalendarMarker('p1', 'marker-1', undefined as never)).rejects.toThrow(
      'fake_invalid_request',
    );
    expect(renameCalendarMarker).not.toHaveBeenCalled();
  });

  it('refuses a normalized-away required marker color before mutation', async () => {
    const recolorCalendarMarker = vi.fn(() =>
      Promise.resolve({ id: 'marker-1', date: '2026-09-07', name: 'Cut', color: '#123456' }),
    );
    const api = refusingApi({ recolorCalendarMarker });

    await expect(api.recolorCalendarMarker('p1', 'marker-1', undefined as never)).rejects.toThrow(
      'fake_invalid_request',
    );
    expect(recolorCalendarMarker).not.toHaveBeenCalled();
  });

  it('does not repair a missing required project-list facade field', async () => {
    const api = refusingApi({
      listProjects: () =>
        Promise.resolve([
          {
            id: 'project-1',
            restricted: false,
            lastOpenedAt: null,
            ownerName: 'Ada',
            startDate: null,
            createdAt: 1,
          },
        ] as never),
    });

    await expect(api.listProjects()).rejects.toThrow('fake_invalid_response');
  });

  it('does not repair a missing required created-project facade field', async () => {
    const api = refusingApi({
      createProject: () => Promise.resolve({ id: 'project-1', name: 'Plan' } as never),
    });

    await expect(api.createProject('Plan')).rejects.toThrow('fake_invalid_response');
  });

  it.each(['undo', 'redo'] as const)(
    'returns only the validated %s facade fields',
    async (method) => {
      const api = refusingApi({
        [method]: () =>
          Promise.resolve({ ok: true, done: 'rename', detail: null, unchecked: true } as never),
      });

      await expect(api[method]('p1')).resolves.toEqual({
        ok: true,
        done: 'rename',
        detail: null,
      });
    },
  );

  it('refuses a truthy non-boolean facade discriminator', async () => {
    const api = refusingApi({
      undo: () => Promise.resolve({ ok: 'yes', done: 'rename', detail: null } as never),
    });

    await expect(api.undo('p1')).rejects.toThrow('fake_invalid_response');
  });

  it('does not rewrite a malformed step-removal discriminant into in_use', async () => {
    const api = refusingApi({
      removeStep: () =>
        Promise.resolve({
          ok: false,
          reason: 'taken',
          inUse: {
            estimates: 0,
            actuals: 0,
            progress: 0,
            measures: 0,
            assignments: 0,
            assumedAssignees: [],
          },
        } as never),
    });

    await expect(api.removeStep('p1', 'step-dev', false)).rejects.toThrow('fake_invalid_response');
  });

  it('does not rewrite a malformed tag-write discriminant into taken', async () => {
    const api = refusingApi({
      renameTag: () =>
        Promise.resolve({ ok: false, reason: 'in_use', survivingName: 'Existing' } as never),
    });

    await expect(api.renameTag('tag-1', 'Changed')).rejects.toThrow('fake_invalid_response');
  });

  it('does not rewrite a malformed tag-removal discriminant into in_use', async () => {
    const api = refusingApi({
      removeTag: () =>
        Promise.resolve({
          ok: false,
          reason: 'taken',
          usage: { projects: [], members: [] },
        } as never),
    });

    await expect(api.removeTag('tag-1', false)).rejects.toThrow('fake_invalid_response');
  });

  it('builds a checked wrapper for every method stated by the complete fake', () => {
    const api = fakeProjectApi();

    expect(() => {
      Object.values(api);
    }).not.toThrow();
  });

  it('refuses malformed dependency reach before the stateful fake mutates', async () => {
    const api = fakeProjectApi();
    const before = (await api.tree('p1')).depReach;

    const outcome = await api.setDepReach('p1', 'quantum' as never).then(
      () => 'resolved',
      (cause: unknown) => (cause instanceof Error ? cause.message : cause),
    );
    const after = await api.tree('p1').then(
      (plan) => plan.depReach,
      (cause: unknown) => (cause instanceof Error ? cause.message : cause),
    );

    expect({ outcome, after }).toEqual({ outcome: 'fake_invalid_request', after: before });
  });

  it('refuses an empty project id before dependency reach mutates', async () => {
    const api = fakeProjectApi();
    const before = (await api.tree('p1')).depReach;

    await expect(api.setDepReach('', 'anchor-slice')).rejects.toThrow('fake_invalid_request');

    expect((await api.tree('p1')).depReach).toBe(before);
  });

  it('refuses a dot-segment project id before a work item is created', async () => {
    const api = fakeProjectApi();
    const before = (await api.tree('p1')).workItems.length;

    await expect(api.createWorkItem('.', { parentId: null })).rejects.toThrow(
      'fake_invalid_request',
    );

    expect((await api.tree('p1')).workItems).toHaveLength(before);
  });

  it('mutates from the normalized patch and leaves an undefined name absent', async () => {
    const api = fakeProjectApi();
    const made = await api.createWorkItem('p1', { parentId: null, name: 'Original' });

    await expect(api.patchWorkItem(made.id, { name: undefined })).resolves.toBeUndefined();

    const plan = await api.tree('p1');
    expect(plan.workItems.find((row) => row.id === made.id)?.name).toBe('Original');
  });

  it('refuses a malformed project command before the stated mutation runs', async () => {
    const setEstimate = vi.fn(() => Promise.resolve());
    const api = refusingApi({ setEstimate });

    await expect(
      api.setEstimate('work-1', 'step-1', {
        optimistic: 1,
        realistic: 2,
        pessimistic: 3,
        extra: true,
      } as never),
    ).rejects.toThrow('fake_invalid_request');
    expect(setEstimate).not.toHaveBeenCalled();
  });

  it('refuses a malformed directory command before the stated mutation runs', async () => {
    const addPerson = vi.fn(() =>
      Promise.resolve({ id: 'person-1', name: 'Ada', kind: 'person' as const, teamIds: [] }),
    );
    const api = refusingApi({ addPerson });

    await expect(api.addPerson('Ada', [7] as never)).rejects.toThrow('fake_invalid_request');
    expect(addPerson).not.toHaveBeenCalled();
  });

  // The real `createPerson` answer carries no memberships: `personEntity` in
  // `work-item.routes.ts` is `{ id, name, kind }` and the batch entity in
  // `work-item-shapes.ts` declares `'teamIds?'`. Production stopped requiring
  // the field in 732614df and this fake did not, so it rejected the one shape
  // be-01 actually sends. Proof: before that was fixed this case failed with
  // `fake_invalid_response`.
  it('accepts a created person with no memberships, the shape createPerson really answers', async () => {
    const addPerson = vi.fn(() =>
      Promise.resolve({ id: 'person-1', name: 'Ada', kind: 'person' as const }),
    );
    const api = refusingApi({ addPerson });

    await expect(api.addPerson('Ada', [])).resolves.toEqual({
      id: 'person-1',
      name: 'Ada',
      kind: 'person',
    });
    expect(addPerson).toHaveBeenCalledWith('Ada', []);
  });

  it('refuses malformed project creation before the stated mutation runs', async () => {
    const createProject = vi.fn(() =>
      Promise.resolve({ id: 'project-1', name: 'Plan', restricted: false }),
    );
    const api = refusingApi({ createProject });

    await expect(api.createProject(7 as never)).rejects.toThrow('fake_invalid_request');
    expect(createProject).not.toHaveBeenCalled();
  });

  it('refuses a malformed project list before a screen can read it', async () => {
    const api = refusingApi({
      listProjects: () =>
        Promise.resolve([
          {
            id: 'project-1',
            name: 'Plan',
            restricted: false,
            lastOpenedAt: null,
            ownerName: 'Ada',
            startDate: null,
            createdAt: 'yesterday',
          },
        ] as never),
    });

    await expect(api.listProjects()).rejects.toThrow('fake_invalid_response');
  });

  it('refuses a malformed created work-item id before a screen can read it', async () => {
    const api = refusingApi({ createWorkItem: () => Promise.resolve({ id: 7 } as never) });

    await expect(api.createWorkItem('p1', { parentId: null })).rejects.toThrow(
      'fake_invalid_response',
    );
  });

  it('passes only the normalized facade input to a stated work-item creation', async () => {
    const createWorkItem = vi.fn(() => Promise.resolve({ id: 'work-1' }));
    const api = refusingApi({ createWorkItem });

    await api.createWorkItem('p1', { parentId: null, name: undefined });

    expect(createWorkItem).toHaveBeenCalledWith('p1', { parentId: null });
  });

  it('keeps a stated delete options object present after its undefined strategy leaves the wire', async () => {
    const removeWorkItem = vi.fn(() => Promise.resolve());
    const api = refusingApi({ removeWorkItem });

    const removal = api.removeWorkItem('work-1', { strategy: undefined });

    expect(removeWorkItem).toHaveBeenCalledWith('work-1', { strategy: undefined });
    await expect(removal).resolves.toBeUndefined();
  });

  it('reconstructs a project-command facade answer from the validated reply', async () => {
    const api = refusingApi({
      createWorkItem: () => Promise.resolve({ id: 'work-1', unchecked: true } as never),
    });

    await expect(api.createWorkItem('p1', { parentId: null })).resolves.toEqual({ id: 'work-1' });
  });

  it('reconstructs a directory-command facade answer from the validated reply', async () => {
    const api = refusingApi({
      addTag: () => Promise.resolve({ id: 'tag-1', name: 'Risk', unchecked: true } as never),
    });

    await expect(api.addTag('Risk')).resolves.toEqual({ id: 'tag-1', name: 'Risk' });
  });

  it('refuses malformed modeled undo detail before a screen can branch on it', async () => {
    const api = refusingApi({
      undo: () => Promise.resolve({ ok: false, reason: 'stale_undo', detail: 7 } as never),
    });

    await expect(api.undo('p1')).rejects.toThrow('fake_invalid_response');
  });

  it('refuses malformed optimizer settings before the stated mutation runs', async () => {
    const setOptimizationSettings = vi.fn(() => Promise.resolve());
    const api = refusingApi({ setOptimizationSettings });

    await expect(
      api.setOptimizationSettings('p1', { scheduleEngine: 'quantum' } as never),
    ).rejects.toThrow('fake_invalid_request');
    expect(setOptimizationSettings).not.toHaveBeenCalled();
  });

  it('refuses a malformed stated request before the answer can mutate', async () => {
    const addStep = vi.fn(() => Promise.resolve({ id: 'step-dev', name: 'Dev' }));
    const api = refusingApi({ addStep });

    await expect(api.addStep('p1', 7 as never)).rejects.toThrow('fake_invalid_request');
    expect(addStep).not.toHaveBeenCalled();
  });

  it('refuses a malformed stated directory answer before a screen can read it', async () => {
    const api = refusingApi({
      listTeams: () => Promise.resolve([{ id: 'team-1', name: 'Delivery' }] as never),
    });

    await expect(api.listTeams()).rejects.toThrow('fake_invalid_response');
  });

  it('refuses a malformed modeled step refusal before a screen can branch on it', async () => {
    const api = refusingApi({
      removeStep: () =>
        Promise.resolve({ ok: false, reason: 'in_use', inUse: { estimates: 1 } } as never),
    });

    await expect(api.removeStep('p1', 'step-dev', false)).rejects.toThrow('fake_invalid_response');
  });
});
