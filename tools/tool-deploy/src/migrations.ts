/**
 * Blue and green share one SQLite file, so a destructive migration breaks the
 * still-live old colour. This gate turns that from a 3am surprise into a
 * deploy-time prompt.
 */
export function hasNewMigrations(deployed: string[] | null, head: string[]): boolean {
  if (deployed === null) return false;
  const known = new Set(deployed);
  return head.some((m) => !known.has(m));
}

export function assertMigrationFlag(newMigrations: boolean, withMigrations: boolean): void {
  if (!newMigrations) return;
  if (withMigrations) return;
  throw new Error(
    'this deploy contains new migrations.\n' +
      '  Blue and green share one database, so the migration must be backward-compatible\n' +
      '  with the release still serving traffic (add columns, never drop).\n' +
      '  Pass --with-migrations once you have confirmed that. There is no automated\n' +
      '  stop-the-world path — if this migration genuinely cannot be made backward-\n' +
      '  compatible, restructure it as an additive change, or take the app down manually\n' +
      '  (stop both colours, apply the migration by hand, bring one colour back up).',
  );
}

/**
 * `--stop-the-world` is parsed (see affected.ts) but not implemented: it used
 * to fall through to the exact same blue/green swap command a normal deploy
 * produces (see deploy.ts's per-tier command construction), so an operator
 * who reached for it BECAUSE a migration is too destructive for two colours
 * sharing one SQLite file got blue/green anyway — silently. A flag that
 * claims a safety property it doesn't have is worse than a flag that refuses
 * outright, so this rejects it unconditionally, before any tier is examined.
 */
export function assertStopTheWorldNotImplemented(stopTheWorld: boolean): void {
  if (!stopTheWorld) return;
  throw new Error(
    '--stop-the-world is not implemented.\n' +
      '  It would produce the exact same blue/green swap command as a normal deploy —\n' +
      '  selecting it does NOT avoid two colours briefly sharing one SQLite file.\n' +
      '  If a migration is too destructive to run backward-compatible under blue/green,\n' +
      '  instead either:\n' +
      '    - restructure it as an additive-only change (add columns, never drop) and\n' +
      '      deploy with --with-migrations, or\n' +
      '    - take the app down manually (stop both colours, apply the migration by hand,\n' +
      '      bring one colour back up) — this tool has no automated stop-the-world\n' +
      '      sequence yet.',
  );
}

const MIGRATION_DIRS = ['apps/be-01/drizzle', 'apps/wbs/be-01/drizzle'] as const;

type GitTreeReader = (
  repository: string,
  sha: string,
  options: readonly string[],
  path: string,
) => string;

function gitLsTree(
  repository: string,
  sha: string,
  options: readonly string[],
  path: string,
): string {
  const invocation = Bun.spawnSync({
    cmd: ['git', 'ls-tree', '-z', ...options, sha, '--', path],
    cwd: repository,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // Proof: an injected nonexistent SHA made the real production command exit non-zero and
  // `names an unreadable revision` observed the SHA in this refusal instead of `[]`.
  if (invocation.exitCode !== 0) {
    throw new Error(
      `git ls-tree ${options.join(' ')} ${sha} -- ${path} failed in ${repository}: ${invocation.stderr.toString('utf8').trim()}`,
    );
  }
  return invocation.stdout.toString('utf8');
}

function migrationTreeAtSha(
  repository: string,
  sha: string,
  dir: string,
  readGitTree: GitTreeReader,
): boolean {
  const output = readGitTree(repository, sha, [], dir);
  if (output === '') return false;
  const entries = output.split('\0').filter((entry) => entry !== '');
  // Proof: injecting two valid records made `refuses malformed Git tree output` observe the
  // exact-entry-count refusal rather than selecting an arbitrary tree.
  if (entries.length !== 1) {
    throw new Error(
      `migration path ${dir} at ${sha} produced ${String(entries.length)} Git entries; expected exactly one`,
    );
  }
  const match = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40,64})\t(.+)$/.exec(entries[0]);
  // Proof: injecting `not a Git tree record` through the production boundary made
  // `refuses malformed Git tree output` fail before this parser existed, then pass here.
  if (match?.[4] !== dir) {
    throw new Error(`migration path ${dir} at ${sha} has malformed Git state: ${entries[0]}`);
  }
  // Proof: committing a blob at `apps/be-01/drizzle` made the production Git reader reach
  // this branch and `refuses a supported migration path that is not a Git tree` pass.
  if (match[2] !== 'tree') {
    throw new Error(`migration path ${dir} at ${sha} is a ${match[2]}, expected a tree`);
  }
  return true;
}

/**
 * Thin git plumbing boundary for `hasNewMigrations`: resolves the one supported
 * migration tree present at the revision, then lists its migration folder names.
 * The deployed revision may predate repository namespacing, so the working tree
 * cannot choose the historical path.
 */
export function migrationsAtSha(
  sha: string,
  repository: string = process.cwd(),
  readGitTree: GitTreeReader = gitLsTree,
): string[] {
  // Proof: forcing this selection to `apps/wbs/be-01/drizzle` for every revision made the
  // rename-spanning production-path fixture return `[]` at the legacy SHA instead of
  // `['0001_init']` (0 passed / 1 failed).
  const migrationTrees = MIGRATION_DIRS.filter((dir) =>
    migrationTreeAtSha(repository, sha, dir, readGitTree),
  );
  // Proof: fixtures with neither and both layouts used to return an empty/combined migration
  // set. The production-path tests observed the named refusals instead of zero migrations.
  if (migrationTrees.length === 0) {
    throw new Error(
      `no supported migration tree at ${sha}; expected exactly one of ${MIGRATION_DIRS.join(', ')}`,
    );
  }
  if (migrationTrees.length > 1) {
    throw new Error(`ambiguous migration trees at ${sha}; found both ${MIGRATION_DIRS.join(', ')}`);
  }
  const dir = migrationTrees[0];
  const output = readGitTree(repository, sha, ['-r', '--name-only'], dir);
  const ids = new Set<string>();
  const prefix = `${dir}/`;
  for (const path of output.split('\0').filter((entry) => entry !== '')) {
    // Proof: injecting `outside/0001/migration.sql` through the Git boundary made
    // `refuses listing output outside the selected migration tree` observe this refusal.
    if (!path.startsWith(prefix)) {
      throw new Error(`migration tree ${dir} at ${sha} returned an out-of-tree path: ${path}`);
    }
    const relative = path.slice(prefix.length);
    const separator = relative.indexOf('/');
    // Proof: committing `drizzle/orphan.sql` made the real Git reader return a path with no
    // migration folder and `refuses a file stored directly in the migration tree` pass here.
    if (separator <= 0) {
      throw new Error(
        `migration tree ${dir} at ${sha} contains a file outside a migration folder: ${path}`,
      );
    }
    ids.add(relative.slice(0, separator));
  }
  return [...ids].sort();
}
