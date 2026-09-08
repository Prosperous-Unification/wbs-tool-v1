import type { Drizzle } from './db';
import type {
  SavedPlanHoldingRow,
  SavedPlanPrincipals,
  SavedPlanTouchOutcome,
  SavedPlanWrite,
  SavedPlanWriteOutcome,
  StoredSavedPlan,
} from './saved-plan';
import type { PlanInputReads } from './saved-plan-capture';
import type { SavedPlanRow } from './schema';

/**
 * A project's saved plans — the {@link HistoryStores} half of a source, and
 * **independent of every batch** (D12, D27).
 *
 * Independent is the contract rather than a description of today's wiring. A
 * save takes no turn at the write coordinator: it runs on its own connection,
 * checks its quota inside its own write, and survives whatever the batch beside
 * it decides. A plan is immutable once written, so there is nothing for a
 * rollback to make consistent, and an author who saved a plan while somebody
 * else's batch was open must not lose it to that batch's refusal.
 *
 * What that costs is contention rather than correctness: a save that meets the
 * database's own write lock answers `snapshot_busy` instead of waiting behind
 * an editing session (`refuseToWaitForWriteLock`).
 */
export interface SavedPlanStore {
  /**
   * Writes a plan's header and bodies, refusing through `check` inside the
   * write's own transaction — which is where a quota has to be read, or two
   * saves at 99 of 100 both pass.
   */
  write<Refusal>(
    plan: SavedPlanWrite,
    check: (holding: SavedPlanHoldingRow, incomingBytes: number) => Promise<Refusal | null>,
  ): Promise<SavedPlanWriteOutcome<Refusal>>;
  /** The count and byte total a quota is read against, inside the caller's transaction. */
  holdingOf(db: Drizzle, projectId: string): Promise<SavedPlanHoldingRow>;
  readOf(savedPlanId: string): Promise<StoredSavedPlan | null>;
  bodyOf(db: Drizzle, savedPlanId: string, kind: 'input' | 'schedule'): Promise<string | null>;
  listOf(projectId: string): Promise<SavedPlanRow[]>;
  /** Who may rename or delete one plan, as one row: the project's owner and the author. */
  principalsOf(savedPlanId: string): Promise<SavedPlanPrincipals | null>;
  renameTo(savedPlanId: string, name: string): Promise<SavedPlanTouchOutcome>;
  deleteOf(savedPlanId: string): Promise<SavedPlanTouchOutcome>;
}

/**
 * The whole-project read a save is taken from, on a snapshot of its own.
 *
 * Its own port beside {@link SavedPlanStore} because it is the one read in the
 * system that has to be **coherent across seventeen queries**: a save made
 * while somebody is editing must not carry rows from two different moments. On
 * SQLite that is a `BEGIN DEFERRED` on a connection nothing else is using; a
 * source with snapshot reads of its own would meet it another way, which is why
 * the port says what it answers and not how.
 */
export interface SavedPlanCaptureStore {
  readPlanInput(projectId: string): Promise<PlanInputReads | null>;
}
