import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * `work-item-deadline` 8.9's repository assertion: **no unqualified deadline
 * copy remains in shipped UI text.**
 *
 * The standing scenario is `specs/scheduler-optimization/spec.md`'s "no
 * unqualified deadline copy remains" — every occurrence reads either
 * *project deadline* or *work item deadline*, because the two are different
 * dates and a bare "deadline" beside a row does not say which one moved. A
 * pinned list of allowed exceptions cannot satisfy it; the scenario says
 * *every*.
 *
 * **The unit is one occurrence of the word inside one run of user-visible
 * text**, and it is declared here, once, because the review that produced this
 * item failed on exactly that: a count built over *distinct literal values*
 * was written up as an inventory of *occurrences*, and the two numbers
 * disagreed inside one sentence.
 *
 * A run of user-visible text is what the TypeScript parser calls a string
 * literal, a template literal's fixed text, or JSX text. Taking the runs from
 * the parser rather than from a regex over the source is what lets the
 * assertion mean what it says: identifiers (`setDeadline`, `deadlineOffsetOf`),
 * member reads (`row.original.deadline`), object keys and comments are not
 * runs, so they are not occurrences, and no exclusion list has to name them. It
 * also reaches the two kinds of copy the item's first measurement never
 * scanned — JSX text, and the `aria-label` a screen reader is the only reader
 * of.
 */

/** `apps/fe-01`, which is where both configs run — see `test-tiers.test.ts`. */
const APP = process.cwd();

/** One run of user-visible text, with the 1-based line it starts on. */
type Run = { readonly file: string; readonly line: number; readonly text: string };

/**
 * Every shipped source under `src`: the `.ts` and `.tsx` that are not suites.
 *
 * `src/testing` is **included**. Its fixtures are ordinary source that happens
 * to be imported by suites, they carry no deadline copy today, and a fixture
 * that grew some would be copy a reader could still end up seeing.
 */
function shippedSources(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(APP, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
      if (/\.tsx?$/.test(entry.name)) found.push(path);
    }
  };
  walk('src');
  return found.sort();
}

