import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'bun:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const hook = join(root, 'ops/agent-trailer/prepare-commit-msg');
const humanEnv: Record<string, string | undefined> = {
  HOME: process.env['HOME'],
  PATH: process.env['PATH'],
};

function makeRepository() {
  const repository = mkdtempSync(join(tmpdir(), 'wbs-agent-trailer-'));
  const trace = join(repository, 'hook-trace');
  const git = (args: string[], env: Record<string, string | undefined> = humanEnv) =>
    Bun.spawnSync(['git', '-C', repository, ...args], { env, stderr: 'pipe', stdout: 'pipe' });

  expect(git(['init', '-q', '-b', 'main']).exitCode).toBe(0);
  expect(git(['config', 'user.email', 'test@example.com']).exitCode).toBe(0);
  expect(git(['config', 'user.name', 'Test']).exitCode).toBe(0);

  const hooks = join(repository, '.git', 'hooks');
  mkdirSync(hooks, { recursive: true });
  for (const stage of ['prepare-commit-msg', 'commit-msg']) {
    const wrapper = join(hooks, stage);
    writeFileSync(
      wrapper,
      '#!/bin/sh\nprintf "%s\\n" "$(basename "$0")" >>"$HOOK_TRACE"\nexec "$FLEET_HOOK" "$@"\n',
    );
    chmodSync(wrapper, 0o755);
  }

  const hookEnv = {
    ...humanEnv,
    FLEET_HOOK: hook,
    HOOK_TRACE: trace,
  };
  const agentEnv = { ...hookEnv, AGENT_AUTHORED_BY: 'openai/gpt-5.6-sol' };
  return { agentEnv, git, hookEnv, repository, trace };
}

function stages(trace: string) {
  return readFileSync(trace, 'utf8').trim().split('\n');
}

function body(git: ReturnType<typeof makeRepository>['git']) {
  return git(['log', '-1', '--format=%B']).stdout.toString();
}

describe('agent trailer hook integration', () => {
  it('keeps both production lefthook stages wired to the shared hook', () => {
    const config = readFileSync(join(root, 'lefthook.yml'), 'utf8');
    expect(config).toContain(
      '\nprepare-commit-msg:\n  commands:\n    agent-authored-by:\n      run: ops/agent-trailer/prepare-commit-msg {1} {2}\n',
    );
    expect(config).toContain(
      '\ncommit-msg:\n  commands:\n    agent-authored-by:\n      run: ops/agent-trailer/prepare-commit-msg {1}\n',
    );
  });

  it('runs both stages and falls back from an unsafe override without injection', () => {
    const { agentEnv, git, repository, trace } = makeRepository();
    writeFileSync(join(repository, 'one'), 'one\n');
    expect(git(['add', 'one'], agentEnv).exitCode).toBe(0);
    const committed = git(['commit', '-m', 'fix: one'], {
      ...agentEnv,
      AGENT_AUTHORED_BY: 'safe\nInjected: yes',
      CODEX_SANDBOX: 'seatbelt',
    });
    expect(committed.stderr.toString()).toBe('');
    expect(committed.exitCode).toBe(0);
    expect(stages(trace)).toEqual(['prepare-commit-msg', 'commit-msg']);
    expect(body(git)).toContain('Agent-Authored-By: codex');
    expect(body(git)).not.toContain('Injected: yes');
  });

  it('runs both stages without stamping a generated squash message', () => {
    for (const verbose of [false, true]) {
      const { agentEnv, git, hookEnv, repository, trace } = makeRepository();
      writeFileSync(join(repository, 'base'), 'base\n');
      expect(git(['add', 'base'], hookEnv).exitCode).toBe(0);
      expect(git(['commit', '-qm', 'base'], hookEnv).exitCode).toBe(0);
      expect(git(['checkout', '-qb', 'topic'], hookEnv).exitCode).toBe(0);
      writeFileSync(join(repository, 'topic'), 'topic\n');
      expect(git(['add', 'topic'], hookEnv).exitCode).toBe(0);
      expect(git(['commit', '-qm', 'topic'], hookEnv).exitCode).toBe(0);
      expect(git(['checkout', '-q', 'main'], hookEnv).exitCode).toBe(0);
      expect(git(['merge', '--squash', 'topic'], hookEnv).exitCode).toBe(0);
      writeFileSync(trace, '');
      expect(
        git(['commit', ...(verbose ? ['-v'] : [])], { ...agentEnv, GIT_EDITOR: 'true' }).exitCode,
      ).toBe(0);
      expect(stages(trace)).toEqual(['prepare-commit-msg', 'commit-msg']);
      expect(body(git)).not.toContain('Agent-Authored-By:');
    }
  });

  it('treats a non-matching SQUASH_MSG as stale and stamps the explicit message', () => {
    const { agentEnv, git, repository, trace } = makeRepository();
    writeFileSync(join(repository, '.git', 'SQUASH_MSG'), 'Squashed commit of an earlier topic\n');
    writeFileSync(join(repository, 'later'), 'later\n');
    expect(git(['add', 'later'], agentEnv).exitCode).toBe(0);
    expect(git(['commit', '-m', 'fix: later work'], agentEnv).exitCode).toBe(0);
    expect(stages(trace)).toEqual(['prepare-commit-msg', 'commit-msg']);
    expect(body(git)).toContain('Agent-Authored-By: openai/gpt-5.6-sol');
  });
});
