import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_PRIORITY_BANDS,
  ORDINARY_BAND_RANK,
  type PriorityBand,
  priorityBandRankOf,
} from '@wbs/domain';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, spyOn } from 'bun:test';

import type { Step } from '../repository';
import { ActualRepository } from '../repository/actual';
import { CalendarMarkerRepository } from '../repository/calendar-marker';
import { CapacityRepository } from '../repository/capacity';
import { CommandJournalRepository } from '../repository/command-journal';
import type { Drizzle } from '../repository/db';
import { openDrizzle } from '../repository/db';
import { DependencyRepository } from '../repository/dependency';
import { DirectoryRepository } from '../repository/directory';
import { EstimateRepository } from '../repository/estimate';
import { OPEN, WriteCoordinator } from '../repository/gate';
import { runMigrations } from '../repository/migrate';
import { PlanEventRepository } from '../repository/plan-event';
import { PriorityBandRepository } from '../repository/priority-band';
import { ProjectRepository } from '../repository/project';
import { person, personTeam, service, serviceTeam, tag, workItemType } from '../repository/schema';
import { sqliteUnitOfWork } from '../repository/sqlite-unit-of-work';
import { StepRepository } from '../repository/step';
import { StepMeasureRepository } from '../repository/step-measure';
import { StepProgressRepository } from '../repository/step-progress';
import { UserRepository } from '../repository/user';
import { SubtreeRepository } from '../repository/work-item';
import { WorkItemRepository } from '../repository/work-item';
import { buildStores } from '../services';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import type { Broadcaster } from './broadcast';
import { CalendarMarkerService } from './calendar-marker.service';
import { CapacityService } from './capacity.service';
import { DirectoryService } from './directory.service';
import type { PlanCommand } from './plan-command';
import {
  type AppliedCommand,
  type BatchOutcome,
  type BatchRefusal,
  PlanCommandRunner,
  type PlanCommandRunnerOptions,
} from './plan-commands';
import { PriorityBandService } from './priority-band.service';
import { ProjectService } from './project.service';
import { StepService } from './step.service';
import { WorkItemService, type WorkItemServiceOptions } from './work-item.service';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

let dir: string;
/** The raw handle, for the claims that are about a column rather than a row. */
let db: Drizzle;
let runner: PlanCommandRunner;
let runnerOptions: PlanCommandRunnerOptions;
let serviceOptions: WorkItemServiceOptions;
let workItems: WorkItemService;
let workItemStore: WorkItemRepository;
let projectStore: ProjectRepository;
let estimateStore: EstimateRepository;
let dependencyStore: DependencyRepository;
let directoryStore: DirectoryRepository;
let journalStore: CommandJournalRepository;
let planEvents: PlanEventRepository;
let bandStore: PriorityBandRepository;
/** Where the pinned `workItems` service's announcements go for the batch in hand. */
let batchBroadcast: Broadcaster;
const relayTo = (collector: Broadcaster): WorkItemService => {
  batchBroadcast = collector;
  return workItems;
};
let projectId: string;
let ownerId: string;
let steps: Step[];

