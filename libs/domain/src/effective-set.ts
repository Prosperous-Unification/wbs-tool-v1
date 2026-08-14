/**
 * A row of a plan, as far as an inherited label is concerned: its own id and
 * its parent's.
 *
 * Structural rather than be-01's `WorkItem` or fe-01's `NumberedWorkItem`,
 * because the whole point of this module is that both read the same rule. The
 * members themselves are read through an accessor rather than off a named
 * field, so **one walk serves every dimension**: teams and services resolve
 * independently and neither is spelled into the shape the other passes.
 */
export interface Nested {
  id: string;
  parentId: string | null;
}

/** Which resources a row's work belongs to, and which row said so. */
export interface EffectiveSet {
  /**
   * The ids in force for this row, in the order the row that carries them
   * states them.
   *
   * **Never empty.** An empty set is _unstated_, which is what inheritance
   * resolves, so a row whose whole ancestry states nothing is absent from the
   * map rather than present with `[]`. There is deliberately no second spelling
   * of "nothing here" — no "deliberately none" beside "nobody said".
   */
  memberIds: readonly string[];
  /**
   * The row that carries the set — this row itself, or the nearest ancestor
   * above it that states one.
   *
   * Carried rather than reduced to a boolean because every consumer that shows
   * an inherited label has to name where it came from: "Platform — inherited
   * from 010 Backend" is the sentence, and a `true` cannot say it.
   */
  fromId: string;
}

/** A `parentId` chain that runs in a circle, which is not a tree and has no ancestors. */
export class AncestryCycleError extends Error {
  override name = 'AncestryCycleError' as const;
  constructor(startedAt: string) {
    super(`the parent chain above ${startedAt} runs in a circle, so it has no nearest label`);
  }
}

/**
 * A set that should hold at most one member and holds more.
 *
 * Not a validation failure and not bad data: it is a **release-ordering**
 * fault. `resource-model` caps every write at one member per dimension, so a
 * plural set arriving at one of these call sites means a writer from a later
 * release is talking to a reader from this one. R5: unknown is not OK, and
 * quietly spending the first of three teams is the silent wrong answer this
 * exists to make loud.
 */
export class PluralMembershipError extends Error {
  override name = 'PluralMembershipError' as const;
  constructor(at: string, memberIds: readonly string[]) {
    super(
      `${at} names ${String(memberIds.length)} resources (${memberIds.join(', ')}), and this release reads one`,
    );
  }
}

/**
 * The one member of a set that is capped at one, or null for a set with none.
 *
 * Every remaining single-valued reader of a resource set goes through here, and
 * that is the point: the narrowing is one function with one name, so the
 * changes that make several real — the multi-pool engine, and the faces that
 * draw a set — are a deleted call site each rather than a hunt for `[0]`.
 *
 * @throws {PluralMembershipError} on two or more. See its own doc: a plural set
 * here is a release-ordering fault, not a user's data.
 */
export function soleMemberOf(memberIds: readonly string[], at: string): string | null {
  if (memberIds.length === 0) return null;
  if (memberIds.length > 1) throw new PluralMembershipError(at, memberIds);
  return memberIds[0] ?? null;
}

/**
 * Every row's effective set for one dimension: its own members, or the nearest
 * ancestor's.
 *
 * **Most-specific wins**, in both directions — a leaf's own set beats every
 * ancestor's, and a nearer ancestor beats a further one. That is deliberately
 * not the rule a `startNoEarlierThan` floor takes, and for the same reason
 * `priorityByLeaf` is not: a floor takes `Math.max` because it is a hard
 * constraint and the strictest of them must hold, while a label is a statement
 * about **whose work this is**, and the one written closest to the work meant
 * that work.
 *
 * **Override, never union.** An ancestor naming A and a row naming B resolve to
 * `{B}`, not `{A, B}` — Dany, 2026-08-13. A union would have no way to say "not
 * that one after all", and every row under a labelled root would accumulate
 * everything written above it.
 *
 * **Per dimension, and each resolves alone.** Call this once per dimension with
 * that dimension's accessor. A row naming two services and no teams therefore
 * overrides its services and inherits its teams, because an empty set is
 * _unstated_ and unstated is what inheritance is for.
 *
 * Rows with no members anywhere above them are simply absent from the map —
 * see {@link EffectiveSet.memberIds} for why that is the one spelling.
 *
 * **No write ever copies a set down.** Inheritance is a reading, computed here
 * and nowhere else: a stored second copy would go out of date the moment
 * anybody moved a row, and the consumers would then disagree about the same row
 * while each held a defensible answer.
 *
 * Returns a `Map` rather than answering about one row, because every consumer
 * of it draws a whole plan: a per-row call would re-walk the ancestry for each
 * of them, which is quadratic in the depth, and the renderers would each hold
 * their own walk. One walk per dimension, memoised, every reader.
 *
 * @throws {AncestryCycleError} when the parent chain loops. Unknown is not OK: a
 * cycle has no nearest ancestor, so there is no set to fall back to and a
 * default would put a row on a pool nobody assigned it to.
 */
export function effectiveSetOf<Row extends Nested>(
  rows: readonly Row[],
  membersOf: (row: Row) => readonly string[],
): Map<string, EffectiveSet> {
  const parentOf = new Map(rows.map((row) => [row.id, row.parentId]));
  const ownMembers = new Map(rows.map((row) => [row.id, membersOf(row)]));
  const found = new Map<string, EffectiveSet>();

  for (const row of rows) {
    // The rows this walk passed through on the way up, in order, so every one
    // of them is memoised with the answer the walk found — a chain of ten
    // unlabelled rows under one labelled root is walked once, not ten times.
    const walked: string[] = [];
    const seen = new Set<string>();
    let resolved: EffectiveSet | undefined;
    for (
      let cursor: string | null | undefined = row.id;
      cursor !== null && cursor !== undefined;
    ) {
      const already = found.get(cursor);
      if (already !== undefined) {
        resolved = already;
        break;
      }
      // Proof: this guard removed and `refuses a parent chain that runs in a
      // circle` never comes back — the walk goes round for ever — so the fault
      // is watched under a timeout rather than as a wrong answer: the eight
      // cases above it pass, that one hangs, and the run under a 45-second
      // timeout is `Killed`. Watched 2026-08-12 for `effectiveTeamOf` and
      // again 2026-08-14 here.
      if (seen.has(cursor)) throw new AncestryCycleError(row.id);
      seen.add(cursor);
      const own = ownMembers.get(cursor);
      // Non-empty is what stops the walk, and empty is what continues it. That
      // one line is the whole of "blank means unstated, so inherit".
      if (own !== undefined && own.length > 0) {
        resolved = { memberIds: own, fromId: cursor };
        break;
      }
      walked.push(cursor);
      cursor = parentOf.get(cursor);
    }
    if (resolved === undefined) continue;
    found.set(row.id, resolved);
    for (const each of walked) found.set(each, resolved);
  }

  return found;
}
