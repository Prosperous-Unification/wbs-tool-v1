import { writeFileSync } from 'node:fs';

import { openConnection } from '../repository/db';
import type { SavedPlanWrite } from '../repository/saved-plan';
import { SavedPlanRepository } from '../repository/saved-plan';

/**
 * A save that takes the write lock in **another process** and holds it.
 *
 * This exists as its own entry point because the property under test cannot be
 * stated inside one process. `bun:sqlite` is synchronous: a second
 * `BEGIN IMMEDIATE` on the same thread blocks the only thread that could ever
 * let the first one reach its `COMMIT`, so an in-process pair cannot produce
 * the interleaving where a contended save *waits and then succeeds* — which is
 * exactly the serialising behaviour the refusal exists to prevent, and
 * therefore exactly what the negative has to be able to observe.
 *
 * It is also the situation itself rather than a model of it. Blue and green are
 * two be-01 processes on one SQLite file during a swap, and an in-flight marker
 * held in either one's memory is invisible to the other; a test that both
 * writers ran from is blind to the difference between SQLite's lock and a
 * `Set`. Here the rival genuinely is a second process, so only a mechanism the
 * file itself carries can refuse it.
 *
 * It holds through {@link SavedPlanRepository.write} rather than through raw
 * SQL, so what it holds is the real writer's transaction — the same
 * `BEGIN IMMEDIATE`, taken the same way, for the same duration a slow save
 * would.
 *
 * Usage: `bun saved-plan-lock-holder.ts <dbPath> <projectId> <planId> <holdMs>
 * <readyPath>`. It writes `readyPath` **after** the lock is held and before it
 * sleeps, so the parent can start its attempt knowing the lock is taken rather
 * than guessing with a delay; it then commits, so the parent can also observe
 * what the file holds once the contention is over.
 */
async function holdTheWriteLock(argv: readonly string[]): Promise<void> {
  // Checked as an arity rather than element by element: this project does not
  // run `noUncheckedIndexedAccess`, so the destructured names are `string` to
  // the compiler whatever the array holds, and five `=== undefined` tests are
  // five conditions lint can prove dead. The count is the thing that can
  // actually be wrong.
  if (argv.length !== 5) {
    throw new Error(
      `usage: <dbPath> <projectId> <planId> <holdMs> <readyPath>; got ${String(argv.length)}`,
    );
  }
  const [dbPath, projectId, planId, holdMs, readyPath] = argv;

  const plan: SavedPlanWrite = {
    id: planId,
    projectId,
    name: planId,
    createdBy: 'The other process',
    createdById: null,
    createdAt: 1_756_000_200,
    input: { schemaVersion: 1, bytes: '{"schemaVersion":1}', sha256: 'c'.repeat(64) },
    schedule: { present: false, absentReason: 'pending' },
  };

  const plans = new SavedPlanRepository({ openConnection: () => openConnection(dbPath) });
  const written = await plans.write<never>(plan, async () => {
    // Inside the transaction, so the lock is held from here to the commit. The
    // signal is written here rather than before the call: at that point the
    // lock is only *about* to be taken, and a parent racing the gap would
    // measure an uncontended save and pass for the wrong reason.
    writeFileSync(readyPath, 'held');
    await Bun.sleep(Number(holdMs));
    return null;
  });
  if (written.outcome !== 'written') {
    throw new Error(`the holder itself failed to write: ${written.outcome}`);
  }
}

await holdTheWriteLock(Bun.argv.slice(2));
