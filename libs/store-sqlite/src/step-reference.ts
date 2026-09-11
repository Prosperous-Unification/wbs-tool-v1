import type { StepWriteOutcome } from '@wbs/core';
import { eq, sql } from 'drizzle-orm';

import { isForeignKeyViolation } from './constraint';
import type { Drizzle } from './db';
import { step } from './schema';

/**
 * Runs a write that names a step, and says `unknown_step` when that is what
 * went wrong.
 *
 * The classification lives **in the store** because the store is the only thing
 * that knows which references its statement carried (D6). SQLite's message
 * names no column — `FOREIGN KEY constraint failed` and nothing else — so the
 * step is re-read before the refusal is believed: a foreign key that failed
 * over the work item or the person is still an unknown and is still thrown.
 *
 * The re-read is inside the same connection and after the failure, which is
 * where it has to be: read first and the step could go between the check and
 * the write, which is the race the refusal exists for in the first place.
 *
 * @throws the driver's own error for any failure that is not this one.
 */
export async function writingStep(
  db: Drizzle,
  stepId: string,
  write: () => Promise<void>,
): Promise<StepWriteOutcome> {
  try {
    await write();
    return 'written';
  } catch (cause) {
    if (!isForeignKeyViolation(cause)) throw cause;
    const rows = await db
      .select({ one: sql<number>`1` })
      .from(step)
      .where(eq(step.id, stepId))
      .limit(1);
    if (rows.length > 0) throw cause;
    return 'unknown_step';
  }
}
