import { readFile } from 'node:fs/promises';

const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'AWS access key id', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'private RSA/EC key header', re: /-----BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY-----/ },
  { name: 'age secret key', re: /AGE-SECRET-KEY-1[0-9A-Z]{58}/ },
  { name: 'GitHub PAT (ghp_)', re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: 'slack token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
];

export interface ScanResult {
  file: string;
  finding: string;
}

/** Thrown when a file could not be read, so its contents were never scanned. */
export class UnscannableFileError extends Error {
  constructor(
    readonly file: string,
    readonly readError: unknown,
  ) {
    super(`${file}: could not be read, so it was never scanned for secrets`);
    this.name = 'UnscannableFileError';
  }
}

/**
 * Scans one file, returning the first pattern that matches or `null` for clean.
 *
 * Read failures throw rather than resolving to `''`. They used to be swallowed
 * with `.catch(() => '')`, which made an unreadable file scan as clean — the
 * scanner's answer for "this file definitely holds no secret" and its answer
 * for "I never looked" were the same value. That is the whole reason this hook
 * exists inverted: a secret in a file the scanner cannot open is exactly the
 * case where a silent pass is most expensive.
 *
 * Exactly two errnos are modeled, and neither is a guess about content:
 *
 * - ENOENT — lefthook passes staged paths, and a commit that deletes a file
 *   stages a path that is already gone. There is nothing to scan.
 * - EISDIR — a directory, or a symlink to one, has no file contents at all.
 *   `.claude/skills/*` are symlinks to directories under `.agents/skills/`,
 *   and `git ls-files` lists them. Their real files are tracked and scanned
 *   individually, so nothing goes unexamined by stepping over the link.
 *
 * Every other errno — EACCES, EIO, ELOOP — means bytes exist that were not
 * read, and is raised. The distinction that matters is between "there is
 * nothing here to scan" and "there is something here I did not look at".
 *
 * Proof: `scan()` on a chmod-000 file throws UnscannableFileError; on a missing
 * path and on a directory it returns null. See hooks.test.ts.
 */
export async function scan(file: string): Promise<ScanResult | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e: unknown) {
    const code = e !== null && typeof e === 'object' && 'code' in e ? e.code : undefined;
    if (code === 'ENOENT' || code === 'EISDIR') return null;
    throw new UnscannableFileError(file, e);
  }
  for (const p of PATTERNS) {
    if (p.re.test(raw)) return { file, finding: p.name };
  }
  return null;
}

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  const findings: ScanResult[] = [];
  const unscannable: UnscannableFileError[] = [];
  for (const f of files) {
    try {
      const hit = await scan(f);
      if (hit) findings.push(hit);
    } catch (e: unknown) {
      // Collected rather than thrown immediately so one unreadable file does
      // not hide a real secret in a later one. Both abort.
      if (e instanceof UnscannableFileError) unscannable.push(e);
      else throw e;
    }
  }
  if (findings.length > 0) {
    console.error('[tool-git-hooks] plaintext secret detected — aborting commit:');
    for (const f of findings) console.error(`  ${f.file}: ${f.finding}`);
  }
  if (unscannable.length > 0) {
    console.error('[tool-git-hooks] files could not be scanned — aborting rather than assuming');
    console.error('  they are clean. Fix permissions, or remove them from the scan set.');
    for (const u of unscannable) console.error(`  ${u.file}`);
  }
  if (findings.length > 0 || unscannable.length > 0) process.exit(1);
}

if (import.meta.main) {
  void main();
}
