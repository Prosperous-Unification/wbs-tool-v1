import { sql } from 'drizzle-orm';

import type { Drizzle } from './db';

/**
 * A table every migration set creates, and the newest one this app needs.
 *
 * Checking `work_item` rather than `users` on purpose: a database migrated to an
 * older release has `users` and not this, and that is exactly the deployment
 * this probe exists to catch.
 */
const REQUIRED_TABLE = 'work_item';

export type DatabaseHealth = 'ok' | 'schema_missing';

/**
 * Whether the database this process holds open is the one it was built for.
 *
 * The endpoint used to answer from an in-memory boolean set at startup, so a
 * container pointed at the wrong `DB_PATH`, or one whose migrations never ran,
 * passed the deploy's health gate and started taking traffic it could not serve
 * (open finding 4).
 *
 * What it cannot catch, and the finding overstated: deleting the file out from
 * under an already-open connection. Unix keeps the inode alive for the open
 * handle, so queries keep working against a file with no name. What it does
 * catch is every failure that reaches a query — a wrong path, an unmigrated or
 * half-migrated schema, a corrupt page, a connection the process has lost.
 */
export function probeSchema(db: Drizzle): DatabaseHealth {
  const rows = db.all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${REQUIRED_TABLE}`,
  );
  return rows.length === 1 ? 'ok' : 'schema_missing';
}
