import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Blue and green run against one SQLite file, so a migration that removes or
 * renames something the outgoing release still reads breaks production
 * mid-swap. This hook is the automated half of that rule.
 *
 * It used to match by substring against the raw file, with the rename rule
 * spelled `'ALTER TABLE ... RENAME COLUMN'` and the ellipsis deleted before
 * matching — needle `ALTER TABLE RENAME COLUMN`. Valid SQL always names the
 * table between those two tokens, so that branch could not match any real
 * migration: the rename rule never fired once. Raw-substring matching also
 * missed anything split across a newline or written with doubled spaces,
 * which is how generated SQL is usually formatted.
 *
 * Patterns are therefore regexes applied to whitespace-normalised SQL, one
 * statement at a time. Per-statement matching is what keeps the two-token
 * rename pattern honest: against the whole file, `.*` would happily bridge an
 * `ALTER TABLE` in one statement and a `RENAME COLUMN` in another.
 */
const FORBIDDEN: { label: string; pattern: RegExp }[] = [
  { label: 'DROP TABLE', pattern: /\bDROP TABLE\b/ },
  { label: 'DROP COLUMN', pattern: /\bDROP COLUMN\b/ },
  { label: 'ALTER TABLE ... RENAME COLUMN', pattern: /\bALTER TABLE\b.*\bRENAME COLUMN\b/ },
  { label: 'TRUNCATE', pattern: /\bTRUNCATE\b/ },
  // A column added `NOT NULL` with no default is the one additive-looking
  // statement SQLite refuses outright, and it refuses it at **runtime**, against
  // a populated table, on the deploy that runs it — every table in this schema is
  // populated in dev and prod, so this is a migration that passes every check in
  // the tree and then takes the release down. `DEFAULT` earns the exception
  // because SQLite can then fill the existing rows, so the statement is genuinely
  // additive; the tempting shortcut it does not earn is stamping an audit column
  // with a made-up author (R5: never convert an unknown into a default).
  //
  // The lookahead is bounded to the statement because statements are matched one
  // at a time here — a `DEFAULT` in the next `ALTER` cannot excuse this one.
  //
  // Proof: this entry deleted, `rejects a NOT NULL column added with no default`
  // failed on `Received value must be a string: undefined` — the lint returned no
  // issue at all for `ALTER TABLE tag ADD created_by text NOT NULL`. Watched
  // 2026-09-01, with the two positive cases beside it staying green, so the
  // pattern is refusing the statement rather than refusing `NOT NULL`.
  {
    label: 'ADD COLUMN ... NOT NULL with no DEFAULT',
    pattern: /\bADD (?:COLUMN )?(?![^;]*\bDEFAULT\b)[^;]*\bNOT NULL\b/,
  },
];

/**
 * The migrations allowed to carry a statement {@link FORBIDDEN} refuses, and
 * what each one must ship to earn that.
 *
 * A waiver is not "this migration is trusted". It names the exact labels it
 * lifts and the gate script that has to be in the tree beside it, so the
 * argument for the exception lives where the exception is granted. Every other
 * migration is unaffected: the additive rule is the default and this table is
 * the only door out of it.
 *
 * `20260831120000_rename_role_to_step` renames tables and columns, which no
 * outgoing colour could read. It is safe only while no prod release exists, and
 * `bin/assert-no-prod-release.sh` is what reads the recorded release state and
 * refuses when one does. **The lint requires that script to be present, not to
 * pass** — CI cannot reach the deploy host, and a gate that quietly succeeded
 * because it could not reach anything would be worse than none. The operator
 * runs it against prod's state directory before deploying; the lint's job is
 * that the migration can never land in a tree where the check has been deleted.
 *
 * Proof: `migration-lint.test.ts` `refuses the rename migration when its gate
 * script is absent` — watched failing with the `existsSync` requirement
 * removed, on `Received value must be a string: undefined`: the lint returned
 * no issue at all. Observed 2026-08-31.
 */
interface Waiver {
  readonly labels: readonly string[];
  readonly gateScript: string;
}

/**
 * A `Map` rather than an object literal, so a migration folder called
 * `constructor` or `toString` cannot resolve to something off Object's
 * prototype and waive itself. It also types the miss honestly: this repo has
 * `noUncheckedIndexedAccess` off, so an indexed read would hand back a `Waiver`
 * for a folder that has none and the guard below would be unreachable.
 */
const WAIVERS = new Map<string, Waiver>([
  [
    '20260831120000_rename_role_to_step',
    { labels: ['ALTER TABLE ... RENAME COLUMN'], gateScript: 'bin/assert-no-prod-release.sh' },
  ],
]);

function assertMigrationWorkspace(file: string, workspaceRoot: string): string {
  // Proof: injecting `.` as the production boundary's workspace root made
  // `refuses a relative workspace root` observe this named refusal.
  if (!isAbsolute(workspaceRoot) || resolve(workspaceRoot) !== workspaceRoot) {
    throw new Error(`workspace root must be an absolute normalized path: ${workspaceRoot}`);
  }
  const migrationsRoot = join(workspaceRoot, 'apps', 'wbs', 'be-01', 'drizzle');
  const migrationPath = resolve(file);
  const fromMigrationsRoot = relative(migrationsRoot, migrationPath);
  // Proof: supplying an unrelated checkout root to the production lint path previously
  // resolved the waiver by directory depth. The moved-depth fixture observed a resolved
  // promise instead of the required `workspace root ... migration` refusal (10 pass / 3 fail).
  if (
    fromMigrationsRoot === '' ||
    fromMigrationsRoot === '..' ||
    fromMigrationsRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromMigrationsRoot)
  ) {
    throw new Error(
      `workspace root ${workspaceRoot} does not own migration ${migrationPath} under ${migrationsRoot}`,
    );
  }
  return workspaceRoot;
}

