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
 * _project deadline_ or _work item deadline_, because the two are different
 * dates and a bare "deadline" beside a row does not say which one moved. A
 * pinned list of allowed exceptions cannot satisfy it; the scenario says
 * _every_.
 *
 * The unit is **one occurrence of the word inside one run of user-visible
 * text**, and it is declared here, once, because the review that produced this
 * item failed on exactly that: a count built over _distinct literal values_
 * was written up as an inventory of _occurrences_, and the two numbers
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
 *
 * The boundary, **stated rather than implied: this checks literal copy in
 * `apps/fe-01/src`.** Text that arrives at render as a value — a toast's
 * `{toast.text}`, a thrown `{message}`, a refusal string from be-01 — is not a
 * run and cannot be, because the source does not contain it. Those are be-01's
 * and the fixtures' to qualify, and the scenario 8.9 answers is about the copy
 * this app writes.
 */

/**
 * `apps/fe-01`, which is where the suite runs.
 *
 * The cwd comes from the `cwd` of the `test` and `test:unit` targets in
 * `apps/fe-01/project.json`, **not** from either config — neither
 * `vitest.config.ts` nor `vitest.node.config.ts` sets `root`, and
 * `test-tiers.test.ts`'s comment overstates that. Invoked through the targets
 * this is `apps/fe-01`; invoked by hand from elsewhere the walk below finds
 * the wrong tree, which the last three cases in this file turn into a failure
 * rather than a silent green.
 */
const APP = process.cwd();

/**
 * One run of user-visible text, with the 1-based line it starts on.
 *
 * `shown` is what separates a run a reader sees from a run that names a value:
 * JSX text, a JSX attribute's string, and a `+` operand are shown, and nothing
 * about their shape can exempt them. See {@link couldBeCopy}.
 */
interface Run {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly shown: boolean;
}

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
      // Quoted property names and module specifiers are the string positions
      // that are never copy however they are spelled. Neither can reach a
      // reader, and both may contain whitespace or punctuation, so no shape
      // rule can distinguish them from prose.
      const isQuotedKey =
        ts.isPropertyAssignment(node.parent) ||
        ts.isPropertySignature(node.parent) ||
        ts.isEnumMember(node.parent)
          ? node.parent.name === node
          : false;
      const isModuleSpecifier =
        (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)) &&
        node.parent.moduleSpecifier === node;
      if (!isQuotedKey && !isModuleSpecifier) {
        const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
        runs.push({
          file,
          line: line + 1,
          text: node.text,
          shown:
            ts.isJsxText(node) ||
            ts.isJsxAttribute(node.parent) ||
            ts.isBinaryExpression(node.parent),
        });
      }
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
 * A bare lower-case token — `deadline`, `not-before`, `deadline_at`.
 *
 * This shape is what a column id, a cell key and an attribute name look like
 * in this app, and it is never what copy looks like: copy is sentence-cased or
 * has a space in it.
 */
const IDENTIFIER_TOKEN = /^[a-z][a-z0-9_-]*$/;

/**
 * Whether a run can be copy at all.
 *
 * The one exemption is {@link IDENTIFIER_TOKEN}, and **it does not apply to a
 * run a reader is shown**. An earlier draft exempted every run with no
 * whitespace instead, which let three real strings through:
 * `<button>Deadline</button>`, `aria-label="Deadline"` and
 * `'Move the ' + 'deadline'` — one-word copy is still copy, and a sentence
 * split across `+` puts a word in a run of its own. `shown` is what keeps
 * those three checked while `cellKey(id, 'deadline')` and `['deadline', 84]`
 * stay out.
 */
const couldBeCopy = (run: Run): boolean =>
  HAS_OCCURRENCE.test(run.text) && (run.shown || !IDENTIFIER_TOKEN.test(run.text.trim()));

/** The occurrences in one run that do not say which deadline they mean. */
function unqualifiedIn(run: Run): string[] {
  if (!couldBeCopy(run)) return [];
  const bare: string[] = [];
  for (const match of run.text.matchAll(OCCURRENCE)) {
    if (!QUALIFIER.test(run.text.slice(0, match.index))) {
      bare.push(`${run.file}:${String(run.line)} — ${run.text.trim()}`);
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

  it('reads one-word copy, which no shape rule may exempt', () => {
    // Sol r6b Critical 1, as three cases. An earlier draft skipped every run
    // with no whitespace in it, and each of these three went through it green
    // while showing a reader a bare "deadline".
    const asJsxText = 'const a = <button>Deadline</button>;\n';
    const asAttribute = 'const a = <input aria-label="Deadline" />;\n';
    const acrossAPlus = "const s = 'Move the ' + 'deadline';\n";
    expect(runsIn('src/x.tsx', asJsxText).flatMap(unqualifiedIn)).toHaveLength(1);
    expect(runsIn('src/x.tsx', asAttribute).flatMap(unqualifiedIn)).toHaveLength(1);
    expect(runsIn('src/x.ts', acrossAPlus).flatMap(unqualifiedIn)).toHaveLength(1);
  });

  it('ignores a quoted key even when it reads like a sentence', () => {
    // Sol r6b Important 1: `'release deadline'` has whitespace and fails the
    // qualifier, so only its position says it is a key. A false positive here
    // is worse than it looks — it is what teaches a later author to weaken the
    // guard rather than fix the copy.
    const source = "const m = { 'release deadline': 1, id: 'deadline' };\n";
    expect(runsIn('src/x.ts', source).flatMap(unqualifiedIn)).toEqual([]);
  });

  it('ignores a module specifier even when its path names a deadline module', () => {
    const source = [
      "import { offset } from '@wbs/domain/deadline-offsets';",
      "export { offset } from './project deadline adapter';",
      '',
    ].join('\n');
    expect(runsIn('src/x.ts', source).flatMap(unqualifiedIn)).toEqual([]);
  });

  it('ignores the column ids and cell keys this app is full of', () => {
    const source = [
      "const k = cellKey(row.original.id, 'deadline');",
      "const widths = [['deadline', 84], ['not-before', 84]];",
      "const column = { id: 'deadline', header: 'Due' };",
      '',
    ].join('\n');
    expect(runsIn('src/x.ts', source).flatMap(unqualifiedIn)).toEqual([]);
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

  it('reaches every occurrence this item qualified, by their text', () => {
    // Sol's r5 inventory, re-measured as text rather than as line numbers:
    // lines move, and a citation that moves is the fault the withdrawn count
    // had.
    //
    // **Seven runs of `Work item deadline for `, not the three r5 counted, and
    // the four that joined them are TASK-291's mobile card.** Named rather
    // than absorbed into a number, because the point of counting by text is
    // that a reader can check the list: the card's trigger, the date box
    // inside its sheet, the sheet's own title, and the `role="img"` mark that
    // carries the §2.3 sentence. All four name the row after the fixed text,
    // exactly as the table's three do, which is why they are one string.
    //
    // The impossible sentence is still **one** run and has simply moved: it
    // lives in `deadline-impossible.ts` now, because the table, the card and
    // the plan export all say it and a copy per face is a chance for three
    // faces to say different things. A second literal appearing here would be
    // that drift, and this assertion is what would catch it.
    const texts = deadlineCopy().map((run) => run.text);
    expect(texts.filter((text) => text === 'Work item deadline for ')).toHaveLength(7);
    expect(texts.filter((text) => text.includes('This work item deadline falls before'))).toEqual([
      "This work item deadline falls before the project's first working day, so nothing can finish by it. The date is kept; move the work item deadline or the project start.",
    ]);
    expect(texts.some((text) => text.includes('hold a work item deadline against'))).toBe(true);
  });
});
