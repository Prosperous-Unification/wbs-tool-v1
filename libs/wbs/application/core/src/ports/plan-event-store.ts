/**
 * One command somebody ran on one project: a row of the plan's history.
 *
 * The fields are the ones `WorkItemService.record` already holds. `before` and
 * `after` are the compensating and forward commands as objects — the store
 * serialises them on the way in and parses them on the way out, the way it does
 * the journal's three JSON columns, and they come back `unknown` for the same
 * reason: a cast here would be a claim about rows written by a release that may
 * no longer exist.
 *
 * There is no `NewPlanEvent` twin of this, unlike {@link NewJournalEntry}: the
 * store assigns nothing. A journal entry's `seq` is chosen by the database
 * inside the insert, so what goes in genuinely is not what comes back; here the
 * row is written exactly as the caller states it.
 *
 * See `plan_event` in `schema.ts` for what this is and — more importantly — what
 * it is not.
 */
export interface PlanEvent {
  id: string;
  projectId: string;
  userId: string;
  kind: string;
  /** The sentence `record` built, stored rather than re-derived; see {@link JournalPayload}. */
  label: string;
  /** The one work item the command was aimed at, or null when it named many. */
  workItemId: string | null;
  /** The step, for the kinds that carry one. */
  stepId: string | null;
  before: unknown;
  after: unknown;
  createdAt: number;
}

/** What narrows a project's history to the part somebody asked for. */
export interface PlanEventFilter {
  /**
   * One work item's own events. Omitted is every item's, and not "the events
   * that name no item" — those are the plan-wide ones, and they are in the
   * project's history rather than any row's.
   */
  workItemId?: string;
  /**
   * The kinds to keep. Omitted — or empty — is every kind: an empty list names
   * no kind, which is the same question as asking for no filter at all, and it
   * is the only reading that cannot surprise a caller.
   *
   * A kind nothing was ever recorded under answers nothing, and that is not an
   * error. `plan_event.kind` is a string rather than an enumeration precisely so
   * that H2's `actual` lands here without a migration, so there is no closed set
   * to refuse a name against.
   */
  kinds?: readonly string[];
}

/**
 * How long a recorded event lives.
 *
 * By **age**, and never by count. Pruning a history table by count is deletion
 * of exactly the thing being asked for: an afternoon's editing on one plan would
 * evict the morning, which is the property that already rules `command_journal`
 * out as a history. A year is long enough that the question "how did this
 * estimate move" has an answer for any plan anybody is still running, and short
 * enough that the table does not grow forever in the file the domain lives in.
 *
 * A constant rather than configuration, for `EVENT_LOG_MAX_PER_SUBSCRIPTION`'s
 * reason: nothing about an environment changes the right answer, and a knob
 * nobody sets is a knob nobody keeps correct.
 */
export const PLAN_EVENT_RETENTION_DAYS = 365;

export interface PlanEventStore {
  /**
   * One project's history, **newest first**, narrowed by `filter`.
   *
   * There is no `append` here, and that absence is the design. A history row is
   * written by {@link CommandJournalStore.append}, inside the transaction that
   * writes the undo entry, because the two record one act — see that method.
   */
  listFor(projectId: string, filter: PlanEventFilter): Promise<PlanEvent[]>;
  /**
   * Deletes every event recorded before `cutoff`, and answers how many went.
   *
   * The only statement in the product that removes a row from this table.
   */
  pruneOlderThan(cutoff: number): Promise<number>;
}
