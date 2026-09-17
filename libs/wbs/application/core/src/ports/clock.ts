import type { WriteStamp } from './write-stamp';

/**
 * The two things a write needs that no request carries: the instant it happens
 * at, and the ids it mints.
 *
 * One collaborator rather than two `now?`/`newId?` options at seven
 * constructors, and — the reason it exists — **one** `stampFor`. That method
 * was written out seven times, identically, and it is the sentence ADR 0012
 * turned into a type: an act reads the clock once, and every row it writes and
 * every event it records carries that one reading. Seven copies of a rule about
 * reading a clock once is seven places for a second reading to appear.
 *
 * `WorkItemService` is where the discipline was kept by hand first: `record`
 * read `now()` once for the journal entry and the plan event, "because two
 * `now()` calls would let one act carry two timestamps". `stampFor` made that
 * sentence the type system's, and covers the rows an act writes as well as the
 * two it records.
 *
 * Minting ids is on here beside the clock because they are the same kind of
 * thing to a caller: the ambient non-determinism a write draws on, which a test
 * must be able to hold still. Injected together, a test holds both with one
 * object.
 *
 * The services that keep a `now` of their own take no stamp and mint nothing —
 * `ReplayBuffer`, `RetentionTimer` and `LoginThrottle` age their own entries,
 * and in their suites the passage of time is the subject rather than a detail
 * to hold still.
 */
export interface Clock {
  /** The instant now, in epoch milliseconds. */
  now(): number;
  /** A fresh id for a row this act creates. */
  newId(): string;
  /** The one stamp an act carries — see {@link WriteStamp}; built once per act. */
  stampFor(actorId: string): WriteStamp;
}

/**
 * A clock over required `now` and `newId` capabilities.
 *
 * `stampFor` is derived from `now` rather than injectable: a stamp whose
 * instant did not come from this clock is the drift the type exists to stop.
 */
export function clockOf(parts: { now: () => number; newId: () => string }): Clock {
  const { now, newId } = parts;
  return {
    now,
    newId,
    stampFor: (actorId: string): WriteStamp => ({ at: now(), by: actorId }),
  };
}