const dev = (): string => {
  const found = steps.at(0);
  if (found === undefined) throw new Error('the project was created without its starting steps');
  return found.id;
};
const DAYS = { optimistic: 1, realistic: 2, pessimistic: 3 };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-batch-'));
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  db = openDrizzle(path);
  projectStore = new ProjectRepository(db, OPEN);
  workItemStore = new WorkItemRepository(db, OPEN);
  estimateStore = new EstimateRepository(db, OPEN);
  dependencyStore = new DependencyRepository(db, OPEN);
  directoryStore = new DirectoryRepository(db, OPEN);
  journalStore = new CommandJournalRepository(db, OPEN);
  planEvents = new PlanEventRepository(db, OPEN);
  const capacityStore = new CapacityRepository(db, OPEN);
  bandStore = new PriorityBandRepository(db, OPEN);
  const broadcast = recordingBroadcaster();

  ownerId = crypto.randomUUID();
  // The account stamps itself, which is what a signup does — and `created_by`
  // references `users(id)`, so nothing else could satisfy it for the first row.
  await new UserRepository(db, OPEN).create(
    {
      id: ownerId,
      username: 'owner',
      passwordHash: 'x',
      createdAt: 1,
    },
    { at: 1, by: ownerId },
  );

  serviceOptions = {
    workItems: workItemStore,
    projects: projectStore,
    estimates: estimateStore,
    actuals: new ActualRepository(db, OPEN),
    measures: new StepMeasureRepository(db, OPEN),
    progress: new StepProgressRepository(db, OPEN),
    directory: directoryStore,
    capacity: capacityStore,
    priorityBands: bandStore,
    dependencies: dependencyStore,
    subtrees: new SubtreeRepository(db, OPEN),
    journal: journalStore,
    broadcast,
  };
  // One work-item service for the whole file, so a `spyOn` in a case still
  // reaches the object the runner uses. Its announcements are relayed to
  // whichever collector the runner hands in, which is what the per-batch graph
  // does for real; only the *identity* is pinned here, and pinning it is what
  // makes a spy possible at all.
  workItems = new WorkItemService({
    ...serviceOptions,
    broadcast: {
      publish: (id, event) => batchBroadcast.publish(id, event),
      latestSeq: (id) => batchBroadcast.latestSeq(id),
    },
  });
  batchBroadcast = broadcast;
  runnerOptions = {
    // The batch's graph, built over whichever collector the runner hands in —
    // which is what makes these services' announcements the batch's own.
    batchServices: (collector) => ({
      workItems: relayTo(collector),
      directory: new DirectoryService({ directory: directoryStore, broadcast: collector }),
      capacity: new CapacityService({
        projects: projectStore,
        capacity: capacityStore,
        broadcast: collector,
      }),
      priorityBands: new PriorityBandService({
        projects: projectStore,
        bands: bandStore,
        broadcast: collector,
      }),
      projects: new ProjectService({ projects: projectStore, broadcast: collector }),
      steps: new StepService({
        projects: projectStore,
        steps: new StepRepository(db, OPEN),
        broadcast: collector,
      }),
      calendarMarkers: new CalendarMarkerService({
        projects: projectStore,
        markers: new CalendarMarkerRepository(db, OPEN),
        broadcast: collector,
      }),
    }),
    // The real unit of work over this file's own connection: every case here
    // is about what a batch leaves behind, which is the transaction's answer.
    uow: sqliteUnitOfWork(db, new WriteCoordinator(), buildStores(db, OPEN)),
    announcements: broadcast,
  };
  runner = new PlanCommandRunner(runnerOptions);
  const created = await new ProjectService({
    projects: projectStore,
    broadcast: recordingBroadcaster(),
  }).create('Rewire the shed', ownerId);
  projectId = created.project.id;
  steps = created.steps;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (commands: PlanCommand[]): Promise<BatchOutcome> =>
  runner.run(projectId, ownerId, commands);

function applied(outcome: BatchOutcome): Map<string, string> {
  if (!outcome.ok) throw new Error(`refused at ${String(outcome.at)}: ${outcome.reason}`);
  return new Map(
    outcome.results.flatMap((each) =>
      each.ref !== undefined && each.id !== undefined ? [[each.ref, each.id]] : [],
    ),
  );
}

const names = async (): Promise<string[]> =>
  (await workItemStore.listByProject(projectId)).map((row) => row.name).sort();

const journal = () => journalStore.entriesFor(projectId, ownerId);

const DRAFT: PlanCommand[] = [
  { kind: 'createWorkItem', ref: 'strip', parentId: null, afterId: null, name: 'Strip' },
  { kind: 'createWorkItem', ref: 'sand', parentId: null, afterRef: 'strip', name: 'Sand' },
  { kind: 'createWorkItem', ref: 'paint', parentId: null, afterRef: 'sand', name: 'Paint' },
  { kind: 'setEstimate', workItemRef: 'strip', stepId: 'STEP', days: DAYS },
  { kind: 'setEstimate', workItemRef: 'sand', stepId: 'STEP', days: DAYS },
  { kind: 'addDependency', workItemRef: 'sand', predecessorRef: 'strip' },
];
/** The draft with the project's real Dev step in place of the placeholder. */
const draft = (): PlanCommand[] =>
  DRAFT.map((command) =>
    'stepId' in command && command.stepId === 'STEP' ? { ...command, stepId: dev() } : command,
  );

