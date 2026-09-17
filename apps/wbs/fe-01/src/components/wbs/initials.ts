/**
 * The two characters a folded step cell names its assignee by.
 *
 * A folded step is 96px wide and holds a figure as well as a person, which left
 * the name about 40px: `vadym` printed as `vad…` and `kucherenko` as `kuc…`, and
 * three characters of a name with an ellipsis after them is not a name — two
 * different people on one plan read identically. Initials are the same length
 * every time, so the column lines up, and nothing is lost that the cell's own
 * tooltip and its hover card do not say in full.
 *
 * Two words give a letter each — `Kat Nowak` is `KN` — and one word gives its
 * first two letters, because usernames here are single words (`vadym` → `VA`)
 * and one letter is not enough to tell two of them apart. Upper case, because
 * these are read as a mark rather than as text.
 *
 * A name of one character answers with that character rather than padding: `K`
 * is what there is. A name that is empty or only spaces is **not** a case this
 * models — the caller does not print an assignee it does not have — so it
 * throws rather than answering with a blank badge nobody can account for (R5).
 *
 * Proof: `.slice(0, 2)` on a single word made `.slice(0, 1)`, `names a
 * one-word assignee by its first two letters` failed on `expected 'V' to be
 * 'VA'`; the throw replaced with `return ''`, `refuses a name with nothing in
 * it` failed on `expected [Function] to throw an error`. Both watched
 * 2026-08-12.
 *
 * @param name The assignee's name, as the directory holds it.
 * @returns One or two upper-case characters.
 * @throws If `name` has no non-space character in it.
 */
export function initialsOf(name: string): string {
  // `filter(Boolean)` and no `trim()`. A `trim()` was written here and deleted:
  // splitting `'  vadym  '` on `/\s+/` yields an empty string at each end, the
  // filter drops both, and removing the `trim()` was watched changing nothing
  // at all — a line whose removal cannot be seen, which is the fault R5's tally
  // counts and the one `column-widths-drag` deleted a line for. The filter is
  // the guarantee, and `reads a name padded with spaces as the name` watches
  // that instead.
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) throw new Error('an assignee with no name cannot be initialled');
  // Branched on the count rather than on `words[1] === undefined`, which this
  // was written as: without `noUncheckedIndexedAccess` an indexed `string[]` is
  // a `string`, so the comparison is one the types say can never hold —
  // `@typescript-eslint/no-unnecessary-condition` refused it, and it was right.
  // A test asserting a branch the types call unreachable is the shape of a
  // check that cannot fail.
  const initials =
    words.length === 1 ? words[0].slice(0, 2) : words[0].slice(0, 1) + words[1].slice(0, 1);
  return initials.toLocaleUpperCase();
}
