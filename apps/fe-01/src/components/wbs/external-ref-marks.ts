import type { CSSProperties } from 'react';

import type { ExternalRefView, ExternalSystemView } from '@/lib/wbs-api';

/**
 * The families the ref column can draw apart, and the granularity "one mark per
 * distinct system" is read at.
 *
 * **A family is not a vocabulary entry.** `github-pr` and `github-issue` are two
 * systems and one family, and they share a mark deliberately: design D3 gives an
 * appearance per family and none per entry, so two entries of one family would
 * be two identical marks — a count of links wearing a costume, which is the one
 * thing D2 says this column is not for ("the column answers *what is this wired
 * to*, not *how many links*"). Which particular GitHub thing a row links to is
 * the hover card's answer, and the card names every ref.
 *
 * `other` is every system no family claims, including one a later migration
 * seeds: an unknown name draws as the neutral ring rather than as nothing, so a
 * vocabulary that grows past this file is still readable on the day it does.
 */
export type SystemFamily = 'jira' | 'confluence' | 'github' | 'slack' | 'other';

/**
 * Which family a vocabulary name belongs to, by its prefix.
 *
 * The prefix and not the whole name, because the vocabulary grows by adding
 * members to a family far more often than by adding a family: `github-release`
 * would be GitHub the day it is seeded, with no edit here. The seeded five are
 * `jira-issue`, `github-pr`, `github-issue`, `confluence-page`, `slack-message`.
 */
export function familyOf(systemName: string): SystemFamily {
  if (systemName.startsWith('jira')) return 'jira';
  if (systemName.startsWith('confluence')) return 'confluence';
  if (systemName.startsWith('github')) return 'github';
  if (systemName.startsWith('slack')) return 'slack';
  return 'other';
}

/** What a family is called where a person reads it — the accessible name's noun. */
const FAMILY_WORDS: Record<SystemFamily, string> = {
  jira: 'Jira',
  confluence: 'Confluence',
  github: 'GitHub',
  slack: 'Slack',
  other: 'other',
};

/**
 * How one family is drawn: a colour, and whether the disc is filled or a ring.
 *
 * **Two channels, because one would be unreadable** (design D3). Jira and
 * Confluence are the pair the common colour deficiencies collapse first — one
 * blue against a darker blue — so they are the *same* blue here and are told
 * apart by fill instead, which is a distinction that survives being printed in
 * grey. The accessible name is the third channel and the one that works with no
 * sight of the column at all.
 *
 * `oklch` with the lightness stated rather than a hex, which is
 * `priority-band-style.ts`'s convention and for its reason: a mid-lightness hue
 * reads on both the light and the dark ground without a `.dark` twin to keep in
 * step. The two values that cannot be one number are the two neutrals, and both
 * are tokens rather than colours — `currentColor` follows the grid's own ink
 * (which follows `--foreground`, so it is near-black on a light page and
 * near-white on a dark one, which is exactly D3's "near-white, not
 * near-black"), and `--muted-foreground` flips the same way one step quieter.
 */
export const FAMILY_PAINT: Record<SystemFamily, { paint: string; filled: boolean }> = {
  jira: { paint: 'oklch(0.55 0.19 255)', filled: true },
  confluence: { paint: 'oklch(0.55 0.19 255)', filled: false },
  github: { paint: 'currentColor', filled: true },
  slack: { paint: 'oklch(0.58 0.15 155)', filled: true },
  other: { paint: 'var(--muted-foreground)', filled: false },
};

/**
 * How many marks the cell draws before the surplus collapses into one.
 *
 * Four, which is what 32px of mark room holds at 6px a mark with 2px between
 * them. A fifth *family* — not a fifth ref — takes the overflow mark instead,
 * because the column's width is the one thing that may not depend on its
 * contents (design D2).
 */
export const MOST_MARKS = 4;

/** One mark on a row's ref cell: what it stands for, and how it is drawn. */
export interface RefMark {
  /**
   * The family, or `overflow` for the mark standing in for the families past
   * {@link MOST_MARKS}. A union rather than a nullable family, because the
   * overflow mark is drawn differently and named differently and nothing about
   * it is a family with a missing value.
   */
  kind: SystemFamily | 'overflow';
  /** How many refs this mark covers — every ref of its family, or of the families it swallowed. */
  count: number;
  /** The mark's accessible name: `2 GitHub links`, `1 Jira link`, `2 more systems`. */
  label: string;
}