/** The runs of user-visible text in one source, in source order. */
function runsIn(file: string, source: string): Run[] {
  const tree = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    // Parent pointers, so a node can be asked which line it starts on.
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const runs: Run[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node)
    ) {
      const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
      runs.push({ file, line: line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return runs;
}

/** The word, singular or plural, however it is cased. */
const OCCURRENCE = /\bdeadlines?\b/gi;

/** The same word, for asking a run whether it has one at all. */
const HAS_OCCURRENCE = /\bdeadlines?\b/i;

/** What has to sit immediately in front of every occurrence. */
const QUALIFIER = /(?:project|work item)\s$/i;

/**
 * Whether a run can be copy at all.
 *
 * A run with no whitespace in it is skipped: `'deadline'` on its own is a
 * column id, an attribute name or a module path, never a sentence. This is the
 * only heuristic in the file, and it is the safe direction to be wrong in — a
 * bare word cannot be copy, while anything with a space in it is checked.
 */
const couldBeCopy = (run: Run): boolean => /\s/.test(run.text) && HAS_OCCURRENCE.test(run.text);

/** The occurrences in one run that do not say which deadline they mean. */
function unqualifiedIn(run: Run): string[] {
  if (!couldBeCopy(run)) return [];
  const bare: string[] = [];
  for (const match of run.text.matchAll(OCCURRENCE)) {
    if (!QUALIFIER.test(run.text.slice(0, match.index))) {
      bare.push(`${run.file}:${run.line} — ${run.text.trim()}`);
    }
  }
  return bare;
}

/** Every run of deadline copy in the shipped tree, qualified or not. */
function deadlineCopy(): Run[] {
  const found: Run[] = [];
  for (const file of shippedSources()) {
    for (const run of runsIn(file, readFileSync(join(APP, file), 'utf8'))) {
      if (couldBeCopy(run)) found.push(run);
    }
  }
  return found;
}

describe('the scan, on sources written to fail it', () => {
  // The control the tree assertion cannot be: a case that only ever asserts an
  // empty list passes just as well once the scan has stopped seeing anything.
  // Each source below is one the scan has to disagree with.

  it('reads a bare deadline in an aria-label as unqualified', () => {
    const source = 'const a = <input aria-label={`Deadline for ${n}`} />;\n';
    expect(runsIn('src/x.tsx', source).flatMap(unqualifiedIn)).toHaveLength(1);
  });

  it('reads the same label as qualified once it names which deadline', () => {
    const source = 'const a = <input aria-label={`Work item deadline for ${n}`} />;\n';
    expect(runsIn('src/x.tsx', source).flatMap(unqualifiedIn)).toEqual([]);
  });

  it('reads JSX text, which this item’s first measurement never scanned', () => {
    const qualified = 'const a = <p>Plan infeasible · 3 Work item deadlines</p>;\n';
    const bare = 'const a = <p>Plan infeasible · 3 deadlines</p>;\n';
    expect(runsIn('src/x.tsx', qualified).flatMap(unqualifiedIn)).toEqual([]);
    expect(runsIn('src/x.tsx', bare).flatMap(unqualifiedIn)).toHaveLength(1);
  });

  it('counts occurrences and not distinct values — two in one sentence are two', () => {
    // The Critical this item earned, as a case: one sentence can say the word
    // twice, and a measure over distinct values would call that one.
    const source = "const s = 'This deadline is early; move the deadline.';\n";
    expect(runsIn('src/x.ts', source).flatMap(unqualifiedIn)).toHaveLength(2);
  });

  it('ignores identifiers, member reads, keys and comments', () => {
    const source = [
      '// A comment about the deadline, which is not copy.',
      '/** A doc block naming the deadline and {@link setDeadline}. */',
      "const setDeadline = (deadline: string) => cellKey(deadline, 'deadline');",
      'const d = row.original.deadline;',
      "import { deadlineOffsetOf } from '@wbs/domain/workday';",
      '',
    ].join('\n');
    expect(runsIn('src/x.ts', source).flatMap(unqualifiedIn)).toEqual([]);
  });

  it('does not read a qualifier across a template hole', () => {
    // `${kind} deadline` is unqualified in the source even where every value
    // of `kind` would qualify it, because the fixed text is all the scan has —
    // and all a reader auditing the source has either.
    const source = 'const s = `${kind} deadline for ${n}`;\n';
    expect(runsIn('src/x.ts', source).flatMap(unqualifiedIn)).toHaveLength(1);
  });
});

describe('shipped deadline copy', () => {
  it('names which deadline it means, everywhere', () => {
    // 8.9's assertion. The failure message is the list itself, so a new
    // unqualified string names itself and its line instead of moving a count.
    expect(deadlineCopy().flatMap(unqualifiedIn)).toEqual([]);
  });

  it('still reaches the copy it is about — the scan is not vacuous', () => {
    // Without this, deleting `runsIn`'s JSX and template arms would leave the
    // assertion above green and empty. These are the two components that carry
    // the copy: the indicator's project-comparison strings, and the table's
    // work-item cell.
    const files = new Set(deadlineCopy().map((run) => run.file));
    expect(files.has('src/components/wbs/optimization-indicator.tsx')).toBe(true);
    expect(files.has('src/components/wbs/wbs-table.tsx')).toBe(true);
  });

  it('reaches the five occurrences this item qualified, by their text', () => {
    // Sol's r5 inventory, re-measured as text rather than as line numbers:
    // lines move, and a citation that moves is the fault the withdrawn count
    // had. Four runs carry the five occurrences — the impossible sentence says
    // the word twice, and the three cell labels are one string each.
    const texts = deadlineCopy().map((run) => run.text);
    expect(texts.filter((text) => text === 'Work item deadline for ')).toHaveLength(3);
    expect(texts.filter((text) => text.includes('This work item deadline falls before'))).toEqual([
      "This work item deadline falls before the project's first working day, so nothing can finish by it. The date is kept; move the work item deadline or the project start.",
    ]);
    expect(texts.some((text) => text.includes('hold a work item deadline against'))).toBe(true);
  });
});
