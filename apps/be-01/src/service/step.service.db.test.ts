import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { systemTimers } from '@wbs/runtime-portable';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type {
  DirectoryStore,
  EstimateStore,
  Step,
  StepStore,
  WorkItem,
  WriteStamp,
} from '../repository';
import { ActualRepository } from '../repository/actual';
import { CommandJournalRepository } from '../repository/command-journal';
import { openDrizzle } from '../repository/db';
import { DependencyRepository } from '../repository/dependency';
import { DirectoryRepository } from '../repository/directory';
import { EstimateRepository } from '../repository/estimate';
import { DrizzleEventLogRepo } from '../repository/event-log';
import { runMigrations } from '../repository/migrate';
import { ProjectRepository } from '../repository/project';
import { StepRepository } from '../repository/step';
import { StepMeasureRepository } from '../repository/step-measure';
import { StepProgressRepository } from '../repository/step-progress';
import { UserRepository } from '../repository/user';
import { SubtreeRepository, WorkItemRepository } from '../repository/work-item';
import { type RecordingBroadcaster, recordingBroadcaster } from '../testing/broadcast-fixture';
import { inMemoryCapacity } from '../testing/capacity-fixture';
import { directoryWith, personAdded } from '../testing/directory-fixture';
import { inMemoryPriorityBands } from '../testing/priority-band-fixture';
import { workItemRow } from '../testing/work-item-fixture';
import type { Broadcaster } from './broadcast';
import { GatewayBroadcaster } from './gateway-broadcaster';
import { ProjectService } from './project.service';
import { PushClient } from './push-client';
import { ReplayBuffer } from './replay-buffer';
import { ReplayOrchestrator } from './replay-orchestrator';
import { StepService } from './step.service';
import { WorkItemService } from './work-item.service';
import { WriteLock } from './write-lock';

/**
 * The step service, against real SQLite.
 *
 * The refusals it answers are all decided by rows — a name the index refuses,
 * an estimate that would be deleted, an assignment whose absence would promote
 * somebody — so the stores under it are the real ones. An in-memory step store
 * would be a second implementation of the rules being asserted.
 */
const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

let dir: string;
let db: ReturnType<typeof openDrizzle>;
let steps: StepService;
let stepStore: StepRepository;
let projectStore: ProjectRepository;
let estimates: EstimateRepository;
let actuals: ActualRepository;
let measures: StepMeasureRepository;
let progressStore: StepProgressRepository;
let directory: DirectoryRepository;
let broadcast: RecordingBroadcaster;
let projectId: string;
let ownerId: string;
let strangerId: string;
let devId: string;
let qaId: string;

const DAYS = { optimistic: 1, realistic: 2, pessimistic: 3 };

const newItem = (id: string, position: number, name: string): WorkItem =>
  workItemRow({
    id,
    projectId,
    position,
    name,
  });

/**
 * The stamp the writes this file makes by hand carry. The account is the owner
 * because `created_by` has an enforced foreign key to `users`, so a stamp naming
 * nobody would answer with the key rather than the behaviour being asserted.
 */
const wrote = (): WriteStamp => ({ at: 1, by: ownerId });

