import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
  it('runs the target commit deployer outside the checkout and retains proof gates', async () => {
    const poller = await readFile(new URL('../../../bin/dev-poll.sh', import.meta.url), 'utf8');
    expect(poller).toContain('flock -n 9');
    expect(poller).toContain('dev-poll-sync.sh');
    expect(poller).not.toContain('"$SRC/tools/tool-devsync/src/sync.ts"');
    expect(poller).toContain('read_served_commit');
    expect(poller).toContain('if [ "${served:-}" != "$remote_sha" ]');
  });

  it('a repaired target deployer replaces a broken candidate without bypassing sync', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wbs-dev-poller-'));
    const source = join(root, 'src');
    const installed = join(root, 'bin');
    const fakeBun = join(root, 'bun');
    const helper = new URL('../../../bin/dev-poll-sync.sh', import.meta.url).pathname;

    await requireCommand(['git', 'init', '--quiet', '--initial-branch=main', source]);
    await requireCommand(['git', '-C', source, 'config', 'user.email', 'poller-test@example.invalid']);
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
      '#!/usr/bin/env bash\nset -eu\nif grep -qx BROKEN "$1"; then exit 23; fi\ngit -C "$POLL_TEST_SRC" reset --hard --quiet "$2"\n',
    );
    await chmod(fakeBun, 0o755);

    const failed = await command(['bash', helper, source, installed, fakeBun, broken], {
      POLL_TEST_SRC: source,
    });
    expect(failed.code).toBe(23);
    expect(await requireCommand(['git', '-C', source, 'rev-parse', 'HEAD'])).toBe(base);

    const recovered = await command(['bash', helper, source, installed, fakeBun, fixed], {
      POLL_TEST_SRC: source,
    });
    expect(recovered).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(await requireCommand(['git', '-C', source, 'rev-parse', 'HEAD'])).toBe(fixed);
    expect(await readFile(join(installed, 'sync.ts'), 'utf8')).toBe('FIXED\n');
  });
});
