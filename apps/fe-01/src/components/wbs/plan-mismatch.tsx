import { type TreeRow } from './wbs-rows';

/**
 * The sentence both mismatch markers end on, in one constant so they end alike.
 *
 * It is the load-bearing half of D5: neither signal refuses anything, moves a
 * date or blocks a write, and a reader meeting a mark on their own row needs to
 * be told that before they go looking for what to fix. Written once because two
 * markers reassuring a reader in two different wordings read as two different
 * kinds of trouble.
 */
export const MISMATCH_TAIL = ' Nothing is blocked — the plan is recording this, not refusing it.';

/**
 * A list of names as a sentence says them: `A`, `A and B`, `A, B and C`.
 *
 * Both markers name a set now — every offending service since the 2026-08-21
 * scope change, and every team in force — so the alternative is a bare
 * comma-join that reads as a fragment inside a sentence that is otherwise
 * English.
 */
export function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Everybody named on any of this row's steps, deduplicated.
 *
 * A module function and not two inline spreads because both readers of it — the
 * `assigneeIds` facet and the assignee marker's list of who is outside — have
 * to be asking about the same people. One person on three steps is one person
 * to filter by and one person to mark, and `includes` over a list holding them
 * three times is the same answer paid for three times on every keystroke.
 */
export function assigneesOf(row: TreeRow): string[] {
  return [...new Set(Object.values(row.assignees).filter((id): id is string => id !== undefined))];
}

/**
 * The quiet marker both mismatch signals wear (task 7.2, design D5).
 *
 * One component for both, which is the whole reason 7.1 was split to bring them
 * here together: two markers that must carry the same kind of sentence get
 * phrased differently when they are written a chunk apart. A hollow triangle
 * and not `!` — `!` is this table's word for a complaint the tool wants fixed
 * (a trio that saves nothing), and neither of these is a complaint. Nothing is
 * refused, nothing moves, no date changes; the plan is being honest about what
 * it holds. Muted ink for the same reason: a marker loud enough to read as an
 * error would be an error the reader cannot clear.
 *
 * `role="img"` with the sentence as its label, because the sentence is the
 * marker. A glyph that cannot say why is a mystery rather than a signal
 * (7.2's own words), and a `title` alone reaches a pointer only.
 *
 * **The pointer rule, in one sentence, because 2026-08-22 found the two marks
 * disagreeing in the DOM and read that as one of them saying nothing:** every
 * mark answers the hover that lands on it with its own sentence — as a `title`
 * where nothing else owns that hover, and off the cell's card where something
 * does. The two are the same promise through different means, not a rule and an
 * exception, which is why `carded` is a property of the *cell* rather than of
 * the kind: the folded assignee mark drops its `title` and the unfolded one
 * keeps it, and both are the same mark. What must never happen is a third case
 * — no `title` and no card — and `answers a pointer at every mark` asserts the
 * promise over every mark on a row rather than over the two this file happens
 * to place today.
 */
export function MismatchMark({
  kind,
  note,
  carded = false,
}: {
  kind: 'service' | 'assignee';
  note: string;
  /**
   * Whether this mark sits in a cell whose one hint is a hover card, in which
   * case it carries no native `title`.
   *
   * The folded step cell's own decision, 2026-08-09 and stated in its code: a
   * browser tooltip is one line, a second late, and it raced the card over the
   * same pixels. So there the sentence goes on the card and the mark keeps only
   * its `aria-label`, which nothing races. A mark with no sentence anywhere
   * would be the mystery 7.2 forbids; this moves the sentence, it does not drop
   * it.
   *
   * The mark sits **inside** the cell whose `onMouseEnter` opens that card, so
   * the pointer that reaches the triangle is the pointer that opens the card:
   * the sentence arrives from hovering the mark either way. Giving this mark a
   * `title` as well would put both on screen at once over the same 96px, which
   * is the race that decision was taken to end.
   */
  carded?: boolean;
}) {
  return (
    <span
      data-mismatch={kind}
      role="img"
      aria-label={note}
      // The `title` is the pointer's copy of the same sentence. Both, not one:
      // `aria-label` is not shown to a sighted reader and `title` is not read
      // to a screen reader off a `span`.
      {...(carded ? {} : { 'data-fact': note })}
      style={{
        color: 'var(--muted-foreground)',
        cursor: 'help',
        flex: 'none',
        fontSize: '0.85em',
        marginLeft: 2,
      }}
    >
      △
    </span>
  );
}
