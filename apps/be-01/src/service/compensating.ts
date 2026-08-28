import type { RoleState } from '@wbs/domain';

import type {
  ActualKey,
  Assignment,
  EstimateKey,
  FrozenNumber,
  MeasureKey,
  MeasureMetric,
  ProgressKey,
  Reparented,
  StoredActual,
  StoredDependency,
  StoredEstimate,
  StoredMeasure,
  StoredProgress,
  WorkItem,
  WorkItemPatch,
} from '../repository';
import type { Days } from './roll-up';

/**
 * One command, expressed so that it can be applied without knowing what it is
 * compensating for.
 *
 * Every journalled change is stored twice in this vocabulary: once as the
 * command a **redo** re-applies, and once as the command an **undo** applies.
 * The two are the same shape on purpose — `apply` has one implementation, so
 * undoing and redoing cannot drift apart, and an inverse is an ordinary
 * mutation that happens to restore rather than a second write path with its
 * own bugs.
 *
 * Each carries its whole before-state. Nothing here is recomputed from the
 * tree at the moment it is applied: a value worked out then would be worked
 * out from a plan that has moved on, which is the entire failure conditional
 * undo exists to prevent.
 */
export type CompensatingCommand =
  | { do: 'patch'; workItemId: string; patch: WorkItemPatch }
  | { do: 'set_estimate'; workItemId: string; roleId: string; days: Days }
  | { do: 'clear_estimate'; workItemId: string; roleId: string }
  /**
   * The days actually spent, as a plain number rather than a trio: an estimate
   * is a guess about a range and an actual is a fact about what happened.
   *
   * `recordedAt` is **not** carried. Re-applying this command stamps the write
   * with the moment it is re-applied, because that column says when the number
   * was typed and an undo is somebody typing it again now. Carrying the original
   * stamp would let a redo write a row that claims to predate the command that
   * wrote it.
   */
  | { do: 'set_actual'; workItemId: string; roleId: string; days: number }
  | { do: 'clear_actual'; workItemId: string; roleId: string }
  /**
   * A figure in a unit that is not days — tokens estimated, tokens spent, hours
   * spent — carrying the `metric` because that is part of the row's identity
   * rather than a property of it. A `set_measure` that dropped it would put the
   * number back under whichever metric happened to be read first.
   *
   * `recordedAt` is **not** carried, for `set_actual`'s reason exactly: an undo
   * is somebody recording the figure again, now.
   */
  | { do: 'set_measure'; workItemId: string; roleId: string; metric: MeasureMetric; value: number }
  | { do: 'clear_measure'; workItemId: string; roleId: string; metric: MeasureMetric }
  /**
   * Where the work has got to, as one of the two states a role may be **stored**
   * in. There is no `set_progress` carrying `not_started`: the way to say that
   * is `clear_progress`, because the absence of a row is how it is spelled in
   * the table and a command that could write it would be a second spelling.
   *
   * `statedAt` is **not** carried, for the reason `set_actual` does not carry
   * `recordedAt`: re-applying this is somebody saying it again, now.
   */
  | { do: 'set_progress'; workItemId: string; roleId: string; state: RoleState }
  | { do: 'clear_progress'; workItemId: string; roleId: string }
  | { do: 'assign'; workItemId: string; roleId: string; personId: string | null }
  | { do: 'add_dependency'; successorId: string; predecessorId: string }
  | { do: 'remove_dependency'; successorId: string; predecessorId: string }
  | { do: 'move'; workItemId: string; parentId: string | null; afterId: string | null }
  | { do: 'set_frozen'; updates: FrozenNumber[] }
  | DeleteSubtree
  | RestoreSubtree;

/**
 * Takes a branch away again: the inverse of a create or a duplicate, and the
 * re-application of a delete.
 *
 * `expectedSubtree` is the guard a revision cannot give. Adding a child under
 * a work item writes a row of its own and moves nothing on the parent, so a
 * created row that has since been built on reads at the revision it was
 * created with. Deleting it would take somebody else's work with it, and this
 * is what refuses instead.
 */