const stepNamed = async (name: string): Promise<Step> => {
  const found = (await stepStore.listByProject(projectId)).find((each) => each.name === name);
  if (found === undefined) throw new Error(`no step called ${name}`);
  return found;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-step-service-'));
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  db = openDrizzle(path);

  projectStore = new ProjectRepository(db);
  stepStore = new StepRepository(db);
  estimates = new EstimateRepository(db);
  actuals = new ActualRepository(db);
  measures = new StepMeasureRepository(db);
  progressStore = new StepProgressRepository(db);
  directory = new DirectoryRepository(db);
  broadcast = recordingBroadcaster();
  steps = new StepService({ projects: projectStore, steps: stepStore, broadcast });

  const users = new UserRepository(db);
  ownerId = crypto.randomUUID();
  strangerId = crypto.randomUUID();
  await users.create(
    { id: ownerId, username: 'owner', passwordHash: 'x', createdAt: 1 },
    { at: 1, by: ownerId },
  );
  await users.create(
    { id: strangerId, username: 'stranger', passwordHash: 'x', createdAt: 2 },
    { at: 2, by: strangerId },
  );

  const created = await new ProjectService({
    projects: projectStore,
    broadcast: recordingBroadcaster(),
  }).create('Shed', ownerId);
  projectId = created.project.id;
  devId = (await stepNamed('Dev')).id;
  qaId = (await stepNamed('QA')).id;

  const workItems = new WorkItemRepository(db);
  await workItems.insert(newItem('strip', 10, 'Strip'), [], wrote());
  await workItems.insert(newItem('sand', 20, 'Sand'), [], wrote());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('StepService.add', () => {
  it('adds a step and announces it', async () => {
    const outcome = await steps.add(projectId, ownerId, 'Design');

    if (!outcome.ok) throw new Error(`add refused: ${outcome.reason}`);
    expect(outcome.value.name).toBe('Design');
    expect(outcome.value.projectId).toBe(projectId);
    // The very row that was written, not a shape that resembles it: the event
    // carrying a different id from the answer is the failure worth catching.
    expect(broadcast.published).toEqual([
      { projectId, event: { type: 'step_added', step: outcome.value } },
    ]);
  });

  it('trims the name, and refuses one that is only spaces', async () => {
    const trimmed = await steps.add(projectId, ownerId, '  Design  ');
    if (!trimmed.ok) throw new Error(`add refused: ${trimmed.reason}`);
    expect(trimmed.value.name).toBe('Design');
    expect(await steps.add(projectId, ownerId, '   ')).toEqual({
      ok: false,
      reason: 'name_required',
    });
    // The refused one announced nothing: there is nothing for anybody to reread.
    expect(broadcast.published).toHaveLength(1);
  });

  it('refuses a name the project already holds', async () => {
    expect(await steps.add(projectId, ownerId, 'QA')).toEqual({ ok: false, reason: 'taken' });
    expect(broadcast.published).toEqual([]);
  });

  it('refuses a project that is not there, and one the caller may not write to', async () => {
    expect(await steps.add(crypto.randomUUID(), ownerId, 'Design')).toEqual({
      ok: false,
      reason: 'not_found',
    });

    await projectStore.update(projectId, { restricted: true }, wrote());
    expect(await steps.add(projectId, strangerId, 'Design')).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    // The owner of the restricted project still may.
    expect((await steps.add(projectId, ownerId, 'Design')).ok).toBe(true);
  });
});

describe('StepService.rename', () => {
  it('renames a step and announces it', async () => {
    const outcome = await steps.rename(projectId, qaId, ownerId, 'Review');

    expect(outcome).toEqual({
      ok: true,
      value: { id: qaId, projectId, name: 'Review', position: 20 },
    });
    expect(broadcast.published).toEqual([
      {
        projectId,
        event: {
          type: 'step_renamed',
          step: { id: qaId, projectId, name: 'Review', position: 20 },
        },
      },
    ]);
  });

  it('refuses a name the project already holds', async () => {
    expect(await steps.rename(projectId, qaId, ownerId, 'Dev')).toEqual({
      ok: false,
      reason: 'taken',
    });
  });

  it('refuses a step that belongs to another project', async () => {
    const other = await new ProjectService({
      projects: projectStore,
      broadcast: recordingBroadcaster(),
    }).create('Roof', ownerId);
    const theirs = (await stepStore.listByProject(other.project.id)).at(0);
    if (theirs === undefined) throw new Error('the other project was created without steps');

    // Not found rather than forbidden: this project does not have that step,
    // and saying "you may not" would tell the caller it exists here.
    expect(await steps.rename(projectId, theirs.id, ownerId, 'Review')).toEqual({
      ok: false,
      reason: 'not_found',
    });
    expect(await stepStore.findById(theirs.id)).toEqual(theirs);
  });
});

/**
 * The real store with one method wrapped, so a test can put somebody else's
 * write in the gap between two of the service's calls.
 *
 * Written out rather than spread from the repository: `StepRepository`'s
 * methods live on its prototype, and `{ ...stepStore }` copies its connection
 * and none of them.
 */
function storeWith(overrides: Partial<StepStore>): StepStore {
  return {
    listByProject: (projectOf) => stepStore.listByProject(projectOf),
    findById: (stepOf) => stepStore.findById(stepOf),
    add: (toAdd, stamp) => stepStore.add(toAdd, stamp),
    rename: (stepOf, name, stamp) => stepStore.rename(stepOf, name, stamp),
    usageOf: (projectOf, stepOf) => stepStore.usageOf(projectOf, stepOf),
    remove: (projectOf, stepOf, cascade, stamp) =>
      stepStore.remove(projectOf, stepOf, cascade, stamp),
    ...overrides,
  };
}

describe('StepService.remove', () => {
  it('removes a step nothing points at, without asking again', async () => {
    const outcome = await steps.remove(projectId, qaId, ownerId, false);

    expect(outcome).toEqual({ ok: true });
    expect(await stepStore.findById(qaId)).toBeNull();
    expect(broadcast.published).toEqual([
      { projectId, event: { type: 'step_removed', stepId: qaId } },
    ]);
  });

  it('refuses a step that is used, counting what would go', async () => {
    await estimates.set({ workItemId: 'strip', stepId: qaId, ...DAYS }, wrote());
    await estimates.set({ workItemId: 'sand', stepId: qaId, ...DAYS }, wrote());
    const ada = await personAdded(
      directory.addPerson({ id: crypto.randomUUID(), name: 'Ada' }, [], wrote()),
    );
    await directory.assign('strip', qaId, ada.id, wrote());
    await directory.assign('strip', devId, ada.id, wrote());

    const outcome = await steps.remove(projectId, qaId, ownerId, false);

    expect(outcome).toEqual({
      ok: false,
      reason: 'in_use',
      inUse: {
        estimates: 2,
        actuals: 0,
        progress: 0,
        measures: 0,
        assignments: 1,
        assumedAssignees: [{ workItemId: 'strip', assumedNow: null, assumedAfter: ada.id }],
      },
    });
    expect(await stepStore.findById(qaId)).not.toBeNull();
    expect(broadcast.published).toEqual([]);
  });

  it('carries the figures that are not days into the refusal it shows a person', async () => {
    // `inUseFrom` is the one place both readings — the fast path's and the
    // transaction's — are turned into the numbers somebody consents to. A count
    // that stopped at the repository would leave this step looking free: no
    // estimate, no recorded day, nobody assigned, and two figures that go.
    await measures.set(
      {
        workItemId: 'strip',
        stepId: qaId,
        metric: 'token_estimate',
        value: 8000,
        recordedAt: 1000,
      },
      wrote(),
    );
    await measures.set(
      {
        workItemId: 'strip',
        stepId: qaId,
        metric: 'token_actual',
        value: 9500,
        recordedAt: 2000,
      },
      wrote(),
    );

    const outcome = await steps.remove(projectId, qaId, ownerId, false);

    expect(outcome).toEqual({
      ok: false,
      reason: 'in_use',
      inUse: {
        estimates: 0,
        actuals: 0,
        progress: 0,
        measures: 2,
        assignments: 0,
        assumedAssignees: [],
      },
    });
    expect(await stepStore.findById(qaId)).not.toBeNull();
    expect(broadcast.published).toEqual([]);
  });

  it.each([
    [
      'recorded days',
      async () =>
        actuals.set({ workItemId: 'strip', stepId: qaId, days: 2, recordedAt: 1000 }, wrote()),
    ],
    [
      'progress',
      async () =>
        progressStore.set(
          { workItemId: 'strip', stepId: qaId, state: 'done', statedAt: 1000 },
          wrote(),
        ),
    ],
  ])(
    'refuses a step holding only %s at the gate, before a transaction opens',
    async (_what, hold) => {
      // **Two moments, one rule.** The gate refuses so a reader is asked to
      // confirm; the transaction refuses again because the gate's answer can be
      // stale by the time the deletes would run. The gate used to ask
      // `estimates > 0 || assignments > 0`, so a step holding only recorded days,
      // only progress, or only measures walked past it and was refused one layer
      // down instead.
      //
      // The outcome is identical either way — which is why the drift was
      // invisible for as long as it was, and why this asserts on the *store call*
      // rather than the answer. `carries the figures that are not days into the
      // refusal it shows a person` above passes with the gate broken.
      //
      // Two proofs, because the assertions break on different faults and
      // neither sees the other's. With the `actuals` term dropped from
      // `stepIsInUse`, the outcome assertion failed on `toMatchObject ·
      // - "ok": false · + "ok": true` — both callers ask that function now, so
      // the step is deleted outright. With the gate's condition put back to
      // `seen.estimates > 0 || seen.assignments > 0`, the count failed on
      // `Expected: 0 · Received: 1` for both cases: the answer was right and a
      // transaction opened to produce it. Both watched 2026-09-02.
      await hold();
      let transactionsOpened = 0;
      const removeThroughStore = stepStore.remove.bind(stepStore);
      stepStore.remove = (...args: Parameters<StepStore['remove']>) => {
        transactionsOpened += 1;
        return removeThroughStore(...args);
      };

      const outcome = await steps.remove(projectId, qaId, ownerId, false);

      expect(outcome).toMatchObject({ ok: false, reason: 'in_use' });
      expect(transactionsOpened).toBe(0);
      expect(await stepStore.findById(qaId)).not.toBeNull();
    },
  );

  it('removes it on the second, explicit call', async () => {
    await estimates.set({ workItemId: 'strip', stepId: qaId, ...DAYS }, wrote());
    expect(await steps.remove(projectId, qaId, ownerId, false)).toMatchObject({ reason: 'in_use' });

    const outcome = await steps.remove(projectId, qaId, ownerId, true);

    expect(outcome).toEqual({ ok: true });
    expect(await estimates.listByProject(projectId)).toEqual([]);
    expect(broadcast.published).toEqual([
      { projectId, event: { type: 'step_removed', stepId: qaId } },
    ]);
  });

  it('refuses an unconfirmed removal when an estimate lands after the count', async () => {
    // The gap the confirmation opens, from the other side. The service counts
    // first as a fast path, and somebody estimates the doomed step in the
    // moment between that count and the delete. An unconfirmed request must
    // still refuse: it was never consent to take anything, and what it would
    // take is a trio nobody has been shown.
    const service = new StepService({
      projects: projectStore,
      steps: storeWith({
        async usageOf(watchedProject, watchedStep) {
          const counted = await stepStore.usageOf(watchedProject, watchedStep);
          await estimates.set({ workItemId: 'strip', stepId: qaId, ...DAYS }, wrote());
          return counted;
        },
      }),
      broadcast,
    });

    const outcome = await service.remove(projectId, qaId, ownerId, false);

    expect(outcome).toMatchObject({ ok: false, reason: 'in_use' });
    expect(await estimates.listByProject(projectId)).toHaveLength(1);
    expect(await stepStore.findById(qaId)).not.toBeNull();
    expect(broadcast.published).toEqual([]);
  });

  it('refuses the loser of two removals, bumping and announcing nothing', async () => {
    // Both requests pass the gate against a step that is still there, and one
    // of them commits first. The loser has nothing to remove, so it has nothing
    // to announce either: a second `step_removed` would make every client
    // reread for a change that did not happen, and the project's revision would
    // move for a write nobody made.
    let winnerRevision: number | undefined;
    const service = new StepService({
      projects: projectStore,
      steps: storeWith({
        async findById(watched) {
          const found = await stepStore.findById(watched);
          if (winnerRevision === undefined) {
            await stepStore.remove(projectId, qaId, true, wrote());
            winnerRevision = (await projectStore.findById(projectId))?.revision;
          }
          return found;
        },
      }),
      broadcast,
    });

    const outcome = await service.remove(projectId, qaId, ownerId, true);

    expect(outcome).toEqual({ ok: false, reason: 'not_found' });
    expect((await projectStore.findById(projectId))?.revision).toBe(winnerRevision);
    expect(broadcast.published).toEqual([]);
  });

  it('refuses a caller who may not write to the project, cascade or not', async () => {
    await projectStore.update(projectId, { restricted: true }, wrote());

    expect(await steps.remove(projectId, qaId, strangerId, true)).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    expect(await stepStore.findById(qaId)).not.toBeNull();
  });

  it('refuses a step that is not there', async () => {
    expect(await steps.remove(projectId, crypto.randomUUID(), ownerId, true)).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('a step removed between the check and the write', () => {
  /**
   * A work item service whose estimate and assignment writes are preceded by
   * somebody else's removal of `qaId` — the commit that lands in the gap
   * between `holdsStep` saying yes and the write reaching the foreign key.
   */
  function serviceWritingIntoTheGap(): WorkItemService {
    const vanishing: EstimateStore = {
      listByProject: (of) => estimates.listByProject(of),
      remove: (workItemId, stepId, stamp) => estimates.remove(workItemId, stepId, stamp),
      moveAll: (from, to, stamp) => estimates.moveAll(from, to, stamp),
      async set(toSet, stamp) {
        await stepStore.remove(projectId, qaId, true, wrote());
        await estimates.set(toSet, stamp);
      },
    };
    const vanishingToo: DirectoryStore = directoryWith(directory, {
      async assign(workItemId, stepId, personId, stamp) {
        await stepStore.remove(projectId, qaId, true, wrote());
        return directory.assign(workItemId, stepId, personId, stamp);
      },
    });
    return new WorkItemService({
      workItems: new WorkItemRepository(db),
      projects: projectStore,
      estimates: vanishing,
      actuals: new ActualRepository(db),
      measures: new StepMeasureRepository(db),
      progress: new StepProgressRepository(db),
      directory: vanishingToo,
      capacity: inMemoryCapacity(),
      priorityBands: inMemoryPriorityBands(),
      dependencies: new DependencyRepository(db),
      subtrees: new SubtreeRepository(db),
      journal: new CommandJournalRepository(db),
      broadcast: recordingBroadcaster(),
    });
  }

  it('refuses the estimate rather than answering with the foreign key', async () => {
    const outcome = await serviceWritingIntoTheGap().setEstimate('strip', ownerId, qaId, DAYS);

    expect(outcome).toEqual({ ok: false, reason: 'unknown_step' });
    expect(await estimates.listByProject(projectId)).toEqual([]);
  });

  it('refuses the assignee the same way', async () => {
    const ada = await personAdded(
      directory.addPerson({ id: crypto.randomUUID(), name: 'Ada' }, [], wrote()),
    );

    const outcome = await serviceWritingIntoTheGap().assign('strip', ownerId, qaId, ada.id);

    expect(outcome).toEqual({ ok: false, reason: 'unknown_step' });
    expect(await directory.assignmentsOf(['strip'])).toEqual([]);
  });

  it('names the person, not the step, when it is the person who has gone', async () => {
    // The person is the one that has gone, and the step is exactly where it
    // was. Reporting `unknown_step` for that would be a confident lie about
    // which of the request's ids is wrong. It is `unknown_person` now rather
    // than the raw foreign key it used to be — `DirectoryRepository.assign`
    // reads the person inside its own transaction — but the thing being
    // asserted is unchanged: `writeNamingStep` must not claim the step.
    const workItems = new WorkItemService({
      workItems: new WorkItemRepository(db),
      projects: projectStore,
      estimates,
      actuals,
      measures,
      progress: progressStore,
      directory,
      capacity: inMemoryCapacity(),
      priorityBands: inMemoryPriorityBands(),
      dependencies: new DependencyRepository(db),
      subtrees: new SubtreeRepository(db),
      journal: new CommandJournalRepository(db),
      broadcast: recordingBroadcaster(),
    });

    const outcome = await workItems.assign('strip', ownerId, qaId, 'nobody-by-that-id');

    expect(outcome).toEqual({ ok: false, reason: 'unknown_person' });
    expect(await stepStore.findById(qaId)).not.toBeNull();
    expect(await directory.assignmentsOf(['strip'])).toEqual([]);
  });
});

describe('step events', () => {
  /** What the project's steps looked like at the moment each event was published. */
  function watchingBroadcaster(): { stepsAtPublish: string[][] } & Broadcaster {
    const stepsAtPublish: string[][] = [];
    return {
      stepsAtPublish,
      async publish(watched: string) {
        stepsAtPublish.push((await stepStore.listByProject(watched)).map((each) => each.name));
      },
      latestSeq: () => Promise.resolve(-1),
    };
  }

  it('records the event after the write, never before it', async () => {
    // The sequence-consistency rule, asserted where it is decided rather than
    // reasoned about: a reader that acts on the event — a client rereading the
    // project, the replay log recording it — must never see the project as it
    // was before the change. Reading the steps from inside `publish` is the
    // only moment that can tell the two orders apart.
    const watching = watchingBroadcaster();
    const service = new StepService({
      projects: projectStore,
      steps: stepStore,
      broadcast: watching,
    });

    await service.add(projectId, ownerId, 'Design');
    await service.remove(projectId, qaId, ownerId, true);

    expect(watching.stepsAtPublish[0]).toContain('Design');
    expect(watching.stepsAtPublish[1]).not.toContain('QA');
  });

  it('replays a step event to a client that reconnects', async () => {
    const eventLog = new DrizzleEventLogRepo(db);
    const buffer = new ReplayBuffer({ maxPerSubscription: 100, maxAgeMs: 60_000 });
    const durable = new StepService({
      projects: projectStore,
      steps: stepStore,
      broadcast: new GatewayBroadcaster({
        eventLog,
        buffer,
        lock: new WriteLock(),
        // Nowhere to push, deliberately: the replay must come from what was
        // recorded, not from a delivery that happened to succeed.
        push: new PushClient({
          ...{
            timers: systemTimers,
            fetchImpl: globalThis.fetch,
            attemptMs: 5000,
            overallMs: 15000,
          },
          gwUrl: 'http://gw.invalid',
          secret: 's'.repeat(32),
        }),
        onPushFailed: () => undefined,
      }),
    });
    const subscription = `project:${projectId}`;

    await durable.add(projectId, ownerId, 'Design');
    const seenUpTo = await eventLog.latestSeq(subscription);
    await durable.remove(projectId, qaId, ownerId, true);

    const replayed = await new ReplayOrchestrator({ log: eventLog, buffer }).replay({
      [subscription]: seenUpTo,
    });

    expect(replayed[subscription]).toEqual({
      status: 'replaying',
      events: [{ seq: seenUpTo + 1, message: { type: 'step_removed', stepId: qaId } }],
    });
  });
});
