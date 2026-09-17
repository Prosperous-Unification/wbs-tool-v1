import type { PlanCommandKind } from '@wbs/contracts';

import type {
  Person,
  PersonWithTeams,
  ServiceTeam,
  TeamWithServices,
} from '../ports/directory-store';
import type { Decision, Scope, UnitOfWork } from '../ports/unit-of-work';
import type { Service, Tag, WorkItemType } from '../ports/work-item-store';
import { AnnouncementCollector, type Broadcaster } from './broadcast';
import type { CapacityService } from './capacity.service';
import { applyCommand, bindCommands, CommandContext, CommandRefused } from './command-bindings';
import type {
  DirectoryOutcome,
  DirectoryRefusal,
  RemoveDirectoryOutcome,
} from './directory.service';
import type { DirectoryService } from './directory.service';
import type { DirectoryUsage } from './directory-usage';
import { MOST_COMMANDS_IN_A_BATCH, type PlanCommand } from './plan-command';
import type { PriorityBandService } from './priority-band.service';
import type { WorkItemRefusal } from './work-item.service';
import type { Collected, UndoOutcome, WorkItemService } from './work-item.service';
import { createWorkingPlan } from './working-plan';

/** The four services a command batch can invoke. */
export interface PlanCommandServices {
  workItems: WorkItemService;
  directory: DirectoryService;
  capacity: CapacityService;
  priorityBands: PriorityBandService;
}

/**
 * What one step of an applied batch produced: the id of anything it created,
 * and for a directory create or patch the entry as its list route shows it —
 * the browser's `addTeam`/`renameTag` answer with the row, and a second read
 * for what the batch just wrote would be the round trip this route removes.
 */
export interface AppliedBase {
  index: number;
  ref?: string;
  id?: string;
}
interface CommandEntities {
  createTeam: ServiceTeam;
  // Proof: widening to ServiceTeam made the actual producer type fixture report TS2578.
  patchTeam: TeamWithServices;
  // Proof: widening to ServiceTeam made the missing-person-kind type fixture report TS2578.
  createPerson: Person;
  patchPerson: PersonWithTeams;
  createTag: Tag;
  patchTag: Tag;
  createService: Service;
  patchService: Service;
  createWorkItemType: WorkItemType;
  patchWorkItemType: WorkItemType;
}
type EntityKind = keyof CommandEntities;
type PlainKind = Exclude<PlanCommandKind, EntityKind>;
type MintedKind = 'createWorkItem' | 'duplicateWorkItem' | Extract<EntityKind, `create${string}`>;
// Proof: making minted id optional produced two TS2578 diagnostics in the created-result fixtures.
export type MintedBase = AppliedBase & { id: string };
/** Internal kind identifies the producer's exact entity contract; controllers erase it from the unchanged wire. */
export type AppliedCommand =
  | (AppliedBase & { kind: Exclude<PlainKind, MintedKind>; entity?: never })
  | (MintedBase & { kind: Extract<PlainKind, MintedKind>; entity?: never })
  | {
      [K in EntityKind]: (K extends MintedKind ? MintedBase : AppliedBase) & {
        kind: K;
        entity: CommandEntities[K];
      };
    }[EntityKind];

type PlainReason =
  | Exclude<WorkItemRefusal, 'deadline_before_project_start'>
  | DirectoryRefusal
  | 'calendar_range'
  | 'too_many_commands'
  | 'project_required'
  | 'unknown_ref'
  | 'missing_id'
  | 'duplicate_ref';
export type Refusal =
  | { reason: PlainReason; detail?: never }
  | {
      reason: 'deadline_before_project_start';
      detail: { workItemId: string; projectDayZero: string };
    }
  | { reason: 'taken'; detail: { name: string } }
  | { reason: 'in_use'; detail: { usage: DirectoryUsage } };
