/**
 * The longest a not-before reason may be — the width of a sentence, not of a
 * paragraph.
 *
 * A reason is read in three places that are all short: a bar's hover card,
 * where it is appended to a floor sentence already ten words long; the
 * table's Not before cell, which is a date column; and one CSV cell. 200
 * characters is about two lines of prose, which is what *"waiting on client
 * sign-off, the contract goes out on the 8th"* needs and what a pasted email
 * thread does not get.
 *
 * Bounded rather than free for `LONGEST_BAND_LABEL`'s reason one module over:
 * the surfaces that show it have a width, and an unbounded column is a hover
 * card that covers the chart it is explaining. Checked at the controller,
 * which is the only boundary a value can enter through.
 */
export const LONGEST_NOT_BEFORE_REASON = 200;

/**
 * True when a reason is held with no date to hold it to — the one state this
 * pair may not be in.
 *
 * **The reason is words about a floor, so with no floor there is nothing for it
 * to be words about.** A row carrying *"waiting on client sign-off"* and no
 * date says nothing a reader can act on: the work is not held back from
 * anything, no bar is floored by it, and the sentence would appear on no
 * surface — the chart says it only where the not-before is the **binding**
 * floor, and the cell prints it beside a date that is not there. It would be
 * text nobody can see and nothing can clear, which is the shape of a `blocked`
 * flag with no until-date, and that is exactly what this feature was chosen
 * instead of (`notes/decisions.md`, 2026-08-18).
 *
 * So the pair is refused rather than tidied: clearing the date does **not**
 * silently delete the words somebody typed. A client that takes the date off
 * says so about both fields in one request, and one that forgets is answered
 * `not_before_reason_needs_a_date` rather than quietly losing a sentence.
 *
 * The other three combinations are all real states. Neither: the ordinary row.
 * A date alone: every not-before written before this existed, and every one
 * whose reason is obvious. Both: what this feature is.
 *
 * Asked where the pair is **written**, against the row as it will stand — the
 * merge of what is stored and what the patch names — and not against the patch
 * alone: a patch naming only the reason is legal on a row that already has a
 * date and illegal on one that does not, and the patch cannot tell which.
 */
export function isOrphanedNotBeforeReason(
  startNoEarlierThan: string | null,
  reason: string | null,
): boolean {
  return reason !== null && startNoEarlierThan === null;
}
