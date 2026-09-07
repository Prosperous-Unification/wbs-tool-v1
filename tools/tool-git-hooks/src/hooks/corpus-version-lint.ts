import { spawnSync } from 'node:child_process';

import ts from 'typescript';

/**
 * The mechanical half of `SCHEDULER_CONTRACT_VERSION`'s obligation: a golden
 * fixture whose `cases` moved without the constant moving with them.
 *
 * **What was missing.** Both corpora assert two things about ONE tree — the
 * fixture's `contractVersion` equals the current constant, and the fixture's
 * cases equal the current computation — and each writer emits the current
 * constant beside the current cases. So a semantic change with the constant
 * left at `8`, followed by the documented `bun …/write-*-golden-corpus.ts`,
 * writes `{ contractVersion: 8, cases: <new bytes> }` and both assertions pass.
 * Nothing in a single tree relates the new bytes to the historical meaning of
 * version 8, because the question is about TWO commits and a unit test's
 * subject is one.
 *
 * **Why a script under a CI step and not a `bun:test` case.** A test that reads
 * a merge base has to answer "which base?" at run time, and the answer differs
 * on a first commit, a rebase, a squash, a detached CI checkout and a developer
 * with no remote configured. Every wrong answer lands in one of two bad places:
 * a false red on somebody's laptop, or a silent skip — and a guard that skips
 * itself is the check-that-cannot-fail AGENTS.md R5 names, which
 * `fast-golden-corpus.test.ts` already quotes at itself. `Doc caps` and
 * `Migration lint` are the established shape for a gate that has to look at the
 * repository rather than at one module, and CI is where the two-commit question
 * is answerable.
 *
 * **The boundary is chosen by the caller and never inferred here.** `HEAD^`
 * would have been the obvious inference and it is wrong for a multi-commit
 * push: if commit B regenerates a fixture unbumped and commit C is unrelated, a
 * push ending at C compares C against B, sees no fixture change and passes
 * while `main` carries new cases under the old version. `main` is not
 * protected, so that shape is admitted. `workflow_dispatch` has no push
 * boundary and no `base_ref` at all. The workflow therefore names the boundary
 * per event — `github.event.before` on push, the merge base on a pull request,
 * an explicit input on dispatch — and this file's job is to refuse anything it
 * cannot read rather than to guess a substitute.
 *
 * **Everything unreadable fails closed with a named reason.** An absent, empty
 * or all-zero base, a missing or ambiguous constant, a deleted fixture,
 * malformed JSON: each is an error naming what could not be read. None of them
 * is a skip.
 *
 * **Two independent refusals, not one.** A fixture whose `cases` moved while the
 * constant stood still is the rule this file was written for. A constant that
 * moved *backwards* is a second rule, asked before any fixture is opened and
 * answered whatever the fixtures say: reusing a retired version makes cache
 * rows computed under its older meaning addressable again, and byte-identical
 * corpora do not certify the meaning is unchanged — they sample a fixed handful
 * of inputs and are silent about the rest. Both are reported when both hold.
 *
 * **The ceiling, stated so the headers can match it.** A version increase made
 * in the same change for an unrelated reason lets this pass. That is not a
 * cache-safety hole — the corpus lands under a new version and the old rows are
 * evicted either way — but it does mean the check proves the two moved
 * together, not that the author bumped *because* of the semantic change.
 */

/** Where the constant is declared. One path, spelled out, never searched for. */
export const CONTRACT_VERSION_PATH = 'libs/domain/src/contract-version.ts';

/**
 * The version-keyed fixtures. Both, because the hole this closes was identical
 * in both and a list of one would leave the other exactly as it was.
 */
export const CORPUS_FIXTURES = [
  'libs/domain/fixtures/fast-golden-corpus.json',
  'libs/domain/fixtures/solver-quantum-golden-corpus.json',
] as const;

/**
 * The two git reads this check needs, behind a port so the whole comparison is
 * an ordinary unit test with no subprocess and no repository.
 *
 * `null` means the path does not exist at that revision, which is a real answer
 * the lifecycle rules below act on. A revision that cannot be read is a
 * THROWN error, because it is not an answer about a path.
 */
export interface RevisionPort {
  readAt(rev: string, path: string): string | null;
}

