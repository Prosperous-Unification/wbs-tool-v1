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

function tree(overrides: Partial<Tree>): Tree {
  return { ...EIGHT, ...overrides };
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

  it('refuses a decrease, so a downgrade cannot satisfy the check', () => {
    const found = reasons(
      EIGHT,
      tree({
        [CONTRACT_VERSION_PATH]: constantSource('7'),
        [QUANTUM]: corpus(7, { drift: { units: 49 } }),
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('7');
    expect(found[0]).toContain('8');
  });

  it('fails closed when the declaration is absent at a revision', () => {
    const found = reasons(EIGHT, tree({ [CONTRACT_VERSION_PATH]: '// nothing declared here\n' }));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(CONTRACT_VERSION_PATH);
    expect(found[0]).toContain(HEAD);
  });

  it('fails closed when the file itself is gone at a revision', () => {
    const gone = tree({});
    delete gone[CONTRACT_VERSION_PATH];
    const found = reasons(EIGHT, gone);
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

  it('fails closed on a value that is not an integer literal', () => {
    const found = reasons(EIGHT, tree({ [CONTRACT_VERSION_PATH]: constantSource('LATEST') }));
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('LATEST');
  });
});

describe('a fixture appearing or disappearing is answered, not tripped over', () => {
  it('treats a fixture added on the branch as a change needing a bump', () => {
    const before = tree({});
    delete before[QUANTUM];
    const found = reasons(before, EIGHT);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(QUANTUM);
  });

  it('accepts that same addition once the constant moves with it', () => {
    const before = tree({});
    delete before[QUANTUM];
    expect(
      reasons(
        before,
        tree({
          [CONTRACT_VERSION_PATH]: constantSource('9'),
          [QUANTUM]: corpus(9, { drift: { units: 48, rounded: false } }),
        }),
      ),
    ).toEqual([]);
  });

  it('refuses a fixture deleted at head outright, bump or no bump', () => {
    const after = tree({ [CONTRACT_VERSION_PATH]: constantSource('9') });
    delete after[FAST];
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
