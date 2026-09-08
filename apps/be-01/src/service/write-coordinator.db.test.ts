import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { ActualRepository } from '../repository/actual';
import { CapacityRepository } from '../repository/capacity';
import { CommandJournalRepository } from '../repository/command-journal';
import type { Drizzle } from '../repository/db';
import { openDrizzle } from '../repository/db';
import { DependencyRepository } from '../repository/dependency';
import { DirectoryRepository } from '../repository/directory';
import { EstimateRepository } from '../repository/estimate';
import { DrizzleEventLogRepo } from '../repository/event-log';
import { OPEN, WriteCoordinator } from '../repository/gate';
import { runMigrations } from '../repository/migrate';
import { PriorityBandRepository } from '../repository/priority-band';
import { ProjectRepository } from '../repository/project';
import { sqliteUnitOfWork } from '../repository/sqlite-unit-of-work';
import { StepRepository } from '../repository/step';
import { StepMeasureRepository } from '../repository/step-measure';
import { StepProgressRepository } from '../repository/step-progress';
import { UserRepository } from '../repository/user';
import { SubtreeRepository, WorkItemRepository } from '../repository/work-item';
import { buildStores } from '../services';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { DeferringBroadcaster } from './broadcast';
import { CapacityService } from './capacity.service';
import { DirectoryService } from './directory.service';
import type { PlanCommand } from './plan-command';
import { type BatchOutcome, PlanCommandRunner } from './plan-commands';
import { PriorityBandService } from './priority-band.service';
import { ProjectService } from './project.service';
import { StepService } from './step.service';
import { WorkItemService } from './work-item.service';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

/**
 * A promise the test resolves, and the promise that says it has been reached.
 *
 * Two halves rather than one: the case has to know the batch really is
 * suspended before it starts the outside write, or it is asserting about a
 * window that may already have closed.
 */
function suspension(): {
  reached: Promise<void>;
  arrive: () => void;
  release: () => void;
  held: Promise<void>;
} {
  let arrive = (): void => {
    throw new Error('the suspension was awaited before it was built');
  };
  let release = arrive;
  const reached = new Promise<void>((resolve) => {
    arrive = () => {
      resolve();
    };
  });
  const held = new Promise<void>((resolve) => {
    release = () => {
      resolve();
    };
  });
  return { reached, arrive, release, held };
}

let dir: string;
let db: Drizzle;
let runner: PlanCommandRunner;
let steps: StepService;
let stepStore: StepRepository;
let workItemStore: WorkItemRepository;
let projectId: string;
let ownerId: string;
let hold: ReturnType<typeof suspension>;
let coordinator: WriteCoordinator;
let publicDirectory: DirectoryRepository;
let publicEventLog: DrizzleEventLogRepo;
let publicProjects: ProjectRepository;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-coordinator-'));
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  db = openDrizzle(path);

  // The process's one coordinator, exactly as `boot.ts` builds it.
  coordinator = new WriteCoordinator();
  // The batch's stores hold no turn: `PlanCommandRunner` holds it for them.
  const projectStore = new ProjectRepository(db, OPEN);
  const directoryStore = new DirectoryRepository(db, OPEN);
  const capacityStore = new CapacityRepository(db, OPEN);
  const bandStore = new PriorityBandRepository(db, OPEN);
  workItemStore = new WorkItemRepository(db, OPEN);
  // The route's do, which is the whole subject of this file.
  stepStore = new StepRepository(db, coordinator);
  publicDirectory = new DirectoryRepository(db, coordinator);
  publicEventLog = new DrizzleEventLogRepo(db, coordinator);
  publicProjects = new ProjectRepository(db, coordinator);
  const broadcast = recordingBroadcaster();

  ownerId = crypto.randomUUID();
  await new UserRepository(db, OPEN).create(
    { id: ownerId, username: 'owner', passwordHash: 'x', createdAt: 1 },
    { at: 1, by: ownerId },
  );

  hold = suspension();
  // The suspension is a *store* method rather than a service one, because the
  // window this case is about is between the batch's first write and its
  // rollback — inside the transaction, holding the lock. The second create
  // arrives here, says so, and waits for the case to let it go.
  let inserts = 0;
  const suspendingWorkItems: WorkItemRepository = Object.create(workItemStore, {
    insert: {
      value: async (...args: Parameters<WorkItemRepository['insert']>) => {
        inserts += 1;
        if (inserts === 2) {
          hold.arrive();
          await hold.held;
        }
        await workItemStore.insert(...args);
      },
    },
  }) as WorkItemRepository;

  const workItems = new WorkItemService({
    workItems: suspendingWorkItems,
    projects: projectStore,
    estimates: new EstimateRepository(db, OPEN),
    actuals: new ActualRepository(db, OPEN),
    measures: new StepMeasureRepository(db, OPEN),
    progress: new StepProgressRepository(db, OPEN),
    directory: directoryStore,
    capacity: capacityStore,
    priorityBands: bandStore,
    dependencies: new DependencyRepository(db, OPEN),
    subtrees: new SubtreeRepository(db, OPEN),
    journal: new CommandJournalRepository(db, OPEN),
    broadcast,
  });
  // The batch's own stores, over an open gate: `sqliteUnitOfWork` holds the
  // turn for them. The suspending work-item store above is one of these.
  const admitted = { ...buildStores(db, OPEN), workItems: suspendingWorkItems };
  const announcements = new DeferringBroadcaster(broadcast);
  runner = new PlanCommandRunner({
    workItems,
    directory: new DirectoryService({ directory: directoryStore, broadcast: announcements }),
    capacity: new CapacityService({
      projects: projectStore,
      capacity: capacityStore,
      broadcast: announcements,
    }),
    priorityBands: new PriorityBandService({
      projects: projectStore,
      bands: bandStore,
      broadcast: announcements,
    }),
    uow: sqliteUnitOfWork(db, coordinator, admitted),
    announcements,
  });
  // The route's own service, built exactly as `buildServices` builds it: the
  // step store on the process connection, and no knowledge of the batch at all.
  steps = new StepService({ projects: projectStore, steps: stepStore, broadcast });

  const created = await new ProjectService({
    projects: projectStore,
    broadcast: recordingBroadcaster(),
  }).create('Rewire the shed', ownerId);
  projectId = created.project.id;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Two creates and a refusal: the second create is where the batch suspends. */
