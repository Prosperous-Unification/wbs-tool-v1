import { describe, expect, it } from 'bun:test';

import {
  CONTRACT_VERSION_PATH,
  CORPUS_FIXTURES,
  lintCorpusVersion,
  type RevisionPort,
} from './corpus-version-lint';

const BASE = '1111111111111111111111111111111111111111';
const HEAD = '2222222222222222222222222222222222222222';

const [FAST, QUANTUM] = CORPUS_FIXTURES;

function constantSource(version: string, trailer = ''): string {
  return [
    '/**',
    ' * The version of Fast’s own semantics.',
    ' */',
    `export const SCHEDULER_CONTRACT_VERSION = ${version};`,
    trailer,
  ].join('\n');
}

function corpus(version: number, cases: unknown): string {
  return `${JSON.stringify({ contractVersion: version, cases }, null, 2)}\n`;
}

/**
 * A tree is `path -> contents`; an absent key is a path that does not exist at
 * that revision, which is a different fact from an unreadable revision. A
 * revision missing from this map is what an unresolvable base looks like, and
 * the port throws for it exactly as `git show` exits non-zero.
 */
type Tree = Record<string, string>;

function portOf(trees: Record<string, Tree>): RevisionPort {
  const revisions = new Map(Object.entries(trees));
  return {
    readAt(rev, path) {
      const tree = revisions.get(rev);
      if (tree === undefined) throw new Error(`fatal: bad object ${rev}`);
      return path in tree ? tree[path] : null;
    },
  };
}

const EIGHT: Tree = {
  [CONTRACT_VERSION_PATH]: constantSource('8'),
  [FAST]: corpus(8, { 'chain-of-three': { units: 48 } }),
  [QUANTUM]: corpus(8, { drift: { units: 48, rounded: false } }),
};

function tree(overrides: Tree): Tree {
  return { ...EIGHT, ...overrides };
}

/**
 * The same tree with one path absent, which is what a fixture that has not been
 * added yet — or one deleted on the branch — looks like to the port.
 */
function without(base: Tree, path: string): Tree {
  return Object.fromEntries(Object.entries(base).filter(([key]) => key !== path));
}

function reasons(base: Tree, head: Tree): string[] {
  return lintCorpusVersion({ base: BASE, head: HEAD }, portOf({ [BASE]: base, [HEAD]: head })).map(
    (issue) => issue.reason,
  );
}

describe('the case the check exists for', () => {
  it('refuses moved cases under a static constant, naming the fixture and the version', () => {
    const found = reasons(EIGHT, tree({ [QUANTUM]: corpus(8, { drift: { units: 49 } }) }));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(QUANTUM);
    expect(found[0]).toContain('8');
  });

  it('refuses it for the Fast corpus too, so neither fixture is the only one covered', () => {
    const found = reasons(EIGHT, tree({ [FAST]: corpus(8, { 'chain-of-three': { units: 49 } }) }));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(FAST);
  });

  it('reports both fixtures when both moved, rather than stopping at the first', () => {
    const found = reasons(
      EIGHT,
      tree({
        [FAST]: corpus(8, { 'chain-of-three': { units: 49 } }),
        [QUANTUM]: corpus(8, { drift: { units: 49 } }),
      }),
    );
    expect(found).toHaveLength(2);
  });
});

describe('the negative controls, without which the refusal above proves nothing', () => {
  it('passes a regeneration that bumps the constant with it', () => {
    expect(
      reasons(
        EIGHT,
        tree({
          [CONTRACT_VERSION_PATH]: constantSource('9'),
          [QUANTUM]: corpus(9, { drift: { units: 49 } }),
        }),
      ),
    ).toEqual([]);
  });

  it('passes a branch that touches neither the fixtures nor the constant', () => {
    expect(reasons(EIGHT, EIGHT)).toEqual([]);
  });

  it('passes a bump that regenerates nothing, which is a different fixture assertion’s job', () => {
    expect(reasons(EIGHT, tree({ [CONTRACT_VERSION_PATH]: constantSource('9') }))).toEqual([]);
  });
});