describe('a command batch', () => {
  it('drafts a plan in one request, and answers the id each ref became', async () => {
    const refs = applied(await run(draft()));
    expect([...refs.keys()].sort()).toEqual(['paint', 'sand', 'strip']);
    expect(await names()).toEqual(['Paint', 'Sand', 'Strip']);
    const sand = refs.get('sand');
    const strip = refs.get('strip');
    // An absent ref is a fault rather than a value to compare: left as
    // `string | undefined` the assertion would happily match a batch that
    // answered nothing at all for one of them.
    if (sand === undefined || strip === undefined) {
      throw new Error('the batch answered no id for a ref it applied');
    }
    expect(
      (await estimateStore.listByProject(projectId)).map((each) => each.workItemId).sort(),
    ).toEqual([sand, strip].sort());
    expect(await dependencyStore.listByProject(projectId)).toHaveLength(1);
  });

  it('leaves the first two unwritten when the third is refused', async () => {
    // All or none, on real SQLite: the two creates before the refused estimate
    // are rolled back with it.
    // Proof: the runner's `rollback` replaced by `commit`, this failed on
    // `expected [ 'Sand', 'Strip' ] to equal []`. Watched, 2026-08-29.
    const outcome = await run([
      ...draft().slice(0, 2),
      { kind: 'setEstimate', workItemRef: 'strip', stepId: 'no-such-step', days: DAYS },
    ]);
    expect(outcome).toEqual({ ok: false, at: 2, kind: 'setEstimate', reason: 'unknown_step' });
    expect(await names()).toEqual([]);
    expect(await journal()).toHaveLength(0);
  });

  it('is one journal entry, one plan event, and one undo puts all of it back', async () => {
    // Proof: the collector bypassed so `record` wrote per step, this failed on
    // `expected 6 to be 1`. Watched, 2026-08-29.
    applied(await run(draft()));
    expect(await journal()).toHaveLength(1);
    expect(await planEvents.listFor(projectId, {})).toHaveLength(1);

    const undone = await runner.undo(projectId, ownerId);
    if (!undone.ok) throw new Error(`undo refused: ${undone.reason} ${undone.detail ?? ''}`);
    expect(await names()).toEqual([]);
    expect(await estimateStore.listByProject(projectId)).toHaveLength(0);
    expect(await dependencyStore.listByProject(projectId)).toHaveLength(0);

    const redone = await runner.redo(projectId, ownerId);
    if (!redone.ok) throw new Error(`redo refused: ${redone.reason} ${redone.detail ?? ''}`);
    expect(await names()).toEqual(['Paint', 'Sand', 'Strip']);
  });

  it('takes back the steps an undo already applied when a later step cannot', async () => {
    // A journal entry as the runner writes one, whose inverse renames X and
    // then sets an estimate for a step nobody has: the preconditions hold, so
    // the first step is applied before the second is refused — and the rename
    // must be gone again, or an undo has left a plan nobody asked for. The
    // entry is appended by hand because every natural way of making a later
    // step fail also moves a revision, and then the staleness check refuses
    // before any step runs (watched: `“A” has changed since then`).
    // Proof: `walk` made to commit on a refusal, this failed on `expected
    // 'Undone' to be 'X'`; the per-step refusal dropped from `apply`'s batch
    // arm, on `expected true to be false` — the undo reported done. Watched,
    // 2026-08-29.
    const refs = applied(
      await run([{ kind: 'createWorkItem', ref: 'x', parentId: null, afterId: null, name: 'X' }]),
    );
    const x = refs.get('x');
    if (x === undefined) throw new Error('no x');
    const row = await workItemStore.findById(x);
    if (row === null) throw new Error('x is not stored');
    const rename = { do: 'patch' as const, workItemId: x, patch: { name: 'Undone' } };
    const impossible = {
      do: 'set_estimate' as const,
      workItemId: x,
      stepId: 'no-such-step',
      days: DAYS,
    };
    const at = Date.now();
    await journalStore.append(
      {
        id: crypto.randomUUID(),
        projectId,
        userId: ownerId,
        kind: 'batch',
        payload: { label: '2 changes', forward: { do: 'batch', steps: [impossible, rename] } },
        inverse: { do: 'batch', steps: [rename, impossible] },
        preconditions: { expected: { [x]: row.revision }, from: { [x]: row.revision } },
        createdAt: at,
      },
      {
        id: crypto.randomUUID(),
        projectId,
        userId: ownerId,
        kind: 'batch',
        label: '2 changes',
        workItemId: x,
        stepId: null,
        before: { do: 'batch', steps: [rename, impossible] },
        after: { do: 'batch', steps: [impossible, rename] },
        createdAt: at,
      },
    );

    const undone = await runner.undo(projectId, ownerId);
    expect(undone.ok).toBe(false);
    if (undone.ok) throw new Error('an undo naming a missing step was accepted');
    expect(undone.reason).toBe('stale_undo');
    expect(undone.detail).toBe('that step is no longer in this project.');
    expect((await workItemStore.findById(x))?.name).toBe('X');
    // And the entry is gone for good, discarded outside the rolled-back
    // transaction: only the create is left to undo.
    expect(await journal()).toHaveLength(1);
  });

  it('records a batch of one as that command, not as a batch', async () => {
    const refs = applied(await run(draft()));
    const strip = refs.get('strip');
    if (strip === undefined) throw new Error('no strip');
    applied(await run([{ kind: 'patchWorkItem', workItemId: strip, patch: { name: 'Strip it' } }]));
    const [, rename] = await journal();
    expect(rename.kind).toBe('patch');
    expect(rename.payload).toMatchObject({ label: 'rename “Strip it”' });
  });

  it('records nothing for a batch that changed nothing', async () => {
    const refs = applied(await run(draft()));
    const paint = refs.get('paint');
    if (paint === undefined) throw new Error('no paint');
    applied(await run([{ kind: 'clearEstimate', workItemId: paint, stepId: dev() }]));
    expect(await journal()).toHaveLength(1);
  });

  it('refuses a ref nobody minted, and a ref minted twice, before applying anything', async () => {
    // Proof: ref substitution removed, the first case failed on `expected
    // { ok: false, at: 0, kind: 'createWorkItem', reason: 'unknown_ref' } …` —
    // the create went through with the literal word as its parent id and was
    // refused as `not_found` instead. Watched, 2026-08-29.
    expect(
      await run([{ kind: 'createWorkItem', parentRef: 'nope', afterId: null, name: 'Orphan' }]),
    ).toEqual({ ok: false, at: 0, kind: 'createWorkItem', reason: 'unknown_ref' });
    expect(
      await run([
        { kind: 'createWorkItem', ref: 'a', parentId: null, afterId: null, name: 'A' },
        { kind: 'createWorkItem', ref: 'a', parentId: null, afterId: null, name: 'B' },
      ]),
    ).toEqual({ ok: false, at: 1, kind: 'createWorkItem', reason: 'duplicate_ref' });
    expect(await names()).toEqual([]);
  });

  it('applies directory commands inside the batch, and undo leaves them in place', async () => {
    const refs = applied(
      await run([
        { kind: 'createService', ref: 'checkout', name: 'Checkout' },
        { kind: 'createWorkItem', ref: 'w', parentId: null, afterId: null, name: 'Pay' },
        { kind: 'patchWorkItem', workItemRef: 'w', patch: { serviceRefs: ['checkout'] } },
      ]),
    );
    expect(refs.has('checkout')).toBe(true);
    const undone = await runner.undo(projectId, ownerId);
    if (!undone.ok) throw new Error(`undo refused: ${undone.reason}`);
    expect(await names()).toEqual([]);
    expect((await directoryStore.listServices()).map((each) => each.name)).toEqual(['Checkout']);
  });

  it('answers a directory create with the entry, and a taken name with the survivor', async () => {
    // The browser's `addTag` answers with the row and its `renameTag` models
    // `taken` by the surviving name; both ride on the batch result rather than
    // costing a second read.
    const outcome = await run([{ kind: 'createTag', ref: 't', name: 'regulatory' }]);
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.results[0]?.entity).toMatchObject({ name: 'regulatory' });
    const tagId = outcome.results[0]?.id;
    if (tagId === undefined) throw new Error('no tag id');
    applied(await run([{ kind: 'createTag', name: 'legal' }]));
    expect(await run([{ kind: 'patchTag', tagId, name: 'legal' }])).toEqual({
      ok: false,
      at: 0,
      kind: 'patchTag',
      reason: 'taken',
      detail: { name: 'legal' },
    });
  });

  it('applies a directory-only batch with no project, and refuses a plan command in it', async () => {
    // The directory page has no project; its writes go through `runDirectory`,
    // which holds the same lock and transaction and records nothing. A plan
    // command has no project to land in there and is refused by index.
    const outcome = await runner.runDirectory(ownerId, [
      { kind: 'createTeam', ref: 'platform', name: 'Platform' },
      { kind: 'createPerson', ref: 'kat', name: 'Kat', teamRefs: ['platform'] },
    ]);
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.results.map((each) => each.ref)).toEqual(['platform', 'kat']);
    expect((await directoryStore.listTeams()).map((each) => each.name)).toEqual(['Platform']);
    expect(await journal()).toHaveLength(0);

    expect(
      await runner.runDirectory(ownerId, [
        { kind: 'createTag', name: 'x' },
        { kind: 'createWorkItem', name: 'Orphan' },
      ]),
    ).toEqual({ ok: false, at: 1, kind: 'createWorkItem', reason: 'project_required' });
    // All or none here too: the tag went with the refusal.
    expect(await directoryStore.listTags()).toHaveLength(0);
  });

  // Dany's item 6, and the narrow case of the audit columns: creating a tag, a
  // work item type, a service, a team or a person must record **who** created
  // it. The directory is where that is load-bearing rather than nice — a
  // directory entity is created outside the plan's own history, so
  // `command_journal` and `plan_event` hold nothing about it and the row's
  // `created_by` is the only place the answer exists.
  //
  // Through `runDirectory` rather than against the repository, because the actor
  // is resolved at the controller and threaded down: a repository-level test
  // would prove the column can hold a value and not that the acting account
  // reaches it.
  //
  // Proof: `DirectoryService.addTag` changed to stamp `this.stampFor('system')`
  // instead of the actor — watched failing on `SQLiteError: FOREIGN KEY
  // constraint failed`, which is a blunter refusal than the assertion below and
  // worth knowing about: `created_by` references `users(id)`, so a row cannot be
  // attributed to something that is not an account at all. A fault that named a
  // *different real* account would reach the assertion instead. 2026-09-01.
  it('records the creator of every directory entity a batch makes', async () => {
    const outcome = await runner.runDirectory(ownerId, [
      { kind: 'createTeam', ref: 'platform', name: 'Platform' },
      { kind: 'createTag', name: 'wiring' },
      { kind: 'createService', name: 'billing' },
      { kind: 'createWorkItemType', name: 'spike' },
      { kind: 'createPerson', ref: 'kat', name: 'Kat', teamRefs: ['platform'] },
    ]);
    if (!outcome.ok) throw new Error(outcome.reason);

    const authorOf = async (
      rows: Promise<{ createdBy: string | null }[]>,
    ): Promise<string | null> => {
      const found = (await rows).at(0);
      if (found === undefined) throw new Error('the batch wrote no row to read an author off');
      return found.createdBy;
    };

    expect(await authorOf(db.select().from(serviceTeam))).toBe(ownerId);
    expect(await authorOf(db.select().from(tag))).toBe(ownerId);
    expect(await authorOf(db.select().from(service))).toBe(ownerId);
    expect(await authorOf(db.select().from(workItemType))).toBe(ownerId);
    expect(await authorOf(db.select().from(person))).toBe(ownerId);
    // The membership the person arrived with is its own row, and it was created
    // by the same act.
    expect(await authorOf(db.select().from(personTeam))).toBe(ownerId);
  });

  it('lets go of the write lock before the broadcast leaves', async () => {
    // The lock is for the one connection; a push to gw-01 is a network call,
    // and holding the lock across it would let one slow gateway stall every
    // write in the process. Batch A's publish is held open here; batch B must
    // still apply while it is pending.
    // Proof: with `announceTreeNow` inside `lock.run` (the shape this shipped in
    // until CI's `pixels` job stalled on a first create), batch B never got the
    // lock and this test timed out at 5000ms. Watched, 2026-08-29.
    let releaseA: () => void = () => undefined;
    const held = new Promise<void>((resume) => {
      releaseA = resume;
    });
    // Two runners over one lock and one set of stores, rather than one runner
    // and "whichever publish happens to be first". The held batch is the one
    // driven through `slowRunner`, by construction — counting pushes made this
    // depend on the number of microtask turns before each announce, and a change
    // that added one `await` between the lock and the broadcast silently swapped
    // which batch was held while proving nothing about the lock.
    const slow: Broadcaster = {
      publish: () => held,
      latestSeq: () => Promise.resolve(0),
    };
    // The slow publisher replaces the batch graph's work-item service, so the
    // held batch is the one driven through `slowRunner` by construction.
    const slowRunner = new PlanCommandRunner({
      ...runnerOptions,
      batchServices: (collector) => ({
        ...runnerOptions.batchServices(collector),
        workItems: new WorkItemService({ ...serviceOptions, broadcast: slow }),
      }),
    });
    const fastRunner = new PlanCommandRunner(runnerOptions);

    const batchA = { state: 'pending' as 'pending' | 'applied' };
    const first = slowRunner
      .run(projectId, ownerId, [
        { kind: 'createWorkItem', parentId: null, afterId: null, name: 'A' },
      ])
      .then(() => {
        batchA.state = 'applied';
      });
    const second = await fastRunner.run(projectId, ownerId, [
      { kind: 'createWorkItem', parentId: null, afterId: null, name: 'B' },
    ]);
    expect(second.ok).toBe(true);
    expect(batchA.state).toBe('pending');
    expect(await names()).toEqual(['A', 'B']);
    releaseA();
    await first;
    expect(batchA.state).toBe('applied');
  });

  it('holds a directory command\u2019s announcement until the lock is let go', async () => {
    // The case the rule was stated for and never covered. `execute` keeps its
    // own broadcast outside `lock.run`; `DirectoryService.announce`,
    // `CapacityService.set` and `PriorityBandService.set` published from inside
    // `applyAll`, which is inside both the lock and the outer transaction. A tag
    // rename across forty projects made forty gateway pushes with the write lock
    // held, and `PushClient` retries a failing one for about a minute.
    //
    // Held by construction rather than by call order, for the reason the case
    // above gives: the runner that publishes slowly is the one driven here.
    //
    // Proof: with `DirectoryService`'s `broadcast` given the raw broadcaster
    // instead of the batch's own collector — the shape this shipped in —
    // watched failing on `this test timed out after 5000ms`, batch B never
    // reaching the lock (2026-09-02, and again on the collector 2026-09-08).
    let releaseTag: () => void = () => undefined;
    const held = new Promise<void>((resume) => {
      releaseTag = resume;
    });
    const slowPushes: Broadcaster = {
      publish: () => held,
      latestSeq: () => Promise.resolve(0),
    };
    const tagRunner = new PlanCommandRunner({
      ...runnerOptions,
      // The batch's own graph over its collector, as always; what is slow is
      // where the collector drains **to**, which is after the turn is let go.
      announcements: slowPushes,
    });

    // The tag has to be **on** something for its rename to touch a project:
    // `DirectoryService.announce` publishes one event per project the write
    // touched, and a tag nobody uses touches none. A rename of an unused tag
    // queues nothing and would pass this whatever the runner did with the lock.
    const seeded = await run([
      { kind: 'createWorkItem', ref: 'w', parentId: null, afterId: null, name: 'Strip' },
      { kind: 'createTag', ref: 't', name: 'urgent' },
      { kind: 'patchWorkItem', workItemRef: 'w', patch: { tagRefs: ['t'] } },
    ]);
    expect(seeded.ok).toBe(true);
    const tagged = await directoryStore.listTags();
    const tagId = tagged.at(0)?.id;
    expect(tagId).toBeDefined();

    const rename = { state: 'pending' as 'pending' | 'applied' };
    const first = tagRunner
      .runDirectory(ownerId, [{ kind: 'patchTag', tagId: tagId ?? '', name: 'critical' }])
      .then(() => {
        rename.state = 'applied';
      });

    // The plan batch has to get through while that directory push is held open.
    const second = await run([
      { kind: 'createWorkItem', parentId: null, afterId: null, name: 'A' },
    ]);

    expect(second.ok).toBe(true);
    expect(rename.state).toBe('pending');
    expect(await names()).toEqual(['A', 'Strip']);
    releaseTag();
    await first;
    expect(rename.state).toBe('applied');
  });

  it('refuses two hundred and one commands before applying any', async () => {
    const many: PlanCommand[] = Array.from({ length: 201 }, (_, n) => ({
      kind: 'createWorkItem',
      parentId: null,
      afterId: null,
      name: `Row ${String(n)}`,
    }));
    expect(await run(many)).toEqual({
      ok: false,
      at: 200,
      kind: 'createWorkItem',
      reason: 'too_many_commands',
    });
    expect(await names()).toEqual([]);
  });

  it('applies a rename queued behind a refused batch, after it', async () => {
    // The write lock on one connection: without it the rename's writes land
    // inside the refused batch's open transaction and vanish with its rollback.
    // Proof: `lock.run` bypassed in the runner, this failed on `expected [] to
    // equal [ 'Strip it' ]`. Watched, 2026-08-29.
    const refs = applied(await run(draft().slice(0, 1)));
    const strip = refs.get('strip');
    if (strip === undefined) throw new Error('no strip');
    const refused = run([
      { kind: 'createWorkItem', ref: 'x', parentId: null, afterId: null, name: 'Doomed' },
      { kind: 'setEstimate', workItemRef: 'x', stepId: 'no-such-step', days: DAYS },
    ]);
    const renamed = run([
      { kind: 'patchWorkItem', workItemId: strip, patch: { name: 'Strip it' } },
    ]);
    expect((await refused).ok).toBe(false);
    expect((await renamed).ok).toBe(true);
    expect(await names()).toEqual(['Strip it']);
  });
});

