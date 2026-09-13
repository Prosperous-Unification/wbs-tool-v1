/**
 * A row of a plan, as far as the tags are concerned: its own id, its parent's,
 * and whatever tags somebody wrote on it.
 *
 * Structural rather than be-01's `LabelledWorkItem` or fe-01's `TreeRow`,
 * because the whole point of this module is that both read the same rule — the
 * argument `TeamsLabelled` makes, one dimension over.
 *
 * `tagIds` is a **set**, and an empty one means this row states nothing. It is
 * no longer the "unstated, therefore inherit" state the team dimension still
 * has: since `tags-accumulate` every row inherits whatever is above it whether
 * or not it states tags of its own, so emptiness decides nothing here beyond
 * "this row added no word to the ones it was already carrying". There is still
 * no "deliberately untagged" state, for the reason there is none for teams
 * (Dany, 2026-08-13, Q4): a second spelling of "nobody has said" is a state
 * every reader then has to handle twice.
 */
export interface TagsLabelled {
  id: string;
  parentId: string | null;
  tagIds: readonly string[];
}

/**
 * One tag in force on one row, and the row that put it there.
 *
 * The provenance is **per tag** rather than per row, which is the whole of what
 * accumulation costs: under override there was one stating row for the set, so
 * `EffectiveTags` could carry a single `fromId`. A row inheriting `Risk` from
 * `010` and `Review` from `010.2` while stating `Ready` itself has three
 * different answers to "who said so" in one cell, and a single id can name at
 * most one of them.
 *
 * `fromId` equal to the row being asked about is how a reader tells a tag the
 * row **states** from one it merely carries: the first is removable where it is
 * drawn, the second only where it was written. Nothing else in this repo
 * distinguishes the two, and the Tags cell's ✕ is decided on exactly this.
 */
export interface TagInForce {
  tagId: string;
  fromId: string;
}

/**
 * What kind of thing a row is: every tag in force on it, each with the row that
 * states it.
 *
 * **Own tags first, in the order the row stores them, then each ancestor's,
 * nearest first.** That is the order every face draws, so the row's own words
 * lead and the inherited ones trail; `work_item_tag` is read by tag id, so two
 * reads of an unchanged plan answer the same list.
 *
 * Never empty. A row carrying nothing anywhere in its ancestry is absent from
 * the map instead, so "no tags at all" has one spelling here too.
 */
export type EffectiveTags = readonly TagInForce[];

/** A `parentId` chain that runs in a circle, which is not a tree and has no ancestors. */
export class TagAncestryCycleError extends Error {
  override name = 'TagAncestryCycleError' as const;
  constructor(startedAt: string) {
    super(`the parent chain above ${startedAt} runs in a circle, so it has no nearest tag`);
  }
}

/**
 * Every row's effective tag set: **its own plus every ancestor's**, unioned.
 *
 * This is the one label dimension that accumulates, and it is deliberately not
 * `effectiveLabelsOf`'s rule — see `docs/adr/0008-tags-accumulate-down-the-tree.md`,
 * which supersedes the override half of Dany's 2026-08-13 Q4 answer for tags
 * and for tags only. Teams and services still override, still through
 * {@link effectiveLabelsOf}, and the two walks are apart precisely so that
 * neither can be changed by a hand aimed at the other.
 *
 * The short of it: a team answers _who does the work_ and one owner is a
 * decision, so a row naming its own team means that team **instead**. A tag
 * answers _what kind of thing this is_, and a child of a `Risk` parent is still
 * risky — it has added a word, not replaced one. Adding `Ready` to a row and
 * watching `Risk` and `Review` vanish from it was the 2026-08-29 report this
 * function answers.
 *
 * **A row restating a tag an ancestor also states is the stating row.** The
 * nearest statement wins the provenance, so the tag is removable on the row a
 * reader is looking at rather than only on the ancestor. It appears once: a
 * cell showing `Risk` twice is a cell describing the tree rather than the work.
 *
 * **Per dimension, independently**, which is the property this function exists
 * to make true rather than to state: a row with tags and no teams inherits its
 * ancestor's teams and accumulates its ancestor's tags, because the two are two
 * walks over two fields and neither reads the other.
 *
 * **What a tag is not:** nothing here is a pool and nothing here is a size. No
 * caller below `slicesOf` exists, `libs/domain/src/schedule.ts` has an empty diff in the
 * change that adds this, and a test wires the scheduler to read a tag and
 * watches every downstream date move to keep it that way. A team answers _who
 * does the work_ and the engine spends its capacity; a tag answers _what kind of
 * thing this is_ and the engine must never read it. Accumulation does not
 * change that: it widens what a face reads, and a face is all it reaches.
 *
 * **No write ever copies a set down.** Inheritance is a reading, computed here
 * and nowhere else — `effectiveLabelsOf`'s argument, which survives the fork.
 *
 * Returns a `Map` rather than answering about one row, because every consumer of
 * it draws a whole plan: a per-row call would re-walk the ancestry for each of
 * them, which is quadratic in the depth.
 *
 * @param rows every row of the plan, in any order — the walk memoises, so a
 * deepest-first list costs no more than a shallowest-first one.
 * @throws {TagAncestryCycleError} when the parent chain loops. Unknown is not
 * OK: a cycle has no top, so there is no finite set of ancestors to accumulate
 * and a default would label a row with something nobody wrote on it.
 */
