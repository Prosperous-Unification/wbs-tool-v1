/**
 * How long a calendar marker's name may be, and the counting that decides it.
 *
 * In the domain rather than in `be-01`, for the reason the colour rules are:
 * the composer refuses an over-long name before it sends anything and the API
 * refuses one that arrives anyway, and two spellings of "too long" are two
 * rules free to disagree about a name the user is looking at.
 */

/**
 * The longest a marker name may be, in **Unicode code points** — 120.
 *
 * 120 rather than 255 because the name is drawn in a chip in an axis cell and
 * read in a hover list, never in a paragraph. It is a label, and a cap that
 * admits a sentence invites one.
 */
export const MARKER_NAME_MAX = 120;

/**
 * Is this a name a marker may carry: at least one code point, at most
 * {@link MARKER_NAME_MAX}?
 *
 * **Code points, not UTF-16 units, and the difference is the whole function.**
 * `String.prototype.length` counts units, so an astral character — an emoji, a
 * musical glyph, most of the CJK extensions — costs two and a name of 60 of
 * them reads as 120. The spec says an emoji costs one, so the count is over the
 * string's own iterator, which yields code points.
 *
 * Empty is refused by the same bound: the minimum is 1, so "unnamed" is not a
 * state a stored marker can be in.
 *
 * **Code points, and not grapheme clusters**, which `no-misused-spread` is
 * right to raise and which the disable below is a decision about rather than a
 * silencing: a ZWJ sequence — a family emoji, a flag — is several code points
 * and costs several here. The spec names code points, so that is the unit; an
 * `Intl.Segmenter` count would be a different cap, and one the composer would
 * have to reproduce exactly for its pre-send refusal to agree with this one.
 */
export function isMarkerName(name: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- code points are the unit the spec counts in
  const points = [...name].length;
  return points >= 1 && points <= MARKER_NAME_MAX;
}
