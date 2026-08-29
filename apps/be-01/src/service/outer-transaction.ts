/**
 * The transaction a {@link Command batch} holds open around the stores' own.
 *
 * Every store method opens its own SQLite transaction; inside one of these it
 * becomes a savepoint, and `rollback` here takes every step with it — measured
 * against `bun:sqlite` and drizzle, not read off the docs (ADR 0007). The three
 * calls are synchronous because the connection is: nothing is awaited between
 * `begin` and the first step, so no other request can slip in — the
 * {@link Write lock} keeps them out for the awaits that follow.
 *
 * The one implementation is `drizzleOuterTransaction` in `repository/db.ts`,
 * the file allowed to import drizzle.
 */
export interface OuterTransaction {
  begin(): void;
  commit(): void;
  rollback(): void;
}
