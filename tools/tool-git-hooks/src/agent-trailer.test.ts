import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'bun:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const hook = join(root, 'ops/agent-trailer/prepare-commit-msg');
type FixtureEnvironmentKey =
  | 'AGENT_AUTHORED_BY'
  | 'CODEX_SANDBOX'
  | 'FLEET_HOOK'
  | 'GIT_CONFIG_GLOBAL'
  | 'GIT_CONFIG_SYSTEM'
  | 'GIT_EDITOR'
  | 'HOME'
  | 'HOOK_TRACE'
  | 'PATH'
  | 'comment_prefix_auto';
type FixtureEnvironment = Partial<Record<FixtureEnvironmentKey, string | undefined>>;

const humanEnv: FixtureEnvironment = {
  HOME: process.env['HOME'],
  PATH: process.env['PATH'],
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function makeRepository() {
  const repository = mkdtempSync(join(tmpdir(), 'wbs-agent-trailer-'));
  const trace = join(repository, 'hook-trace');
  const git = (args: string[], env: FixtureEnvironment = humanEnv) =>
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
      '#!/bin/sh\n"$FLEET_HOOK" "$@"\nstatus=$?\nif grep -qi "^Agent-Authored-By:" "$1"; then state=present; else state=absent; fi\nprintf "%s:%s\\n" "$(basename "$0")" "$state" >>"$HOOK_TRACE"\nexit "$status"\n',
    );
    chmodSync(wrapper, 0o755);
  }

  const hookEnv: FixtureEnvironment = {
    ...humanEnv,
    FLEET_HOOK: hook,
    HOOK_TRACE: trace,
  };
  const agentEnv: FixtureEnvironment = {
    ...hookEnv,
    AGENT_AUTHORED_BY: 'openai/gpt-5.6-sol',
  };
  return { agentEnv, git, hookEnv, repository, trace };
}

function stages(trace: string) {
  return readFileSync(trace, 'utf8')
    .trim()
    .split('\n')
    .map((record) => record.split(':', 1)[0]);
}

function stageRecords(trace: string) {
  return readFileSync(trace, 'utf8').trim().split('\n');
}

function body(git: ReturnType<typeof makeRepository>['git']) {
  return git(['log', '-1', '--format=%B']).stdout.toString();
}

