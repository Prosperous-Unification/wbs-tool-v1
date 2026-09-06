import { describe, expect, it, vi } from 'vitest';

import { refusingApi } from './refusing-api';

describe('refusingApi contract boundary', () => {
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