/** A runtime refusal always carries its command index and recognized kind. */
export type BatchRefusal = { ok: false; at: number; kind: PlanCommandKind } & Refusal;
export type ServiceRefusal =
  | { ok: false; reason: PlainReason }
  | {
      ok: false;
      reason: 'deadline_before_project_start';
      workItemId?: string;
      projectDayZero?: string;
    }
  | Extract<DirectoryOutcome<never> | RemoveDirectoryOutcome, { ok: false }>;

export type BatchOutcome =
  { ok: true; results: AppliedCommand[]; undoable: boolean; redoable: boolean } | BatchRefusal;

export interface PlanCommandRunnerOptions {
  /**
   * The batch's own service graph, built **per batch** over the admitted scope
   * and broadcaster this runner hands it (D20/D24).
   *
   * A factory rather than the services themselves, and that is the whole of who
   * owns an announcement: every batch gets its own {@link AnnouncementCollector},
   * and the graph built over it publishes into that batch and nowhere else. A
   * route's graph is built over the direct broadcaster and is never this one, so
   * a committed route event cannot be dropped by somebody else's refusal.
   *
   * The scope is the unit of work's for this act. A staged source hands out new
   * stores on every run; retaining an earlier graph would write into discarded
   * state.
   */
  batchServices: (scope: Scope, broadcast: Broadcaster) => PlanCommandServices;
  /**
   * The process graph used after the unit of work settles: reads and broadcasts
   * here observe the committed source and take their own turn.
   */
  publicServices: PlanCommandServices;
  /**
   * What the batch is one of. It takes the source's one turn for the whole act
   * and settles every write together (ADR 0015).
   */
  uow: UnitOfWork;
  /**
   * Where a batch's collected announcements go once it has committed and let go
   * of its turn. The **direct** broadcaster: nothing between the runner and the
   * gateway holds anything back.
   */
  announcements: Broadcaster;
}

/** Commands that can lengthen or reorder the placed plan's calendar horizon. */
const CALENDAR_AFFECTING_KINDS: ReadonlySet<PlanCommandKind> = new Set([
  'patchWorkItem',
  'duplicateWorkItem',
  'setEstimate',
  'setAssignee',
  'addDependency',
  'setCapacity',
]);

/**
 * Applies a {@link Command batch}: every step through the service it belongs
 * to, as one {@link Unit of work} — one {@link Turn} at the source's write
 * coordinator, and every write settled together — then
 * one journal entry and one broadcast — `plan-commands` D2–D4 and ADR 0007.
 *
 * Refs are the batch's {@link CommandContext}: a create's id is remembered
 * under its `ref`, and any `…Ref` field is replaced by that id before the
 * bound service sees the step. A ref nobody minted, or minted twice, refuses
 * the batch at that step.
 *
 * Undo and redo run through here too, for the same reason a batch does: a
 * batch's inverse is many steps, and only the outer transaction can make a
 * step that fails midway take the ones before it back.
 */
export class PlanCommandRunner {
  constructor(private readonly opts: PlanCommandRunnerOptions) {}

  run(projectId: string, actorId: string, commands: readonly PlanCommand[]): Promise<BatchOutcome> {
    return this.execute(projectId, actorId, commands);
  }

  /**
   * A batch with no project: directory commands only, for the directory page
   * and for a model editing the directory on its own. Same turn, same unit of
   * work, and nothing is journalled — the directory has no undo. A plan
   * command in it has no project to land in and refuses the batch as
   * `project_required` at its index.
   */
  runDirectory(actorId: string, commands: readonly PlanCommand[]): Promise<BatchOutcome> {
    return this.execute(null, actorId, commands);
  }