/**
 * What a created work item's priority is, and where the number comes from.
 *
 * It comes from **this project's ladder, at rank 2** — not from the constant 50
 * and not from the band that happens to be called `Medium`.
 * `openspec/changes/priority-default-medium/design.md` D1.
 */
describe('the priority a create writes', () => {
  const priorityOf = async (id: string | undefined): Promise<number | null> => {
    if (id === undefined) throw new Error('the create minted no id');
    const row = await workItemStore.findById(id);
    if (row === null) throw new Error('the created work item is not stored');
    return row.priority;
  };

  /** A ladder whose middle rung writes 200 — a number the default ladder calls `Critical`. */
  const RECUT: PriorityBand[] = [
    { startsAt: 1, label: 'Critical', defaultValue: 10 },
    { startsAt: 101, label: 'High', defaultValue: 150 },
    { startsAt: 181, label: 'Medium', defaultValue: 200 },
    { startsAt: 301, label: 'Low', defaultValue: 350 },
    { startsAt: 401, label: 'Lowest', defaultValue: 450 },
  ];

  const add = (ref: string, priority?: number | null): PlanCommand => ({
    kind: 'createWorkItem',
    ref,
    parentId: null,
    afterId: null,
    name: 'Rewire',
    ...(priority === undefined ? {} : { priority }),
  });

  it('a new work item is ordinary by default', async () => {
    const refs = applied(await run([add('w')]));
    expect(await priorityOf(refs.get('w'))).toBe(50);
    // And 50 is the *third rung* of this project's ladder rather than a number
    // that happens to be 50: the rank is the contract, the figure is what this
    // ladder cuts it at.
    expect(priorityBandRankOf(await bandStore.listFor(projectId), 50)).toBe(ORDINARY_BAND_RANK);
  });

  it('a re-cut ladder moves the default', async () => {
    // Proof: `bands.at(ORDINARY_BAND_RANK).defaultValue` replaced by the
    // constant `50` in `WorkItemService.ordinaryPriorityOf`, and this failed on
    // `Expected: 200 / Received: 50` — the row stamped into this ladder's
    // *Critical* band, which starts at 1. Watched 2026-08-29.
    const refs = applied(await run([{ kind: 'setPriorityBands', bands: RECUT }, add('w')]));
    expect(await priorityOf(refs.get('w'))).toBe(200);
  });

  it('a renamed middle band still supplies the default', async () => {
    // Proof: the lookup changed to `bands.find((band) => band.label === 'Medium')`,
    // and this failed on `project … has a priority ladder of 5 bands, so it has
    // no rank 2 rung to create work items at` — the rung is still there and only
    // the word has moved, which is exactly the fault. Watched 2026-08-29.
    const renamed = DEFAULT_PRIORITY_BANDS.map((band, rank) =>
      rank === ORDINARY_BAND_RANK ? { ...band, label: 'Normal' } : { ...band },
    );
    const refs = applied(await run([{ kind: 'setPriorityBands', bands: renamed }, add('w')]));
    expect(await priorityOf(refs.get('w'))).toBe(50);
  });

  it('an explicit priority is written as given', async () => {
    const refs = applied(await run([add('w', 7)]));
    expect(await priorityOf(refs.get('w'))).toBe(7);
  });

  it('an explicit null creates an unprioritised item', async () => {
    // Absent and null are different answers, and this is the case that says so.
    // Proof: the service's `input.priority === undefined ? … : input.priority`
    // written as `input.priority ?? …` — null collapsed to absent — and this
    // failed on `expect(received).toBeNull() / Received: 50`. Watched 2026-08-29.
    const refs = applied(await run([add('w', null)]));
    expect(await priorityOf(refs.get('w'))).toBeNull();
  });

  it('the default priority comes from the project being written to', async () => {
    // Two plans on differently-cut ladders, written through one runner. A ladder
    // read once and kept would give the second plan the first plan's number.
    // Proof: the read hoisted out of the create — `ordinaryPriorityOf` memoised
    // on the service, ignoring its `projectId` after the first call — and this
    // failed on `Expected: 50 / Received: 200`. Watched 2026-08-29.
    const recut = applied(await run([{ kind: 'setPriorityBands', bands: RECUT }, add('w')]));
    const other = await new ProjectService({
      projects: projectStore,
      broadcast: recordingBroadcaster(),
    }).create('Tile it', ownerId);
    const plain = applied(
      await runner.run(other.project.id, ownerId, [
        { kind: 'createWorkItem', ref: 'w', parentId: null, afterId: null, name: 'Grout' },
      ]),
    );
    expect(await priorityOf(recut.get('w'))).toBe(200);
    expect(await priorityOf(plain.get('w'))).toBe(50);
  });
});

