import {
  type CommandJournalStore,
  JOURNAL_DEPTH,
  type JournalEntry,
  type NewJournalEntry,
  type PlanEvent,
} from '@wbs/core';

/**
 * The undo stack in an array, for tests whose subject is not SQLite.
 *
 * It keeps every rule the real store's callers depend on — a per-pair `seq`,
 * the redo branch cleared by a forward command, the depth prune, and the
 * ordering each half of the stack is read in — because a fixture laxer than
 * production lets a test pass against behaviour that does not exist.
 *
 * **What it does not model is the one claim the SQL makes**: that `seq` is
 * chosen by the database inside the insert rather than read out and written
 * back. An array has no statement to put it in, so this reads the maximum and
 * adds one — the exact implementation the real store refuses to have. That is
 * the same call `subtree-fixture.ts` makes about atomicity, for the same
 * reason, and it is why the journal's behaviour under two writers is asserted
 * against real SQLite in `service/undo.test.ts` and nowhere else.
 *
 * The JSON columns are held as the values they were given rather than as text.
 * Callers that care about the round trip run against the real store.
 *
 * `events` is the plan's history as this fixture received it — every append's
 * second argument, in the order they arrived, **never pruned**. The real store
 * writes both rows in one transaction and prunes only the stack, and holding the
 * events in a list that the depth rule cannot reach is how a test can see that
 * an evicted undo entry still has its history row. That the two are written
 * atomically is the one claim this fixture cannot make, so it is asserted against
 * real SQLite in `repository/command-journal.test.ts` and nowhere else.
 */
export interface MemoryCommandJournalTables {
  readonly entries: JournalEntry[];
  readonly events: PlanEvent[];
}
export function memoryCommandJournalTables(): MemoryCommandJournalTables {
  return { entries: [], events: [] };
}

export function inMemoryCommandJournal(
  tables: MemoryCommandJournalTables = memoryCommandJournalTables(),
): CommandJournalStore & {
  readonly entries: JournalEntry[];
  readonly events: PlanEvent[];
} {
  const { entries, events } = tables;
  const mine = (projectId: string, userId: string): JournalEntry[] =>
    entries.filter((each) => each.projectId === projectId && each.userId === userId);

  return {
    entries,
    events,
    append(entry: NewJournalEntry, event: PlanEvent) {
      events.push(event);
      for (const undone of mine(entry.projectId, entry.userId).filter((each) => each.undone)) {
        entries.splice(entries.indexOf(undone), 1);
      }
      const group = mine(entry.projectId, entry.userId);
      const seq = group.reduce((highest, each) => Math.max(highest, each.seq), 0) + 1;
      entries.push({ ...entry, seq, undone: false });
      for (const old of mine(entry.projectId, entry.userId).filter(
        (each) => each.seq < seq - (JOURNAL_DEPTH - 1),
      )) {
        entries.splice(entries.indexOf(old), 1);
      }
      return Promise.resolve();
    },
    entriesFor(projectId, userId) {
      return Promise.resolve(mine(projectId, userId).sort((a, b) => a.seq - b.seq));
    },
    flip(id, undone, preconditions) {
      const found = entries.find((each) => each.id === id);
      if (found === undefined) throw new Error(`no journal entry ${id}`);
      found.undone = undone;
      found.preconditions = preconditions;
      return Promise.resolve();
    },
    restamp(id, preconditions) {
      const found = entries.find((each) => each.id === id);
      if (found === undefined) throw new Error(`no journal entry ${id}`);
      found.preconditions = preconditions;
      return Promise.resolve();
    },
    discard(id) {
      const found = entries.find((each) => each.id === id);
      if (found === undefined) throw new Error(`no journal entry ${id}`);
      entries.splice(entries.indexOf(found), 1);
      return Promise.resolve();
    },
    stateOf(projectId, userId) {
      const group = mine(projectId, userId);
      return Promise.resolve({
        undoable: group.some((each) => !each.undone),
        redoable: group.some((each) => each.undone),
      });
    },
  };
}
