import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test } from 'bun:test';

import { readCandidate } from './read-candidate';

const repositories: string[] = [];

function runGit(repository: string, argv: string[]): string {
  const invocation = Bun.spawnSync(['git', '-C', repository, ...argv], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const stderr = invocation.stderr.toString('utf8');
  expect(invocation.exitCode, stderr).toBe(0);
  return invocation.stdout.toString('utf8').trim();
}

function createRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), 'tool-wiki-reader-'));
  repositories.push(repository);
  runGit(repository, ['init', '--initial-branch=main']);
  runGit(repository, ['config', 'user.email', 'reader@example.test']);
  runGit(repository, ['config', 'user.name', 'Reader Fixture']);
  return repository;
}

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { force: true, recursive: true });
  }
});

test('preserves Git path bytes, executable modes and symlink blobs from a committed tree', () => {
  const repository = createRepository();
  mkdirSync(join(repository, 'odd'), { recursive: true });
  writeFileSync(join(repository, 'odd', 'tab\tname'), 'tabbed\n', 'utf8');
  writeFileSync(join(repository, 'run.sh'), '#!/bin/sh\n', { encoding: 'utf8', mode: 0o755 });
  symlinkSync('odd/tab\tname', join(repository, 'link'));
  runGit(repository, ['add', '--all']);
  runGit(repository, ['commit', '--message', 'odd paths']);
  const revision = runGit(repository, ['rev-parse', 'HEAD']);

  const candidate = readCandidate(repository, { kind: 'committed', revision });

  expect(candidate.selection).toEqual({
    kind: 'committed',
    revision,
    tree: runGit(repository, ['rev-parse', 'HEAD^{tree}']),
  });
  expect(candidate.entries).toEqual([
    { path: 'link', mode: '120000', blob: runGit(repository, ['rev-parse', 'HEAD:link']) },
    {
      path: 'odd/tab\tname',
      mode: '100644',
      blob: runGit(repository, ['rev-parse', 'HEAD:odd/tab\tname']),
    },
    { path: 'run.sh', mode: '100755', blob: runGit(repository, ['rev-parse', 'HEAD:run.sh']) },
  ]);
  expect(candidate.untracked).toEqual([]);
});
