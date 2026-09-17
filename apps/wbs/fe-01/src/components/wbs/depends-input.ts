/** A work item as this parser needs to see it: a number someone can type. */
export interface NumberedRow {
  id: string;
  number: string;
}

export interface ParsedDependencies {
  /** The rows named, in the order typed, without repeats. */
  found: NumberedRow[];
  /** Tokens that matched no work item, in the order typed, without repeats. */
  unknown: string[];
}

/**
 * The work items a typed list of numbers names.
 *
 * Several at once, separated by commas or spaces — `010, 020 030`. That is the
 * convention every predecessors column in every planning tool uses, and it is
 * also the fastest thing to type in a table built to be typed into: one field,
 * one Enter, no widget to open and no mouse.
 *
 * Unknown tokens are **returned rather than thrown on**, and separately from the
 * ones that resolved. A typo in the middle of a list should not discard the four
 * numbers around it that were right, and the caller can add what it found and
 * name what it did not in the same breath.
 *
 * Repeats collapse. Typing `010 010` is one dependency asked for twice, not an
 * error worth interrupting anyone about — and be-01's unique pair would ignore
 * the second anyway.
 */
export function parseDependencies(typed: string, rows: readonly NumberedRow[]): ParsedDependencies {
  const byNumber = new Map(rows.map((row) => [row.number, row]));
  const found: NumberedRow[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();

  for (const token of typed.split(/[,\s]+/)) {
    const wanted = token.trim();
    if (wanted === '' || seen.has(wanted)) continue;
    seen.add(wanted);
    const row = byNumber.get(wanted);
    if (row === undefined) unknown.push(wanted);
    else found.push(row);
  }

  return { found, unknown };
}

/** What to tell someone about the tokens that named nothing, or `null` if none did. */
export function unknownMessage(unknown: readonly string[]): string | null {
  if (unknown.length === 0) return null;
  if (unknown.length === 1) return `No work item numbered ${unknown[0] ?? ''}.`;
  return `No work items numbered ${unknown.join(', ')}.`;
}
