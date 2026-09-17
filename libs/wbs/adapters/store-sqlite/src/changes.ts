import { sql } from 'drizzle-orm';

import type { Drizzle } from './db';

/** Whatever can run a `SELECT` — the process connection or a transaction on it. */
type Reader = Pick<Drizzle, 'all'>;

/**
 * How many rows the statement just run on `reader` changed.
 *
 * `changes()` rather than counting the table before and after. Two full scans
 * per write is the expensive way to ask and it is also the wrong way: the other
 * deployment colour writes to this same file, so a concurrent insert between
 * the two counts lands in the difference and reports as a change this statement
 * made.
 *
 * **No row back throws**, and `what` is spelled into the message so the throw
 * says which write it was about. A sweep that deleted a year of history and
 * reported none is the shape of failure a retention timer must not be able to
 * have, and a conditional revision bump that read zero would leave every
 * reader's precondition stale. There is no negative test and there cannot be
 * one: `SELECT changes()` answers exactly one row, always, which is why four of
 * the five copies of this threw and the fifth (`pruneBeyond`) read `?? 0` — a
 * default for an unknown, in the one place that returns the count to a caller
 * who acts on it.
 */
export function rowsChanged(reader: Reader, what: string): number {
  const changed = reader.all<{ n: number }>(sql`SELECT changes() AS n`).at(0);
  if (changed === undefined) throw new Error(`SELECT changes() answered no row after ${what}`);
  return changed.n;
}