export interface DeleteSubtree {
  do: 'delete_subtree';
  /** The row whose whole subtree must still look the way the command left it. */
  rootId: string;
  /** Every id that was under `rootId`, including it, when the command ran. */
  expectedSubtree: string[];
  /** The ids actually deleted — all of `expectedSubtree` for a cascade, the root alone for a promotion. */
  remove: string[];
  /** Where the children being promoted out of `remove` go, and the respacing around them. */
  reparented: Reparented[];
  /** Estimates handed **up** to the surviving parent, exactly as the original delete wrote them. */
  setEstimates: StoredEstimate[];
  /**
   * Actuals handed **up** to the surviving parent, the same way and at the same
   * moment as {@link DeleteSubtree.setEstimates}.
   *
   * Carried with their `recordedAt` from the rows they were summed out of — the
   * newest of them, since the parent's number is now the whole branch's — so a
   * re-applied delete leaves the same stamp the original left rather than
   * claiming the days were recorded at the moment somebody pressed redo.
   */
  setActuals: StoredActual[];
  /**
   * Statements handed **up** to the surviving parent, at the same moment and by
   * the same rule as {@link DeleteSubtree.setActuals}.
   *
   * The branch's folded reading rather than its rows — a deleted child that is
   * itself a parent holds no rows of its own — and `not_started` is never in
   * here, because that is the absence of a row. Carried with the newest
   * `statedAt` in the branch, since the parent's reading is now the whole
   * branch's.
   */
  setProgress: StoredProgress[];
  /**
   * Figures in every unit that is not days, handed **up** to the surviving
   * parent, at the same moment and by the same rule as
   * {@link DeleteSubtree.setActuals}.
   *
   * The branch's folded totals rather than its rows, per metric, each carrying
   * the newest `recordedAt` in the branch for that metric and role — the
   * parent's figure is now the whole branch's. A metric nobody recorded
   * anywhere in the branch contributes nothing here, because the absence of a
   * row is how "nobody has said" is spelled in every unit.
   */
  setMeasures: StoredMeasure[];
}

/**
 * Puts a branch back: the inverse of a delete, and the re-application of a
 * create or a duplicate.
 *
 * The rows come back with the ids they had. Nothing recreated them — a
 * collision means something else is now using an id this branch owns, and that
 * is refused rather than remapped: a restore that invented fresh ids would
 * leave every journalled reference to the branch, and everybody else's, aimed
 * at rows that are gone.
 */
export interface RestoreSubtree {
  do: 'restore_subtree';
  /**
   * Ancestors first: `parent_id` references a row that has to be there already.
   * New journals carry the whole team set; old journals omit it and restore
   * the singleton projected in `serviceTeamId`.
   */
  rows: (WorkItem & { teamIds?: readonly string[] })[];
  /** Where the root sat among its siblings, which is how the restore finds its slot again. */
  rootPosition: number;
  /** Rows to put back under the restored branch, at the positions they had before. */
  reparented: Reparented[];
  estimates: StoredEstimate[];
  /**
   * The days recorded against the rows being restored, put back with them.
   *
   * Empty for the restore a **create** is the inverse of, except in one case: a
   * leaf that gains its first child hands its figures down, actuals with
   * estimates, so undoing that create has to hand them back up. Empty for a
   * **duplicate**, whose copies were never worked on — see
   * {@link SubtreeCopy.actuals}.
   */
  actuals: StoredActual[];
  /**
   * What the rows being restored said about themselves, put back with them.
   *
   * Empty for the restore a **create** is the inverse of, except in one case: a
   * leaf that gains its first child hands its statements down with its figures,
   * so undoing that create has to hand them back up. Empty for a **duplicate**,
   * whose copies nobody has ever worked on or spoken about.
   */
  progress: StoredProgress[];
  /**
   * The tokens and hours recorded against the rows being restored, put back
   * with them.
   *
   * Empty for the restore a **create** is the inverse of, except in the one
   * case the two figures beside it name: a leaf that gains its first child
   * hands everything it holds down, measures with actuals, so undoing that
   * create has to hand them back up. Empty for a **duplicate**, whose copies
   * nobody has ever spent a token or an hour on — see
   * {@link SubtreeCopy.measures}.
   */
  measures: StoredMeasure[];
  assignments: Assignment[];
  /** Edges with both ends inside the branch: restored with it, in the same write. */
  internalDependencies: StoredDependency[];
  /**
   * Edges with one end outside the branch, restored **best-effort**.
   *
   * They are the one part of a restore that can come back incomplete, and the
   * one part whose other end is deliberately **not** a precondition. The row
   * at the far end may have been deleted, moved under the branch, or wired
   * into a path that would now close a circle, and each of those is judged
   * against the plan as it stands when the restore runs. Refusing the whole
   * restore for any of them would strand the branch for a reason that has
   * nothing to do with it; putting the edge back regardless would hand the
   * project a schedule nobody can compute. So the branch returns without that
   * edge, and the answer says how many and why.
   */
  externalDependencies: StoredDependency[];
  /** Estimates to take off the surviving parent, undoing the hand-up a delete did. */
  removedEstimates: EstimateKey[];
  /** Actuals to take off the surviving parent, for {@link RestoreSubtree.removedEstimates}' reason. */
  removedActuals: ActualKey[];
  /** Statements to take off the surviving parent, for {@link RestoreSubtree.removedEstimates}' reason. */
  removedProgress: ProgressKey[];
  /**
   * Figures to take off the surviving parent, for
   * {@link RestoreSubtree.removedEstimates}' reason, one key per metric.
   *
   * The metric is part of the key because it is part of the row's identity: a
   * pair may hold a token estimate the delete handed up and an hours fact it
   * did not, and taking the pair away wholesale would delete a figure this
   * restore never wrote.
   */
  removedMeasures: MeasureKey[];
}

