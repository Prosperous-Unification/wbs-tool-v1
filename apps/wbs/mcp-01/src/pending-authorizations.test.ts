import { describe, expect, it } from 'bun:test';

import { PendingAuthorizations } from './pending-authorizations';

const FIRST = {
  clientId: 'client-1',
  codeChallenge: 'challenge-1',
  redirectUri: 'https://claude.ai/api/mcp/auth_callback',
  scope: 'wbs:read',
  state: 'downstream-1',
};

function pendingMaps(pending: PendingAuthorizations): {
  contexts: Map<string, unknown>;
  records: Map<string, unknown>;
} {
  const internals = pending as unknown as {
    contexts: Map<string, unknown>;
    transactions: { records: Map<string, unknown> };
  };
  return { contexts: internals.contexts, records: internals.transactions.records };
}

describe('PendingAuthorizations', () => {
  // Proof: letting the shared store read the clock directly makes one save
  // sample it four times instead of once and gives the two maps different instants.
  it('samples one clock instant while saving both records', () => {
    let clockReads = 0;
    const pending = new PendingAuthorizations({
      globalLimit: 1,
      now: () => 1_000 + clockReads++,
      perClientLimit: 1,
      ttlMs: 5_000,
    });

    expect(pending.save('binding-1', 'upstream-1', 'nonce-1', 'verifier-1', FIRST)).toBe('saved');
    const maps = pendingMaps(pending);
    expect(clockReads).toBe(1);
    expect(JSON.stringify([...maps.contexts.values()])).toContain('"expiresAt":6000');
    expect(JSON.stringify([...maps.records.values()])).toContain('"expiresAt":6000');
  });

  // Proof: omitting save's expiry sweep returns `capacity` instead of `saved`
  // at the deadline; omitting the per-client bound admits binding-2.
  it('enforces global and per-client capacity without eviction, then frees both at expiry', () => {
    let now = 1_000;
    const pending = new PendingAuthorizations({
      globalLimit: 2,
      now: () => now,
      perClientLimit: 1,
      ttlMs: 5_000,
    });

    expect(pending.save('binding-1', 'upstream-1', 'nonce-1', 'verifier-1', FIRST)).toBe('saved');
    expect(
      pending.save('binding-2', 'upstream-2', 'nonce-2', 'verifier-2', {
        ...FIRST,
        state: 'downstream-2',
      }),
    ).toBe('capacity');
    expect(
      pending.save('binding-3', 'upstream-3', 'nonce-3', 'verifier-3', {
        ...FIRST,
        clientId: 'client-2',
      }),
    ).toBe('saved');
    expect(pendingMaps(pending).contexts.size).toBe(2);

    now = 6_000;
    expect(
      pending.save('binding-4', 'upstream-4', 'nonce-4', 'verifier-4', {
        ...FIRST,
        state: 'downstream-4',
      }),
    ).toBe('saved');
    expect(pendingMaps(pending).contexts.size).toBe(1);
    expect(pendingMaps(pending).records.size).toBe(1);
  });

  // Proof: removing the collision guard lets the second save resolve and
  // overwrite the first authorization addressed by the same binding.
  it('refuses a duplicate live binding without replacing its authorization', () => {
    const pending = new PendingAuthorizations({
      globalLimit: 2,
      now: () => 1_000,
      perClientLimit: 2,
      ttlMs: 5_000,
    });
    pending.save('same-binding', 'upstream-1', 'nonce-1', 'verifier-1', FIRST);

    expect(() =>
      pending.save('same-binding', 'upstream-2', 'nonce-2', 'verifier-2', {
        ...FIRST,
        redirectUri: 'https://claude.com/api/mcp/auth_callback',
      }),
    ).toThrow('generated OIDC browser binding collided with a live authorization');
    expect(pending.consume('same-binding', 'upstream-1')).toEqual({
      authorization: FIRST,
      nonce: 'nonce-1',
      outcome: 'consumed',
      verifier: 'verifier-1',
    });
  });

  // Proof: returning `missing` instead of throwing leaves the trusted-state
  // failure undefined after proof consumption.
  it('throws when consumed proof has no matching authorization context', () => {
    const pending = new PendingAuthorizations({
      globalLimit: 1,
      now: () => 1_000,
      perClientLimit: 1,
      ttlMs: 5_000,
    });
    pending.save('binding-1', 'upstream-1', 'nonce-1', 'verifier-1', FIRST);
    pendingMaps(pending).contexts.clear();

    expect(() => pending.consume('binding-1', 'upstream-1')).toThrow(
      'consumed OIDC proof has no authorization context',
    );
  });
});
