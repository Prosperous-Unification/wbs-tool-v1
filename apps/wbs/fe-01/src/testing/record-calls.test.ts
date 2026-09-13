import { describe, expect, it } from 'vitest';

import { fakeProjectApi } from './fake-project-api';
import { recordCalls } from './record-calls';

/**
 * What the forty-five hand-written recorders all had to get right, in one
 * place — and the one thing among them that no test of theirs could see.
 */
describe('recording what a fake client was asked to write', () => {
  it('records what it was asked and still performs it', async () => {
    // The fault this is the negative for: a recorder that pushes and returns
    // without delegating. Everything downstream still reads as a test — the
    // request is recorded, the assertion about it passes — while the fake's
    // plan never changed and every later assertion is about a screen nothing
    // wrote to.
    //
    // Proof: `return perform(...args)` replaced with `return undefined as
    // never`, this failed on `expected '' to be 'Strip'` — the row still
    // unnamed, its patch recorded and never written. Watched 2026-09-02.
    const api = fakeProjectApi();
    const created = await api.createWorkItem('p1', { parentId: null });
    const patches = recordCalls(api, 'patchWorkItem', (_id, patch) => patch);

    await api.patchWorkItem(created.id, { name: 'Strip' });

    expect(patches).toEqual([{ name: 'Strip' }]);
    const plan = await api.tree('p1');
    expect(plan.workItems.find((row) => row.id === created.id)?.name).toBe('Strip');
  });

  it('remembers the whole argument tuple when nothing says otherwise', async () => {
    const api = fakeProjectApi();
    const created = await api.createWorkItem('p1', { parentId: null });
    const calls = recordCalls(api, 'patchWorkItem');

    await api.patchWorkItem(created.id, { notes: 'sanded' });

    expect(calls).toEqual([[created.id, { notes: 'sanded' }]]);
  });

  it('records in call order, and the array the caller holds grows', async () => {
    // The array is the live one, not a copy taken at wrap time: every call site
    // reads it after the gesture it is about.
    const api = fakeProjectApi();
    const created = await api.createWorkItem('p1', { parentId: null });
    const names = recordCalls(api, 'patchWorkItem', (_id, patch) => patch.name);
    expect(names).toEqual([]);

    await api.patchWorkItem(created.id, { name: 'one' });
    await api.patchWorkItem(created.id, { name: 'two' });

    expect(names).toEqual(['one', 'two']);
  });
});
