import { expect, test } from 'bun:test';

import { type AuthorityClock, MemoryAuthorityStore } from './authority-store';
import { acquireClaims, expandClaims } from './claims';
import {
  abandonGeneration,
  fenceExpiredGenerations,
  heartbeatGeneration,
  integrateGeneration,
  rejectGeneration,
  releaseGeneration,
  type SubmissionIdentity,
  submitGeneration,
} from './generations';

const PATCH = '1'.repeat(64);
const DIFF = '2'.repeat(64);
const CONTENT = '3'.repeat(64);
const OTHER_PATCH = '4'.repeat(64);

class ControlledClock implements AuthorityClock {
  now = 1_000;

  read(): number {
    return this.now;
  }
}

function fixture() {
  const clock = new ControlledClock();
  const store = new MemoryAuthorityStore(undefined, clock);
  const token = acquireClaims(store, {
    owner: { sessionId: 'session-a', worktreePath: '/worktrees/session-a' },
    paths: [{ access: 'write', path: 'tools/tool-wiki' }],
    conflictGroups: ['wiki-authority'],
  });
  return { clock, store, token };
}

const submission: SubmissionIdentity = {
  candidateDiffIdentity: DIFF,
  contentIdentity: CONTENT,
  patchIdentity: PATCH,
};

test('heartbeats use the store clock and expiry fences for investigation without releasing claims', () => {
  const { clock, store, token } = fixture();
  clock.now = 1_050;
  expect(heartbeatGeneration(store, token)).toEqual(token);
  clock.now = 1_149;
  expect(fenceExpiredGenerations(store, 100)).toEqual([]);
  clock.now = 1_150;
  expect(fenceExpiredGenerations(store, 100)).toEqual([token]);

  const generation = store.inspect().generations[0];
  expect(generation).toMatchObject({
    claims: [
      { access: 'write', identity: 'tools/tool-wiki', kind: 'path' },
      { identity: 'wiki-authority', kind: 'group' },
    ],
    heartbeatAt: 1_050,
    status: 'investigating',
    statusAt: 1_150,
  });
  expect(() => heartbeatGeneration(store, token)).toThrow('generation is fenced for investigation');
  expect(() => submitGeneration(store, token, submission)).toThrow(
    'generation is fenced for investigation',
  );
});

test('submission freezes one exact identity and keeps claims until integration', () => {
  const { clock, store, token } = fixture();
  clock.now = 1_010;
  expect(submitGeneration(store, token, submission)).toEqual(token);
  expect(store.inspect().generations[0]).toMatchObject({
    claims: [
      { access: 'write', identity: 'tools/tool-wiki', kind: 'path' },
      { identity: 'wiki-authority', kind: 'group' },
    ],
    status: 'submitted',
    submission,
  });

  expect(() => submitGeneration(store, token, submission)).toThrow('generation already submitted');
  expect(() =>
    submitGeneration(store, token, { ...submission, patchIdentity: OTHER_PATCH }),
  ).toThrow('generation already submitted');
  expect(() => releaseGeneration(store, token)).toThrow('submitted generation cannot be released');
  expect(() =>
    expandClaims(store, {
      token,
      paths: [{ access: 'write', path: 'apps/fe-01' }],
      conflictGroups: [],
    }),
  ).toThrow('generation is not working');

  clock.now = 1_020;
  expect(integrateGeneration(store, token)).toEqual(token);
  expect(store.inspect().generations[0]).toMatchObject({ claims: [], status: 'integrated' });
});

test('exact release is idempotent while wrong-generation release preserves a successor', () => {
  const { clock, store, token } = fixture();
  clock.now = 1_010;
  expect(releaseGeneration(store, token)).toEqual(token);
  clock.now = 999;
  expect(releaseGeneration(store, token)).toEqual(token);

  clock.now = 1_020;
  const successor = acquireClaims(store, {
    owner: { sessionId: 'session-a', worktreePath: '/worktrees/session-a' },
    paths: [{ access: 'write', path: 'tools/tool-wiki' }],
    conflictGroups: [],
  });
  expect(successor.generation).toBe(2);
  expect(releaseGeneration(store, token)).toEqual(token);
  expect(() => releaseGeneration(store, { generation: 99, sessionId: 'session-a' })).toThrow(
    'generation does not exist',
  );
  expect(store.inspect().generations.find(({ generation }) => generation === 2)).toMatchObject({
    claims: [{ access: 'write', identity: 'tools/tool-wiki', kind: 'path' }],
    status: 'working',
  });
});

test('rejection and abandonment free claims for a new generation', () => {
  for (const finish of [rejectGeneration, abandonGeneration]) {
    const { clock, store, token } = fixture();
    clock.now = 1_010;
    expect(finish(store, token)).toEqual(token);
    clock.now = 1_020;
    const successor = acquireClaims(store, {
      owner: { sessionId: 'session-b', worktreePath: '/worktrees/session-b' },
      paths: [{ access: 'write', path: 'tools/tool-wiki/src' }],
      conflictGroups: ['wiki-authority'],
    });
    expect(successor.generation).toBe(2);
    expect(store.inspect().generations[0]?.claims).toEqual([]);
  }
});

test('rejection and abandonment retain an already frozen submission identity', () => {
  for (const finish of [rejectGeneration, abandonGeneration]) {
    const { clock, store, token } = fixture();
    clock.now = 1_010;
    submitGeneration(store, token, submission);
    clock.now = 1_020;
    expect(finish(store, token)).toEqual(token);
    expect(store.inspect().generations[0]).toMatchObject({ claims: [], submission });
  }
});

