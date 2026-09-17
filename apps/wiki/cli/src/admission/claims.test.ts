import { expect, test } from 'bun:test';

import { MemoryAuthorityStore } from './authority-store';
import { acquireClaims, expandClaims } from './claims';

const owner = (sessionId: string, worktreePath = `/worktrees/${sessionId}`) => ({
  sessionId,
  worktreePath,
});

test('acquires every requested claim with one generation', () => {
  const store = new MemoryAuthorityStore(undefined, { read: () => 1_000 });

  expect(
    acquireClaims(store, {
      owner: owner('session-a'),
      paths: [
        { access: 'write', path: 'libs/contracts' },
        { access: 'read', path: 'apps/be-01/src' },
      ],
      conflictGroups: ['root-schema'],
    }),
  ).toEqual({ generation: 1, sessionId: 'session-a' });
  expect(store.inspect()).toEqual({
    nextGeneration: 2,
    integrations: [],
    generations: [
      {
        generation: 1,
        heartbeatAt: 1_000,
        sessionId: 'session-a',
        status: 'working',
        statusAt: 1_000,
        submission: undefined,
        worktreePath: '/worktrees/session-a',
        claims: [
          { access: 'read', kind: 'path', identity: 'apps/be-01/src' },
          { access: 'write', kind: 'path', identity: 'libs/contracts' },
          { kind: 'group', identity: 'root-schema' },
        ],
      },
    ],
  });
});

test('refuses the complete request when one path or group conflicts', () => {
  const store = new MemoryAuthorityStore();
  acquireClaims(store, {
    owner: owner('session-a'),
    paths: [{ access: 'write', path: 'libs/contracts' }],
    conflictGroups: ['root-schema'],
  });

  expect(() =>
    acquireClaims(store, {
      owner: owner('session-b'),
      paths: [
        { access: 'write', path: 'apps/fe-01' },
        { access: 'read', path: 'libs/contracts/src' },
      ],
      conflictGroups: [],
    }),
  ).toThrow('path claim overlaps session session-a: libs/contracts/src');
  expect(() =>
    acquireClaims(store, {
      owner: owner('session-c'),
      paths: [{ access: 'write', path: 'apps/gw-01' }],
      conflictGroups: ['root-schema'],
    }),
  ).toThrow('conflict-group claim belongs to session session-a: root-schema');
  expect(store.inspect().generations).toHaveLength(1);
  expect(store.inspect().nextGeneration).toBe(2);
});

test('permits disjoint writers and overlapping readers', () => {
  const store = new MemoryAuthorityStore();
  acquireClaims(store, {
    owner: owner('session-a'),
    paths: [{ access: 'read', path: 'docs' }],
    conflictGroups: [],
  });
  acquireClaims(store, {
    owner: owner('session-b'),
    paths: [
      { access: 'read', path: 'docs/plans' },
      { access: 'write', path: 'apps/fe-01' },
    ],
    conflictGroups: [],
  });

  expect(store.inspect().generations.map(({ sessionId }) => sessionId)).toEqual([
    'session-a',
    'session-b',
  ]);
});

test('refuses reused sessions and malformed identities without mutation', () => {
  const store = new MemoryAuthorityStore();
  acquireClaims(store, {
    owner: owner('session-a'),
    paths: [{ access: 'write', path: 'apps/fe-01' }],
    conflictGroups: [],
  });

  expect(() =>
    acquireClaims(store, {
      owner: owner('session-a'),
      paths: [{ access: 'write', path: 'apps/gw-01' }],
      conflictGroups: [],
    }),
  ).toThrow('session already exists: session-a');
  for (const path of ['', '/root', 'a//b', 'a/./b', 'a/../b', 'a\\b', 'a\u0000b', '\ud800']) {
    expect(() =>
      acquireClaims(store, {
        owner: owner(`bad-${String(path.length)}`),
        paths: [{ access: 'write', path }],
        conflictGroups: [],
      }),
    ).toThrow('invalid canonical claim path');
  }
  expect(store.inspect().generations).toHaveLength(1);
});

test('expands under the same owner and generation or changes nothing', () => {
  const store = new MemoryAuthorityStore();
  const first = acquireClaims(store, {
    owner: owner('session-a'),
    paths: [{ access: 'read', path: 'docs' }],
    conflictGroups: [],
  });
  acquireClaims(store, {
    owner: owner('session-b'),
    paths: [{ access: 'read', path: 'libs/contracts' }],
    conflictGroups: [],
  });

  expect(
    expandClaims(store, {
      token: first,
      paths: [
        { access: 'read', path: 'docs' },
        { access: 'write', path: 'apps/fe-01' },
      ],
      conflictGroups: ['ui-shell'],
    }),
  ).toEqual(first);
  expect(() =>
    expandClaims(store, {
      token: first,
      paths: [
        { access: 'write', path: 'apps/gw-01' },
        { access: 'write', path: 'libs' },
      ],
      conflictGroups: [],
    }),
  ).toThrow('path claim overlaps session session-b: libs');

  const session = store.inspect().generations.find(({ sessionId }) => sessionId === 'session-a');
  expect(session?.claims).toEqual([
    { access: 'write', kind: 'path', identity: 'apps/fe-01' },
    { access: 'read', kind: 'path', identity: 'docs' },
    { kind: 'group', identity: 'ui-shell' },
  ]);
  expect(store.inspect().nextGeneration).toBe(3);
});

