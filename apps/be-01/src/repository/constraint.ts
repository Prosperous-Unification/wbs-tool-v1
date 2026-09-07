/**
 * Whether a thrown error is SQLite refusing a write because a foreign key
 * pointed at a row that is not there.
 *
 * `bun:sqlite` reports constraint violations as messages rather than typed
 * errors, so this is a string test — the same translation
 * `UserRepository.create` makes for a duplicate username, and
 * `StepRepository.add` for a duplicate step name. The message is looked for
 * down the `cause` chain, not on the outer error alone: see {@link messagesOf}.
 *
 * **It does not say which key.** SQLite's message names no column, so a caller
 * that turns this into a refusal must establish *which* of the request's ids is
 * missing before it does — otherwise it reports a confident lie about the one
 * that was fine. {@link WorkItemService} does that by re-reading the project's
 * steps and rethrowing when the step is still there.
 */
export function isForeignKeyViolation(err: unknown): boolean {
  return messagesOf(err).some((message) => message.includes('FOREIGN KEY constraint failed'));
}

/**
 * Every message on an error's `cause` chain, outermost first, at most eight
 * deep.
 *
 * The string tests either side of {@link isWriteLockBusy} used to read the
 * outer message alone, and that was right until drizzle 1.0.0-rc.4: a
 * statement issued through drizzle now throws `DrizzleQueryError: Failed
 * query: insert into "step" …` with SQLite's own `UNIQUE constraint failed:
 * step.project_id, step.name` one level down, as `cause`. Read the outer
 * message alone and every modeled refusal in be-01 becomes an unhandled 500 —
 * 22 tests said so on 2026-09-06, the controllers' among them answering
 * `Failed query` text where a 409 was owed. The walk and its depth bound are
 * {@link isWriteLockBusy}'s, for the reason given there.
 *
 * Exported for the repository tests that assert an *unmodeled* violation
 * escapes as SQLite's own refusal — they read the chain the same way rather
 * than the wrapper's text, which names the statement and not the constraint.
 */
export function messagesOf(err: unknown): string[] {
  const messages: string[] = [];
  let at: unknown = err;
  for (let depth = 0; depth < 8 && at instanceof Error; depth += 1) {
    messages.push(at.message);
    at = at.cause;
  }
  return messages;
}

/**
 * Whether a thrown error is SQLite refusing to take the write lock because
 * another connection already holds it.
 *
 * **Not a string test, unlike the two either side of it, and deliberately so.**
 * Probed against the shipped `bun:sqlite` on h2puni: a `BEGIN IMMEDIATE`
 * refused at `busy_timeout = 0` throws a `SQLiteError` carrying
 * `code: "SQLITE_BUSY"` and `errno: 5`, and it arrives in 1 ms. The code is the
 * identity SQLite itself assigns the condition; `database is locked` is one
 * rendering of it that a later bun is free to reword, and `SQLITE_LOCKED`
 * (errno 6) is a *different* condition whose message a loose test would fold
 * into this one. Constraint violations get a string test because bun reports
 * them without a code; this one has a code, so it uses it.
 *
 * **The chain is walked, and that is not defensive.** Measured: probed directly
 * against `bun:sqlite` the `SQLiteError` is what is thrown, but the statement
 * this classifies is issued through drizzle, which catches it and throws
 * `DrizzleError: Failed to run the query 'BEGIN IMMEDIATE'` with the original
 * as its `cause`. A test against the outer error alone was watched failing on
 * exactly that: the refusal escaped as an unhandled `DrizzleError` instead. The
 * depth bound is there because a `cause` chain is caller-supplied data and a
 * cycle in it would hang this function.
 *
 * The caller that turns this into a refusal must have taken the lock with
 * waiting turned off — see `db.refuseToWaitForWriteLock`. At the default
 * `busy_timeout` the same error still arrives, five seconds later, which is the
 * serialising behaviour the refusal exists to prevent rather than to report.
 */
export function isWriteLockBusy(err: unknown): boolean {
  let at: unknown = err;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!(at instanceof Error)) return false;
    const { code, cause } = at as Error & { readonly code?: unknown };
    if (code === 'SQLITE_BUSY') return true;
    at = cause;
  }
  return false;
}

/**
 * The physical columns of one unique index, spelled the way SQLite quotes them
 * in a violation message: `table.column`, in the index's own order.
 *
 * A stale spelling here is silent — the message simply stops matching and the
 * refusal the caller owed becomes an uncaught 500. That happened once already:
 * `20260831120000_rename_role_to_step` renamed the table and
 * `StepRepository`'s literal kept saying `role`. Every entry of
 * {@link UNIQUE_INDEXES} is therefore asserted against a migrated database by
 * `constraint.db.test.ts`.
 */
export type UniqueIndexColumns = readonly [string, ...string[]];

/**
 * Every unique index a repository translates into a modeled refusal, by the
 * name the refusal has in the domain.
 *
 * Kept together rather than beside each caller so the test above has one list
 * to walk; a literal written inline is a literal nothing checks.
 *
 * Proof that a stale spelling is not cosmetic: `refuses a name the project
 * already holds, and leaves the steps as they were` and `refuses a rename onto
 * a name already in use, leaving both alone` in `step.test.ts` were watched
 * failing with `stepNameInProject` left at the pre-rename `role.project_id,
 * role.name` against the renamed schema, on `SQLiteError: UNIQUE constraint
 * failed: step.project_id, step.name` escaping the repository instead of
 * becoming a `taken`. Observed 2026-08-31.
 */
export const UNIQUE_INDEXES = {
  personName: ['person.name'],
  serviceName: ['service.name'],
  stepNameInProject: ['step.project_id', 'step.name'],
  tagName: ['tag.name'],
  teamName: ['service_team.name'],
  username: ['users.username'],
  workItemTypeName: ['work_item_type.name'],
} as const satisfies Record<string, UniqueIndexColumns>;

/**
 * Whether a thrown error is SQLite refusing a write because it would have made
 * a second row with the same key under `index`.
 *
 * A string test for the same reason {@link isForeignKeyViolation} is one, and
 * unlike that one it **does** say which key: the message names the index's
 * columns, so a different constraint failing at the same call site stays an
 * unknown and still throws. Looked for down the `cause` chain — see
 * {@link messagesOf}.
 *
 * Proof: with {@link messagesOf} cut to the outer message, `patchTeam ›
 * answers 409 taken with the surviving name`, `patchPerson › …` and `the
 * service commands › …` in `directory.controller.db.test.ts` failed on the
 * 500 that escaped instead, and `finds the index name one cause down` and
 * `finds a foreign key one cause down` in `constraint.db.test.ts` on
 * `Expected: true · Received: false`. Observed 2026-09-06.
 */
export function isUniqueViolation(err: unknown, index: UniqueIndexColumns): boolean {
  const named = `UNIQUE constraint failed: ${index.join(', ')}`;
  return messagesOf(err).some((message) => message.includes(named));
}
