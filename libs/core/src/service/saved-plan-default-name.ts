/** Two digits, so every rendered field has the same width. */
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * The name a save falls back to when the caller supplied none — assumption A-1.
 *
 * **The argument is the same `created_at` the record is about to be written
 * with, read once.** That is the whole design of this function and the reason it
 * takes a number rather than calling a clock: the default name and the timestamp
 * beside it in the shelf are one value rendered twice, so they cannot disagree.
 * A second `now()` here would be a different instant — usually by microseconds,
 * occasionally by a second across a tick — and a plan named 07:40:12 sitting
 * under a 07:40:13 date is a support question nobody can answer from the row.
 *
 * **Not the client's clock, for the reason `saved-plan-api.ts` states**: the
 * browser has no clock worth trusting for a label that claims to be a server
 * timestamp, and a skewed one produces a name that contradicts its own record.
 * The default is therefore chosen *after* the route's validation rather than
 * before it, which is also why the `minLength: 1` the route asks of a supplied
 * name does not cover this string — `saved-plan-default-name.test.ts` asserts
 * the floor separately.
 *
 * **UTC and explicitly labelled.** Epoch seconds have no zone; rendering them in
 * the server's local zone would make the same instant read differently after a
 * deployment moved region, and would silently reorder names against `created_at`
 * across a DST boundary. The trailing `UTC` is not decoration — without it the
 * string is a local time to whoever reads it.
 *
 * @param createdAt Epoch **seconds**, as {@link SavedPlanServiceOptions.now}
 *   returns and `saved_plan.created_at` stores.
 */
export function defaultSavedPlanName(createdAt: number): string {
  const at = new Date(createdAt * 1000);
  // `String(...)` and not the bare number: `restrict-template-expressions` is
  // on here, and the year is the one field `pad` does not render — four digits,
  // never two.
  const date = `${String(at.getUTCFullYear())}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  const time = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`;
  return `${date} ${time} UTC`;
}
