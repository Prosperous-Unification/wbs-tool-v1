import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { readDeployedCommit } from './deployed-commit';

const SHA = 'a'.repeat(39) + '1';
const OTHER = 'b'.repeat(39) + '2';

const roots: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-commit-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A `.git` directory whose HEAD is a symbolic ref to a loose branch ref. */
function repoOnBranch(root: string, branch = 'main', sha = SHA): void {
  const gitDir = join(root, '.git');
  mkdirSync(join(gitDir, 'refs', 'heads', ...branch.split('/').slice(0, -1)), { recursive: true });
  writeFileSync(join(gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`);
  writeFileSync(join(gitDir, 'refs', 'heads', branch), `${sha}\n`);
}

describe('readDeployedCommit', () => {
  it('reads the object name behind a symbolic HEAD', () => {
    const root = tempRoot();
    repoOnBranch(root);
    expect(readDeployedCommit(root)).toBe(SHA);
  });

  it('reads a branch name with a slash in it', () => {
    // The dev checkout has sat on `change/dev-environment-auto-deploy` since
    // 2026-08-04, so a reader that treated the ref as one path segment would
    // report null on the one machine this exists for.
    const root = tempRoot();
    repoOnBranch(root, 'change/dev-environment-auto-deploy');
    expect(readDeployedCommit(root)).toBe(SHA);
  });

  it('reads a detached HEAD, which is what a reset to a bare sha can leave', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'HEAD'), `${SHA}\n`);
    expect(readDeployedCommit(root)).toBe(SHA);
  });

  it('falls back to packed-refs once git has packed the loose ref away', () => {
    const root = tempRoot();
    const gitDir = join(root, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(
      join(gitDir, 'packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted \n${OTHER} refs/heads/other\n${SHA} refs/heads/main\n^${OTHER}\n`,
    );
    expect(readDeployedCommit(root)).toBe(SHA);
  });

  it('searches upward, because each tier runs with its own app as cwd', () => {
    // be-01 serves from `apps/be-01`; the repository root is two levels up.
    const root = tempRoot();
    repoOnBranch(root);
    const cwd = join(root, 'apps', 'be-01');
    mkdirSync(cwd, { recursive: true });
    expect(readDeployedCommit(cwd)).toBe(SHA);
  });

  it('follows a `.git` file, which is what a worktree checkout has', () => {
    const root = tempRoot();
    const real = join(root, 'real-git');
    mkdirSync(join(real, 'refs', 'heads'), { recursive: true });
    writeFileSync(join(real, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(real, 'refs', 'heads', 'main'), `${SHA}\n`);
    const tree = join(root, 'tree');
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, '.git'), `gitdir: ${real}\n`);
    expect(readDeployedCommit(tree)).toBe(SHA);
  });

  it('answers null where there is no repository at all', () => {
    // The prod image, which serves a built bundle. Null is "this deployment
    // cannot tell you", and the caller must not read it as "nothing deployed".
    expect(readDeployedCommit(tempRoot())).toBeNull();
  });

  it('answers null rather than throwing when HEAD points at a ref that is gone', () => {
    const root = tempRoot();
    const gitDir = join(root, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    expect(readDeployedCommit(root)).toBeNull();
  });

  it('answers null on a HEAD that is not a ref and not a sha', () => {
    const root = tempRoot();
    const gitDir = join(root, '.git');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'HEAD'), 'not a ref\n');
    expect(readDeployedCommit(root)).toBeNull();
  });

  it('refuses an abbreviated sha instead of reporting a commit nobody can match', () => {
    // A poller compares this against `git rev-parse HEAD`. A short answer would
    // never equal it, and the deploy would read as permanently in flight.
    const root = tempRoot();
    repoOnBranch(root, 'main', 'abc1234');
    expect(readDeployedCommit(root)).toBeNull();
  });
});
