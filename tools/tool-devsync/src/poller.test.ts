import { chmod, mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function command(argv: string[], env: Record<string, string> = {}): Promise<CommandResult> {
  const child = Bun.spawn(argv, {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

async function requireCommand(argv: string[]): Promise<string> {
  const result = await command(argv);
  if (result.code !== 0) throw new Error(`${argv.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

describe('durable dev poller', () => {
  it('guards the installed poller source shape for its interpreter, target ref, and proof hooks', async () => {
    const poller = await readFile(new URL('../../../bin/dev-poll.sh', import.meta.url), 'utf8');
    expect(poller).toContain('flock -n 9');
    expect(poller).toContain('dev-poll-sync.sh');
    expect(poller).not.toContain('"$SRC/tools/tool-devsync/src/sync.ts"');
    expect(poller).toContain('BUN=/home/puni1/wbs-dev/bin/bun');
    expect(poller).not.toContain('/wbs-dark/');
    expect(poller).toContain('git rev-parse refs/remotes/origin/main');
    expect(poller).not.toContain('git rev-parse FETCH_HEAD');
    expect(poller).toContain('read_served_commit');
    expect(poller).toContain('if [ "${served:-}" != "$remote_sha" ]');
  });

  it('guards the manual deploy source shape that streams the candidate loader', async () => {
    const deploy = await readFile(new URL('../../../bin/dev-deploy.sh', import.meta.url), 'utf8');
    expect(deploy).toContain('< "$(dirname "${BASH_SOURCE[0]}")/dev-poll-sync.sh"');
    expect(deploy).not.toContain('/home/puni1/wbs-dev/bin/dev-poll-sync.sh');
  });

  it('names the managed Bun installation remedy before reading the target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wbs-dev-poller-missing-bun-'));
    const source = join(root, 'src');
    const installed = join(root, 'bin');
    const helper = new URL('../../../bin/dev-poll-sync.sh', import.meta.url).pathname;

    await requireCommand(['git', 'init', '--quiet', '--initial-branch=main', source]);
    const failed = await command([
      'bash',
      helper,
      source,
      installed,
      join(root, 'missing-bun'),
      'a'.repeat(40),
      '1.3.14',
    ]);

    expect(failed.code).not.toBe(0);
    expect(failed.stderr).toContain('missing managed Bun 1.3.14');
    expect(failed.stderr).toContain('install it with the poller pair');
    expect(failed.stderr).toContain('docs/runbook-dev-deploy.md');
  });

  it('removes its private candidate when target extraction fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wbs-dev-poller-extract-failure-'));
    const source = join(root, 'src');
    const installed = join(root, 'bin');
    const commands = join(root, 'commands');
    const fakeGit = join(commands, 'git');
    const fakeBun = join(root, 'bun');
    const helper = new URL('../../../bin/dev-poll-sync.sh', import.meta.url).pathname;

    await requireCommand(['mkdir', '-p', source, commands]);
    await writeFile(fakeGit, '#!/usr/bin/env bash\nexit 17\n');
    await writeFile(
      fakeBun,
      '#!/usr/bin/env bash\nif [ "$1" = --version ]; then echo 1.3.14; exit 0; fi\nexit 64\n',
    );
    await chmod(fakeGit, 0o755);
    await chmod(fakeBun, 0o755);

    const failed = await command(
      ['bash', helper, source, installed, fakeBun, 'a'.repeat(40), '1.3.14'],
      { PATH: `${commands}:${process.env['PATH'] ?? ''}` },
    );

    expect(failed.code).toBe(17);
    expect(await readdir(installed)).toEqual([]);
  });

  it('prunes stale installed and interrupted candidates before running the target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wbs-dev-poller-prune-'));
    const source = join(root, 'src');
    const installed = join(root, 'bin');
    const commands = join(root, 'commands');
    const fakeGit = join(commands, 'git');
    const fakeBun = join(root, 'bun');
    const helper = new URL('../../../bin/dev-poll-sync.sh', import.meta.url).pathname;
    const sha = 'a'.repeat(40);
    const staleSha = 'b'.repeat(40);
    const staleInstalled = join(installed, `sync.${staleSha}.ts`);
    const staleInterrupted = join(installed, `sync.${staleSha}.ts.deadbeef`);

    await requireCommand(['mkdir', '-p', source, installed, commands]);
    await writeFile(fakeGit, '#!/usr/bin/env bash\nprintf CURRENT\\n\n');
    await writeFile(
      fakeBun,
      '#!/usr/bin/env bash\nif [ "$1" = --version ]; then echo 1.3.14; fi\n',
    );
    await Promise.all([writeFile(staleInstalled, 'old'), writeFile(staleInterrupted, 'partial')]);
    const staleTime = new Date(Date.now() - 9 * 24 * 60 * 60 * 1_000);
    await Promise.all([
      utimes(staleInstalled, staleTime, staleTime),
      utimes(staleInterrupted, staleTime, staleTime),
    ]);
    await chmod(fakeGit, 0o755);
    await chmod(fakeBun, 0o755);

    const result = await command(['bash', helper, source, installed, fakeBun, sha, '1.3.14'], {
      PATH: `${commands}:${process.env['PATH'] ?? ''}`,
    });

    // Proof: narrowing the prune glob back to sync.*.ts leaves staleInterrupted behind.
    expect(result.code).toBe(0);
    expect(await readdir(installed)).toEqual([`sync.${sha}.ts`]);
  });

  it('a repaired target deployer replaces a broken candidate without bypassing sync', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wbs-dev-poller-'));
    const source = join(root, 'src');
    const installed = join(root, 'bin');
    const fakeBun = join(root, 'bun');
    const helper = new URL('../../../bin/dev-poll-sync.sh', import.meta.url).pathname;

    await requireCommand(['git', 'init', '--quiet', '--initial-branch=main', source]);
    await requireCommand([
      'git',
      '-C',
      source,
      'config',
      'user.email',
      'poller-test@example.invalid',
    ]);
    await requireCommand(['git', '-C', source, 'config', 'user.name', 'poller test']);

    const sync = join(source, 'tools/tool-devsync/src/sync.ts');
    await requireCommand(['mkdir', '-p', join(source, 'tools/tool-devsync/src')]);
    await writeFile(sync, 'BASE\n');
    await requireCommand(['git', '-C', source, 'add', sync]);
    await requireCommand(['git', '-C', source, 'commit', '--quiet', '-m', 'base']);
    const base = await requireCommand(['git', '-C', source, 'rev-parse', 'HEAD']);

    await writeFile(sync, 'BROKEN\n');
    await requireCommand(['git', '-C', source, 'commit', '--quiet', '-am', 'broken']);
    const broken = await requireCommand(['git', '-C', source, 'rev-parse', 'HEAD']);
    await writeFile(sync, 'FIXED\n');
    await requireCommand(['git', '-C', source, 'commit', '--quiet', '-am', 'fixed']);
    const fixed = await requireCommand(['git', '-C', source, 'rev-parse', 'HEAD']);
    await requireCommand(['git', '-C', source, 'reset', '--hard', '--quiet', base]);

    await writeFile(
      fakeBun,
      '#!/usr/bin/env bash\nset -eu\nif [ "$1" = --version ]; then echo 1.3.14; exit 0; fi\nif grep -qx BROKEN "$1"; then exit 23; fi\ngit -C "$POLL_TEST_SRC" reset --hard --quiet "$2"\n',
    );
    await chmod(fakeBun, 0o755);

    const failed = await command(['bash', helper, source, installed, fakeBun, broken, '1.3.14'], {
      POLL_TEST_SRC: source,
    });
    expect(failed.code).toBe(23);
    expect(await requireCommand(['git', '-C', source, 'rev-parse', 'HEAD'])).toBe(base);

    const recovered = await command(['bash', helper, source, installed, fakeBun, fixed, '1.3.14'], {
      POLL_TEST_SRC: source,
    });
    expect(recovered).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await requireCommand(['git', '-C', source, 'rev-parse', 'HEAD'])).toBe(fixed);
    expect(await readFile(join(installed, `sync.${fixed}.ts`), 'utf8')).toBe('FIXED\n');
  });

  it('keeps concurrent target candidates isolated by commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wbs-dev-poller-race-'));
    const source = join(root, 'src');
    const installed = join(root, 'bin');
    const commands = join(root, 'commands');
    const fakeGit = join(commands, 'git');
    const fakeBun = join(root, 'bun');
    const started = join(root, 'started');
    const release = join(root, 'release');
    const observations = join(root, 'observations');
    const helper = new URL('../../../bin/dev-poll-sync.sh', import.meta.url).pathname;
    const firstSha = 'b'.repeat(40);
    const secondSha = 'c'.repeat(40);

    await requireCommand(['mkdir', '-p', source, commands]);
    await writeFile(
      fakeGit,
      `#!/usr/bin/env bash
set -eu
case " $* " in *" fetch "*) exit 0;; esac
spec="\${!#}"
case "$spec" in
  "${firstSha}:"*)
    printf BRO
    : > "$RACE_STARTED"
    while [ ! -e "$RACE_RELEASE" ]; do sleep 0.01; done
    printf 'KEN\\n'
    ;;
  "${secondSha}:"*)
    while [ ! -e "$RACE_STARTED" ]; do sleep 0.01; done
    printf 'FIXED\\n'
    : > "$RACE_RELEASE"
    ;;
  *) exit 64;;
esac
`,
    );
    await writeFile(
      fakeBun,
      '#!/usr/bin/env bash\nset -eu\nif [ "$1" = --version ]; then echo 1.3.14; exit 0; fi\nprintf "%s:%s" "$2" "$(cat "$1")" >> "$POLL_OBSERVATIONS"\nprintf "\\n" >> "$POLL_OBSERVATIONS"\n',
    );
    await chmod(fakeGit, 0o755);
    await chmod(fakeBun, 0o755);

    const env = {
      PATH: `${commands}:${process.env['PATH'] ?? ''}`,
      POLL_OBSERVATIONS: observations,
      RACE_STARTED: started,
      RACE_RELEASE: release,
    };
    const first = command(['bash', helper, source, installed, fakeBun, firstSha, '1.3.14'], env);
    const second = command(['bash', helper, source, installed, fakeBun, secondSha, '1.3.14'], env);
    const results = await Promise.all([first, second]);

    expect(results.map((result) => result.code)).toEqual([0, 0]);
    expect((await readFile(observations, 'utf8')).trim().split('\n').sort()).toEqual(
      [`${firstSha}:BROKEN`, `${secondSha}:FIXED`].sort(),
    );
  });

  it('runs byte-identical candidates when the same target overlaps itself', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wbs-dev-poller-same-sha-'));
    const source = join(root, 'src');
    const installed = join(root, 'bin');
    const commands = join(root, 'commands');
    const fakeGit = join(commands, 'git');
    const fakeBun = join(root, 'bun');
    const first = join(root, 'first');
    const release = join(root, 'release');
    const observations = join(root, 'observations');
    const helper = new URL('../../../bin/dev-poll-sync.sh', import.meta.url).pathname;
    const sha = 'd'.repeat(40);

    await requireCommand(['mkdir', '-p', source, commands]);
    await writeFile(
      fakeGit,
      `#!/usr/bin/env bash
set -eu
if mkdir "$RACE_FIRST" 2>/dev/null; then
  while [ ! -e "$RACE_RELEASE" ]; do sleep 0.01; done
else
  : > "$RACE_RELEASE"
fi
printf 'SAME\\n'
`,
    );
    await writeFile(
      fakeBun,
      '#!/usr/bin/env bash\nset -eu\nif [ "$1" = --version ]; then echo 1.3.14; exit 0; fi\nprintf "%s:%s\\n" "$2" "$(cat "$1")" >> "$POLL_OBSERVATIONS"\n',
    );
    await chmod(fakeGit, 0o755);
    await chmod(fakeBun, 0o755);
    const env = {
      PATH: `${commands}:${process.env['PATH'] ?? ''}`,
      POLL_OBSERVATIONS: observations,
      RACE_FIRST: first,
      RACE_RELEASE: release,
    };

    const runs = await Promise.all([
      command(['bash', helper, source, installed, fakeBun, sha, '1.3.14'], env),
      command(['bash', helper, source, installed, fakeBun, sha, '1.3.14'], env),
    ]);

    expect(runs.map(({ code }) => code)).toEqual([0, 0]);
    expect((await readFile(observations, 'utf8')).trim().split('\n')).toEqual([
      `${sha}:SAME`,
      `${sha}:SAME`,
    ]);
    expect(await readFile(join(installed, `sync.${sha}.ts`), 'utf8')).toBe('SAME\n');
  });

  it('guards the canonical h2puni gate wiring for the real orphan process proof', async () => {
    const gate = await readFile(new URL('../../../bin/h2puni-gate.sh', import.meta.url), 'utf8');
    expect(gate).toContain('WBS_RUN_SOLVER_ORPHAN_PROC=1');
    expect(gate).toContain('bunx nx run be-01:solver-image-smoke');
  });
});