it('retains producer kinds and create-versus-patch entity requirements internally', async () => {
  const outcome = await runner.runDirectory(ownerId, [
    { kind: 'createTeam', ref: 'team', name: 'Build' },
    { kind: 'patchTeam', teamRef: 'team', patch: { name: 'Ship' } },
    { kind: 'createPerson', ref: 'person', name: 'Ada' },
    { kind: 'patchPerson', personRef: 'person', patch: { teamIds: [] } },
  ]);
  if (!outcome.ok) throw new Error(outcome.reason);
  expect(outcome.results.map((entry) => entry.kind)).toEqual([
    'createTeam',
    'patchTeam',
    'createPerson',
    'patchPerson',
  ]);
  expect(outcome.results[1]?.entity).toHaveProperty('serviceIds', []);
  expect(outcome.results[2]?.entity).toHaveProperty('kind', 'person');
  expect(outcome.results[3]?.entity).toHaveProperty('teamIds', []);
});

it('throws on malformed trusted deadline detail before creating a modeled batch refusal', async () => {
  const patch = spyOn(workItems, 'patch');
  try {
    for (const missing of [
      { ok: false, reason: 'deadline_before_project_start', workItemId: 'w' },
      { ok: false, reason: 'deadline_before_project_start', projectDayZero: '2026-09-07' },
    ]) {
      patch.mockResolvedValueOnce(missing as never);
      await runner
        .run(projectId, ownerId, [{ kind: 'patchWorkItem', workItemId: 'w', patch: {} }])
        .then(
          () => {
            throw new Error('Malformed deadline refusal resolved');
          },
          (cause: unknown) => {
            expect(cause).toEqual(
              new Error('Deadline refusal requires work item and project day zero'),
            );
          },
        );
    }
  } finally {
    patch.mockRestore();
  }
});

