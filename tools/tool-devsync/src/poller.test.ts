import { chmod, mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
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

const HELPER = new URL('../../../bin/dev-poll-sync.sh', import.meta.url).pathname;
const DEPLOYER = 'tools/tool-devsync/src/sync.ts';

/** Where the loader lays a candidate's deployer, given the installed bin dir. */
function candidateDeployer(installed: string, sha: string): string {
  return join(installed, `sync.${sha}`, DEPLOYER);
}

/**
 * A fake `git` whose `archive` answers with a tar holding one deployer file,
 * the shape the loader extracts. `body` runs first with the requested commit
 * in `$sha` and must set `CONTENT`; it may block, which is what the race
 * cases use it for.
 */
function fakeGitArchiving(body: string): string {
  return `#!/usr/bin/env bash
set -eu
case " $* " in *" fetch "*) exit 0;; esac
sha=$4
${body}
tree=$(mktemp -d)
mkdir -p "$tree/tools/tool-devsync/src"
printf '%s\\n' "$CONTENT" > "$tree/${DEPLOYER}"
tar -c -C "$tree" tools
rm -rf "$tree"
`;
}

/**
 * The files a candidate is archived from, in the shape the real repository has
 * them: the deployer's project, the contract it imports through an `@wbs/*`
 * path, and the root configs Bun resolves that path with.
 */
async function seedDeployerTree(source: string, contract: string, deployer: string): Promise<void> {
  await mkdir(join(source, 'tools/tool-devsync/src'), { recursive: true });
  await mkdir(join(source, 'tools/tool-remote-scripts/src/lib'), { recursive: true });
  await mkdir(join(source, 'libs'), { recursive: true });
  await writeFile(join(source, 'libs/.keep'), '');
  await writeFile(join(source, 'package.json'), '{ "name": "poller-fixture", "type": "module" }\n');
  await writeFile(
    join(source, 'tsconfig.base.json'),
    JSON.stringify({
      compilerOptions: {
        paths: { '@wbs/probe-contract': ['./tools/tool-remote-scripts/src/lib/probe-contract.ts'] },
      },
    }),
  );
  await writeFile(
    join(source, 'tools/tool-devsync/tsconfig.json'),
    JSON.stringify({ extends: '../../tsconfig.base.json' }),
  );
  await writeFile(join(source, 'tools/tool-remote-scripts/src/lib/probe-contract.ts'), contract);
  await writeFile(join(source, DEPLOYER), deployer);
}

async function initFixtureRepository(source: string): Promise<void> {
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
}

async function commitAll(source: string, message: string): Promise<string> {
  await requireCommand(['git', '-C', source, 'add', '-A']);
  await requireCommand(['git', '-C', source, 'commit', '--quiet', '-m', message]);
  return await requireCommand(['git', '-C', source, 'rev-parse', 'HEAD']);
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
    const staleInstalled = join(installed, `sync.${staleSha}`);
    const staleInterrupted = join(installed, `sync.${staleSha}.deadbeef`);
    const staleSingleFile = join(installed, `sync.${staleSha}.ts`);

    await requireCommand(['mkdir', '-p', source, installed, commands]);
    await writeFile(fakeGit, fakeGitArchiving('CONTENT=CURRENT'));
    await writeFile(
      fakeBun,
      '#!/usr/bin/env bash\nif [ "$1" = --version ]; then echo 1.3.14; fi\n',
    );
    await Promise.all([
      mkdir(join(staleInstalled, 'tools'), { recursive: true }),
      mkdir(staleInterrupted, { recursive: true }),
      writeFile(staleSingleFile, 'a candidate the loader wrote before 2026-09-07'),
    ]);
    const staleTime = new Date(Date.now() - 9 * 24 * 60 * 60 * 1_000);
    await Promise.all([
      utimes(staleInstalled, staleTime, staleTime),
      utimes(staleInterrupted, staleTime, staleTime),
      utimes(staleSingleFile, staleTime, staleTime),
    ]);
    await chmod(fakeGit, 0o755);
    await chmod(fakeBun, 0o755);

    const result = await command(['bash', helper, source, installed, fakeBun, sha, '1.3.14'], {
      PATH: `${commands}:${process.env['PATH'] ?? ''}`,
    });

    // Proof: the prune glob narrowed back to `sync.*.ts` keeps both stale
    // directories and fails here on `Received + 2`: `sync.bbbb…` and
    // `sync.bbbb….deadbeef` beside the fresh candidate.
    expect(result.code).toBe(0);
    expect(await readdir(installed)).toEqual([`sync.${sha}`]);
  });

  it('a repaired target deployer replaces a broken candidate without bypassing sync', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wbs-dev-poller-'));
    const source = join(root, 'src');
    const installed = join(root, 'bin');
    const fakeBun = join(root, 'bun');
    const helper = new URL('../../../bin/dev-poll-sync.sh', import.meta.url).pathname;

    await initFixtureRepository(source);
    const sync = join(source, DEPLOYER);
    await seedDeployerTree(source, '', 'BASE\n');
    const base = await commitAll(source, 'base');
    await writeFile(sync, 'BROKEN\n');
    const broken = await commitAll(source, 'broken');
    await writeFile(sync, 'FIXED\n');
    const fixed = await commitAll(source, 'fixed');
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
    expect(await readFile(candidateDeployer(installed, fixed), 'utf8')).toBe('FIXED\n');
  });

  it('runs the target deployer against the contract the target commit carries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wbs-dev-poller-contract-'));
    const source = join(root, 'src');
    const installed = join(root, 'bin');

    await initFixtureRepository(source);
    await seedDeployerTree(
      source,
      "export const PROBE = 'the contract as the checkout still has it';\n",
      "import { PROBE } from '@wbs/probe-contract';\nconsole.log(PROBE);\n",
    );
    const base = await commitAll(source, 'base');
    await writeFile(
      join(source, 'tools/tool-remote-scripts/src/lib/probe-contract.ts'),
      "export const PROBE = 'the contract the target was written against';\n",
    );
    const target = await commitAll(source, 'target');
    await requireCommand(['git', '-C', source, 'reset', '--hard', '--quiet', base]);

    // The managed interpreter is this test's own Bun, so the resolution under
    // test is the real resolver's and not a fake's.
    const run = await command([
      'bash',
      HELPER,
      source,
      installed,
      process.execPath,
      target,
      Bun.version,
    ]);

    // Proof: the loader extracting `sync.ts` alone into the bin dir, as it did
    // until 2026-09-07, fails here on stderr
    // `error: Cannot find module '@wbs/probe-contract' from '…/bin/sync.<sha>.ts'`;
    // extracting that one file into the checkout's own `tools/tool-devsync/src`
    // instead resolves the alias through the checkout and fails on
    // `Received "the contract as the checkout still has it"`.
    expect(run).toEqual({
      code: 0,
      stdout: 'the contract the target was written against\n',
      stderr: '',
    });
  });

  it('extracts everything the committed deployer imports, resolved by the real bundler', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wbs-dev-poller-repository-'));
    const installed = join(root, 'bin');
    const out = join(root, 'out');
    const repository = new URL('../../../', import.meta.url).pathname;
    const head = await requireCommand(['git', '-C', repository, 'rev-parse', 'HEAD']);
    // Resolves the whole import graph of the candidate's deployer without
    // running it: an alias outside the archived pathspecs fails the build.
    const bundlingBun = join(root, 'bun');
    await writeFile(
      bundlingBun,
      `#!/usr/bin/env bash
set -eu
if [ "$1" = --version ]; then echo ${Bun.version}; exit 0; fi
exec ${process.execPath} build --target=bun --outdir=${out} "$1"
`,
    );
    await chmod(bundlingBun, 0o755);

    const built = await command([
      'bash',
      HELPER,
      repository,
      installed,
      bundlingBun,
      head,
      Bun.version,
    ]);

    // Proof: the single-file loader fails here on
    // `error: Could not resolve: "@wbs/deploy-contract". Maybe you need to "bun install"?`;
    // `tools` dropped from the archived pathspecs fails on exit 1 with
    // `ENOENT opening root directory "…/sync.<sha>/tools/tool-devsync/src"`.
    // `libs` dropped stays green today because the deployer imports only from
    // `tools/`; the day it imports `@wbs/contracts`, this is the case that says
    // the archive no longer covers it.
    expect(built.stderr).not.toContain('Could not resolve');
    expect(built.code).toBe(0);
    expect(await readdir(out)).toEqual(['sync.js']);
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
      fakeGitArchiving(`case "$sha" in
  ${firstSha})
    : > "$RACE_STARTED"
    while [ ! -e "$RACE_RELEASE" ]; do sleep 0.01; done
    CONTENT=BROKEN
    ;;
  ${secondSha})
    while [ ! -e "$RACE_STARTED" ]; do sleep 0.01; done
    CONTENT=FIXED
    : > "$RACE_RELEASE"
    ;;
  *) exit 64;;
esac`),
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
      fakeGitArchiving(`if mkdir "$RACE_FIRST" 2>/dev/null; then
  while [ ! -e "$RACE_RELEASE" ]; do sleep 0.01; done
else
  : > "$RACE_RELEASE"
fi
CONTENT=SAME`),
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
    expect(await readFile(candidateDeployer(installed, sha), 'utf8')).toBe('SAME\n');
  });

  it('guards the canonical h2puni gate wiring for the real orphan process proof', async () => {
    const gate = await readFile(new URL('../../../bin/h2puni-gate.sh', import.meta.url), 'utf8');
    expect(gate).toContain('WBS_RUN_SOLVER_ORPHAN_PROC=1');
    expect(gate).toContain('bunx nx run be-01:solver-image-smoke');
  });
});
