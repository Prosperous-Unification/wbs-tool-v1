import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

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
];

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

export async function lintMigration(file: string): Promise<MigrationIssue | null> {
  if (!file.endsWith('.sql')) return null;
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
  const rebuildTarget = compatibleRebuildTarget(raw);
  for (const statement of normalizeSql(raw).split(';')) {
    for (const { label, pattern } of FORBIDDEN) {
      if (pattern.test(statement)) {
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
  for (const f of files) {
    const hit = await lintMigration(f);
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