/** What a journalled command did, in the words an undo says back. */
export interface JournalPayload {
  /** `rename “Strip”` — the sentence, already built, so it never re-derives a number that has moved. */
  label: string;
  /** What a redo re-applies. */
  forward: CompensatingCommand;
}

/** `{workItemId: revision}`, for one moment in one entity's life. */
export type Revisions = Record<string, number>;

/**
 * What an entry checks before it applies, and what lets the entry below it
 * still apply afterwards.
 *
 * `expected` is the condition: every entity the last-applied direction touched,
 * at the revision it left them. Nothing applies unless all of them still read
 * exactly that.
 *
 * `from` is what those entities read **before** that direction ran, and it
 * exists for one reason: an undo is itself a write. Undoing a rename moves the
 * row again, so the entry below — the rename before it — would be checking
 * against a revision that this account's own undo has just walked past, and a
 * second press of the key would refuse for no reason a reader could accept.
 *
 * `from` is what makes the difference between that and a genuine conflict
 * visible. After undoing E, the row holds exactly what the entry below left it
 * holding **if and only if** `E.from` is what that entry recorded as its
 * `expected` — nobody wrote between the two. When it matches, the entry below
 * is re-stamped to the revision the undo produced and stays usable; when
 * somebody else did write in between it does not match, is not re-stamped, and
 * refuses. See `openspec/changes/conditional-undo/design.md`.
 */
export interface Preconditions {
  expected: Revisions;
  from: Revisions;
}

const COMMANDS = [
  'patch',
  'set_estimate',
  'clear_estimate',
  'set_actual',
  'clear_actual',
  'set_measure',
  'clear_measure',
  'set_progress',
  'clear_progress',
  'assign',
  'add_dependency',
  'remove_dependency',
  'move',
  'set_frozen',
  'delete_subtree',
  'restore_subtree',
] as const;

/**
 * A stored command, checked far enough to be dispatched on.
 *
 * **What is checked and what is not.** The discriminator is checked because it
 * is the one thing that can genuinely be wrong: a release that removed a
 * command kind would find rows written by the release before it, and
 * dispatching on a value no branch handles is how a silent no-op reaches a
 * user who asked for their work back. The fields are not checked. They were
 * written by this process from typed values one statement earlier, and a
 * second schema for them would be a second definition of every command — the
 * honest limit is that a hand-edited row fails inside `apply` rather than here.
 *
 * @throws when the value is not an object, or names a command this release has no branch for.
 */
export function readCommand(value: unknown): CompensatingCommand {
  if (typeof value !== 'object' || value === null || !('do' in value)) {
    throw new Error(`a journal entry holds no command: ${JSON.stringify(value)}`);
  }
  // `'do' in value` has already narrowed `value` to an object that has it.
  const named: unknown = value.do;
  if (typeof named !== 'string' || !(COMMANDS as readonly string[]).includes(named)) {
    throw new Error(`a journal entry names a command this release cannot apply: ${String(named)}`);
  }
  // The one cast in this file, and the boundary it crosses is named above: the
  // discriminator has been checked, the fields are this process's own writing.
  return value as CompensatingCommand;
}

/** The `{label, forward}` a journal entry's payload is, checked the same far and no further. */
export function readPayload(value: unknown): JournalPayload {
  if (typeof value !== 'object' || value === null || !('forward' in value) || !('label' in value)) {
    throw new Error(`a journal entry holds no payload: ${JSON.stringify(value)}`);
  }
  const { label, forward }: { label: unknown; forward: unknown } = value;
  if (typeof label !== 'string') throw new Error('a journal entry has no label');
  return { label, forward: readCommand(forward) };
}

/** The two revision maps a journal entry's preconditions are. */
export function readPreconditions(value: unknown): Preconditions {
  if (typeof value !== 'object' || value === null || !('expected' in value) || !('from' in value)) {
    throw new Error(`a journal entry holds no preconditions: ${JSON.stringify(value)}`);
  }
  return { expected: readRevisions(value.expected), from: readRevisions(value.from) };
}