  /**
   * The turn covers the unit of work and nothing after it: the broadcast is a
   * push to gw-01 over the network, and a turn held across it would let one
   * slow gateway stall every write in the process. Proof:
   * `plan-commands.test.ts` › lets go of the write lock before the broadcast
   * leaves — with the announce inside `lock.run` the second batch waited on a
   * publish held open and the test timed out.
   *
   * That rule used to be this method's alone, and three services it calls broke
   * it by publishing from inside `applyAll`. They publish through
   * this batch's own {@link AnnouncementCollector} now, held for the length of
   * the unit of work and drained here — so the rule is one mechanism rather
   * than four conventions.
   *
   * **The hold sits inside `lock.run`, not around it**, and that is not a
   * detail: `execute` runs concurrently for every queued batch and only the lock
   * makes one-at-a-time true. Held around the lock, a second batch opened a hold
   * while the first still waited for it, and the queue is process-wide.
   * Proof: with `hold` moved outside, `lets go of the write lock before the
   * broadcast leaves` and `applies a rename queued behind a refused batch, after
   * it` both failed on `error: a batch is already holding announcements`;
   * watched 2026-09-02. That *symptom* is gone since TASK-256 made the queue
   * per-caller — two concurrent holds now each get their own — but the ordering
   * is unchanged and for a second reason the symptom never named: the hold has
   * to open inside the unit of work's act and close before its decision, so
   * what it collects is exactly the writes that decision is about.
   */
  private async execute(
    projectId: string | null,
    actorId: string,
    commands: readonly PlanCommand[],
  ): Promise<BatchOutcome> {
    // This batch's own collector and its own graph over it. Two batches never
    // share either, and no route's graph is built over this one.
    // Proof: reusing a constructor-owned collector made compose.test.ts receive
    // the same AnnouncementCollector for two batches at its identity assertion.
    const collector = new AnnouncementCollector(this.opts.announcements);
    type Applied = BatchOutcome | Collected<AppliedCommand[]>;
    const done = await this.opts.uow.run<Applied>(async (scope): Promise<Decision<Applied>> => {
      const workingPlan = projectId === null ? undefined : createWorkingPlan(scope, projectId);
      // Proof: building from publicServices let the refused write survive:
      // expected [], received ["rolled back"] (2026-09-09).
      // Proof: caching the first graph made the subsequent batch omit `later`:
      // expected ["kept", "later"], received ["kept"] (2026-09-09).
      try {
        // Proof: retaining the first working graph across SQLite batches made
        // the second undo restore stale 4/5/6 figures instead of an intervening
        // ordinary write's 7/8/9 figures.
        const graph = this.opts.batchServices(
          workingPlan === undefined ? scope : { stores: workingPlan.stores },
          collector,
        );
        // Proof: admitting one extra command returned404 instead of400 in the mounted cap-order case.
        const over = commands.at(MOST_COMMANDS_IN_A_BATCH);
        if (over !== undefined) {
          return {
            // Nothing was written, so there is nothing to undo — but the unit of
            // work opened for this act all the same, and `commit: false` is how
            // it is told to close without keeping anything. The transaction is
            // the unit of work's to open and to close; this method no longer
            // decides *when*, only *whether*.
            commit: false,
            value: {
              ok: false,
              at: MOST_COMMANDS_IN_A_BATCH,
              kind: over.kind,
              reason: 'too_many_commands',
            },
          };
        }
        let applied: Applied;
        const collected = await graph.workItems.collect(() =>
          this.applyAll(graph, projectId, actorId, commands),
        );
        if (projectId !== null) {
          const needsCalendarPreflight = commands.some(({ kind }) =>
            CALENDAR_AFFECTING_KINDS.has(kind),
          );
          const tree = needsCalendarPreflight ? await graph.workItems.tree(projectId) : null;
          if (needsCalendarPreflight && tree === null)
            throw new Error(`Project ${projectId} disappeared inside its command batch`);
          if (tree !== null && !('kind' in tree) && tree.scheduleError === 'calendar_range') {
            const last = commands.at(-1);
            if (last === undefined)
              throw new Error('A calendar-affecting batch completed without a command');
            applied = {
              ok: false,
              at: commands.length - 1,
              kind: last.kind,
              reason: 'calendar_range',
            };
          } else {
            await graph.workItems.recordCollected(projectId, actorId, collected.recordings);
            applied = collected;
          }
        } else {
          applied = collected;
        }
        // A refusal rolls the unit of work back, so whatever this batch collected
        // describes writes that will not be there. Dropped rather than sent —
        // which is one `if`, because the collector is this batch's alone.
        return 'ok' in applied
          ? { commit: false, value: applied }
          : { commit: true, value: applied };
      } catch (cause) {
        if (cause instanceof CommandRefused) {
          return {
            commit: false,
            value: { ok: false, at: cause.at, kind: cause.kind, ...cause.refusal },
          };
        }
        throw cause;
      } finally {
        // Proof: omitting this close let callbacks retained from successful,
        // refused and throwing batches keep reading after settlement.
        workingPlan?.close();
      }
    });
    if ('ok' in done) return done;
    // After the commit and after the turn is let go, which is what the whole
    // collector is for.
    await collector.send();
    if (projectId === null)
      return { ok: true, results: done.result, undoable: false, redoable: false };
    // Through the public graph, because this runs after the collector has been
    // drained and the unit of work has settled. A staged graph may now name
    // discarded stores; its collector will never be drained again.
    const afterCommit = this.opts.publicServices;
    if (done.dirty) await afterCommit.workItems.announceTreeNow(projectId);
    const state = await afterCommit.workItems.undoState(projectId, actorId);
    return { ok: true, results: done.result, ...state };
  }

