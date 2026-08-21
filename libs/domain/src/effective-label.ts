/**
 * The inheritance walk both label dimensions read, written once.
 *
 * A plan has three label dimensions now — teams, since `team-sets`, tags, since
 * R10-B, and services, since `service-split` — and they inherit by **exactly**
 * the same rule: most-specific wins, override rather than union, the whole set
 * rather than a member of it, and "unstated" spelled only as absence. Three
 * copies of that walk would be three places for the rule to drift, and this repo
 * has already shipped the stored-versus-effective version of that bug twice. So
 * the walk lives here and {@link effectiveTeamsOf}, {@link effectiveTagsOf} and
 * {@link effectiveServicesOf} are each one line over it.
 *
 * The third dimension stores a **column** rather than a join table and is still
 * one line over this walk: `effectiveServicesOf` puts a singleton set in and
 * takes a single id out, so nothing here knows which dimensions are set-shaped
 * in the store.
 *
 * What stays per-dimension is only the vocabulary: each keeps its own row shape,
 * its own result type and its own cycle error, because the sentence a consumer
 * shows is dimension-specific — "Platform — inherited from 010 Backend" is not
 * "regulatory — inherited from 010 Backend", and a shared error class would name
 * neither.
 *
 * This module is deliberately not exported from the package index: it is the
 * shared mechanism, not a fourth thing to read a plan with. A consumer asking
 * about labels is asking about teams, about tags or about services, never about
 * "labels".
 */

/** A row of a plan as far as any label dimension is concerned. */
export interface Labelled {
  id: string;
  parentId: string | null;
}

/**
 * The set in force for one row, and the row that carries it — the shape each
 * dimension's own answer is built from, never returned as itself.
 *
 * The dimension supplies a `wrap` that turns this pair into its own vocabulary
 * (`teamIds`/`tagIds`), and **the wrap is called once per stating row, not once
 * per answered row**. That is not tidiness: `resolves a chain of unlabelled rows
 * once, and hands each of them the same answer` asserts object identity across
 * every row a walk passed through, which is the only way the memoisation is
 * observable from outside. Converting the map afterwards would build a fresh
 * object per entry and break it.
 */
export interface EffectiveLabels {
  /** The stating row's set, **whole**. Never empty — absence is the unstated state. */
  labelIds: readonly string[];
  /** This row, or the nearest ancestor above it that states a set. */
  fromId: string;
}

/**
 * Every row's effective set: its own, or the nearest ancestor's.
 *
 * **Most-specific wins**, in both directions — a leaf's own set beats every
 * ancestor's, and a nearer ancestor beats a further one. That is deliberately
 * not the rule a `startNoEarlierThan` floor takes, and for the same reason
 * `priorityByLeaf` is not: a floor takes `Math.max` because it is a hard
 * constraint and the strictest of them must hold, while a label is a statement
 * about the work, and the one written closest to the work meant that work.
 *
 * **Override, not union** (Dany, 2026-08-13, on teams; unchanged for tags):
 * an ancestor stating `{A}` and a row stating `{B}` leaves the row on `{B}`
 * alone. The row's own set replaces the inherited one whole; it does not
 * accumulate. And what is inherited is the ancestor's **whole** set — a reader
 * handed one member of two would report a set the plan never narrowed to.
 *
 * **Per dimension, independently.** Nothing here reads a second dimension, which
 * is what makes "a row with tags and no teams inherits its ancestor's teams and
 * overrides its ancestor's tags" fall out rather than need stating: two calls,
 * two maps, no shared state.
 *
 * Rows with no non-empty set anywhere above them are simply absent from the map.
 *
 * **No write ever copies a set down.** Inheritance is a reading, computed here
 * and nowhere else: a stored second copy would go out of date the moment
 * anybody moved a row, and every consumer would then disagree about the same row
 * while each held a defensible answer.
 *
 * Returns a `Map` rather than answering about one row, because every consumer of
 * it draws a whole plan: a per-row call would re-walk the ancestry for each of
 * them, which is quadratic in the depth.
 *
 * @param rows every row of the plan, in any order — the walk memoises, so a
 * deepest-first list costs no more than a shallowest-first one.
 * @param labelsOf the row's **own** stored set, empty meaning unstated.
 * @param wrap builds the dimension's answer from the set and the row that
 * states it. Called once per stating row, so every row that inherits holds the
 * **same object** — see {@link EffectiveLabels}.
 * @param cycleError builds the dimension's own error for a parent chain that
 * loops. Unknown is not OK: a cycle has no nearest ancestor, so there is no set
 * to fall back to and a default would put a row on a set nobody assigned it.
 */
export function effectiveLabelsOf<Row extends Labelled, Answer>(
  rows: readonly Row[],
  labelsOf: (row: Row) => readonly string[],
  wrap: (labels: EffectiveLabels) => Answer,
  cycleError: (startedAt: string) => Error,
): Map<string, Answer> {
  const parentOf = new Map(rows.map((row) => [row.id, row.parentId]));
  const own = new Map(rows.map((row) => [row.id, labelsOf(row)]));
  const found = new Map<string, Answer>();

  for (const row of rows) {
    // The rows this walk passed through on the way up, in order, so every one
    // of them is memoised with the answer the walk found — a chain of ten
    // unlabelled rows under one labelled root is walked once, not ten times.
    const walked: string[] = [];
    const seen = new Set<string>();
    let resolved: Answer | undefined;
    for (
      let cursor: string | null | undefined = row.id;
      cursor !== null && cursor !== undefined;
    ) {
      const already = found.get(cursor);
      if (already !== undefined) {
        resolved = already;
        break;
      }
      // Proof: this guard replaced by `seen.size;` and `refuses a parent chain
      // that runs in a circle` never comes back — the run stops and is killed by
      // the shell's own `timeout`, printing nothing further. Which is why the
      // assertion is on the throw and the fault is watched as a hang rather than
      // as a wrong answer; watched 2026-08-12, again 2026-08-14 over the set,
      // and again 2026-08-19 over both dimensions.
      if (seen.has(cursor)) throw cycleError(row.id);
      seen.add(cursor);
      const stated = own.get(cursor);
      // The whole set, not `stated[0]`: narrowing here is the one fault in this
      // function that changes dates rather than failing, since the capacity
      // adapter spends slots in whatever it is handed.
      //
      // Proof: `stated` replaced by `stated.slice(0, 1)` and `inherits an
      // ancestor’s whole set, not its first member` failed on
      // `expect(received).toEqual(expected)` with `- "platform"` missing from
      // `[ "design", "platform" ]`; watched 2026-08-14, and the tag half of the
      // same fault watched 2026-08-19.
      if (stated !== undefined && stated.length > 0) {
        resolved = wrap({ labelIds: stated, fromId: cursor });
        break;
      }
      walked.push(cursor);
      cursor = parentOf.get(cursor);
    }
    if (resolved === undefined) continue;
    found.set(row.id, resolved);
    // Proof: this line replaced by `walked.length;` and `resolves a chain of
    // unlabelled rows once, and hands each of them the same answer` failed on
    // `expect(received).toBe(expected)` — `Received: serializes to the same
    // string`, which is two equal objects and exactly what a re-walked chain
    // produces. The test's rows are deepest-first for this reason; in tree order
    // the fault is invisible. Watched 2026-08-14.
    for (const each of walked) found.set(each, resolved);
  }

  return found;
}
