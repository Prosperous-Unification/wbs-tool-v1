import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, expect, test } from 'bun:test';

import { hashCanonical } from '../evidence/content-manifest';
import { openAuthorityStore } from './authority-store';
import { acquireClaims, expandClaims } from './claims';
import { abandonGeneration } from './generations';
import { createAdmissionPacket, expandPacketReads } from './packet';
import { submitPacket } from './submit';

const scratch: string[] = [];

afterAll(() => {
  for (const path of scratch) rmSync(path, { force: true, recursive: true });
});

function git(repository: string, argv: readonly string[]): string {
  const invocation = Bun.spawnSync(['git', '-C', repository, ...argv], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (invocation.exitCode !== 0) throw new Error(invocation.stderr.toString('utf8'));
  const output = invocation.stdout.toString('utf8');
  return output.endsWith('\n') ? output.slice(0, -1) : output;
}

function fixture() {
  const repository = mkdtempSync(join(tmpdir(), 'wiki-submit-'));
  scratch.push(repository);
  git(repository, ['init', '--quiet']);
  git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  git(repository, ['config', 'user.name', 'Fixture']);
  mkdirSync(join(repository, 'src'));
  writeFileSync(join(repository, 'src', 'owned.ts'), 'export const owned = 1;\n');
  writeFileSync(join(repository, 'src', 'read.ts'), 'export const read = 1;\n');
  writeFileSync(join(repository, 'outside.ts'), 'outside\n');
  symlinkSync('src/owned.ts', join(repository, 'owned-link'));
  symlinkSync('owned.ts', join(repository, 'src', 'owned-link'));
  git(repository, ['add', '.']);
  git(repository, ['commit', '--quiet', '--message', 'base']);
  const root = realpathSync(repository);
  const baseCommit = git(root, ['rev-parse', 'HEAD']);
  const baseTree = git(root, ['rev-parse', 'HEAD^{tree}']);
  const store = openAuthorityStore(root);
  const token = acquireClaims(store, {
    owner: { sessionId: 'session-a', worktreePath: root },
    paths: [
      { access: 'write', path: 'src' },
      { access: 'read', path: 'src/read.ts' },
    ],
    conflictGroups: [],
  });
  const packet = createAdmissionPacket(store, token, root, {
    base: { commit: baseCommit, tree: baseTree },
    checks: ['check.typecheck'],
    conflictGroups: [],
    consumedContracts: ['contract.read'],
    consumedInterfaces: ['interface.read'],
    evidenceRequirements: ['evidence.check-receipt'],
    invariants: ['invariant.no-contract-regression'],
    mappingIdentity: '2'.repeat(64),
    objective: 'Change the owned implementation',
    outcome: 'The owned implementation is updated',
    ownedPaths: ['src'],
    policyIdentity: '1'.repeat(64),
    producedContracts: ['contract.owned'],
    producedInterfaces: ['interface.owned'],
    readPaths: ['src/read.ts'],
  });
  return { baseCommit, packet, repository: root, store, token };
}

test('freezes an exact staged publication before atomically submitting its generation', () => {
  const subject = fixture();
  expect(subject.packet).toMatchObject({
    base: { commit: subject.baseCommit },
    checks: ['check.typecheck'],
    conflictGroups: [],
    consumedContracts: ['contract.read'],
    consumedInterfaces: ['interface.read'],
    evidenceRequirements: ['evidence.check-receipt'],
    generation: subject.token.generation,
    invariants: ['invariant.no-contract-regression'],
    mappingIdentity: '2'.repeat(64),
    objective: 'Change the owned implementation',
    outcome: 'The owned implementation is updated',
    ownedPaths: ['src'],
    policyIdentity: '1'.repeat(64),
    producedContracts: ['contract.owned'],
    producedInterfaces: ['interface.owned'],
    sessionId: subject.token.sessionId,
    worktreePath: subject.repository,
  });
  expect(subject.packet.packetIdentity).toMatch(/^[0-9a-f]{64}$/);
  expect(subject.packet.readDependencies).toEqual([
    {
      blob: git(subject.repository, ['rev-parse', `${subject.baseCommit}:src/read.ts`]),
      mode: '100644',
      path: 'src/read.ts',
    },
  ]);
  writeFileSync(join(subject.repository, 'src', 'owned.ts'), 'export const owned = 2;\n');
  git(subject.repository, ['add', 'src/owned.ts']);

  const report = submitPacket(subject.store, subject.packet, subject.repository, {
    base: subject.baseCommit,
    kind: 'staged',
  });

  expect(report.status).toBe('submitted');
  expect(report.baseRelationship).toBe('index-based-on-packet-head');
  expect(report.patchIdentity).toMatch(/^[0-9a-f]{64}$/);
  expect(report.candidateDiffIdentity).toMatch(/^[0-9a-f]{64}$/);
  expect(report.contentIdentity).toMatch(/^[0-9a-f]{64}$/);
  expect(report.scope).toBe(
    'publication violations were detected and refused at submission; editing-time writes were not prevented',
  );
  expect(subject.store.inspect().generations[0]?.status).toBe('submitted');
  subject.store.close();
});

test('refuses every unowned changed path and leaves authority working', () => {
  for (const mutation of ['addition', 'deletion', 'mode', 'rename-destination'] as const) {
    const subject = fixture();
    if (mutation === 'addition') writeFileSync(join(subject.repository, 'new-outside.ts'), 'new\n');
    if (mutation === 'deletion') rmSync(join(subject.repository, 'outside.ts'));
    if (mutation === 'mode') chmodSync(join(subject.repository, 'outside.ts'), 0o755);
    if (mutation === 'rename-destination') {
      git(subject.repository, ['mv', 'src/owned.ts', 'renamed-outside.ts']);
    }
    git(subject.repository, ['add', '--all']);

    expect(() =>
      submitPacket(subject.store, subject.packet, subject.repository, {
        base: subject.baseCommit,
        kind: 'staged',
      }),
    ).toThrow('publication refused: changed path is outside packet write claims');
    expect(subject.store.inspect().generations[0]?.status).toBe('working');
    subject.store.close();
  }
});

test('accounts for owned additions, deletions, rename sides, modes and symlink blobs', () => {
  for (const [mutation, change, expected] of [
    [
      'addition',
      (repository: string): void => {
        writeFileSync(join(repository, 'src', 'added.ts'), 'new\n');
      },
      ['src/added.ts'],
    ],
    [
      'deletion',
      (repository: string): void => {
        rmSync(join(repository, 'src', 'owned.ts'));
      },
      ['src/owned.ts'],
    ],
    [
      'rename',
      (repository: string): void => {
        git(repository, ['mv', 'src/owned.ts', 'src/renamed.ts']);
      },
      ['src/owned.ts', 'src/renamed.ts'],
    ],
    [
      'mode',
      (repository: string): void => {
        chmodSync(join(repository, 'src', 'owned.ts'), 0o755);
      },
      ['src/owned.ts'],
    ],
    [
      'symlink',
      (repository: string): void => {
        rmSync(join(repository, 'src', 'owned-link'));
        symlinkSync('../outside.ts', join(repository, 'src', 'owned-link'));
      },
      ['src/owned-link'],
    ],
  ] as const) {
    const subject = fixture();
    change(subject.repository);
    git(subject.repository, ['add', '--all']);
    const report = submitPacket(subject.store, subject.packet, subject.repository, {
      base: subject.baseCommit,
      kind: 'staged',
    });
    expect(report.changedPaths, mutation).toEqual(expected);
    subject.store.close();
  }
});

test('refuses a changed pinned read and a packet path traversing a symlink', () => {
  const changed = fixture();
  writeFileSync(join(changed.repository, 'src', 'read.ts'), 'export const read = 2;\n');
  git(changed.repository, ['add', 'src/read.ts']);
  expect(() =>
    submitPacket(changed.store, changed.packet, changed.repository, {
      base: changed.baseCommit,
      kind: 'staged',
    }),
  ).toThrow('publication refused: read dependency changed');
  expect(changed.store.inspect().generations[0]?.status).toBe('working');
  changed.store.close();

  const escaped = fixture();
  expect(() =>
    createAdmissionPacket(escaped.store, escaped.token, escaped.repository, {
      ...escaped.packet,
      ownedPaths: ['../outside.ts'],
      readPaths: ['src/read.ts'],
    }),
  ).toThrow('invalid canonical claim path');
  escaped.store.close();
});

test('read expansion adds only pinned reads and cannot upgrade packet writes', () => {
  const subject = fixture();
  const expanded = expandPacketReads(subject.store, subject.packet, subject.repository, [
    'outside.ts',
  ]);
  expect(expanded.readDependencies.map(({ path }) => path)).toEqual(['outside.ts', 'src/read.ts']);
  expect(expanded.ownedPaths).toEqual(['src']);
  expect(() =>
    expandPacketReads(subject.store, expanded, subject.repository, ['src/owned.ts']),
  ).toThrow('read expansion cannot overlap packet write claims');
  expect(subject.store.inspect().generations[0]?.claims).toHaveLength(3);
  subject.store.close();
});

test('owns a symlink blob exactly but refuses claims below symlinks and gitlinks', () => {
  const subject = fixture();
  expandClaims(subject.store, {
    conflictGroups: [],
    paths: [{ access: 'write', path: 'owned-link' }],
    token: subject.token,
  });
  const exact = createAdmissionPacket(subject.store, subject.token, subject.repository, {
    ...subject.packet,
    conflictGroups: [],
    ownedPaths: ['owned-link', 'src'],
    readPaths: ['src/read.ts'],
  });
  expect(exact.ownedPaths).toContain('owned-link');

  expandClaims(subject.store, {
    conflictGroups: [],
    paths: [{ access: 'write', path: 'owned-link/escaped.ts' }],
    token: subject.token,
  });
  expect(() =>
    createAdmissionPacket(subject.store, subject.token, subject.repository, {
      ...subject.packet,
      conflictGroups: [],
      ownedPaths: ['owned-link', 'owned-link/escaped.ts', 'src'],
      readPaths: ['src/read.ts'],
    }),
  ).toThrow('packet path traverses symlink');
  abandonGeneration(subject.store, subject.token);
  git(subject.repository, [
    'update-index',
    '--add',
    '--cacheinfo',
    `160000,${subject.baseCommit},vendor`,
  ]);
  git(subject.repository, ['commit', '--quiet', '--message', 'gitlink']);
  const gitlinkBase = {
    commit: git(subject.repository, ['rev-parse', 'HEAD']),
    tree: git(subject.repository, ['rev-parse', 'HEAD^{tree}']),
  };
  const gitlinkToken = acquireClaims(subject.store, {
    conflictGroups: [],
    owner: { sessionId: 'session-gitlink', worktreePath: subject.repository },
    paths: [
      { access: 'write', path: 'vendor/escaped.ts' },
      { access: 'read', path: 'src/read.ts' },
    ],
  });
  expect(() =>
    createAdmissionPacket(subject.store, gitlinkToken, subject.repository, {
      ...subject.packet,
      base: gitlinkBase,
      conflictGroups: [],
      ownedPaths: ['vendor/escaped.ts'],
      readPaths: ['src/read.ts'],
    }),
  ).toThrow('packet path traverses gitlink');
  subject.store.close();
});

test('atomically refuses submission when authority claims changed after packet creation', () => {
  const subject = fixture();
  expandClaims(subject.store, {
    conflictGroups: [],
    paths: [{ access: 'read', path: 'outside.ts' }],
    token: subject.token,
  });
  writeFileSync(join(subject.repository, 'src', 'owned.ts'), 'export const owned = 2;\n');
  git(subject.repository, ['add', 'src/owned.ts']);
  expect(() =>
    submitPacket(subject.store, subject.packet, subject.repository, {
      base: subject.baseCommit,
      kind: 'staged',
    }),
  ).toThrow('generation authority differs from admission packet');
  expect(subject.store.inspect().generations[0]?.status).toBe('working');
  subject.store.close();
});

test('records a committed descendant relationship and refuses stale staged HEAD', () => {
  const committed = fixture();
  writeFileSync(join(committed.repository, 'src', 'owned.ts'), 'export const owned = 2;\n');
  git(committed.repository, ['add', 'src/owned.ts']);
  git(committed.repository, ['commit', '--quiet', '--message', 'candidate']);
  const revision = git(committed.repository, ['rev-parse', 'HEAD']);
  expect(
    submitPacket(committed.store, committed.packet, committed.repository, {
      kind: 'committed',
      revision,
    }).baseRelationship,
  ).toBe('commit-descends-from-packet-base');
  committed.store.close();

  const staged = fixture();
  writeFileSync(join(staged.repository, 'outside.ts'), 'successor\n');
  git(staged.repository, ['add', 'outside.ts']);
  git(staged.repository, ['commit', '--quiet', '--message', 'advanced head']);
  expect(() =>
    submitPacket(staged.store, staged.packet, staged.repository, {
      base: staged.baseCommit,
      kind: 'staged',
    }),
  ).toThrow('staged candidate is not based on packet base HEAD');
  expect(staged.store.inspect().generations[0]?.status).toBe('working');
  staged.store.close();
});

test('production CLI reports submission detection scope and rejects undeclared packet fields', () => {
  const subject = fixture();
  writeFileSync(join(subject.repository, 'src', 'owned.ts'), 'export const owned = 2;\n');
  git(subject.repository, ['add', 'src/owned.ts']);
  const packetPath = join(subject.repository, '.git', 'packet.json');
  writeFileSync(packetPath, `${JSON.stringify(subject.packet)}\n`);
  subject.store.close();
  const cli = join(import.meta.dir, '..', 'cli.ts');
  const accepted = Bun.spawnSync(
    [
      process.execPath,
      cli,
      'submit-admission',
      subject.repository,
      packetPath,
      'staged',
      subject.baseCommit,
    ],
    { stderr: 'pipe', stdout: 'pipe' },
  );
  expect(accepted.exitCode).toBe(0);
  expect(JSON.parse(accepted.stdout.toString('utf8'))).toMatchObject({
    scope:
      'publication violations were detected and refused at submission; editing-time writes were not prevented',
    status: 'submitted',
  });

  const malformed = fixture();
  const malformedPath = join(malformed.repository, '.git', 'packet.json');
  writeFileSync(
    malformedPath,
    `${JSON.stringify({ ...malformed.packet, extraWrites: ['outside.ts'] })}\n`,
  );
  malformed.store.close();
  const refused = Bun.spawnSync(
    [
      process.execPath,
      cli,
      'submit-admission',
      malformed.repository,
      malformedPath,
      'staged',
      malformed.baseCommit,
    ],
    { stderr: 'pipe', stdout: 'pipe' },
  );
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr.toString('utf8')).toContain(
    'undeclared admission packet field: extraWrites',
  );
  expect(refused.stderr.toString('utf8')).toContain('editing-time writes were not prevented');
});

