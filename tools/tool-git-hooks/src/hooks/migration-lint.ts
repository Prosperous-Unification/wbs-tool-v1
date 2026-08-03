import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

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

export async function lintMigration(file: string): Promise<MigrationIssue | null> {
  if (!file.endsWith('.sql')) return null;
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
  for (const statement of normalizeSql(raw).split(';')) {
    for (const { label, pattern } of FORBIDDEN) {
      if (pattern.test(statement)) {
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