describe('what counts as a change is exactly what the corpus tests compare', () => {
  it('ignores reordered object keys, because the corpus tests compare parsed values', () => {
    const reordered = `${JSON.stringify(
      { cases: { drift: { rounded: false, units: 48 } }, contractVersion: 8 },
      null,
      2,
    )}\n`;
    expect(reasons(EIGHT, tree({ [QUANTUM]: reordered }))).toEqual([]);
  });

  it('does not call negative zero equal to zero, which JSON.stringify would', () => {
    // `JSON.stringify(-0)` is `"0"` while `toEqual` tells the two apart, so a
    // canonicaliser resting on stringify alone would let a stored value move
    // from 0 to -0 under an unchanged version and report it unchanged. The
    // fixtures are read as TEXT here because a writer would never emit `-0`;
    // a hand edit is the way it gets into a file.
    const zero = '{ "contractVersion": 8, "cases": { "drift": { "units": 0 } } }';
    const negated = '{ "contractVersion": 8, "cases": { "drift": { "units": -0 } } }';
    const found = reasons(tree({ [QUANTUM]: zero }), tree({ [QUANTUM]: negated }));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(QUANTUM);
  });

  it('ignores whitespace, which the repository format check owns instead', () => {
    const reflowed = JSON.stringify(JSON.parse(EIGHT[QUANTUM]));
    expect(reasons(EIGHT, tree({ [QUANTUM]: reflowed }))).toEqual([]);
  });

  it('ignores the stored contractVersion field, which is not what it is asking about', () => {
    expect(
      reasons(
        EIGHT,
        tree({
          [CONTRACT_VERSION_PATH]: constantSource('9'),
          [FAST]: corpus(9, { 'chain-of-three': { units: 48 } }),
          [QUANTUM]: corpus(9, { drift: { units: 48, rounded: false } }),
        }),
      ),
    ).toEqual([]);
  });
});