test('every old-writer mutation is fenced after successor acquisition', () => {
  const { clock, store, token } = fixture();
  clock.now = 1_010;
  rejectGeneration(store, token);
  clock.now = 1_020;
  const successor = acquireClaims(store, {
    owner: { sessionId: 'session-b', worktreePath: '/worktrees/session-b' },
    paths: [{ access: 'write', path: 'tools/tool-wiki' }],
    conflictGroups: [],
  });
  const operations = [
    () => heartbeatGeneration(store, token),
    () => submitGeneration(store, token, submission),
    () => integrateGeneration(store, token),
    () => rejectGeneration(store, token),
    () => abandonGeneration(store, token),
    () => releaseGeneration(store, token),
  ];
  for (const operation of operations) expect(operation).toThrow('generation is terminal');
  expect(() =>
    expandClaims(store, {
      token,
      paths: [{ access: 'write', path: 'apps/stale' }],
      conflictGroups: [],
    }),
  ).toThrow('generation is not working');
  expect(
    store.inspect().generations.find(({ generation }) => generation === successor.generation),
  ).toMatchObject({ status: 'working' });
});

test('a rejected submitted generation cannot integrate after a successor acquires', () => {
  const { clock, store, token } = fixture();
  clock.now = 1_010;
  submitGeneration(store, token, submission);
  clock.now = 1_020;
  rejectGeneration(store, token);
  clock.now = 1_030;
  const successor = acquireClaims(store, {
    owner: { sessionId: 'session-b', worktreePath: '/worktrees/session-b' },
    paths: [{ access: 'write', path: 'tools/tool-wiki' }],
    conflictGroups: [],
  });
  expect(() => integrateGeneration(store, token)).toThrow('generation is terminal');
  expect(
    store.inspect().generations.find(({ generation }) => generation === successor.generation),
  ).toMatchObject({ status: 'working' });
});

test('malformed submission identities and clock regressions refuse without mutation', () => {
  for (const [field, message] of [
    ['patchIdentity', 'invalid patch identity'],
    ['candidateDiffIdentity', 'invalid candidate diff identity'],
    ['contentIdentity', 'invalid content identity'],
  ] as const) {
    const { store, token } = fixture();
    const before = store.inspect();
    expect(() => submitGeneration(store, token, { ...submission, [field]: 'not-sha256' })).toThrow(
      message,
    );
    expect(store.inspect()).toEqual(before);
  }

  for (const timestamp of [-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    const { clock, store, token } = fixture();
    const before = store.inspect();
    clock.now = timestamp;
    expect(() => heartbeatGeneration(store, token)).toThrow('invalid authority clock timestamp');
    expect(store.inspect()).toEqual(before);
  }

  const regression = fixture();
  const beforeRegression = regression.store.inspect();
  regression.clock.now = 999;
  expect(() => heartbeatGeneration(regression.store, regression.token)).toThrow(
    'authority clock regressed',
  );
  expect(regression.store.inspect()).toEqual(beforeRegression);
});

test('expiry rejects non-finite or unbounded durations at the trusted lifecycle boundary', () => {
  const { store } = fixture();
  for (const duration of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => fenceExpiredGenerations(store, duration)).toThrow(
      'invalid heartbeat expiry duration',
    );
  }
});

test('acquisition refuses a regressed trusted clock after terminal history', () => {
  const { clock, store, token } = fixture();
  clock.now = 1_010;
  releaseGeneration(store, token);
  clock.now = 1_009;
  expect(() =>
    acquireClaims(store, {
      owner: { sessionId: 'session-b', worktreePath: '/worktrees/session-b' },
      paths: [{ access: 'write', path: 'apps/fe-01' }],
      conflictGroups: [],
    }),
  ).toThrow('authority clock regressed');
  expect(store.inspect().generations).toHaveLength(1);
});

test('memory state refuses malformed lifecycle records before ownership decisions', () => {
  const base = {
    claims: [],
    generation: 1,
    heartbeatAt: 1_000,
    sessionId: 'session-a',
    status: 'working' as const,
    statusAt: 1_000,
    worktreePath: '/worktrees/session-a',
  };
  const invalidStates = [
    { ...base, heartbeatAt: -1 },
    { ...base, statusAt: 999 },
    { ...base, status: 'submitted' as const },
    { ...base, status: 'released' as const, submission },
    {
      ...base,
      claims: [{ access: 'write' as const, identity: 'tools/wiki', kind: 'path' as const }],
      status: 'integrated' as const,
      submission,
    },
    { ...base, status: 'unknown' as never },
  ];
  for (const generation of invalidStates) {
    expect(
      () => new MemoryAuthorityStore({ generations: [generation], nextGeneration: 2 }),
    ).toThrow();
  }
  expect(
    () =>
      new MemoryAuthorityStore({
        generations: [base, { ...base, generation: 2 }],
        nextGeneration: 3,
      }),
  ).toThrow('duplicate active authority session');
});

test('memory authority refuses a malformed trusted clock adapter during construction', () => {
  expect(() => new MemoryAuthorityStore(undefined, {} as never)).toThrow(
    'invalid authority clock adapter',
  );
});

test('lifecycle operations reject malformed generation tokens without mutation', () => {
  const { store, token } = fixture();
  const before = store.inspect();
  expect(() => heartbeatGeneration(store, { ...token, sessionId: 'bad/session' })).toThrow(
    'invalid session id',
  );
  for (const generation of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    expect(() => heartbeatGeneration(store, { ...token, generation })).toThrow(
      'invalid generation',
    );
  }
  expect(store.inspect()).toEqual(before);
});
