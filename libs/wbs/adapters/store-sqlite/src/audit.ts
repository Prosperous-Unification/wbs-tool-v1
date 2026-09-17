import type { WriteStamp } from '@wbs/core';

/**
 * The audit columns a **new** row carries, from the act that wrote it.
 *
 * Spread into every `.values(…)` in this folder: `.values({ ...row,
 * ...auditOnCreate(stamp) })`. That is deliberately one grep-able token per
 * write site, because a required {@link WriteStamp} parameter proves the stamp
 * **arrived** and says nothing about whether it was used — `insert(row, stamp)`
 * that never mentions `stamp` compiles perfectly.
 *
 * What closes that gap is `audit.test.ts`, which reads this folder's own source
 * and fails naming any write that does not call one of these helpers. It is a
 * test rather than the ESLint rule first attempted here, and that file records
 * why: the selector needed is "an object literal that does **not** contain a
 * spread of `auditOnCreate`", which wants `:has()` inside `:not()` over an
 * argument at a known position, and esquery has no argument-index selector — so
 * the rule also fired on `map.set(key, { … })`. That test, not the parameter, is
 * what makes the fill impossible to forget at a write site added next year.
 *
 * **`updatedAt` equals `createdAt` on a new row**, rather than being left null:
 * "never changed since it was made" and "last changed when it was made" are the
 * same fact about the same row, and a null there would make every reader of the
 * two write `updatedAt ?? createdAt` forever.
 */
export const auditOnCreate = (stamp: WriteStamp) => ({
  createdAt: stamp.at,
  updatedAt: stamp.at,
  createdBy: stamp.by,
});

/**
 * {@link auditOnCreate} for a row whose table dates itself.
 *
 * Two tables and no more: `users` and `project` have carried a `NOT NULL`
 * `created_at` since they were written, supplied by the row object the service
 * builds. This fills the two columns they gained and leaves that one exactly
 * where it was, so neither table changes behaviour and neither ends up with two
 * sources for one value — a field the caller sets and the write silently
 * overrides is a trap for whoever reads it next. Mirrors
 * `schema.ts`'s `auditColumnsBesidesCreatedAt`, which is the other half of the
 * same exception.
 */
export const auditOnCreateBesidesCreatedAt = (stamp: WriteStamp) => ({
  updatedAt: stamp.at,
  createdBy: stamp.by,
});

/**
 * The audit column an **update** moves, from the act that wrote it.
 *
 * Spread into every `.set(…)`. `createdAt` and `createdBy` are absent on
 * purpose and that absence is the guarantee: they describe the act that made the
 * row, which a later act cannot have been, so an update that carried them would
 * quietly reassign authorship to whoever touched a row last.
 */
export const auditOnUpdate = (stamp: WriteStamp) => ({
  updatedAt: stamp.at,
});

/** The three columns {@link auditOnCreate} and {@link auditOnUpdate} write. */
export const AUDIT_COLUMN_NAMES = ['createdBy', 'updatedAt', 'updatedBy'] as const;

/**
 * A row with the audit columns taken off, for a read that answers with the row.
 *
 * Every read in this folder names its columns instead, which is better — the
 * declared return type then checks the projection is complete. This exists for
 * the one read that cannot: `project.ts`'s `toProject` is generic over the row
 * it maps, so it has no column list to name, and it spread the rest of the row
 * straight into its answer. `createdBy` — a user id — reached
 * `GET /api/projects/{id}` that way, under a JSDoc that cited this mapper as
 * the reason it could not.
 *
 * `createdAt` stays: it is a published field of a project and predates the
 * audit columns by months.
 */
export function withoutAuditColumns<T extends object>(
  row: T,
): Omit<T, (typeof AUDIT_COLUMN_NAMES)[number]> {
  const dropped = new Set<string>(AUDIT_COLUMN_NAMES);
  // Rebuilt rather than copied-and-deleted, because `delete` on a computed key
  // is banned here and because building the answer states what it publishes.
  return Object.fromEntries(Object.entries(row).filter(([name]) => !dropped.has(name))) as Omit<
    T,
    (typeof AUDIT_COLUMN_NAMES)[number]
  >;
}