export interface CorpusVersionIssue {
  reason: string;
}

export interface Boundary {
  /** The revision this change is measured against. Chosen by the caller. */
  base: string;
  /** The revision being checked. `HEAD` under CI. */
  head: string;
}

const ALL_ZERO = /^0{40}$/;

/**
 * The exported declaration, found by PARSING the file rather than by matching
 * text in it.
 *
 * Two rounds of peer review defeated a textual reader, and the second one is
 * the reason this is a parse. Round 2 broke a bare pattern with a block comment
 * placed between the constant's name and its `=`, plus a commented-out
 * declaration naming a higher number; the answer was to blank comments first
 * and anchor the pattern to a line start. Round 3 then broke *that*, and the
 * bypass was measured before it was believed:
 *
 * ```ts
 * const TEMPLATE = `
 * export const SCHEDULER_CONTRACT_VERSION = 9;
 * `;
 * const OPEN = '/*';
 * export const SCHEDULER_CONTRACT_VERSION = 8;
 * const CLOSE = '*' + '/';
 * ```
 *
 * A comment stripper that does not know what a string is treats `'/*'` … as
 * opening a block comment, blanks the real declaration between them, and the
 * line inside the template literal — which is data, not code — supplies the
 * only match. The reader returns `9` while the module still exports `8`, and
 * moved fixture cases pass as an increase.
 *
 * There is no textual patch for that: the difference between code and a string
 * containing code is exactly what a parser is for, and the previous header's
 * claim that over-stripping "can only produce a named missing-declaration
 * error" was wrong for the same reason. So the value comes from the syntax
 * tree: one exported `const` binding this name, at the top level, whose
 * initialiser is a numeric literal node. A template's contents are never
 * statements, a string's contents are never tokens, and a commented-out
 * declaration is trivia the parser never yields.
 */
function versionDeclarationsIn(source: string): {
  readonly file: ts.SourceFile;
  readonly initialisers: readonly (ts.Expression | undefined)[];
} {
  const file = ts.createSourceFile(
    CONTRACT_VERSION_PATH,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const initialisers: (ts.Expression | undefined)[] = [];
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported !== true) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (declaration.name.text !== 'SCHEDULER_CONTRACT_VERSION') continue;
      // A binding with no initialiser is `declare const`-shaped and names no
      // number. Recorded as a declaration anyway, so that a file holding one
      // fails with a reason rather than reading as "declares none".
      initialisers.push(declaration.initializer);
    }
  }
  return { file, initialisers };
}

/**
 * Read as a NUMBER at both revisions, not as bytes.
 *
 * Comparing `contract-version.ts` blobs would count a prose edit as a bump, and
 * that file is nearly all prose. Reading the fixture's own `contractVersion`
 * field would hand the invariant back to the assertion the corpora already
 * make. So the integer is taken off the declaration's initialiser node, and
 * anything that is not exactly one integer-valued declaration is an error.
 */
function versionAt(rev: string, port: RevisionPort): number {
  const source = port.readAt(rev, CONTRACT_VERSION_PATH);
  if (source === null)
    throw new Error(`${CONTRACT_VERSION_PATH} does not exist at ${rev}, so no version can be read`);
  const { file, initialisers } = versionDeclarationsIn(source);
  if (initialisers.length === 0)
    throw new Error(
      `${CONTRACT_VERSION_PATH} at ${rev} declares no exported SCHEDULER_CONTRACT_VERSION, ` +
        'so the version this change starts from is unknown.',
    );
  if (initialisers.length > 1)
    throw new Error(
      `${CONTRACT_VERSION_PATH} at ${rev} declares SCHEDULER_CONTRACT_VERSION twice, ` +
        'so which one governs the corpora is ambiguous.',
    );
  const initialiser = initialisers[0];
  // `ts.isNumericLiteral` is the whole type check: `-1` is a prefix unary
  // expression and not a numeric literal, `'8'` is a string literal, and `8n`
  // is a bigint literal. Each of them arrives here as its own node kind.
  if (initialiser === undefined || !ts.isNumericLiteral(initialiser))
    throw new Error(
      `SCHEDULER_CONTRACT_VERSION at ${rev} is \`${
        initialiser === undefined ? '' : initialiser.getText(file)
      }\`, not an integer literal. ` +
        'This check compares version numbers and cannot order anything else.',
    );
  // `.text` is the literal with numeric separators already removed, so `1_000`
  // reads as `1000` rather than being refused for a legal spelling. What it
  // does NOT do is bound the value: a long enough digit string converts to
  // `Infinity`, which compares greater than every version and can never be
  // exceeded afterwards. That is a version no bump could follow, so it is
  // refused here rather than stored.
  const literal = initialiser.text;
  if (!/^\d+$/.test(literal))
    throw new Error(
      `SCHEDULER_CONTRACT_VERSION at ${rev} is \`${literal}\`, not an integer literal. ` +
        'This check compares version numbers and cannot order anything else.',
    );
  const version = Number(literal);
  if (!Number.isSafeInteger(version))
    throw new Error(
      `SCHEDULER_CONTRACT_VERSION at ${rev} is \`${literal}\`, which is not a safe integer. ` +
        'A version no later version can compare greater than is not a version this check can order.',
    );
  return version;
}