export function appliedProducerTypes() {
  const missingMintedId = { index: 0, kind: 'createWorkItem' as const };
  const missingDirectoryId = {
    index: 0,
    kind: 'createTeam' as const,
    entity: { id: 't', name: 'Team' },
  };
  const missingServices = {
    index: 0,
    kind: 'patchTeam' as const,
    entity: { id: 't', name: 'Team' },
  };
  const missingPersonKind = {
    index: 0,
    kind: 'createPerson' as const,
    id: 'p',
    entity: { id: 'p', name: 'Person' },
  };
  const missingDayZero = {
    ok: false as const,
    reason: 'deadline_before_project_start' as const,
    at: 0,
    kind: 'patchWorkItem' as const,
    detail: { workItemId: 'w' },
  };
  // @ts-expect-error Every created result preserves its minted top-level id.
  expectTypeOf<AppliedCommand>(missingMintedId);
  // @ts-expect-error A directory entity id cannot replace the minted top-level id.
  expectTypeOf<AppliedCommand>(missingDirectoryId);
  // @ts-expect-error Patch teams require their membership field.
  expectTypeOf<AppliedCommand>(missingServices);
  // @ts-expect-error Create-person output carries its known person kind.
  expectTypeOf<AppliedCommand>(missingPersonKind);
  // @ts-expect-error Deadline output requires both correlated detail fields.
  expectTypeOf<BatchRefusal>(missingDayZero);
}
