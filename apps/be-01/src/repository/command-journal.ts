import { and, asc, eq, lt, sql } from 'drizzle-orm';

import type { Drizzle } from './db';
import type { Gate } from './gate';
import {
  type CommandJournalStore,
  JOURNAL_DEPTH,
  type JournalEntry,
  type NewJournalEntry,
  type PlanEvent,
  type UndoState,
} from './index';
import { commandJournal, type CommandJournalRow, planEvent } from './schema';

/**
 * The undo stack, one per (project, account), on the server — and the one
 * statement that writes the plan's history, because a command is journalled and
 * recorded in the same transaction. See {@link CommandJournalRepository.append}.
 *
 * `seq` is assigned by SQLite inside the `INSERT`, from the pair's current
 * maximum — `(select coalesce(max(seq), 0) + 1 …)`. It is the same rule the
 * revision counters follow and it is here for the same reason: two be-01
 * processes share one file during a blue/green swap, and a maximum read into
 * this process and written back would let both pick the same number. The
 * unique index on `(project_id, user_id, seq)` would then refuse the second
 * insert — failing an edit that had already been applied to the plan.
 *
 * A subquery over the table being inserted into is evaluated against the table
 * as it stands when the statement runs, which is what makes one statement
 * enough. SQLite serialises writers, so there is no moment at which two
 * inserts are both choosing a number.
 */
export class CommandJournalRepository implements CommandJournalStore {
  constructor(
    private readonly db: Drizzle,
    private readonly gate: Gate,
  ) {}

  /**
   * Appends, clears this account's redo branch, prunes the stack and writes the
   * history row — in one transaction, because all four describe the same act.
   *
   * The order matters. The redo branch goes **first**: those entries hold the
   * highest `seq` values for the pair, and leaving them would make the new
   * entry look older than commands that are no longer reachable. Pruning goes
   * last, against the maximum the insert has just written.
   *
   * **Why the `plan_event` insert is here and not in `PlanEventRepository`.** The
   * two rows record one act, and a history row written by a second call is a
   * history row that can fail on its own — leaving a plan with an undo entry for
   * a change its history does not contain. The store interfaces are async, so a
   * transaction cannot be handed across one; the alternative is this statement,
   * in the transaction that already exists, in the class that owns it. Reads and
   * retention live in `PlanEventRepository`, which has no `append` at all so that
   * a second write path cannot be added by accident.
   *
   * The prune deliberately does **not** reach `plan_event`: the journal is fifty
   * deep per account and the history is kept by age. Pruning the history here
   * would make it a second undo stack.
   *
   * Proof: with the `planEvent` insert moved out of the transaction and run after
   * it, `writes neither when the history row is refused` in
   * `command-journal.test.ts` fails on a `toEqual` diff — the stack holding a
   * command the history never received, which is the shape of the failure this
   * refuses to be able to have. 4 pass, 1 fail; watched 2026-08-17.
   */
  async append(entry: NewJournalEntry, event: PlanEvent): Promise<void> {
    await this.gate.enter(async () => {
      await Promise.resolve();
      const mine = and(
        eq(commandJournal.projectId, entry.projectId),
        eq(commandJournal.userId, entry.userId),
      );
      this.db.transaction((tx) => {
        tx.delete(commandJournal)
          .where(and(mine, eq(commandJournal.undone, true)))
          .run();
        tx.insert(commandJournal)
          .values({
            id: entry.id,
            projectId: entry.projectId,
            userId: entry.userId,
            // Never a number this process read and wrote back. See the class note.
            seq: sql`(select coalesce(max(${commandJournal.seq}), 0) + 1 from ${commandJournal} where ${commandJournal.projectId} = ${entry.projectId} and ${commandJournal.userId} = ${entry.userId})`,
            kind: entry.kind,
            payload: JSON.stringify(entry.payload),
            inverse: JSON.stringify(entry.inverse),
            preconditions: JSON.stringify(entry.preconditions),
            undone: false,
            createdAt: entry.createdAt,
          })
          .run();
        // Everything more than JOURNAL_DEPTH entries below the newest. Compared
        // against the maximum in SQL rather than against a count read out first,
        // so the prune describes the table the insert just left behind.
        tx.delete(commandJournal)
          .where(
            and(
              mine,
              lt(
                commandJournal.seq,
                sql`(select max(${commandJournal.seq}) from ${commandJournal} where ${commandJournal.projectId} = ${entry.projectId} and ${commandJournal.userId} = ${entry.userId}) - ${JOURNAL_DEPTH - 1}`,
              ),
            ),
          )
          .run();
        // The history, in the same transaction and after the prune, so that a
        // journal write which fails for any reason takes this with it. Never
        // pruned here: the plan's history is kept by age, by the retention timer.
        tx.insert(planEvent)
          .values({
            id: event.id,
            projectId: event.projectId,
            userId: event.userId,
            kind: event.kind,
            label: event.label,
            workItemId: event.workItemId,
            stepId: event.stepId,
            before: JSON.stringify(event.before),
            after: JSON.stringify(event.after),
            createdAt: event.createdAt,
          })
          .run();
      });
    });
  }

  async entriesFor(projectId: string, userId: string): Promise<JournalEntry[]> {
    const rows = await this.db
      .select()
      .from(commandJournal)
      .where(and(eq(commandJournal.projectId, projectId), eq(commandJournal.userId, userId)))
      .orderBy(asc(commandJournal.seq));
    return rows.map(asEntry);
  }

  async flip(id: string, undone: boolean, preconditions: unknown): Promise<void> {
    await this.gate.enter(async () => {
      await this.db
        .update(commandJournal)
        .set({ undone, preconditions: JSON.stringify(preconditions) })
        .where(eq(commandJournal.id, id));
    });
  }

  async restamp(id: string, preconditions: unknown): Promise<void> {
    await this.gate.enter(async () => {
      await this.db
        .update(commandJournal)
        .set({ preconditions: JSON.stringify(preconditions) })
        .where(eq(commandJournal.id, id));
    });
  }

  async discard(id: string): Promise<void> {
    await this.gate.enter(async () => {
      await this.db.delete(commandJournal).where(eq(commandJournal.id, id));
    });
  }

  /**
   * Two existence questions, asked as two `LIMIT 1` reads.
   *
   * It is answered on every tree read, so it counts nothing: a plan somebody
   * has been editing all afternoon holds fifty entries, and counting them to
   * discover whether there is at least one is work with no reader.
   */
  async stateOf(projectId: string, userId: string): Promise<UndoState> {
    const half = async (undone: boolean): Promise<boolean> => {
      const rows = await this.db
        .select({ id: commandJournal.id })
        .from(commandJournal)
        .where(
          and(
            eq(commandJournal.projectId, projectId),
            eq(commandJournal.userId, userId),
            eq(commandJournal.undone, undone),
          ),
        )
        .limit(1);
      return rows.length > 0;
    };
    return { undoable: await half(false), redoable: await half(true) };
  }
}

/**
 * A stored row as the service reads it: the three JSON columns parsed.
 *
 * `JSON.parse` throws on text that is not JSON, which is the right answer for
 * a column this process wrote — malformed trusted data is R5's "unknown is not
 * OK", not a condition to model. What comes back is `unknown` rather than a
 * shape, because a cast here would be a claim about rows written by a release
 * that may no longer exist.
 */
function asEntry(row: CommandJournalRow): JournalEntry {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    seq: row.seq,
    kind: row.kind,
    payload: JSON.parse(row.payload),
    inverse: JSON.parse(row.inverse),
    preconditions: JSON.parse(row.preconditions),
    undone: row.undone,
    createdAt: row.createdAt,
  };
}