test('refuses worktree aliases and read expansion from another real worktree', () => {
  const subject = fixture();
  const alias = `${subject.repository}-alias`;
  scratch.push(alias);
  symlinkSync(subject.repository, alias, 'dir');
  expect(() =>
    createAdmissionPacket(subject.store, subject.token, alias, {
      ...subject.packet,
      conflictGroups: [],
      ownedPaths: ['src'],
      readPaths: ['src/read.ts'],
    }),
  ).toThrow('worktree path is a filesystem alias');
  const sibling = `${subject.repository}-sibling`;
  scratch.push(sibling);
  git(subject.repository, ['worktree', 'add', '--quiet', '-b', 'sibling', sibling]);
  expect(() => expandPacketReads(subject.store, subject.packet, sibling, ['outside.ts'])).toThrow(
    'read expansion repository differs from packet worktree',
  );
  subject.store.close();
});

test('refuses an unrelated committed candidate and an index race before authority submission', () => {
  const unrelated = fixture();
  const revision = git(unrelated.repository, [
    'commit-tree',
    unrelated.packet.base.tree,
    '-m',
    'unrelated',
  ]);
  expect(() =>
    submitPacket(unrelated.store, unrelated.packet, unrelated.repository, {
      kind: 'committed',
      revision,
    }),
  ).toThrow('committed candidate does not descend from packet base');
  expect(unrelated.store.inspect().generations[0]?.status).toBe('working');
  unrelated.store.close();

  const raced = fixture();
  writeFileSync(join(raced.repository, 'src', 'owned.ts'), 'export const owned = 2;\n');
  git(raced.repository, ['add', 'src/owned.ts']);
  const namedWrapper = join(raced.repository, '.git', 'git');
  const marker = join(raced.repository, '.git', 'race-marker');
  const realGit = Bun.which('git');
  if (realGit === null) throw new Error('git executable unavailable');
  writeFileSync(
    namedWrapper,
    `#!/bin/sh\n"$WIKI_REAL_GIT" "$@"\ncode=$?\nif [ "$3" = "diff-tree" ] && [ ! -e "$WIKI_RACE_MARKER" ]; then\n  : > "$WIKI_RACE_MARKER"\n  printf 'raced\\n' > "$2/outside.ts"\n  "$WIKI_REAL_GIT" -C "$2" add outside.ts\nfi\nexit "$code"\n`,
  );
  chmodSync(namedWrapper, 0o755);
  const packetPath = join(raced.repository, '.git', 'race-packet.json');
  writeFileSync(packetPath, `${JSON.stringify(raced.packet)}\n`);
  raced.store.close();
  const racedCli = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, '..', 'cli.ts'),
      'submit-admission',
      raced.repository,
      packetPath,
      'staged',
      raced.baseCommit,
    ],
    {
      env: {
        ...process.env,
        PATH: `${join(raced.repository, '.git')}:${process.env['PATH'] ?? ''}`,
        WIKI_RACE_MARKER: marker,
        WIKI_REAL_GIT: realGit,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );
  expect(racedCli.exitCode).toBe(1);
  expect(racedCli.stderr.toString('utf8')).toContain(
    'candidate changed while submission was frozen',
  );
  const racedState = openAuthorityStore(raced.repository);
  expect(racedState.inspect().generations[0]?.status).toBe('working');
  racedState.close();
});

