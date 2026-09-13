/**
 * How one surface words be-01's refusal codes.
 *
 * The codes are be-01's contract and have to stay stable; the sentence is a
 * presentation decision that differs per surface, which is why there is a table
 * per surface and not one table. What was duplicated is the **shape** of the
 * lookup, and it was written out five times: an exact-code table, a
 * spelled-limit prefix, a 5xx arm, and a grammatical fallback that carries the
 * code so an unworded refusal is still a sentence rather than a snake_case
 * token in the corner of the screen.
 *
 * Five copies of that shape is five chances to leave an arm out, and three of
 * them had: the step and directory tables have no 5xx arm at all, and the
 * estimating panel words every refusal but one the same way. Those differences
 * are **kept** — the wording on a surface is Dany's call, not a refactor's —
 * and they are now visible as an absent field rather than as a missing `if`.
 */
export interface RefusalWords {
  /**
   * The sentence for be-01's exact code.
   *
   * A total record rather than a `Partial` read at each call site: a
   * `string | undefined` with a fallback invented per read is how two spellings
   * of one refusal happen.
   */
  readonly sentences: Readonly<Record<string, string | undefined>>;
  /**
   * The codes be-01 spells a **number** into, and what the number it carries
   * says.
   *
   * A prefix rather than a literal case, because be-01 builds these out of its
   * own constants (`MOST_PEOPLE_AT_ONCE`, the band count): a literal
   * `maxParallel_must_be_at_most_1000` here would be a second copy of that
   * number, free to drift from it and to fall silently back to printing the
   * wire code the day it did.
   */
  readonly limits?: readonly {
    readonly prefix: string;
    readonly says: (limit: string) => string;
  }[];
  /**
   * What any 5xx says. Something answered, so never "the server did not
   * answer".
   *
   * Matched as a family rather than listed: a proxy in front of be-01 can
   * answer with any of them and none of them is the reader's doing. Absent on a
   * surface that words a server failure through {@link RefusalWords.otherwise}
   * — which two of them do, and it is a fact about those surfaces rather than
   * this table's default.
   */
  readonly serverFailure?: string;
  /** The sentence for a code nobody has worded, which still has to be a sentence. */
  readonly otherwise: (code: string) => string;
}

/** The sentence `words` gives be-01's `code`. */
export function sentenceForRefusal(words: RefusalWords, code: string): string {
  const worded = words.sentences[code];
  if (worded !== undefined) return worded;
  for (const limit of words.limits ?? []) {
    if (code.startsWith(limit.prefix)) return limit.says(code.slice(limit.prefix.length));
  }
  if (words.serverFailure !== undefined && /^http_5\d\d$/.test(code)) return words.serverFailure;
  return words.otherwise(code);
}
