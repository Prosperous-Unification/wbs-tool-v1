import type { Point } from './estimate-draft';
import { HoverCard } from './hover-card';
import type { CardAssignee } from './plan-cards';

/** One of the three points, as the row holds it: `''` where nobody typed one. */
export interface FoldedRolePoint {
  point: Point;
  days: string;
}

/**
 * What the folded cell says about itself when there is nothing to complain
 * about. Lives on the card, not in a native `title`: the hover preview is the
 * one positioned surface a mark shows (CONTEXT.md), and a browser tooltip
 * racing it over the same cell was two hints disagreeing about one figure.
 */
export const SHORTHAND_HELP =
  'Days as optimistic/realistic/pessimistic — 2/3/8. One number means all three. Empty clears it. ' +
  '@ looks somebody up to do it.';

export interface FoldedRoleCardProps {
  roleName: string;
  /** The work item's number, so a card over a busy table says whose it is. */
  number: string;
  /**
   * The card's id, which the folded cell's box points `aria-describedby` at.
   *
   * The one card in this table that is a description as well as a hover, which
   * is why it carries no label: see {@link HoverCard}'s `label` for what a
   * label does to a description.
   */
  id: string;
  points: readonly FoldedRolePoint[];
  /** The figure the folded cell shows — `''` where there is nothing to show. */
  final: string;
  doing: CardAssignee | null;
  /**
   * The cell's complaint, where it holds one — a typed trio that saves
   * nothing. On the card because the card is the cell's one hint: the native
   * `title` that used to carry it fought the card on hover.
   */
  problem: string | null;
}

/**
 * What one folded role column cell folds away, in full.
 *
 * The cell at rest is `4.8 · Ka…` in 96px: one computed figure, and a person's
 * name cut to about four characters. The trio behind the figure is only on
 * screen while the role is unfolded — and unfolding one folds another, so a
 * plan cannot be read with every trio open. This is where the folded ones are
 * read.
 *
 * Everything here is already on the row the client holds, which is the whole
 * of "hover asks the server for nothing": the three points, the final figure,
 * who is doing it and whether anybody said so.
 *
 * It is also the folded cell's `aria-describedby`, so that a reader with no
 * pointer is not simply told less. That is why the role and the number are the
 * first line of the card rather than an `aria-label` on it — a label would be
 * read out *instead of* everything under it.
 */
export function FoldedRoleCard({
  roleName,
  number,
  id,
  points,
  final,
  doing,
  problem,
}: FoldedRoleCardProps) {
  const estimated = points.some((each) => each.days.trim() !== '');
  return (
    <HoverCard id={id}>
      <div style={{ fontWeight: 600 }}>
        {roleName} for {number}
      </div>
      {/*
        Said in words, not as `2/3/8`: the shorthand is what an estimator types
        into the cell, and a card is read by whoever is looking at the plan.
      */}
      <div>
        {estimated
          ? points.map((each) => `${each.point} ${each.days === '' ? '—' : each.days}`).join(' · ')
          : 'No estimate yet'}
      </div>
      {final !== '' && <div>Final {final} days</div>}
      {doing !== null && (
        <div>
          {doing.name}
          {doing.assumed &&
            ' — assumed: they are the only person assigned, so they are taken to be doing this phase too'}
        </div>
      )}
      {/*
        Task 7.2's assignee sentence, on the card because the folded cell has no
        `title` to put it in — the decision above `data-folded-assignee`, taken
        2026-08-09 when a native tooltip raced this card over the same pixels.
        The mark beside the initials is what says there is something to read;
        this is what it says.

        Muted and below the name, not `--destructive` like the complaint under
        it: a person outside the team is a fact about the plan, and the trio
        that saves nothing is the tool refusing to store what somebody typed.
        Colouring them alike would make one of the two a lie.
      */}
      {doing?.outside != null && (
        <div style={{ color: 'var(--muted-foreground)' }}>{doing.outside}</div>
      )}
      {/*
        Proof: this line deleted, four tests failed — `a folded role cannot
        hide a complaint`, `sends nothing for a trio that runs backwards, and
        says why`, `lets a box replace what the folded cell was holding`,
        `marks the folded cell when the boxes hold a trio that saves nothing`
        — each on the complaint missing from the card. And the fault the
        removal of the native `title` guards against: the `title` put back on
        the folded wrapper, `a folded role cannot hide a complaint` failed on
        `expected 'Fill all three…' to be null`. Both watched, 2026-08-09.
      */}
      {problem !== null && <div style={{ color: 'var(--destructive)' }}>{problem}</div>}
      {/*
        The typing help rides the same card so the cell has exactly one hint.
        Last and muted: whoever hovers is reading the plan first and an
        estimator second.
      */}
      <div style={{ color: 'var(--muted-foreground)' }}>{SHORTHAND_HELP}</div>
    </HoverCard>
  );
}