function readRevisions(value: unknown): Revisions {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`a journal entry holds revisions that are not a map: ${JSON.stringify(value)}`);
  }
  const out: Revisions = {};
  for (const [id, revision] of Object.entries(value)) {
    if (typeof revision !== 'number') {
      throw new Error(`a journal entry expects ${id} at a revision that is not a number`);
    }
    out[id] = revision;
  }
  return out;
}

/**
 * Every work item a command will have written to once it has been applied.
 *
 * This is what the **next** set of preconditions is read from, so it has to
 * name everything and may name rows that will not exist afterwards — the ones
 * a `delete_subtree` removes. The caller reads the revisions of whichever of
 * them are still there; an id that is gone is not a precondition anybody can
 * hold.
 */
export function touchedBy(command: CompensatingCommand): string[] {
  switch (command.do) {
    case 'patch':
    case 'set_estimate':
    case 'clear_estimate':
    case 'set_actual':
    case 'clear_actual':
    case 'set_measure':
    case 'clear_measure':
    case 'set_progress':
    case 'clear_progress':
    case 'assign':
      return [command.workItemId];
    case 'add_dependency':
    case 'remove_dependency':
      return [command.successorId, command.predecessorId];
    case 'move':
      return [command.workItemId];
    case 'set_frozen':
      return command.updates.map((each) => each.id);
    case 'delete_subtree':
      return [
        ...command.remove,
        ...command.reparented.map((each) => each.id),
        ...command.setEstimates.map((each) => each.workItemId),
        ...command.setActuals.map((each) => each.workItemId),
        ...command.setProgress.map((each) => each.workItemId),
        ...command.setMeasures.map((each) => each.workItemId),
      ];
    case 'restore_subtree':
      return [
        ...command.rows.map((row) => row.id),
        ...command.reparented.map((each) => each.id),
        ...command.removedEstimates.map((each) => each.workItemId),
        ...command.removedActuals.map((each) => each.workItemId),
        ...command.removedProgress.map((each) => each.workItemId),
        ...command.removedMeasures.map((each) => each.workItemId),
        ...command.externalDependencies.flatMap((edge) => [edge.predecessorId, edge.successorId]),
      ];
  }
}

/** The one work item and role a command was aimed at, either of them absent. */
export interface CommandSubject {
  workItemId: string | null;
  roleId: string | null;
}

/**
 * What a command was aimed at, for the plan's history to be filtered by.
 *
 * Deliberately **not** {@link touchedBy}. That answers "every row whose revision
 * becomes a precondition" and is a set; this answers "the row somebody was
 * looking at when they did this", which is what "how did *this* estimate move"
 * filters on. A dependency touches two work items and is aimed at the successor —
 * the row the request named, and the subject of the label `record` writes. A
 * freeze is aimed at the plan and has no single row, which is what `null` is for:
 * a project's whole history still holds it, and no item's history claims it.
 *
 * A subtree command names its root. The rows beneath it are gone or restored with
 * it, and an event per row would turn one act into forty entries in a reader
 * nobody could use.
 */
export function subjectOf(command: CompensatingCommand): CommandSubject {
  switch (command.do) {
    case 'set_estimate':
    case 'clear_estimate':
    case 'set_actual':
    case 'clear_actual':
    case 'set_measure':
    case 'clear_measure':
    case 'set_progress':
    case 'clear_progress':
    case 'assign':
      return { workItemId: command.workItemId, roleId: command.roleId };
    case 'patch':
    case 'move':
      return { workItemId: command.workItemId, roleId: null };
    case 'add_dependency':
    case 'remove_dependency':
      return { workItemId: command.successorId, roleId: null };
    case 'delete_subtree':
      return { workItemId: command.rootId, roleId: null };
    case 'restore_subtree':
      // Ancestors first, so the first row is the branch's root. An empty `rows`
      // is refused by `applyRestore` before it can be journalled, and would be a
      // restore of nothing.
      return { workItemId: command.rows.at(0)?.id ?? null, roleId: null };
    case 'set_frozen':
      // The whole plan, even when one row's number moved: freezing is a project
      // act and the label says so. Naming `updates[0]` would make a plan-wide
      // event read as one item's.
      return { workItemId: null, roleId: null };
  }
}

/**
 * A work item's name as a sentence can carry it, shortened and quoted.
 *
 * The **name**, never the derived number: a number is recomputed from the
 * whole tree on every read, so “Undid: rename 020” could name a different row
 * by the time it is on screen. An unnamed row says so rather than quoting
 * nothing.
 */
export function quoteName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return 'an unnamed work item';
  return `“${trimmed.length > 40 ? `${trimmed.slice(0, 39)}…` : trimmed}”`;
}