/**
 * Object keys sorted at every depth, so the comparison below is by value.
 *
 * That is deliberate and it is the same unit the corpus tests use: both compare
 * parsed `cases` with `toEqual`, so reordering keys is not a change to either
 * of them and must not be a change here either. Layout is the format check's
 * business (`bunx nx format:check --all`), which is a separate gate with a
 * separate red.
 */
function byKey([a]: [string, unknown], [b]: [string, unknown]): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function canonical(value: unknown): string {
  if (value === null) return 'null';
  // `JSON.stringify(-0)` is `"0"`, and `toEqual` tells the two apart — so
  // without this line a stored value could move from `0` to `-0` under an
  // unchanged version while this file called them equal, which is exactly the
  // silence it exists to prevent. Found by peer review, not by a case.
  if (Object.is(value, -0)) return '-0';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(byKey);
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * The fixture's `cases` and nothing else.
 *
 * `cases` only, never the whole file: a legitimate bump rewrites
 * `contractVersion` too — both writers emit the whole object — and a
 * whole-file comparison would make every bump look like a case change.
 */
function casesAt(rev: string, path: string, port: RevisionPort): string | null {
  const raw = port.readAt(rev, path);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: unknown) {
    // The message keeps the parser's own words because that is what the gate
    // prints: `lintCorpusVersion` flattens every throw from here to
    // `{ reason: e.message }`, so a bare `cause` would read as preserved and
    // print as nothing. `cause` is attached as well, for a caller that ever
    // stops flattening.
    //
    // `raw` is never interpolated, but that is not a guarantee that the
    // fixture stays out of the log: a `JSON.parse` message may quote the token
    // it choked on. That is how this line already behaved before `cause`
    // existed, and narrowing it is a separate decision from unbreaking the
    // gate — so it is said here rather than claimed away.
    throw new Error(
      `${path} at ${rev} is not valid JSON (${e instanceof Error ? e.message : String(e)}), ` +
        'so its cases could not be compared.',
      { cause: e },
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`${path} at ${rev} is not a JSON object, so it has no cases to compare.`);
  const cases = (parsed as Record<string, unknown>)['cases'];
  if (cases === undefined || cases === null || typeof cases !== 'object' || Array.isArray(cases))
    throw new Error(
      `${path} at ${rev} has no \`cases\` object, so there is nothing for this check to compare.`,
    );
  return canonical(cases);
}

/**
 * Every issue, not the first: two fixtures can move in one commit and a gate
 * that names one of them sends the author round twice.
 */
export function lintCorpusVersion(boundary: Boundary, port: RevisionPort): CorpusVersionIssue[] {
  const { base, head } = boundary;
  if (base.trim() === '')
    return [
      {
        reason:
          'No base revision was supplied. The workflow chooses the boundary per event and ' +
          'passes it in; an empty one means that selection failed, and comparing against ' +
          'nothing would pass every change.',
      },
    ];
  if (ALL_ZERO.test(base))
    return [
      {
        reason:
          `The base revision ${base} is the all-zero SHA, which names no commit — it is what ` +
          'a branch creation reports as `before`. The workflow must supply a real boundary.',
      },
    ];

  let baseVersion: number;
  let headVersion: number;
  try {
    baseVersion = versionAt(base, port);
    headVersion = versionAt(head, port);
  } catch (e: unknown) {
    return [{ reason: e instanceof Error ? e.message : String(e) }];
  }

  const issues: CorpusVersionIssue[] = [];
  // Asked before any fixture is opened, and answered whatever they say. The
  // per-fixture rule below only reaches the versions once a `cases` value has
  // already moved, so a revision that lowers the constant with both corpora
  // untouched used to return zero issues — the shape this check exists to
  // refuse, arriving by the one door it was not watching.
  if (headVersion < baseVersion)
    issues.push({
      reason:
        `SCHEDULER_CONTRACT_VERSION went from ${String(baseVersion)} at ${base} to ` +
        `${String(headVersion)} at ${head} — a decrease. Stored schedules are keyed on that ` +
        'number, so reusing a version makes rows computed under its older meaning addressable ' +
        'again. Identical fixture cases do not license that: the corpora sample a fixed handful ' +
        `of inputs and say nothing about the rest. Move ${CONTRACT_VERSION_PATH} forward instead.`,
    });
  for (const fixture of CORPUS_FIXTURES) {
    let before: string | null;
    let after: string | null;
    try {
      before = casesAt(base, fixture, port);
      after = casesAt(head, fixture, port);
    } catch (e: unknown) {
      issues.push({ reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    // A fixture that is gone at head is a hard failure whatever the constant
    // did. The corpora are the guard; deleting one is a decision that does not
    // get to ride along inside a version bump.
    if (after === null) {
      issues.push({
        reason:
          `${fixture} does not exist at ${head}. Both golden corpora are checked in, and ` +
          'removing one is not something a contract-version bump can authorise.',
      });
      continue;
    }
    // Absent at base and present at head is new stored behaviour under a
    // version that has been in use, so it is a change like any other.
    if (before === after) continue;
    if (headVersion > baseVersion) continue;
    issues.push({
      reason:
        `${fixture} has different \`cases\` than at ${base}, but SCHEDULER_CONTRACT_VERSION ` +
        `went from ${String(baseVersion)} to ${String(headVersion)} — it did not increase. ` +
        'Stored schedules are keyed on that number, so cached rows computed under the old ' +
        'semantics stay addressable and keep being served. Bump the constant in ' +
        `${CONTRACT_VERSION_PATH} and regenerate, or restore the fixture.`,
    });
  }
  return issues;
}

/**
 * The adapter. `git cat-file -e` answers "does this path exist at this
 * revision" without conflating it with "is this revision readable", which is
 * the distinction the whole lifecycle rests on.
 */
export function gitPort(cwd: string = process.cwd()): RevisionPort {
  return {
    readAt(rev, path) {
      const spec = `${rev}:${path}`;
      const exists = spawnSync('git', ['cat-file', '-e', spec], { cwd });
      if (exists.status === 0) {
        const shown = spawnSync('git', ['show', spec], { cwd, encoding: 'utf8' });
        if (shown.status !== 0) throw new Error(`git show ${spec} failed: ${shown.stderr.trim()}`);
        return shown.stdout;
      }
      // The path is absent only if the revision itself resolved. Otherwise the
      // failure belongs to the boundary and must not be read as "no fixture".
      const resolved = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
        cwd,
        encoding: 'utf8',
      });
      if (resolved.status !== 0)
        throw new Error(
          `The base or head revision \`${rev}\` could not be resolved in this checkout. ` +
            'CI checks out with fetch-depth 0 so a real boundary is reachable; a missing one ' +
            'is a workflow fault, not a clean tree.',
        );
      return null;
    },
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const base = args.length > 0 ? args[0] : '';
  const head = args.length > 1 ? args[1] : 'HEAD';
  const issues = lintCorpusVersion({ base, head }, gitPort());
  if (issues.length > 0) {
    console.error('[tool-git-hooks] corpus-version-lint failed:');
    for (const i of issues) console.error(`  ${i.reason}`);
    process.exit(1);
  }
  console.log(
    `corpus-version-lint: ${String(CORPUS_FIXTURES.length)} fixtures checked ${base}..${head}`,
  );
}

if (import.meta.main) {
  main();
}