describe('the constant is read as a number, not as bytes', () => {
  it('does not accept a prose edit as a bump', () => {
    const found = reasons(
      EIGHT,
      tree({
        [CONTRACT_VERSION_PATH]: constantSource('8', '// a sentence added to the file'),
        [QUANTUM]: corpus(8, { drift: { units: 49 } }),
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(QUANTUM);
  });

  it('refuses a decrease with the cases held still, which is the cache-key downgrade', () => {
    // The whole tree is EIGHT except the constant: both fixtures are
    // byte-identical, so every per-fixture rule below stays quiet and this
    // reason can only come from the versions themselves.
    const found = reasons(EIGHT, tree({ [CONTRACT_VERSION_PATH]: constantSource('7') }));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('from 8');
    expect(found[0]).toContain('to 7');
  });

  it('names the decrease and the moved cases apart, because either alone refuses', () => {
    // This case used to be titled as the proof that a downgrade is refused,
    // and it was not: the fixture moved in the same tree, so the fixture's own
    // "did not increase" reason was the only one it could have been reading.
    // The decrease is proved by the case above, with the cases held still;
    // here both faults are present and each is named on its own line.
    const found = reasons(
      EIGHT,
      tree({
        [CONTRACT_VERSION_PATH]: constantSource('7'),
        [QUANTUM]: corpus(7, { drift: { units: 49 } }),
      }),
    );
    expect(found).toHaveLength(2);
    expect(found[0]).toContain('from 8');
    expect(found[0]).toContain('to 7');
    expect(found[1]).toContain(QUANTUM);
  });

  it('fails closed when the declaration is absent at a revision', () => {
    const found = reasons(EIGHT, tree({ [CONTRACT_VERSION_PATH]: '// nothing declared here\n' }));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(CONTRACT_VERSION_PATH);
    expect(found[0]).toContain(HEAD);
  });

  it('fails closed when the file itself is gone at a revision', () => {
    const found = reasons(EIGHT, without(EIGHT, CONTRACT_VERSION_PATH));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(CONTRACT_VERSION_PATH);
  });

  it('fails closed on two declarations rather than picking one', () => {
    const found = reasons(
      EIGHT,
      tree({
        [CONTRACT_VERSION_PATH]: `${constantSource('8')}\nexport const SCHEDULER_CONTRACT_VERSION = 9;\n`,
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('twice');
  });

  it('reads no version out of a commented-out declaration, which is the review bypass', () => {
    // Legal TypeScript, and it defeated the first pattern: a block comment
    // between the name and the `=` hides the real declaration, and a
    // commented-out one names a higher number. Without the strip the check
    // reads 9 here and lets moved cases through as an increase.
    const bypass = [
      '// export const SCHEDULER_CONTRACT_VERSION = 9;',
      'export const SCHEDULER_CONTRACT_VERSION /* still eight */ = 8;',
    ].join('\n');
    const found = reasons(
      EIGHT,
      tree({
        [CONTRACT_VERSION_PATH]: bypass,
        [QUANTUM]: corpus(8, { drift: { units: 49 } }),
      }),
    );
    expect(found).toHaveLength(1);
    // Read as 8 — the real declaration, whose block comment is blanked to
    // spaces — and NOT as the 9 sitting in the commented-out line.
    expect(found[0]).toContain('went from 8 to 8');
    expect(found[0]).not.toContain('to 9');
  });

  it('ignores a declaration quoted inside a comment while a real one is present', () => {
    expect(
      reasons(
        EIGHT,
        tree({
          [CONTRACT_VERSION_PATH]: `// once: export const SCHEDULER_CONTRACT_VERSION = 7;\n${constantSource('9')}`,
          [QUANTUM]: corpus(9, { drift: { units: 49 } }),
        }),
      ),
    ).toEqual([]);
  });

  it('reads no version out of a string or a template literal, which is the round-3 bypass', () => {
    // The one that broke the comment stripper, and it was measured before it
    // was believed: `'/*'` and `'*' + '/'` are STRINGS, but a stripper that
    // does not know what a string is treats them as a block comment and blanks
    // the real declaration between them. The line inside the template literal
    // is data — never a statement — but it is the only thing left that a
    // line-anchored pattern can match, so the reader returned 9 while the
    // module still exported 8. A parse cannot be fooled this way: a template's
    // contents are not statements and a string's contents are not tokens.
    const bypass = [
      'const TEMPLATE = `',
      'export const SCHEDULER_CONTRACT_VERSION = 9;',
      '`;',
      "const OPEN = '/*';",
      'export const SCHEDULER_CONTRACT_VERSION = 8;',
      "const CLOSE = '*' + '/';",
    ].join('\n');
    const found = reasons(
      EIGHT,
      tree({
        [CONTRACT_VERSION_PATH]: bypass,
        [QUANTUM]: corpus(8, { drift: { units: 49 } }),
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('went from 8 to 8');
    expect(found[0]).not.toContain('to 9');
  });

  it('fails closed on a value that is not an integer literal', () => {
    const found = reasons(EIGHT, tree({ [CONTRACT_VERSION_PATH]: constantSource('LATEST') }));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('LATEST');
  });

  it('refuses an integer past the safe range, which no later version could exceed', () => {
    // `9007199254740993` is a legal integer literal that the parser normalises
    // to `9007199254740992` — still all digits, so the integer test passes it —
    // and `Number.isSafeInteger` is false for it. Accepting it would store a
    // version no bump can compare greater than. Measured, not assumed: a much
    // longer digit string normalises to `Infinity` instead and is refused one
    // branch earlier, as `not an integer literal`.
    const found = reasons(
      EIGHT,
      tree({
        [CONTRACT_VERSION_PATH]: constantSource('9007199254740993'),
        [QUANTUM]: corpus(8, { drift: { units: 49 } }),
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('safe integer');
  });

  it('refuses a digit string long enough to normalise to Infinity', () => {
    const found = reasons(
      EIGHT,
      tree({
        [CONTRACT_VERSION_PATH]: constantSource('9'.repeat(400)),
        [QUANTUM]: corpus(8, { drift: { units: 49 } }),
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('Infinity');
    expect(found[0]).toContain('not an integer literal');
  });

  it('accepts a legal numeric separator, which the text reader refused', () => {
    // `1_000` is one integer literal spelled legally. The old `^\d+$` test on
    // raw text called it a non-integer; the parser hands back `1000`.
    expect(
      reasons(
        EIGHT,
        tree({
          [CONTRACT_VERSION_PATH]: constantSource('1_000'),
          [QUANTUM]: corpus(1000, { drift: { units: 49 } }),
        }),
      ),
    ).toEqual([]);
  });
});

describe('a fixture appearing or disappearing is answered, not tripped over', () => {
  it('treats a fixture added on the branch as a change needing a bump', () => {
    const found = reasons(without(EIGHT, QUANTUM), EIGHT);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(QUANTUM);
  });

  it('accepts that same addition once the constant moves with it', () => {
    expect(
      reasons(
        without(EIGHT, QUANTUM),
        tree({
          [CONTRACT_VERSION_PATH]: constantSource('9'),
          [QUANTUM]: corpus(9, { drift: { units: 48, rounded: false } }),
        }),
      ),
    ).toEqual([]);
  });

  it('refuses a fixture deleted at head outright, bump or no bump', () => {
    const after = without(tree({ [CONTRACT_VERSION_PATH]: constantSource('9') }), FAST);
    const found = reasons(EIGHT, after);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(FAST);
  });
});

describe('unreadable inputs fail closed, because a check that skips itself is the fault it prevents', () => {
  it('refuses an unresolvable base revision', () => {
    const found = lintCorpusVersion(
      { base: 'origin/nowhere', head: HEAD },
      portOf({ [HEAD]: EIGHT }),
    );
    expect(found).toHaveLength(1);
    expect(found[0].reason).toContain('origin/nowhere');
  });

  it('refuses the all-zero base a branch creation reports', () => {
    const zero = '0000000000000000000000000000000000000000';
    const found = lintCorpusVersion(
      { base: zero, head: HEAD },
      portOf({ [zero]: EIGHT, [HEAD]: EIGHT }),
    );
    expect(found).toHaveLength(1);
    expect(found[0].reason).toContain('no commit');
  });

  it('refuses an empty base rather than reading it as "compare with nothing"', () => {
    const found = lintCorpusVersion({ base: '', head: HEAD }, portOf({ [HEAD]: EIGHT }));
    expect(found).toHaveLength(1);
  });

  it('refuses malformed JSON in a fixture', () => {
    const found = reasons(EIGHT, tree({ [FAST]: '{ "contractVersion": 8, "cases": ' }));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(FAST);
    // The issue this check hands back is a string, so the parser's own words
    // have to survive *in the message*; attaching them as the thrown error's
    // `cause` instead would read as preserved and print as nothing. Matching
    // the wrapper alone would say that and still pass with the interpolation
    // deleted, so the parentheses are required to hold something: this fails
    // on `(…)` empty, which is exactly the regression worth catching. The
    // parser's exact wording is the engine's to choose and is not pinned.
    expect(found[0]).toMatch(
      /is not valid JSON \(\S[^)]*\), so its cases could not be compared\.$/,
    );
  });

  it('refuses a fixture whose cases key is missing', () => {
    const found = reasons(EIGHT, tree({ [FAST]: '{ "contractVersion": 8 }\n' }));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('cases');
  });

  it('refuses a fixture whose cases is not an object', () => {
    const found = reasons(EIGHT, tree({ [FAST]: '{ "contractVersion": 8, "cases": [] }\n' }));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('cases');
  });
});

describe('the fixture list is the one the corpora actually ship', () => {
  it('names both checked-in golden corpora and nothing else', () => {
    expect([...CORPUS_FIXTURES]).toEqual([
      'libs/domain/fixtures/fast-golden-corpus.json',
      'libs/domain/fixtures/solver-quantum-golden-corpus.json',
    ]);
  });
});