test('upgrades a read atomically and refuses a wrong token distinctly', () => {
  const store = new MemoryAuthorityStore();
  const first = acquireClaims(store, {
    owner: owner('session-a'),
    paths: [{ access: 'read', path: 'docs' }],
    conflictGroups: [],
  });
  acquireClaims(store, {
    owner: owner('session-b'),
    paths: [{ access: 'read', path: 'docs/plans' }],
    conflictGroups: [],
  });

  expect(() =>
    expandClaims(store, {
      token: first,
      paths: [{ access: 'write', path: 'docs' }],
      conflictGroups: [],
    }),
  ).toThrow('path claim overlaps session session-b: docs');
  expect(() =>
    expandClaims(store, {
      token: { generation: 99, sessionId: 'session-a' },
      paths: [{ access: 'read', path: 'apps' }],
      conflictGroups: [],
    }),
  ).toThrow('generation mismatch for session session-a');
  expect(() =>
    expandClaims(store, {
      token: { generation: 1, sessionId: 'absent' },
      paths: [{ access: 'read', path: 'apps' }],
      conflictGroups: [],
    }),
  ).toThrow('session does not exist: absent');
  expect(store.inspect().generations[0]?.claims).toEqual([
    { access: 'read', kind: 'path', identity: 'docs' },
  ]);

  const upgradeStore = new MemoryAuthorityStore();
  const upgrade = acquireClaims(upgradeStore, {
    owner: owner('upgrade'),
    paths: [{ access: 'read', path: 'docs' }],
    conflictGroups: [],
  });
  expandClaims(upgradeStore, {
    token: upgrade,
    paths: [{ access: 'write', path: 'docs' }],
    conflictGroups: [],
  });
  expect(upgradeStore.inspect().generations[0]?.claims).toEqual([
    { access: 'write', kind: 'path', identity: 'docs' },
  ]);
});

test('rejects noncanonical worktree identities before reserving a session', () => {
  const store = new MemoryAuthorityStore();
  for (const worktreePath of ['relative', '/worktrees/../other', '/worktrees/bad\\alias']) {
    expect(() =>
      acquireClaims(store, {
        owner: owner(`session-${String(worktreePath.length)}`, worktreePath),
        paths: [{ access: 'write', path: 'apps' }],
        conflictGroups: [],
      }),
    ).toThrow('invalid canonical worktree path');
  }
  expect(store.inspect().generations).toEqual([]);
});

test('rejects a session identity outside the strict authority alphabet', () => {
  const store = new MemoryAuthorityStore();
  expect(() =>
    acquireClaims(store, {
      owner: owner('bad/session'),
      paths: [{ access: 'write', path: 'apps' }],
      conflictGroups: [],
    }),
  ).toThrow('invalid session id: bad/session');
  expect(() =>
    acquireClaims(store, {
      owner: owner('valid-session'),
      paths: [],
      conflictGroups: ['bad/group'],
    }),
  ).toThrow('invalid conflict group: bad/group');
  expect(store.inspect().generations).toEqual([]);
});

test('fails closed before overflowing the persisted generation counter', () => {
  const store = new MemoryAuthorityStore({
    generations: [],
    integrations: [],
    nextGeneration: Number.MAX_SAFE_INTEGER,
  });
  expect(() =>
    acquireClaims(store, {
      owner: owner('session-a'),
      paths: [{ access: 'write', path: 'apps' }],
      conflictGroups: [],
    }),
  ).toThrow('authority generation exhausted');
  expect(store.inspect()).toEqual({
    generations: [],
    integrations: [],
    nextGeneration: Number.MAX_SAFE_INTEGER,
  });
});

test('rejects a state whose next generation can collide with an existing owner', () => {
  expect(
    () =>
      new MemoryAuthorityStore({
        nextGeneration: 1,
        integrations: [],
        generations: [
          {
            claims: [],
            generation: 1,
            heartbeatAt: 1_000,
            sessionId: 'session-a',
            status: 'working',
            statusAt: 1_000,
            worktreePath: '/worktrees/session-a',
          },
        ],
      }),
  ).toThrow('authority next generation does not follow existing generations');
});

test('refuses an asynchronous transaction callback before committing its pending state', () => {
  const store = new MemoryAuthorityStore();
  expect(() =>
    store.transact((transaction) => {
      transaction.writeState({ generations: [], integrations: [], nextGeneration: 2 });
      return Promise.resolve();
    }),
  ).toThrow('authority transaction callback must be synchronous');
  expect(store.inspect()).toEqual({ generations: [], integrations: [], nextGeneration: 1 });
});
