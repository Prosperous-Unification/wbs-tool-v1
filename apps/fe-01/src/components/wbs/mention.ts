/**
 * The two things a folded role's cell can hold at once: an estimate somebody
 * is typing, and a person somebody is looking up.
 *
 * `mention: null` is "no `@` has been typed", which is not the same as an
 * empty search: `2/3/8` offers nobody and `2/3/8@` offers everybody.
 */
export interface Mentioned {
  /** The estimate half — the only half {@link parseTrioShorthand} may ever see. */
  estimate: string;
  /** What follows the `@`, or null while there is no `@`. */
  mention: string | null;
}

/**
 * Splits `2/3/8@ka` into the trio and the name being searched for.
 *
 * One box does both jobs because Dany asked for one gesture — "trio typed,
 * Kateryna assigned" — and this is the line that keeps them from becoming one
 * value. Everything downstream of the estimate half (the draft, the shorthand
 * parser, the request) reads `estimate`; the picker reads `mention`. Without
 * the split a half-typed `@ka` is a four-part entry the parser refuses, and
 * the cell turns red at somebody who is doing nothing wrong — and worse, the
 * blur that closes the picker would commit it.
 *
 * The **first** `@` splits. A second one is part of what is being searched
 * for: nobody types two mentions into an estimate cell, and splitting at the
 * last would leave `@a` sitting in the estimate half as a trio that cannot
 * parse.
 *
 * Neither half is trimmed. The estimate half is somebody's unfinished draft
 * and editing it is exactly what this tool refuses to do; the search half is
 * trimmed where it is compared against a name.
 *
 * @param typed The whole of what the box holds.
 */
export function splitMention(typed: string): Mentioned {
  const at = typed.indexOf('@');
  if (at === -1) return { estimate: typed, mention: null };
  return { estimate: typed.slice(0, at), mention: typed.slice(at + 1) };
}