  undo(projectId: string, actorId: string): Promise<UndoOutcome> {
    return this.walk(projectId, (graph) => graph.workItems.undo(projectId, actorId));
  }

  redo(projectId: string, actorId: string): Promise<UndoOutcome> {
    return this.walk(projectId, (graph) => graph.workItems.redo(projectId, actorId));
  }

  /**
   * One undo or redo as its own unit of work. A refusal rolls everything back —
   * a batch inverse that failed at step three has taken steps one and two back
   * too — and then discards the stale entry again through `afterRollback`,
   * because the service's own discard went with the rollback.
   */
  private async walk(
    projectId: string,
    step: (graph: PlanCommandServices) => Promise<UndoOutcome>,
  ): Promise<UndoOutcome> {
    const collector = new AnnouncementCollector(this.opts.announcements);
    // The step's own broadcast is collected rather than sent, for the reason
    // `execute` gives: the push happens after the turn is let go.
    const walked = await this.opts.uow.run<Collected<UndoOutcome>>(
      async (scope): Promise<Decision<Collected<UndoOutcome>>> => {
        const graph = this.opts.batchServices(scope, collector);
        const { workItems } = graph;
        const collected = await workItems.collect(() => step(graph));
        if (collected.result.ok) return { commit: true, value: collected };
        const entryId = collected.result.entryId;
        return {
          commit: false,
          value: { ...collected, dirty: false },
          // The discard the refusal owes, in the one window it can be made: the
          // service's own went back with the rollback, and a discard issued
          // after `run` returns would be a second batch queueing behind this
          // one (D28).
          //
          afterRollback:
            entryId === undefined
              ? undefined
              : async (repairScope) => {
                  // Proof: discarding through the rolled-back graph made the
                  // memory composition throw `no journal entry id-5` instead
                  // of consuming the committed stale entry (compose.test.ts).
                  await this.opts
                    .batchServices(repairScope, collector)
                    .workItems.discardEntry(entryId);
                },
        };
      },
    );
    await collector.send();
    // The direct broadcaster, for `execute`'s reason: the collector has been
    // drained and will not be again.
    if (walked.dirty) {
      await this.opts.publicServices.workItems.announceTreeNow(projectId);
    }
    return walked.result;
  }

  private async applyAll(
    graph: PlanCommandServices,
    projectId: string | null,
    actorId: string,
    commands: readonly PlanCommand[],
  ): Promise<AppliedCommand[]> {
    const refs = new Map<string, string>();
    const bindings = bindCommands(graph);
    const applied: AppliedCommand[] = [];
    for (const [index, command] of commands.entries()) {
      const context = new CommandContext(actorId, projectId, index, command.kind, refs);
      applied.push(await applyCommand(bindings, command, context));
    }
    return applied;
  }
}
