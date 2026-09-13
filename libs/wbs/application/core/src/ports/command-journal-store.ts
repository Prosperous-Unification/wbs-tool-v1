import type { PlanEvent } from './plan-event-store';

/**
 * One command an account ran on one project, and what it takes to reverse it.
 *
 * The three JSON fields arrive parsed but **unvalidated beyond their shape** —
 * see `command_journal` in `schema.ts` for what is written into them and
 * `readCommand` in `service/compensating.ts` for the one thing that is checked.
 */
export interface JournalEntry {
  id: string;
  projectId: string;
  userId: string;
  /** This entry's place in the account's stack for this project; higher is newer. */
  seq: number;
  kind: string;
  /** `{label, forward}` — what to say about it, and what a redo re-applies. */
  payload: unknown;
  /** The compensating command an undo applies, carrying its before-state. */
  inverse: unknown;
  /** `{workItemId: revision}` at the revisions the command left them at. */
  preconditions: unknown;
  /** True once undone: the entry has left the undo stack and joined the redo one. */
  undone: boolean;
  createdAt: number;
}

/** A journal entry on its way in, before the store decides where it sits in the stack. */
export interface NewJournalEntry {
  id: string;
  projectId: string;
  userId: string;
  kind: string;
  payload: unknown;
  inverse: unknown;
  preconditions: unknown;
  createdAt: number;
}

/** Whether an account has anything to undo or redo on one project. */
export interface UndoState {
  undoable: boolean;
  redoable: boolean;
}

/**
 * The last {@link JOURNAL_DEPTH} commands each account ran on each project.
 *
 * Deep enough to walk back through a working session, shallow enough that the
 * table does not grow without bound on a plan somebody edits every day. A
 * number rather than a setting: nothing about an environment changes the right
 * answer.
 */
export const JOURNAL_DEPTH = 50;

export interface CommandJournalStore {
  /**
   * Appends a command to the account's stack for this project and the same
   * command to the project's history, **clearing that account's redo branch**
   * and pruning past {@link JOURNAL_DEPTH}, in one transaction.
   *
   * The redo branch goes because it describes a future that no longer exists:
   * having undone a rename and then typed something else, re-applying the
   * rename would put back a value computed from a plan that has moved on. Only
   * this account's branch goes — the stacks are per account.
   *
   * **`event` is a second argument rather than a second call**, and that is the
   * one thing this signature exists to guarantee. Two calls are two
   * transactions, and the second can fail: a plan would then gain an undo entry
   * for a change absent from its history, which is a history that is quietly
   * short rather than visibly incomplete. `record` is already called after the
   * mutation and after the broadcast — see `WorkItemService.record` for why —
   * so widening that window with a second statement of its own is the failure
   * this refuses to be able to have.
   */
  append(entry: NewJournalEntry, event: PlanEvent): Promise<void>;
  /**
   * The whole of one account's stack for one project, **oldest first**.
   *
   * All of it rather than just the end being asked for, because applying one
   * entry re-stamps its neighbours: an undo is a write, and the entries below
   * it hold revisions that this account's own undo has just walked past. It is
   * bounded by {@link JOURNAL_DEPTH}, so this is fifty rows at worst.
   */
  entriesFor(projectId: string, userId: string): Promise<JournalEntry[]>;
  /**
   * Moves one entry between the two halves of the stack, and records the
   * revisions the direction just applied left behind.
   *
   * The two go together because they describe one act. An entry that changed
   * sides while keeping the preconditions of the direction it came from would
   * be checked against revisions the tree has deliberately moved past — every
   * redo would read as stale, and the redo half of the stack would be
   * decorative.
   */
  flip(id: string, undone: boolean, preconditions: unknown): Promise<void>;
  /**
   * Rewrites one entry's preconditions where it stands, without moving it
   * between the halves of the stack.
   *
   * For the neighbours of an entry that was just applied — see
   * `Preconditions` in `service/compensating.ts` for when a neighbour may be
   * re-stamped and when it must be left to refuse.
   */
  restamp(id: string, preconditions: unknown): Promise<void>;
  /**
   * Throws an entry away for good.
   *
   * What happens to an entry whose preconditions no longer hold: it can never
   * apply again — the state it described is gone — and leaving it at the top
   * would jam the stack, refusing every later press of the key for a change
   * nobody can reach any more.
   */
  discard(id: string): Promise<void>;
  /** Whether either half of the account's stack has anything in it. */
  stateOf(projectId: string, userId: string): Promise<UndoState>;
}
