const REPOSITORY_ROOT = new URL('../../../../', import.meta.url).pathname;

function gitOutput(...arguments_: string[]): string {
  const command = Bun.spawnSync({
    cmd: ['git', ...arguments_],
    cwd: REPOSITORY_ROOT,
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (command.exitCode !== 0) {
    throw new Error(
      `source certification could not read Git revision: ${command.stderr.toString().trim()}`,
    );
  }
  return command.stdout.toString().trim();
}

/** Identifies the exact checkout certified, including uncommitted source changes. */
export function sourceRevision(): string {
  const revision = gitOutput('rev-parse', 'HEAD');
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error(
      `source certification received invalid Git revision ${JSON.stringify(revision)}`,
    );
  }
  return gitOutput('status', '--porcelain=v1').length === 0 ? revision : `${revision}-dirty`;
}
