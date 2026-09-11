import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { scratchSync } from '@wbs/tool-test-scratch';
import { afterEach, describe, expect, it } from 'bun:test';

const SCRIPT = join(import.meta.dir, 'corpus-version-base.ts');
const roots: string[] = [];

function git(root: string, ...args: string[]): string {
  const invocation = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const message =
    new TextDecoder().decode(invocation.stdout) + new TextDecoder().decode(invocation.stderr);
  if (invocation.exitCode !== 0) throw new Error(message);
  return new TextDecoder().decode(invocation.stdout).trim();
}

function commit(root: string, contents: string): string {
  writeFileSync(join(root, 'boundary.txt'), contents);
  git(root, 'add', 'boundary.txt');
  git(root, 'commit', '-m', contents);
  return git(root, 'rev-parse', 'HEAD');
}

function history(): { root: string; first: string; base: string; head: string } {
  const root = scratchSync('wbs-corpus-base-');
  roots.push(root);
  git(root, 'init');
  git(root, 'config', 'user.name', 'Corpus Base Test');
  git(root, 'config', 'user.email', 'corpus-base@example.invalid');
  const first = commit(root, 'first');
  const base = commit(root, 'base');
  const head = commit(root, 'head');
  git(root, 'update-ref', 'refs/remotes/origin/main', first);
  return { root, first, base, head };
}

function chooseBase(root: string, env: Record<string, string>): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync({
    cmd: [process.execPath, SCRIPT],
    cwd: root,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function stdoutOf(invocation: ReturnType<typeof Bun.spawnSync>): string {
  return new TextDecoder().decode(invocation.stdout).trim();
}

function stderrOf(invocation: ReturnType<typeof Bun.spawnSync>): string {
  return new TextDecoder().decode(invocation.stderr).trim();
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the corpus comparison boundary used by CI', () => {
  it('uses the pull request event SHA when the named base ref has moved', () => {
    // Proof: replaced the SHA path with `origin/$PR_BASE_REF`. This case read
    // the first commit instead of `base`, and the missing-SHA case also went
    // green through that fallback; 2 passed / 2 failed, watched 2026-09-08.
    const { root, first, base, head } = history();

    const invocation = chooseBase(root, {
      EVENT_NAME: 'pull_request',
      PR_BASE_REF: 'main',
      PR_BASE_SHA: base,
    });

    expect(invocation.exitCode).toBe(0);
    expect(stdoutOf(invocation)).toBe(base);
    expect(stdoutOf(invocation)).not.toBe(first);
    expect(head).not.toBe(base);
  });

  it('refuses a pull request event without its immutable base SHA', () => {
    const { root } = history();

    const invocation = chooseBase(root, {
      EVENT_NAME: 'pull_request',
      PR_BASE_REF: 'main',
    });

    expect(invocation.exitCode).not.toBe(0);
    expect(stderrOf(invocation)).toContain('PR_BASE_SHA');
  });

  it('refuses a malformed pull request base SHA before asking Git to read it', () => {
    // Proof: removed the full-SHA validation from the production selector.
    // `main` then resolved successfully and this failed on `Expected: not 0`;
    // 6 passed / 1 failed, watched 2026-09-08.
    const { root } = history();

    const invocation = chooseBase(root, {
      EVENT_NAME: 'pull_request',
      PR_BASE_SHA: 'main',
    });

    expect(invocation.exitCode).not.toBe(0);
    expect(stderrOf(invocation)).toContain('not a full lowercase Git SHA');
  });

  it('refuses a full event SHA that the checked-out history does not contain', () => {
    // The gate checkout has full history. An event SHA absent from that history
    // is malformed trusted state and Git must name the revision it refused.
    // Proof: returned the validated SHA without asking production `mergeBase`
    // to read it. This failed on `Expected: not 0`; 6 passed / 1 failed,
    // watched 2026-09-08.
    const { root } = history();

    const invocation = chooseBase(root, {
      EVENT_NAME: 'pull_request',
      PR_BASE_SHA: '0123456789abcdef0123456789abcdef01234567',
    });

    expect(invocation.exitCode).not.toBe(0);
    expect(stderrOf(invocation)).toContain('0123456789abcdef0123456789abcdef01234567');
  });

  it('returns the immutable before SHA for a push', () => {
    // Proof: returned `HEAD` from the production push branch. This failed with
    // `Received: "HEAD"` instead of the before SHA; 6 passed / 1 failed,
    // watched 2026-09-08.
    const { root, base } = history();

    const invocation = chooseBase(root, {
      EVENT_NAME: 'push',
      PUSH_BEFORE: base,
    });

    expect(invocation.exitCode).toBe(0);
    expect(stdoutOf(invocation)).toBe(base);
  });

  it('returns the merge base for an immutable merge-group SHA', () => {
    // Proof: removed the merge-group branch from the production selector. This
    // invocation exited 1 instead of 0; 8 passed / 2 failed, watched 2026-09-08.
    const { root, base } = history();

    const invocation = chooseBase(root, {
      EVENT_NAME: 'merge_group',
      MERGE_GROUP_BASE_SHA: base,
    });

    expect(invocation.exitCode).toBe(0);
    expect(stdoutOf(invocation)).toBe(base);
  });

  it('refuses a merge-group event without its immutable base SHA', () => {
    // Proof: removed the merge-group branch from the production selector. The
    // error named the absent boundary rule instead of `MERGE_GROUP_BASE_SHA`;
    // 8 passed / 2 failed, watched 2026-09-08.
    const { root } = history();

    const invocation = chooseBase(root, {
      EVENT_NAME: 'merge_group',
    });

    expect(invocation.exitCode).not.toBe(0);
    expect(stderrOf(invocation)).toContain('MERGE_GROUP_BASE_SHA');
  });

  it('refuses an event with no modeled comparison boundary', () => {
    // Proof: returned `HEAD` for an unsupported event. This failed on
    // `Expected: not 0, Received: 0`; 9 passed / 1 failed, watched 2026-09-08.
    const { root } = history();

    const invocation = chooseBase(root, {
      EVENT_NAME: 'schedule',
    });

    expect(invocation.exitCode).not.toBe(0);
    expect(stderrOf(invocation)).toContain('no boundary rule for event schedule');
  });

  it('terminates option parsing before a dispatch revision beginning with a dash', () => {
    // Proof: removed `--` from the production `git merge-base` invocation.
    // Git reported `unknown switch 'f'` instead of naming `-foo` as the invalid
    // revision, and this assertion failed; 3 passed / 1 failed, watched
    // 2026-09-08.
    const { root } = history();

    const invocation = chooseBase(root, {
      EVENT_NAME: 'workflow_dispatch',
      DISPATCH_BASE_REF: '-foo',
    });

    expect(invocation.exitCode).not.toBe(0);
    expect(stderrOf(invocation)).toContain('-foo');
    expect(stderrOf(invocation)).not.toContain('unknown option');
  });

  it('returns the merge base for a valid dispatch revision', () => {
    const { root, base } = history();

    const invocation = chooseBase(root, {
      EVENT_NAME: 'workflow_dispatch',
      DISPATCH_BASE_REF: 'HEAD~1',
    });

    expect(invocation.exitCode).toBe(0);
    expect(stdoutOf(invocation)).toBe(base);
  });
});