describe('agent trailer hook integration', () => {
  it('keeps the isolated human environment surface explicit', () => {
    expect(Object.keys(humanEnv).sort()).toEqual([
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_SYSTEM',
      'HOME',
      'PATH',
    ]);
    expect(humanEnv.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(humanEnv.GIT_CONFIG_SYSTEM).toBe('/dev/null');
  });

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
    expect(stageRecords(trace)).toEqual(['prepare-commit-msg:present', 'commit-msg:present']);
    expect(body(git)).toContain('Agent-Authored-By: codex');
    expect(body(git)).not.toContain('Injected: yes');
  });

  function expectGeneratedSquashUnstamped(verbose: boolean) {
    const { agentEnv, git, hookEnv, repository, trace } = makeRepository();
    writeFileSync(join(repository, 'base'), 'base\n');
    expect(git(['add', 'base'], hookEnv).exitCode).toBe(0);
    expect(git(['commit', '-qm', 'base'], hookEnv).exitCode).toBe(0);
    expect(git(['checkout', '-qb', 'topic'], hookEnv).exitCode).toBe(0);
    writeFileSync(join(repository, 'topic'), 'topic\n');
    expect(git(['add', 'topic'], hookEnv).exitCode).toBe(0);
    expect(
      git(
        [
          'commit',
          '-qm',
          'topic mentions ------------------------ >8 ------------------------ inline',
        ],
        hookEnv,
      ).exitCode,
    ).toBe(0);
    expect(git(['checkout', '-q', 'main'], hookEnv).exitCode).toBe(0);
    expect(git(['merge', '--squash', 'topic'], hookEnv).exitCode).toBe(0);
    writeFileSync(trace, '');
    expect(
      git(['commit', ...(verbose ? ['-v'] : [])], { ...agentEnv, GIT_EDITOR: 'true' }).exitCode,
    ).toBe(0);
    expect(stages(trace)).toEqual(['prepare-commit-msg', 'commit-msg']);
    expect(body(git)).not.toContain('Agent-Authored-By:');
  }

  it('runs both stages without stamping a plain generated squash message', () => {
    expectGeneratedSquashUnstamped(false);
  });

  it('runs both stages without stamping a verbose generated squash message', () => {
    expectGeneratedSquashUnstamped(true);
  });

  it('stamps an ordinary verbose commit above the discarded diff', () => {
    const { agentEnv, git, repository, trace } = makeRepository();
    const editor = join(repository, 'editor');
    writeFileSync(
      editor,
      '#!/bin/sh\nmsg="$1"\n{ printf "fix: ordinary verbose\\n\\n"; cat "$msg"; } >"$msg.tmp"\nmv "$msg.tmp" "$msg"\n',
    );
    chmodSync(editor, 0o755);
    writeFileSync(join(repository, 'ordinary'), 'ordinary\n');
    expect(git(['add', 'ordinary'], agentEnv).exitCode).toBe(0);
    const committed = git(['commit', '-v'], { ...agentEnv, GIT_EDITOR: editor });
    expect(committed.stderr.toString()).toBe('');
    expect(committed.exitCode).toBe(0);
    expect(stages(trace)).toEqual(['prepare-commit-msg', 'commit-msg']);
    expect(stageRecords(trace)).toEqual(['prepare-commit-msg:present', 'commit-msg:present']);
    expect(body(git).match(/^Agent-Authored-By:/gm)).toHaveLength(1);
    expect(body(git)).not.toContain('diff --git');
  });

  it('keeps the legacy fallback above exact scissors without truncating a body substring', () => {
    const { agentEnv, repository } = makeRepository();
    const realGit = Bun.spawnSync(['sh', '-c', 'command -v git'], {
      env: humanEnv,
      stderr: 'pipe',
      stdout: 'pipe',
    })
      .stdout.toString()
      .trim();
    expect(realGit).not.toBe('');
    const fakeBin = join(repository, 'fake-bin');
    mkdirSync(fakeBin);
    const fakeGit = join(fakeBin, 'git');
    writeFileSync(
      fakeGit,
      `#!/bin/sh\nif [ "\${1:-}" = interpret-trailers ]; then exit 1; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
    );
    chmodSync(fakeGit, 0o755);
    const message = join(repository, 'COMMIT_EDITMSG');
    writeFileSync(
      message,
      [
        'fix: body mentions ------------------------ >8 ------------------------ without being a marker',
        '',
        '# ------------------------ >8 ------------------------',
        'diff --git a/a b/a',
        '--- a/a',
      ].join('\n'),
    );
    const result = Bun.spawnSync(['sh', hook, message], {
      cwd: repository,
      env: { ...agentEnv, PATH: `${fakeBin}:${humanEnv.PATH ?? ''}` },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    const text = readFileSync(message, 'utf8');
    expect(text.match(/^Agent-Authored-By:/gm)).toHaveLength(1);
    expect(text.indexOf('Agent-Authored-By:')).toBeGreaterThan(
      text.indexOf('body mentions ------------------------ >8'),
    );
    expect(text.indexOf('Agent-Authored-By:')).toBeLessThan(
      text.indexOf('# ------------------------ >8'),
    );
    expect(text).toContain(
      'body mentions ------------------------ >8 ------------------------ without being a marker',
    );
  });

  it('recognises a CRLF scissors line with a multi-character comment string', () => {
    const { agentEnv, git, repository } = makeRepository();
    expect(git(['config', 'core.commentString', '//'], humanEnv).exitCode).toBe(0);
    const realGit = Bun.spawnSync(['sh', '-c', 'command -v git'], { env: humanEnv })
      .stdout.toString()
      .trim();
    const fakeBin = join(repository, 'git-245-bin');
    mkdirSync(fakeBin);
    writeFileSync(
      join(fakeBin, 'git'),
      `#!/bin/sh\nif [ "\${1:-}" = version ]; then echo "git version 2.45.0"; exit 0; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
    );
    chmodSync(join(fakeBin, 'git'), 0o755);
    writeFileSync(join(repository, '.git', 'SQUASH_MSG'), 'generated squash subject\n');
    const message = join(repository, 'COMMIT_EDITMSG');
    writeFileSync(
      message,
      'generated squash subject\r\n\r\n// ------------------------ >8 ------------------------\r\ndiff --git a/a b/a\r\n',
    );
    const result = Bun.spawnSync(['sh', hook, message], {
      cwd: repository,
      env: { ...agentEnv, PATH: `${fakeBin}:${humanEnv.PATH ?? ''}` },
      stderr: 'pipe',
      stdout: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(message, 'utf8')).not.toContain('Agent-Authored-By:');
  });

  it('uses the last configured comment setting and isolates auto mode from the environment', () => {
    const { agentEnv, git, repository } = makeRepository();
    expect(git(['config', 'core.commentString', '//'], humanEnv).exitCode).toBe(0);
    expect(git(['config', 'core.commentChar', ';'], humanEnv).exitCode).toBe(0);
    writeFileSync(join(repository, '.git', 'SQUASH_MSG'), 'generated squash subject\n');
    const generated = join(repository, 'GENERATED_EDITMSG');
    writeFileSync(
      generated,
      'generated squash subject\n\n; ------------------------ >8 ------------------------\ndiff --git a/a b/a\n',
    );
    expect(
      Bun.spawnSync(['sh', hook, generated], {
        cwd: repository,
        env: agentEnv,
      }).exitCode,
    ).toBe(0);
    expect(readFileSync(generated, 'utf8')).not.toContain('Agent-Authored-By:');

    expect(git(['config', '--unset-all', 'core.commentChar'], humanEnv).exitCode).toBe(0);
    expect(git(['config', '--unset-all', 'core.commentString'], humanEnv).exitCode).toBe(0);
    expect(git(['config', 'core.commentChar', ';'], humanEnv).exitCode).toBe(0);
    expect(git(['config', 'core.commentString', '//'], humanEnv).exitCode).toBe(0);
    const realGit = Bun.spawnSync(['sh', '-c', 'command -v git'], { env: humanEnv })
      .stdout.toString()
      .trim();
    const git244Bin = join(repository, 'git-244-bin');
    mkdirSync(git244Bin);
    writeFileSync(
      join(git244Bin, 'git'),
      `#!/bin/sh\nif [ "\${1:-}" = version ]; then echo "git version 2.44.0"; exit 0; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
    );
    chmodSync(join(git244Bin, 'git'), 0o755);
    const charOnOldGit = join(repository, 'CHAR_OLD_GIT_EDITMSG');
    writeFileSync(
      charOnOldGit,
      'generated squash subject\n\n; ------------------------ >8 ------------------------\ndiff --git a/a b/a\n',
    );
    expect(
      Bun.spawnSync(['sh', hook, charOnOldGit], {
        cwd: repository,
        env: { ...agentEnv, PATH: `${git244Bin}:${humanEnv.PATH ?? ''}` },
      }).exitCode,
    ).toBe(0);
    expect(readFileSync(charOnOldGit, 'utf8')).not.toContain('Agent-Authored-By:');

    const git245Bin = join(repository, 'git-245-bin');
    mkdirSync(git245Bin);
    writeFileSync(
      join(git245Bin, 'git'),
      `#!/bin/sh\nif [ "\${1:-}" = version ]; then echo "git version 2.45.0"; exit 0; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
    );
    chmodSync(join(git245Bin, 'git'), 0o755);
    const stringLast = join(repository, 'STRING_LAST_EDITMSG');
    writeFileSync(
      stringLast,
      'generated squash subject\n\n// ------------------------ >8 ------------------------\ndiff --git a/a b/a\n',
    );
    expect(
      Bun.spawnSync(['sh', hook, stringLast], {
        cwd: repository,
        env: { ...agentEnv, PATH: `${git245Bin}:${humanEnv.PATH ?? ''}` },
      }).exitCode,
    ).toBe(0);
    expect(readFileSync(stringLast, 'utf8')).not.toContain('Agent-Authored-By:');

    expect(git(['config', '--unset-all', 'core.commentString'], humanEnv).exitCode).toBe(0);
    expect(git(['config', 'core.commentChar', 'auto'], humanEnv).exitCode).toBe(0);
    const automatic = join(repository, 'AUTO_EDITMSG');
    writeFileSync(
      automatic,
      'generated squash subject\n\n@ ------------------------ >8 ------------------------\ndiff --git a/a b/a\n',
    );
    expect(
      Bun.spawnSync(['sh', hook, automatic], {
        cwd: repository,
        env: agentEnv,
      }).exitCode,
    ).toBe(0);
    expect(readFileSync(automatic, 'utf8')).not.toContain('Agent-Authored-By:');

    expect(git(['config', 'core.commentChar', '#'], humanEnv).exitCode).toBe(0);
    const inherited = join(repository, 'INHERITED_AUTO_EDITMSG');
    writeFileSync(
      inherited,
      'generated squash subject\n\n@ ------------------------ >8 ------------------------\ndiff --git a/a b/a\n',
    );
    expect(
      Bun.spawnSync(['sh', hook, inherited], {
        cwd: repository,
        env: { ...agentEnv, comment_prefix_auto: '1' },
      }).exitCode,
    ).toBe(0);
    expect(readFileSync(inherited, 'utf8')).toContain('Agent-Authored-By:');
  });

  it('appends the legacy fallback when no scissors marker exists and preserves a trailer block', () => {
    const { agentEnv, repository } = makeRepository();
    const realGit = Bun.spawnSync(['sh', '-c', 'command -v git'], { env: humanEnv })
      .stdout.toString()
      .trim();
    expect(realGit).not.toBe('');
    const fakeBin = join(repository, 'fake-bin');
    mkdirSync(fakeBin);
    writeFileSync(
      join(fakeBin, 'git'),
      `#!/bin/sh\nif [ "\${1:-}" = version ]; then echo "git version 2.45.0"; exit 0; fi\nif [ "\${1:-}" = interpret-trailers ]; then exit 1; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
    );
    chmodSync(join(fakeBin, 'git'), 0o755);
    const message = join(repository, 'COMMIT_EDITMSG');
    writeFileSync(message, 'fix: legacy message\n\nCo-Authored-By: Peer <peer@example.com>\n');
    const result = Bun.spawnSync(['sh', hook, message], {
      cwd: repository,
      env: { ...agentEnv, PATH: `${fakeBin}:${humanEnv.PATH ?? ''}` },
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(message, 'utf8')).toEndWith(
      'Co-Authored-By: Peer <peer@example.com>\nAgent-Authored-By: openai/gpt-5.6-sol\n',
    );

    const plainMessage = join(repository, 'PLAIN_COMMIT_EDITMSG');
    writeFileSync(plainMessage, 'fix: one-line conventional subject\n');
    const plainResult = Bun.spawnSync(['sh', hook, plainMessage], {
      cwd: repository,
      env: { ...agentEnv, PATH: `${fakeBin}:${humanEnv.PATH ?? ''}` },
    });
    expect(plainResult.exitCode).toBe(0);
    expect(readFileSync(plainMessage, 'utf8')).toBe(
      'fix: one-line conventional subject\n\nAgent-Authored-By: openai/gpt-5.6-sol\n',
    );

    const offsetMessage = join(repository, 'OFFSET_COMMIT_EDITMSG');
    writeFileSync(offsetMessage, '\n# template\n\nfix: offset conventional subject\n');
    const offsetResult = Bun.spawnSync(['sh', hook, offsetMessage], {
      cwd: repository,
      env: { ...agentEnv, PATH: `${fakeBin}:${humanEnv.PATH ?? ''}` },
    });
    expect(offsetResult.exitCode).toBe(0);
    expect(readFileSync(offsetMessage, 'utf8')).toEndWith(
      'fix: offset conventional subject\n\nAgent-Authored-By: openai/gpt-5.6-sol\n',
    );
  });

  it('places the legacy fallback above a CRLF multi-character scissors marker', () => {
    const { agentEnv, git, repository } = makeRepository();
    expect(git(['config', 'core.commentString', '//'], humanEnv).exitCode).toBe(0);
    const realGit = Bun.spawnSync(['sh', '-c', 'command -v git'], { env: humanEnv })
      .stdout.toString()
      .trim();
    const fakeBin = join(repository, 'fake-bin');
    mkdirSync(fakeBin);
    writeFileSync(
      join(fakeBin, 'git'),
      `#!/bin/sh\nif [ "\${1:-}" = version ]; then echo "git version 2.45.0"; exit 0; fi\nif [ "\${1:-}" = interpret-trailers ]; then exit 1; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
    );
    chmodSync(join(fakeBin, 'git'), 0o755);
    const message = join(repository, 'COMMIT_EDITMSG');
    writeFileSync(
      message,
      'fix: multi-prefix fallback\r\n// ------------------------ >8 ------------------------\r\ndiff --git a/a b/a\r\n',
    );
    const result = Bun.spawnSync(['sh', hook, message], {
      cwd: repository,
      env: { ...agentEnv, PATH: `${fakeBin}:${humanEnv.PATH ?? ''}` },
    });
    expect(result.exitCode).toBe(0);
    const text = readFileSync(message, 'utf8');
    expect(text.match(/^Agent-Authored-By:/gm)).toHaveLength(1);
    expect(text).toStartWith(
      'fix: multi-prefix fallback\r\n\r\nAgent-Authored-By: openai/gpt-5.6-sol\r\n// ------------------------ >8 ------------------------\r\n',
    );
    expect(text.indexOf('Agent-Authored-By:')).toBeLessThan(
      text.indexOf('// ------------------------ >8'),
    );
  });

  it('keeps fallback trailers together ahead of trailing whitespace and comments', () => {
    const { agentEnv, repository } = makeRepository();
    const realGit = Bun.spawnSync(['sh', '-c', 'command -v git'], { env: humanEnv })
      .stdout.toString()
      .trim();
    const fakeBin = join(repository, 'fake-bin');
    mkdirSync(fakeBin);
    writeFileSync(
      join(fakeBin, 'git'),
      `#!/bin/sh\nif [ "\${1:-}" = interpret-trailers ]; then exit 1; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
    );
    chmodSync(join(fakeBin, 'git'), 0o755);
    const message = join(repository, 'COMMIT_EDITMSG');
    writeFileSync(
      message,
      'fix: legacy message\n \nCo-Authored-By: Peer <peer@example.com>\n continuation\n\n# Please enter the commit message\n#\n',
    );
    expect(
      Bun.spawnSync(['sh', hook, message], {
        cwd: repository,
        env: { ...agentEnv, PATH: `${fakeBin}:${humanEnv.PATH ?? ''}` },
      }).exitCode,
    ).toBe(0);
    expect(readFileSync(message, 'utf8')).toBe(
      'fix: legacy message\n \nCo-Authored-By: Peer <peer@example.com>\n continuation\nAgent-Authored-By: openai/gpt-5.6-sol\n\n# Please enter the commit message\n#\n',
    );
  });

  it('falls open with attribution on mktemp failure and cleans up rewrite failures', () => {
    for (const failedTool of ['mktemp', 'awk', 'mv']) {
      const { agentEnv, repository } = makeRepository();
      const realGit = Bun.spawnSync(['sh', '-c', 'command -v git'], { env: humanEnv })
        .stdout.toString()
        .trim();
      const fakeBin = join(repository, 'fake-bin');
      mkdirSync(fakeBin);
      writeFileSync(
        join(fakeBin, 'git'),
        `#!/bin/sh\nif [ "\${1:-}" = interpret-trailers ]; then exit 1; fi\nexec ${JSON.stringify(realGit)} "$@"\n`,
      );
      chmodSync(join(fakeBin, 'git'), 0o755);
      writeFileSync(join(fakeBin, failedTool), '#!/bin/sh\nexit 1\n');
      chmodSync(join(fakeBin, failedTool), 0o755);
      const message = join(repository, 'COMMIT_EDITMSG');
      writeFileSync(
        message,
        failedTool === 'mktemp'
          ? 'fix: failure edge\n# ------------------------ >8 ------------------------\ndiff --git a/a b/a\n'
          : 'fix: failure edge\n',
      );
      const result = Bun.spawnSync(['sh', hook, message], {
        cwd: repository,
        env: { ...agentEnv, PATH: `${fakeBin}:${humanEnv.PATH ?? ''}` },
      });
      expect(result.exitCode).toBe(0);
      if (failedTool === 'mktemp') {
        expect(readFileSync(message, 'utf8')).toStartWith(
          'fix: failure edge\n\nAgent-Authored-By: openai/gpt-5.6-sol\n# ------------------------ >8',
        );
      }
      expect(readdirSync(repository).some((name) => name.includes('.agent-trailer.'))).toBe(false);
    }
  });

  it('treats a non-matching SQUASH_MSG as stale and stamps the explicit message', () => {
    const { agentEnv, git, repository, trace } = makeRepository();
    writeFileSync(join(repository, '.git', 'SQUASH_MSG'), 'Squashed commit of an earlier topic\n');
    writeFileSync(join(repository, 'later'), 'later\n');
    expect(git(['add', 'later'], agentEnv).exitCode).toBe(0);
    expect(git(['commit', '-m', 'fix: later work'], agentEnv).exitCode).toBe(0);
    expect(stageRecords(trace)).toEqual(['prepare-commit-msg:present', 'commit-msg:present']);
    expect(body(git)).toContain('Agent-Authored-By: openai/gpt-5.6-sol');
  });
});