const REFUSED_BATCH: PlanCommand[] = [
  { kind: 'createWorkItem', ref: 'strip', parentId: null, afterId: null, name: 'Strip' },
  { kind: 'createWorkItem', ref: 'sand', parentId: null, afterRef: 'strip', name: 'Sand' },
  {
    kind: 'setEstimate',
    workItemRef: 'strip',
    stepId: 'no-such-step',
    days: { optimistic: 1, realistic: 2, pessimistic: 3 },
  },
];

describe('the write coordinator', () => {
  it('does not roll a route write back with a batch it never belonged to', async () => {
    const batch: Promise<BatchOutcome> = runner.run(projectId, ownerId, REFUSED_BATCH);
    await hold.reached;

    // Started while the batch holds the transaction open, and deliberately not
    // awaited yet: what this case is about is where the write *lands*, and on a
    // process whose route writes take no turn it lands inside the batch.
    const added = steps.add(projectId, ownerId, 'Wiring');
    hold.release();

    const outcome = await batch;
    expect(outcome.ok).toBe(false);
    const step = await added;
    expect(step.ok).toBe(true);

    // The batch's own two rows went with its refusal, which is ADR 0007 working.
    expect(await workItemStore.listByProject(projectId)).toEqual([]);
    // The step did not. It was a different request, and nobody refused it.
    // Proof: `StepRepository.add`'s `this.gate` replaced by `OPEN` — the shape
    // this process had before the coordinator existed, where a route's write
    // takes no turn. Failed on `Expected to contain: "Wiring" · Received:
    // [ "Dev", "QA" ]`: the insert landed inside the batch's `BEGIN IMMEDIATE`
    // and its refusal took the step with it, while `steps.add` had answered
    // `ok`. Watched 2026-09-08, and again on `main` before the fix existed.
    expect((await stepStore.listByProject(projectId)).map((each) => each.name)).toContain('Wiring');
  });

  it("makes every public transactional store wait for the batch's turn", async () => {
    // Case (i) of the plan's admission list, on the production call path: one
    // mutating method per public store, started while a batch is suspended and
    // read back after that batch has been **refused**. Survival is the oracle
    // rather than "has it written yet": a store that took no turn writes inside
    // the batch's `BEGIN IMMEDIATE`, and the rollback erases it. Counting
    // microtasks instead was tried first and could not fail — an ungated write
    // is a few turns late, not synchronous, so the sample was satisfied for the
    // wrong reason.
    const stamp = { at: 1, by: ownerId };
    const batch = runner.run(projectId, ownerId, REFUSED_BATCH);
    await hold.reached;

    const writes = [
      stepStore.add({ id: crypto.randomUUID(), projectId, name: 'Wiring' }, stamp),
      publicDirectory.addTag({ id: crypto.randomUUID(), name: 'urgent' }, stamp),
      publicEventLog.recordEvent(`project:${projectId}`, { type: 'saved_plans_changed' }, 1),
      publicProjects.update(projectId, { name: 'Rewire the shed, again' }, stamp),
    ];
    hold.release();

    expect((await batch).ok).toBe(false);
    await Promise.all(writes);

    // Proof: `publicProjects` built over `OPEN` instead of the coordinator —
    // the shape every store had before this change. Failed on `expected
    // 'Rewire the shed' to be 'Rewire the shed, again'`: the rename landed
    // inside the batch's transaction and its refusal took it. Watched
    // 2026-09-08.
    expect((await publicProjects.findById(projectId))?.name).toBe('Rewire the shed, again');
    expect((await stepStore.listByProject(projectId)).map((each) => each.name)).toContain('Wiring');
    expect((await publicDirectory.listTags()).map((each) => each.name)).toContain('urgent');
    expect(await publicEventLog.latestSeq(`project:${projectId}`)).toBeGreaterThanOrEqual(0);
  });
});
