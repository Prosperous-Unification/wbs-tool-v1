import { describe, expect, it } from 'bun:test';

import { deriveNumbers, type WorkItemPlacement } from './derive-numbers';

/** `id` doubles as the readable name in these tests; parents are named before their children. */
function place(id: string, parentId: string | null, position: number): WorkItemPlacement {
  return { id, parentId, position, frozenNumber: null };
}

/** Positions in the order given, spaced as the repository spaces them. */
function siblings(parentId: string | null, ...ids: string[]): WorkItemPlacement[] {
  return ids.map((id, i) => place(id, parentId, (i + 1) * 10));
}

describe('deriveNumbers', () => {
  it('numbers roots in tens', () => {
    const numbers = deriveNumbers(siblings(null, 'a', 'b', 'c'));

    expect(numbers.get('a')).toBe('010');
    expect(numbers.get('b')).toBe('020');
    expect(numbers.get('c')).toBe('030');
  });

  it('nests children under their parent', () => {
    const numbers = deriveNumbers([
      ...siblings(null, 'a'),
      ...siblings('a', 'a1', 'a2'),
      ...siblings('a2', 'a2x'),
    ]);

    expect(numbers.get('a1')).toBe('010.1');
    expect(numbers.get('a2')).toBe('010.2');
    expect(numbers.get('a2x')).toBe('010.2.1');
  });

  it('keeps nine children at one digit', () => {
    const kids = Array.from({ length: 9 }, (_, i) => `k${String(i)}`);
    const numbers = deriveNumbers([...siblings(null, 'a'), ...siblings('a', ...kids)]);

    expect(numbers.get('k0')).toBe('010.1');
    expect(numbers.get('k8')).toBe('010.9');
  });

  it('widens the whole group when a parent gains a tenth child', () => {
    const kids = Array.from({ length: 10 }, (_, i) => `k${String(i)}`);
    const numbers = deriveNumbers([...siblings(null, 'a'), ...siblings('a', ...kids)]);

    expect(numbers.get('k0')).toBe('010.01');
    expect(numbers.get('k9')).toBe('010.10');
  });

  it('widens one parent without touching a sibling parent', () => {
    const wide = Array.from({ length: 10 }, (_, i) => `w${String(i)}`);
    const numbers = deriveNumbers([
      ...siblings(null, 'a', 'b'),
      ...siblings('a', ...wide),
      ...siblings('b', 'n1', 'n2', 'n3'),
    ]);

    expect(numbers.get('w0')).toBe('010.01');
    expect(numbers.get('n1')).toBe('020.1');
    expect(numbers.get('n3')).toBe('020.3');
  });

  it('widens roots at the hundredth, where three characters stop sorting', () => {
    const many = Array.from({ length: 100 }, (_, i) => `r${String(i)}`);
    const numbers = deriveNumbers(siblings(null, ...many));

    expect(numbers.get('r0')).toBe('0010');
    expect(numbers.get('r98')).toBe('0990');
    expect(numbers.get('r99')).toBe('1000');
  });

  it('produces numbers that sort into tree order', () => {
    // Proof: this is the property the padding rules exist for. Unpadded, the
    // tenth child sorts second — ['010.1','010.10','010.2'] sorted byte-wise
    // yields 010.1, 010.10, 010.2 — which is why a tenth child widens the group.
    //
    // It holds for a project with no frozen number and is **not** promised
    // where one has moved (ADR 0023); `treeOrder` is what readers sort by.
    const kids = Array.from({ length: 10 }, (_, i) => `k${String(i)}`);
    const numbers = deriveNumbers([
      ...siblings(null, 'a', 'b'),
      ...siblings('a', ...kids),
      ...siblings('b', 'b1'),
    ]);

    const ordered = ['a', ...kids, 'b', 'b1'];
    const treeOrdered = ordered.map((id) => numbers.get(id) ?? '');
    // Asserted before the sort: an implementation returning nothing would make
    // the comparison below hold vacuously, which is how this test passed
    // against a stub that returned an empty map.
    expect(treeOrdered).toHaveLength(ordered.length);
    for (const number of treeOrdered) expect(number).not.toBe('');

    expect([...treeOrdered].sort()).toEqual(treeOrdered);
  });

  it('refuses a work item whose parent is not in the project', () => {
    // An unreachable work item would otherwise be handed back with no number at
    // all, and the caller would render a row with an empty first column rather
    // than learn its tree is broken.
    expect(() => deriveNumbers([...siblings(null, 'a'), place('orphan', 'gone', 10)])).toThrow(
      /orphan/,
    );
  });
});

