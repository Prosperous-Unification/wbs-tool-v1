import { type EdgeRefusal, type GraphRow, indexDepGraph, refusalFor } from './dep-graph';

/** A work item as the picker shows it: a number and the name beside it. */
export interface PickableRow extends GraphRow {
  number: string;
  name: string;
}

/**
 * A row the picker offers, and — when be-01 would refuse the edge — why.
 *
 * `self` cannot appear: the row picking its predecessors is not in its own
 * list. A marked entry is shown and not pickable, which is the point of marking
 * it rather than dropping it.
 */
export interface PickerEntry extends PickableRow {
  refusal?: Exclude<EdgeRefusal, 'self'>;
}

/**
 * What a greyed entry in a Depends on list says about itself.
 *
 * The refusal be-01 would answer with, in the words of the plan it is being read
 * in: the reader is looking at rows and asking why this one is out, not reading
 * an API's vocabulary. `— would loop` is the whole of the cycle explanation on
 * purpose; the loop can run through any number of rows and naming them in a list
 * entry is a paragraph nobody reads.
 *
 * Exhaustive rather than `Partial`: a new refusal must not reach a list as a
 * silently unexplained grey row.
 *
 * **Here rather than in `wbs-table.tsx`, where it was written**, because since
 * `card-field-pickers` chunk 7 two faces draw this list — the table's dropdown
 * and the card's sheet — and `wbs-table.tsx` already argues (of the frozen row's
 * refusal) that two spellings of one refusal is how the two drift apart. It sits
 * beside {@link pickerEntries}, which is the function that decides which entries
 * carry one.
 */
export const REFUSAL_SUFFIX: Record<NonNullable<PickerEntry['refusal']>, string> = {
  ancestor: 'contains this row',
  descendant: 'inside this row',
  cycle: 'would loop',
};

/**
 * The rows the Depends on picker may offer, narrowed by what was typed, each
 * carrying the refusal be-01 would answer with if it were picked.
 *
 * The row picking its predecessors is never offered — a row cannot wait for
 * itself — and neither are the predecessors it already has: offering one would
 * be offering a click that be-01's unique pair turns into nothing.
 *
 * Everything else **is** offered, including the rows be-01 would refuse as a
 * cycle or an ancestor, but marked with {@link PickerEntry.refusal} so the
 * dropdown can grey them and say why. This reverses the decision this function
 * used to state: that guessing the graph here would be a second implementation
 * of be-01's judgement, so the refusal should simply be relayed after the
 * click. It is one implementation ported deliberately — {@link refusalFor} —
 * and be-01 still decides; a click that can only end in an error message is a
 * worse teacher than a row that says, before it is clicked, that it contains
 * this one.
 *
 * The filter is a case-insensitive substring over the number and the name,
 * because those are the two things a person knows about the row they want.
 * Order is the order given, which is table order — the same order the eye
 * searches the table in. Narrowing happens first and the graph is asked only
 * about what survives it, so typing shortens the work rather than adding to it.
 */
export function pickerEntries(
  rows: readonly PickableRow[],
  forRow: { id: string; dependsOn: readonly string[] },
  typed: string,
): PickerEntry[] {
  const wanted = typed.trim().toLowerCase();
  const taken = new Set(forRow.dependsOn);
  const offered = rows.filter(
    (row) =>
      row.id !== forRow.id &&
      !taken.has(row.id) &&
      (wanted === '' ||
        row.number.toLowerCase().includes(wanted) ||
        row.name.toLowerCase().includes(wanted)),
  );

  // Re-derived from the rows handed in on every call, never remembered: a
  // refetch can move a row under a parent or land a peer's edge while this list
  // is open, and a cached graph would go on greying yesterday's rows.
  const graph = indexDepGraph(rows);
  return offered.map((row) => {
    const refused = refusalFor(graph, { predecessorId: row.id, successorId: forRow.id });
    // `self` is unreachable — the row itself was filtered out above — and
    // spreading it into the entry rather than mapping it would put a word in
    // the dropdown that no sentence is written for.
    return refused === null || refused === 'self' ? row : { ...row, refusal: refused };
  });
}