test.each([
  [
    'blank objective',
    'invalid packet objective',
    (packet: Record<string, unknown>): void => {
      packet['objective'] = ' ';
    },
  ],
  [
    'blank outcome',
    'invalid packet outcome',
    (packet: Record<string, unknown>): void => {
      packet['outcome'] = ' ';
    },
  ],
  [
    'empty checks',
    'packet requires at least one check',
    (packet: Record<string, unknown>): void => {
      packet['checks'] = [];
    },
  ],
  [
    'empty invariants',
    'packet requires at least one invariant',
    (packet: Record<string, unknown>): void => {
      packet['invariants'] = [];
    },
  ],
  [
    'empty evidence',
    'packet requires at least one evidence requirement',
    (packet: Record<string, unknown>): void => {
      packet['evidenceRequirements'] = [];
    },
  ],
  [
    'unordered owned paths',
    'noncanonical owned path order',
    (packet: Record<string, unknown>): void => {
      packet['ownedPaths'] = ['z', 'a'];
    },
  ],
  [
    'unordered checks',
    'noncanonical check order',
    (packet: Record<string, unknown>): void => {
      packet['checks'] = ['z', 'a'];
    },
  ],
  [
    'bad policy identity',
    'invalid policy identity',
    (packet: Record<string, unknown>): void => {
      packet['policyIdentity'] = 'bad';
    },
  ],
  [
    'bad mapping identity',
    'invalid mapping identity',
    (packet: Record<string, unknown>): void => {
      packet['mappingIdentity'] = 'bad';
    },
  ],
  [
    'zero generation',
    'invalid admission packet generation: 0',
    (packet: Record<string, unknown>): void => {
      packet['generation'] = 0;
    },
  ],
  [
    'invalid read mode',
    'invalid read dependency mode: 100600',
    (packet: Record<string, unknown>) => {
      const dependencies = packet['readDependencies'];
      if (
        !Array.isArray(dependencies) ||
        typeof dependencies[0] !== 'object' ||
        dependencies[0] === null
      ) {
        throw new Error('fixture read dependency absent');
      }
      Reflect.set(dependencies[0], 'mode', '100600');
    },
  ],
] as const)(
  'CLI rejects independently rehashed malformed packet: %s',
  (label, expected, mutate) => {
    const cli = join(import.meta.dir, '..', 'cli.ts');
    const subject = fixture();
    const candidate = JSON.parse(JSON.stringify(subject.packet)) as Record<string, unknown>;
    mutate(candidate);
    const { packetIdentity: _oldIdentity, ...body } = candidate;
    candidate['packetIdentity'] = hashCanonical(body);
    const packetPath = join(subject.repository, '.git', `${label.replaceAll(' ', '-')}.json`);
    writeFileSync(packetPath, `${JSON.stringify(candidate)}\n`);
    subject.store.close();
    const refusal = Bun.spawnSync(
      [
        process.execPath,
        cli,
        'submit-admission',
        subject.repository,
        packetPath,
        'staged',
        subject.baseCommit,
      ],
      { stderr: 'pipe', stdout: 'pipe' },
    );
    expect(refusal.exitCode, label).toBe(1);
    expect(refusal.stderr.toString('utf8'), label).toContain(expected);
  },
);

test('CLI rejects a packet whose bytes changed without a new packet identity', () => {
  const cli = join(import.meta.dir, '..', 'cli.ts');
  const changedIdentity = fixture();
  const identityPath = join(changedIdentity.repository, '.git', 'changed-identity.json');
  writeFileSync(
    identityPath,
    `${JSON.stringify({ ...changedIdentity.packet, outcome: 'Changed without rehashing' })}\n`,
  );
  changedIdentity.store.close();
  const identityRefusal = Bun.spawnSync(
    [
      process.execPath,
      cli,
      'submit-admission',
      changedIdentity.repository,
      identityPath,
      'staged',
      changedIdentity.baseCommit,
    ],
    { stderr: 'pipe', stdout: 'pipe' },
  );
  expect(identityRefusal.exitCode).toBe(1);
  expect(identityRefusal.stderr.toString('utf8')).toContain('admission packet identity mismatch');
});