export function effectiveTagsOf(rows: readonly TagsLabelled[]): Map<string, EffectiveTags> {
  const parentOf = new Map(rows.map((row) => [row.id, row.parentId]));
  const own = new Map(rows.map((row) => [row.id, row.tagIds]));
  /**
   * Every row this walk has settled, **including the ones that carry nothing**.
   *
   * Separate from the map handed back because the two answer different
   * questions: this one is the memo, and a row that accumulates to nothing is
   * as settled as one that accumulates to three. The returned map spells "no
   * tags anywhere above this row" as absence, so an empty entry cannot live in
   * it — and without this second map a chain of untagged rows would be
   * re-walked once per row, which is the quadratic this function's memo exists
   * to avoid.
   */
  const settled = new Map<string, EffectiveTags>();

  for (const row of rows) {
    if (settled.has(row.id)) continue;
    // The rows between this one and the nearest settled ancestor, deepest
    // first. Collected on the way up and then folded on the way back down,
    // because accumulation reads in the opposite direction from override: an
    // override walk can stop at the first statement it meets, while a union has
    // to know the whole chain above a row before it knows the row's answer.
    const unsettled: string[] = [];
    const seen = new Set<string>();
    let carried: EffectiveTags = [];
    for (let cursor: string | null | undefined = row.id; cursor !== null && cursor !== undefined;) {
      const already = settled.get(cursor);
      if (already !== undefined) {
        carried = already;
        break;
      }
      // Proof: this guard replaced by `seen.size;` and `refuses a parent chain
      // that runs in a circle` never comes back — the run stops and is killed
      // by the shell's own `timeout`, printing nothing further. Which is why
      // the assertion is on the throw and the fault is watched as a hang rather
      // than as a wrong answer; watched 2026-08-29 over the accumulating walk,
      // and before the fork on 2026-08-12/14/19 over the shared one.
      if (seen.has(cursor)) throw new TagAncestryCycleError(row.id);
      seen.add(cursor);
      unsettled.push(cursor);
      cursor = parentOf.get(cursor);
    }
    // Reversed in place rather than indexed backwards: an index read types as
    // possibly-undefined under `noUncheckedIndexedAccess` and would buy a `??`
    // no test could ever watch fail. `unsettled` is local to this iteration.
    unsettled.reverse();
    for (const id of unsettled) {
      carried = accumulate(own.get(id) ?? [], carried, id);
      settled.set(id, carried);
    }
  }

  const found = new Map<string, EffectiveTags>();
  for (const [id, tags] of settled) if (tags.length > 0) found.set(id, tags);
  return found;
}

/**
 * One row's answer: what it states, then what it was already carrying.
 *
 * Returns `carried` **itself** when the row states nothing, which is what makes
 * the memo observable: every row of a chain that adds no tag of its own holds
 * the same array object, and `resolves a chain of untagged rows once, and hands
 * each of them the same answer` asserts exactly that identity. Building a fresh
 * copy would be correct and would re-allocate the whole inherited list once per
 * level of depth.
 *
 * Proof: this early return deleted, so every level rebuilds, and that test
 * failed on `expect(received).toBe(expected)` — `Expected: [ { tagId:
 * "regulatory", fromId: "a" } ] / Received: serializes to the same string`,
 * which is two equal arrays and exactly what a re-walked chain produces.
 * Watched 2026-08-29.
 *
 * The inherited half is what accumulation **is**, and dropping it is the
 * override this function replaces. Proof: the `for (const above of carried)`
 * loop removed and four cases went red at once — `keeps every ancestor's tags
 * when a row states one of its own` on `Expected - 2 / Received + 0`, missing
 * `"risk@parent"` and `"review@parent"` from `[ "ready@leaf" ]`;
 * `accumulates every ancestor in the chain, not only the nearest` on the same
 * shape missing `"q3@parent"` and `"tech-debt@grandparent"`; plus the
 * `names the row each tag came from` and cross-dimension cases. Watched
 * 2026-08-29.
 *
 * A tag already carried is **not** added twice, and the nearer statement is the
 * one kept: `stated` is walked first, so a row restating its parent's `Risk`
 * owns it. Proof: the `claimed` guard on the inherited half deleted and `a row
 * restating an ancestor's tag states it itself, once` failed on
 * `expect(received).toEqual(expected)` — `Expected - 0 / Received + 1`, with
 * `"risk@parent"` standing beside `"risk@leaf"`. Watched 2026-08-29.
 *
 * And the provenance is the entry's own, not the reader's. Proof: `push(above)`
 * replaced by `push({ tagId: above.tagId, fromId: statedBy })` and `names the
 * row each tag came from, so a reader can be told` failed on
 * `- "far@far-up" / + "far@near-up"` — every tag claiming to have been written
 * where it is drawn, which is a removable ✕ on a chip that cannot remove it.
 * Watched 2026-08-29.
 */
function accumulate(
  stated: readonly string[],
  carried: EffectiveTags,
  statedBy: string,
): EffectiveTags {
  if (stated.length === 0) return carried;
  const claimed = new Set<string>();
  const inForce: TagInForce[] = [];
  for (const tagId of stated) {
    if (claimed.has(tagId)) continue;
    claimed.add(tagId);
    inForce.push({ tagId, fromId: statedBy });
  }
  for (const above of carried) {
    if (claimed.has(above.tagId)) continue;
    claimed.add(above.tagId);
    inForce.push(above);
  }
  return inForce;
}
