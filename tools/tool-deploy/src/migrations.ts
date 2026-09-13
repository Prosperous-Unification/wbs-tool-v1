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

function git(repository: string, args: string[], description: string): string {
  const process = Bun.spawnSync(['git', '-C', repository, ...args]);
  if (process.exitCode !== 0) {
    throw new Error(
      `${description} failed: ${process.stderr.toString('utf8').trim() || 'git returned no diagnostic'}`,
    );
  }
  return process.stdout.toString('utf8');
}

/**
 * Lists migration folder names at a revision while the repository transitions
 * between its two supported backend layouts. The working tree cannot select
 * the path: the deployed SHA may predate the namespace move.
 *
 * Exactly one root must be a tree at the revision. An empty result would mean
 * "no migrations" to the deploy guard, so absence, ambiguity and unreadable
 * revisions are refused rather than converted into that valid domain value.
 */
export function migrationsAtSha(sha: string, repository: string = process.cwd()): string[] {
  git(repository, ['cat-file', '-e', `${sha}^{tree}`], `git revision ${sha}`);
  const rootOutput = git(
    repository,
    ['ls-tree', '-d', '--name-only', sha, '--', ...MIGRATION_DIRS],
    `migration-root discovery at ${sha}`,
  );
  const roots = rootOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const supportedRoots = new Set<string>(MIGRATION_DIRS);
  const unknown = roots.find((root) => !supportedRoots.has(root));
  if (unknown !== undefined) {
    throw new Error(`migration-root discovery at ${sha} returned unexpected path ${unknown}`);
  }
  const uniqueRoots = [...new Set(roots)];
  if (uniqueRoots.length === 0) {
    throw new Error(
      `revision ${sha} has neither supported migration root: ${MIGRATION_DIRS.join(' or ')}`,
    );
  }
  if (uniqueRoots.length !== 1) {
    throw new Error(
      `revision ${sha} has both supported migration roots: ${MIGRATION_DIRS.join(' and ')}`,
    );
  }
  const migrationDir = uniqueRoots[0];
  const files = git(
    repository,
    ['ls-tree', '-r', '--name-only', sha, '--', migrationDir],
    `migration listing at ${sha} for ${migrationDir}`,
  );
  const ids = new Set<string>();
  const prefix = `${migrationDir}/`;
  for (const raw of files.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (!line.startsWith(prefix)) {
      throw new Error(`migration listing at ${sha} returned unexpected path ${line}`);
    }
    const rest = line.slice(prefix.length);
    const id = rest.split('/')[0];
    if (id === '') {
      throw new Error(`migration listing at ${sha} returned malformed path ${line}`);
    }
    ids.add(id);
  }
  return [...ids].sort();
}