describe('deriveNumbers around frozen labels', () => {
  const frozen = (
    id: string,
    position: number,
    frozenNumber: string,
    parentId: string | null = null,
  ): WorkItemPlacement => ({ id, parentId, position, frozenNumber });

  it('reports a frozen number verbatim', () => {
    const numbers = deriveNumbers([frozen('a', 10, '010'), frozen('b', 20, '020')]);

    expect(numbers.get('a')).toBe('010');
    expect(numbers.get('b')).toBe('020');
  });

  it('gives an unfrozen sibling the next natural label its frozen siblings leave free', () => {
    // Until ADR 0023 this answered `011` — a label fitted *between* the two
    // anchors so that a byte-wise sort still equalled tree order. Frozen work
    // items may move now, so that sort is no longer the order anything reads
    // by, and the fitting is gone with it.
    const numbers = deriveNumbers([
      frozen('a', 10, '010'),
      place('new', null, 15),
      frozen('b', 20, '020'),
    ]);

    expect(numbers.get('new')).toBe('030');
  });

  it('skips only the naturals its frozen siblings actually hold', () => {
    // `011` is not one of the three naturals for a group of three, so it
    // consumes none of them and the unfrozen work item takes `020`. Until ADR
    // 0023 this answered `0105`, appended because nothing digit-shaped sorts
    // between `010` and `011`.
    const numbers = deriveNumbers([
      frozen('a', 10, '010'),
      place('new', null, 15),
      frozen('b', 20, '011'),
    ]);

    expect(numbers.get('new')).toBe('020');
  });

  it('gives the first work item a later label when a frozen sibling below it holds the first', () => {
    // Until ADR 0023 this answered something below `010`. A number no longer
    // promises where its row sits, so the work item reading first here is
    // numbered `020` — and that is the cost the ADR names, made visible.
    const numbers = deriveNumbers([place('new', null, 5), frozen('a', 10, '010')]);

    expect(numbers.get('new')).toBe('020');
  });

  it('keeps two frozen labels that have gone out of order', () => {
    const numbers = deriveNumbers([frozen('later', 10, '020'), frozen('earlier', 20, '010')]);

    expect(numbers.get('later')).toBe('020');
    expect(numbers.get('earlier')).toBe('010');
  });

  it('numbers a partially frozen group without repeating a label', () => {
    const numbers = deriveNumbers([
      frozen('a', 10, '010'),
      place('mid', null, 15),
      frozen('b', 20, '020'),
      place('last', null, 30),
    ]);

    expect(numbers.get('a')).toBe('010');
    expect(numbers.get('mid')).toBe('030');
    expect(numbers.get('b')).toBe('020');
    expect(numbers.get('last')).toBe('040');
  });

  it('leaves a frozen child at the width it was frozen at', () => {
    const numbers = deriveNumbers([
      place('root', null, 10),
      { id: 'kid', parentId: 'root', position: 10, frozenNumber: '010.1' },
    ]);

    expect(numbers.get('kid')).toBe('010.1');
  });

  it('reads a frozen child by its last segment, so a wide sibling still fits', () => {
    // The group of ten has naturals `01`…`10`; the frozen child's last segment
    // is `1`, which is none of them, so all ten stay free and nine are claimed.
    const kids = Array.from({ length: 9 }, (_, i) => place(`k${String(i)}`, 'root', (i + 2) * 10));
    const numbers = deriveNumbers([
      place('root', null, 10),
      { id: 'old', parentId: 'root', position: 10, frozenNumber: '010.1' },
      ...kids,
    ]);

    expect(numbers.get('old')).toBe('010.1');
    expect(numbers.get('k0')).toBe('010.01');
    expect(numbers.get('k8')).toBe('010.09');
  });

  it('never gives two siblings the same label, over seeded frozen arrangements', () => {
    // The invariant ADR 0023 keeps when it drops the ordinal one, and the only
    // thing that makes a number safe to put on a ticket. Seeded rather than
    // hand-written because the fault is a *collision*, which needs a frozen
    // label that happens to be one of the group's own naturals — and which
    // natural that is depends on the group's size.
    //
    // Proof: the `.filter((label) => !held.has(label))` dropped from
    // `deriveNumbers`, so unfrozen work items claim naturals a frozen sibling
    // already holds — watched failing on `run 1: 010, 050, 020, 030, 040, 050,
    // 060 · Expected: 7 · Received: 6`, two work items both reading `050`. The
    // four named cases above went red with it, on `Expected: "030" · Received:
    // "010"` and its like; restored 2026-09-11.
    let seed = 1;
    const next = (bound: number): number => {
      // A small deterministic generator, so a failure names a seed somebody
      // can re-run rather than a shape nobody can reproduce.
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };

    for (let run = 1; run <= 400; run++) {
      const size = 1 + next(12);
      const labels = Array.from({ length: size }, (_, i) => String((i + 1) * 10).padStart(3, '0'));
      const group = Array.from({ length: size }, (_, i) => {
        const id = `w${String(i)}`;
        // Roughly a third frozen, and the labels they hold are drawn from the
        // group's own naturals — the case where a collision is possible at all.
        if (next(3) === 0) {
          return frozen(id, (i + 1) * 10, labels[next(size)] ?? '010');
        }
        return place(id, null, (i + 1) * 10);
      });
      // Two frozen work items could be dealt the same label by the generator,
      // which is a project the writer cannot produce; skip those draws rather
      // than assert about them.
      const dealt = group.flatMap((each) =>
        each.frozenNumber === null ? [] : [each.frozenNumber],
      );
      if (new Set(dealt).size !== dealt.length) continue;

      const numbers = deriveNumbers(group);
      const produced = group.map((each) => numbers.get(each.id) ?? '');
      expect(new Set(produced).size, `run ${String(run)}: ${produced.join(', ')}`).toBe(
        group.length,
      );
    }
  });
});
