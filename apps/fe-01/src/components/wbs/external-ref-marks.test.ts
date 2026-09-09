import { describe, expect, it } from 'vitest';

import type { ExternalRefView, ExternalSystemView } from '@/lib/wbs-api';

import {
  FAMILY_PAINT,
  familyOf,
  MARK_BOX_PX,
  MARK_PX,
  markStyle,
  MOST_MARKS,
  refMarksOf,
  refMarksSentence,
} from './external-ref-marks';

/** The vocabulary be-01 seeds, which is exactly what `systemOfUrl` can answer. */
const SEEDED: ExternalSystemView[] = [
  { id: 'sys-jira', name: 'jira-issue' },
  { id: 'sys-gh-pr', name: 'github-pr' },
  { id: 'sys-gh-issue', name: 'github-issue' },
  { id: 'sys-confluence', name: 'confluence-page' },
  { id: 'sys-slack', name: 'slack-message' },
];

const refsTo = (...systemIds: string[]): ExternalRefView[] =>
  systemIds.map((systemId, at) => ({
    id: `ref${String(at)}`,
    systemId,
    url: `https://example.com/${String(at)}`,
    // The marks are drawn from the system alone; a name changes none of them,
    // which is why every fixture here is unnamed.
    name: '',
  }));

describe('which marks a row’s links draw', () => {
  it('draws one mark per system family, never one per link', () => {
    // Design D2. Four GitHub pull requests are one mark, because the column
    // answers *what is this wired to* and not *how many links*.
    //
    // Proof: the family count replaced by `refs.map(...)` — one entry per ref —
    // and this failed on `expected [ …(4) ] to deeply equal [ { kind:
    // 'github', count: 4, …(1) } ]`, with three cases below it and
    // `four refs to one system are one mark` in `wbs-table.test.tsx`. Watched,
    // 2026-08-31.
    expect(refMarksOf(refsTo('sys-gh-pr', 'sys-gh-pr', 'sys-gh-pr', 'sys-gh-pr'), SEEDED)).toEqual([
      { kind: 'github', count: 4, label: '4 GitHub links' },
    ]);
  });

  it('folds two systems of one family into one mark, and names the family', () => {
    // `github-pr` and `github-issue` are two vocabulary entries and one family.
    // They share a mark deliberately: design D3 gives an appearance per family
    // and none per entry, so two entries would be two identical dots — a count
    // of links wearing a costume. Which particular GitHub thing is the card's
    // answer.
    expect(refMarksOf(refsTo('sys-gh-pr', 'sys-gh-issue'), SEEDED)).toEqual([
      { kind: 'github', count: 2, label: '2 GitHub links' },
    ]);
  });

  it('keeps the order each family was first mentioned in', () => {
    // Not alphabetical and not by count: a row's marks must not reshuffle when
    // a fifth link is added, because a 40px cell is recognised by its shape.
    expect(
      refMarksOf(refsTo('sys-slack', 'sys-jira', 'sys-slack'), SEEDED).map((mark) => mark.kind),
    ).toEqual(['slack', 'jira']);
  });

  it('collapses everything past the fourth family into one overflow mark', () => {
    const marks = refMarksOf(
      refsTo('sys-jira', 'sys-confluence', 'sys-gh-pr', 'sys-slack', 'sys-nobody-has-heard-of'),
      SEEDED,
    );
    expect(marks).toHaveLength(MOST_MARKS);
    expect(marks.at(-1)).toEqual({
      kind: 'overflow',
      count: 2,
      label: '2 more systems, 2 links',
    });
  });

  it('is empty for a row with no links, which is a blank cell and not a dash', () => {
    expect(refMarksOf([], SEEDED)).toEqual([]);
    expect(refMarksSentence(refMarksOf([], SEEDED))).toBe('');
  });

  it('draws a system this directory has not listed as the neutral ring', () => {
    // A swap-window state with a correct rendering rather than a fault: a peer
    // may add a ref through a be-01 whose vocabulary this page read before it
    // grew. Dropping the ref would under-report what the row is wired to.
    expect(refMarksOf(refsTo('sys-from-the-future'), SEEDED)).toEqual([
      { kind: 'other', count: 1, label: '1 other link' },
    ]);
    expect(familyOf('')).toBe('other');
  });

  it('says the whole cell in one sentence, for a reader with no pointer', () => {
    expect(
      refMarksSentence(refMarksOf(refsTo('sys-gh-pr', 'sys-gh-issue', 'sys-jira'), SEEDED)),
    ).toBe('2 GitHub links, 1 Jira link');
  });
});

describe('how one mark is drawn', () => {
  it('places every mark out of flow inside a box of a fixed height', () => {
    // Design D2's height claim, as far as jsdom can state it: the rule is
    // `position: absolute` on every mark, and the box that holds them is
    // {@link MARK_BOX_PX} tall whatever it holds. Whether that really keeps two
    // rows the same height is a browser's answer — `e2e/external-refs.spec.ts`.
    for (const at of [0, 1, 2, 3]) {
      expect(markStyle('github', at).position).toBe('absolute');
      expect(markStyle('github', at).left).toBe(at * (MARK_PX + 2));
    }
    // Four marks and their gaps inside the 32px of mark room a 40px column
    // declares — the fourth mark's right edge is what the column has to hold.
    const last = markStyle('github', MOST_MARKS - 1);
    expect(Number(last.left) + MARK_PX).toBeLessThanOrEqual(32);
    expect(MARK_BOX_PX).toBeGreaterThan(MARK_PX);
  });

  it('tells the two Atlassian marks apart by fill rather than by hue', () => {
    // The pair the common colour deficiencies collapse first is one blue
    // against a darker blue, so these two are the **same** blue and differ in
    // fill instead.
    expect(FAMILY_PAINT.jira.paint).toBe(FAMILY_PAINT.confluence.paint);
    expect(FAMILY_PAINT.jira.filled).toBe(true);
    expect(FAMILY_PAINT.confluence.filled).toBe(false);
    expect(markStyle('jira', 0).background).toBe(FAMILY_PAINT.jira.paint);
    expect(markStyle('confluence', 0).background).toBe('transparent');
    expect(markStyle('confluence', 0).border).toContain(FAMILY_PAINT.confluence.paint);
  });

  it('keeps the ring the same size as the disc beside it', () => {
    // The reset in `styles.css` stops at `[data-grid]`, so a mark in the table
    // keeps the browser's `content-box` and a 1px border would make the ring
    // 8px across beside a 6px disc — two channels saying two different sizes.
    expect(markStyle('confluence', 0).boxSizing).toBe('border-box');
    expect(markStyle('jira', 0).width).toBe(markStyle('confluence', 0).width);
  });

  it('paints both neutrals with a token, because a literal reads on one ground only', () => {
    // Design D3: `currentColor` follows the grid's own ink, which follows
    // `--foreground` — near-black on a light page, near-white on a dark one.
    // A hex here would be the GitHub mark disappearing into a dark page, which
    // is the fault the browser half of this watches.
    expect(FAMILY_PAINT.github.paint).toBe('currentColor');
    expect(FAMILY_PAINT.other.paint).toBe('var(--muted-foreground)');
  });
});