/** `1 Jira link` / `2 Jira links` — the count is the point, so it leads. */
const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? '' : 's'}`;

/**
 * The marks one row's cell draws, in the order its refs first named each family.
 *
 * **One mark per family, never one per ref**, which is the whole of D2: a row
 * with four GitHub pull requests is wired to GitHub once, and a column that grew
 * a mark per link would be a column whose width depends on its contents.
 *
 * The order is first-mention rather than alphabetical or by count, so a row's
 * marks do not reshuffle when a fifth ref is added — the cell is 40px and a
 * reader recognises it by shape.
 *
 * A ref naming a system this directory does not hold is drawn as `other` rather
 * than dropped. That is not a softened invariant: the vocabulary is read once
 * per page load and a peer may add a ref through a be-01 that has already been
 * given a system this page has never listed, so "a system I have not heard of"
 * is a swap-window state with a correct rendering — the neutral ring — and
 * dropping the ref would under-report what the row is wired to.
 *
 * @param refs the row's refs, in the order they were added.
 * @param systems the directory's vocabulary, for turning a `systemId` into a name.
 * @returns at most {@link MOST_MARKS} marks; `[]` for a row with no refs, which
 * is an **empty cell** and never a placeholder character.
 */
export function refMarksOf(
  refs: readonly ExternalRefView[],
  systems: readonly ExternalSystemView[],
): RefMark[] {
  const nameOf = new Map(systems.map((system) => [system.id, system.name]));
  /** Families in first-mention order, with how many refs each has taken. */
  const counted = new Map<SystemFamily, number>();
  for (const ref of refs) {
    const family = familyOf(nameOf.get(ref.systemId) ?? '');
    counted.set(family, (counted.get(family) ?? 0) + 1);
  }
  const families = [...counted];
  const shown = families.slice(0, MOST_MARKS);
  const hidden = families.slice(MOST_MARKS);
  const marks: RefMark[] = shown.map(([family, count]) => ({
    kind: family,
    count,
    label: plural(count, `${FAMILY_WORDS[family]} link`),
  }));
  if (hidden.length === 0) return marks;
  // The overflow takes the last drawn mark's place rather than sitting after it:
  // {@link MOST_MARKS} is what fits, so a `+` beside four marks would be a fifth
  // mark and the column would be over its room by one.
  const swallowed = [...shown.slice(MOST_MARKS - 1), ...hidden];
  marks[MOST_MARKS - 1] = {
    kind: 'overflow',
    count: swallowed.reduce((total, [, count]) => total + count, 0),
    label: `${plural(swallowed.length, 'more system')}, ${plural(
      swallowed.reduce((total, [, count]) => total + count, 0),
      'link',
    )}`,
  };
  return marks;
}

/**
 * The whole cell in one sentence, for the `aria-describedby` a reader with no
 * pointer gets instead of the card — `2 GitHub links, 1 Jira link`.
 *
 * Built from the same {@link refMarksOf} the marks are drawn from, deliberately:
 * a description assembled separately is a second reading of the row, and the one
 * that goes stale. Empty for a row with no refs, so nothing is announced at all.
 */
export function refMarksSentence(marks: readonly RefMark[]): string {
  return marks.map((mark) => mark.label).join(', ');
}

/** How wide and tall one mark is, in px. */
export const MARK_PX = 6;

/** How much clear space stands between two marks, in px. */
export const MARK_GAP_PX = 2;

/**
 * How tall the box the marks are placed inside is, in px.
 *
 * **Fixed, and that is the whole of design D2's height claim.** Every mark is
 * `position: absolute` inside this box, so the box is exactly this tall whether
 * it holds four marks or none — a row wired to four systems and a row wired to
 * nothing lay out identically. jsdom computes no layout, so the claim is
 * asserted in Chromium (`e2e/external-refs.spec.ts`) and the styles below are
 * what it is asserted about.
 *
 * 12 and not {@link MARK_PX}: a 6px box would put the dots on the cell's top
 * edge, and the row's 28px budget has the room for a box the marks sit centred
 * in.
 */
export const MARK_BOX_PX = 12;

/**
 * Where and how one mark is drawn — the fill/ring split of design D3, placed
 * out of flow.
 *
 * `boxSizing: 'border-box'` is not tidiness: the reset in `styles.css` stops at
 * `[data-grid]`, so a mark in the table keeps the browser's `content-box`, and a
 * ring drawn with a 1px border would be 8px across beside a 6px filled disc —
 * two channels saying two different sizes, which is a third channel nobody
 * asked for.
 *
 * The overflow mark is a `+` rather than a disc, so the one mark standing for
 * several systems at once cannot be mistaken for one of them.
 *
 * @param kind the family, or `overflow`.
 * @param at the mark's place in the row, 0-based — its `left` and nothing else.
 */
export function markStyle(kind: SystemFamily | 'overflow', at: number): CSSProperties {
  const placed: CSSProperties = {
    position: 'absolute',
    left: at * (MARK_PX + MARK_GAP_PX),
    top: (MARK_BOX_PX - MARK_PX) / 2,
  };
  if (kind === 'overflow') {
    return {
      ...placed,
      width: MARK_PX,
      height: MARK_PX,
      boxSizing: 'border-box',
      color: 'var(--muted-foreground)',
      fontSize: MARK_PX + 3,
      lineHeight: `${String(MARK_PX)}px`,
      textAlign: 'center',
    };
  }
  return { ...placed, ...familyDotStyle(kind) };
}

/**
 * One family's disc, with no placement — the two channels of design D3 and
 * nothing about where the mark stands.
 *
 * Split out of {@link markStyle} for the links card, which draws the same disc
 * beside a name in ordinary flow rather than absolutely inside a 40px cell. The
 * _paint_ is the fact both surfaces share and the placement is not, so this is
 * where the fill/ring split lives and {@link markStyle} adds its own `position`
 * on top. Two copies of `FAMILY_PAINT[kind].filled` would be two answers to
 * "which of these is a ring", and the day one of them changed the cell and the
 * card would disagree about what a reader is looking at.
 *
 * `flexShrink: 0` because this disc is a flex child on the card: a 6px box in a
 * row with a long URL in it is the first thing a flex layout takes width from,
 * and a squashed mark is a mark that says nothing.
 */
export function familyDotStyle(family: SystemFamily): CSSProperties {
  const { paint, filled } = FAMILY_PAINT[family];
  return {
    width: MARK_PX,
    height: MARK_PX,
    boxSizing: 'border-box',
    borderRadius: '50%',
    flexShrink: 0,
    ...(filled
      ? { background: paint, border: 'none' }
      : { background: 'transparent', border: `1px solid ${paint}` }),
  };
}
