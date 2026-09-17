/** The one thing the upward walk needs of a row: which row it hangs from. */
export interface ParentedRow {
  id: string;
  parentId: string | null;
}

/**
 * Who each row hangs from, by id.
 *
 * Separate from {@link isWithin} because the question is asked twice per edge
 * and once per drag candidate, and the three call sites that used to build this
 * inline built it inside the walk — once per question over the whole project.
 */
export function parentIndexOf(rows: readonly ParentedRow[]): Map<string, string | null> {
  return new Map(rows.map((row) => [row.id, row.parentId]));
}

/**
 * Whether `candidateId` **is** `rootId` or sits anywhere beneath it, walking
 * parents upward.
 *
 * Including the root itself is load-bearing at every caller: a row cannot be
 * dragged into itself, and an edge cannot be drawn from a work item to itself,
 * and both refusals are this walk returning true on its first step.
 *
 * An id `parentOf` has no entry for ends the walk and answers `false` — that is
 * how a cross-project id arrives at `canDepend`, and it is the same reading
 * `expandToLeaves` gives an end it has no row for.
 */
export function isWithin(
  parentOf: ReadonlyMap<string, string | null>,
  candidateId: string,
  rootId: string,
): boolean {
  let cursor: string | null | undefined = candidateId;
  while (cursor !== null && cursor !== undefined) {
    if (cursor === rootId) return true;
    cursor = parentOf.get(cursor);
  }
  return false;
}