export interface MigrationIssue {
  file: string;
  reason: string;
}

/**
 * Uppercased, comments removed, every whitespace run collapsed to one space.
 * Comments go first so a `-- drop table users` note in the header cannot fail
 * the hook; whitespace collapsing is what makes a statement broken over three
 * lines look the same as one written inline.
 */
function normalizeSql(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

function compatibleRebuildTarget(raw: string): string | null {
  if (
    !raw.includes('-- migration-lint: compatible-table-rebuild') ||
    !raw.includes('-- foreign-keys-off-rebuild')
  )
    return null;
  const sql = normalizeSql(raw).replace(/[`"]/g, '');
  const created = /\bCREATE TABLE (\w+)_NEW\b/.exec(sql);
  if (created === null) return null;
  const target = created[1];
  const drops = [...sql.matchAll(/\bDROP TABLE (\w+)\b/g)].map((hit) => hit[1]);
  if (drops.length !== 1 || drops[0] !== target) return null;
  if (!new RegExp(`\\bALTER TABLE ${target}_NEW RENAME TO ${target}\\b`).test(sql)) return null;
  if (!/\bCHECK \(VIOLATIONS = 0\)/.test(sql)) return null;
  if (!/\bSELECT COUNT\(\*\) FROM PRAGMA_FOREIGN_KEY_CHECK\b/.test(sql)) return null;
  return target;
}

/**
 * A down script is destructive BY DEFINITION -- reversing an additive forward
 * migration means dropping what it added -- so the forbidden-statement rules
 * do not apply to it. What is checked instead is that it exists at all.
 *
 * The asymmetry is the whole policy: forward migrations stay additive so blue
 * and green can share one database mid-swap, and the destructive half is
 * quarantined in a file that runs only when one of those colours is being
 * taken away.
 */
export function isDownScript(file: string): boolean {
  return basename(file) === 'down.sql';
}

/**
 * Every migration must ship the script that reverses it. Without one, a failed
 * deploy leaves the old release running against a schema it did not ask for
 * and cannot undo -- the deploy's rollback restores routing, and the database
 * stays where the migration left it.
 */
export function lintDownScriptPresence(file: string): MigrationIssue | null {
  if (basename(file) !== 'migration.sql') return null;
  const down = join(dirname(file), 'down.sql');
  if (existsSync(down)) return null;
  return {
    file,
    reason:
      `${basename(dirname(file))} has no down.sql. Every migration must ship the ` +
      'script that reverses it, or a failed deploy cannot restore the schema the ' +
      'still-serving release expects.',
  };
}

export async function lintMigration(
  file: string,
  workspaceRoot: string = process.cwd(),
): Promise<MigrationIssue | null> {
  if (!file.endsWith('.sql')) return null;
  const root = assertMigrationWorkspace(file, workspaceRoot);
  const missingDown = lintDownScriptPresence(file);
  if (missingDown) return missingDown;
  if (isDownScript(file)) return null;
  // Fail closed. This used to swallow the error and lint '' instead, so a
  // migration the hook could not open was indistinguishable from a clean one
  // — the check reported success precisely when it had checked nothing.
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e: unknown) {
    return {
      file,
      reason:
        `${basename(file)} could not be read (${e instanceof Error ? e.message : String(e)}), ` +
        'so it could not be checked for destructive statements.',
    };
  }
  const folder = basename(dirname(file));
  const waiver = WAIVERS.get(folder);
  if (waiver !== undefined && !existsSync(join(root, waiver.gateScript))) {
    return {
      file,
      reason:
        `${folder} is waived from ${waiver.labels.join(', ')} only while ` +
        `${waiver.gateScript} is in the tree, and it is not. That script is what refuses ` +
        'this migration when a prod release is recorded as deployed; without it the ' +
        'waiver rests on nothing.',
    };
  }
  const rebuildTarget = compatibleRebuildTarget(raw);
  for (const statement of normalizeSql(raw).split(';')) {
    for (const { label, pattern } of FORBIDDEN) {
      if (pattern.test(statement)) {
        if (waiver?.labels.includes(label)) continue;
        const unquoted = statement.replace(/[`"]/g, '');
        if (
          label === 'DROP TABLE' &&
          rebuildTarget !== null &&
          new RegExp(`\\bDROP TABLE ${rebuildTarget}\\b`).test(unquoted)
        )
          continue;
        return {
          file,
          reason:
            `${basename(file)} contains destructive statement: ${label}. ` +
            `Destructive migrations must be split into a deploy-then-cleanup pair (see plan).`,
        };
      }
    }
  }
  return null;
}

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  const issues: MigrationIssue[] = [];
  const workspaceRoot = process.cwd();
  for (const f of files) {
    const hit = await lintMigration(f, workspaceRoot);
    if (hit) issues.push(hit);
  }
  if (issues.length > 0) {
    console.error('[tool-git-hooks] migration-lint failed:');
    for (const i of issues) console.error(`  ${i.file}: ${i.reason}`);
    process.exit(1);
  }
}

if (import.meta.main) {
  void main();
}
