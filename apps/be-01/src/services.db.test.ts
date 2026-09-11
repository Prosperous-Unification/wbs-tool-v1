import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger } from '@wbs/observability';
import { openSqliteSource } from '@wbs/store-sqlite';
import { afterEach, describe, expect, it } from 'bun:test';

import { openConnection, type openDrizzle } from './repository/db';
import { DrizzleEventLogStore } from './repository/event-log';
import { OPEN } from './repository/gate';
import { runMigrations } from './repository/migrate';
import { allocateGeneration } from './repository/optimization-generation';
import { ProjectRepository } from './repository/project';
import { SavedPlanRepository } from './repository/saved-plan';
import { SavedPlanCaptureRepository } from './repository/saved-plan-capture';
import { scheduleInputHash } from './repository/schedule-input-hash';
import {
  optimizationGeneration,
  optimizedScheduleCache,
  solverQueue,
  solverSlot,
} from './repository/schema';
import { UserRepository } from './repository/user';
import { WorkItemRepository } from './repository/work-item';
import { nodeDigest } from './runtime/bun-runtime';
import { subscriptionFor } from './service/broadcast';
import type { ReservedSpawner, ReservedSpawnRequest } from './service/optimization-coordinator';
import { PlanCommandRunner } from './service/plan-commands';
import { SavedPlanService } from './service/saved-plan.service';
import { readRuntimeSolverVersion } from './service/solver-launcher-process';
import { buildServices } from './services';
import { projectRow } from './testing/project-fixture';

const FOLDER = new URL('../drizzle', import.meta.url).pathname;

const dirs: string[] = [];

function signal(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => {
    throw new Error('signal resolved before construction');
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function bootstrap(optimizer?: {
  solverVersion: string;
  budgetMs: number;
  spawn: ReservedSpawner;
}) {
  const pushUrls: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'wbs-services-'));
  dirs.push(dir);
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  const source = openSqliteSource({ dbPath: path });
  const db = source.db;
  const services = buildServices({
    source,
    logger: createLogger({ service: 'be-01' }),
    jwtKey: 'k'.repeat(32),
    gwUrl: 'http://gw.invalid',
    internalAuthSecret: 's'.repeat(32),
    // Proof: replacing this stub with `globalThis.fetch` made the two wiring
    // cases below time out after 5000ms in the parallel workspace gate while
    // `PushClient` retried the deliberately unreachable gateway.
    pushFetch: (url) => {
      pushUrls.push(url);
      return Promise.resolve(Response.json({ delivered_to_sockets: 0 }));
    },
    optimizer,
  });
  return { db, path, services, pushUrls };
}

async function seedProject(db: ReturnType<typeof openDrizzle>): Promise<{
  projectId: string;
  ownerId: string;
}> {
  const ownerId = crypto.randomUUID();
  await new UserRepository(db, OPEN).create(
    {
      id: ownerId,
      username: 'owner',
      passwordHash: 'x',
      createdAt: 1,
    },
    { at: 1, by: ownerId },
  );
  const projectId = crypto.randomUUID();
  const project = await new ProjectRepository(db, OPEN).create(
    projectRow({
      id: projectId,
      ownerId,
    }),
    [{ id: crypto.randomUUID(), projectId, name: 'Dev', position: 10 }],
    { at: 1, by: ownerId },
  );
  return { projectId: project.id, ownerId };
}

describe('buildServices', () => {
  it('saves an idle optimized capture without admitting solver state', async () => {
    const { db, path, services } = bootstrap({
      solverVersion: '2.4',
      budgetMs: 12_345,
      spawn: () => {
        throw new Error('captured scheduling admitted a solver process');
      },
    });
    const { projectId, ownerId } = await seedProject(db);
    await new ProjectRepository(db, OPEN).update(
      projectId,
      { optimizationEnabled: true, scheduleEngine: 'optimized', scheduleObjective: 'pri' },
      { at: 2, by: ownerId },
    );
    await new WorkItemRepository(db, OPEN).insert(
      {
        id: 'captured-work',
        projectId,
        parentId: null,
        position: 10,
        name: 'Captured work',
        notes: '',
        frozenNumber: null,
        priority: null,
        startNoEarlierThan: null,
        startNoEarlierThanReason: null,
        deadline: null,
        serviceTeamId: null,
        serviceId: null,
        maxParallel: 1,
        revision: 0,
      },
      [],
      { at: 2, by: ownerId },
    );
    const state = () => ({
      generations: db.select().from(optimizationGeneration).all(),
      slots: db.select().from(solverSlot).all(),
      queue: db.select().from(solverQueue).all(),
    });
    const before = state();
    const savedPlans = new SavedPlanService({
      scheduler: services.scheduler,
      digest: nodeDigest,
      capture: new SavedPlanCaptureRepository({ openConnection: () => openConnection(path) }),
      plans: new SavedPlanRepository({ openConnection: () => openConnection(path) }),
      newId: () => 'saved-idle',
      now: () => 3,
    });

    const saved = await savedPlans.save({
      projectId,
      name: 'idle optimized capture',
      createdBy: 'owner',
      createdById: ownerId,
    });

    expect(saved.outcome).toBe('saved');
    if (saved.outcome !== 'saved') return;
    expect(saved.record.schedule).toEqual({ present: false, absentReason: 'pending' });
    // Proof: routing capture through the live coordinator allocated generation 1
    // before save returned, instead of leaving all three admission tables empty.
    expect(state()).toEqual(before);
  });

  it('gives the broadcaster and the replay orchestrator the same buffer', async () => {
    // The wiring, not the classes. `GatewayBroadcaster` filling a buffer and
    // `ReplayOrchestrator` reading one were each proven in isolation, and both
    // proofs would have survived this file handing them two different buffers:
    // replay would still work, silently, off the database on every reconnect.
    //
    // Proof: `buffer: replayBuffer` in `services.ts` replaced with a freshly
    // constructed `new ReplayBuffer(...)` and only this test failed.
    const { db, services, pushUrls } = bootstrap();
    const { projectId, ownerId } = await seedProject(db);

    // Delivery is accepted by the injected transport; the assertion below
    // proves recording fills the shared buffer independently of gateway I/O.
    await services.workItems.create(projectId, ownerId, {
      parentId: null,
      afterId: null,
      name: 'Strip',
    });
    expect(pushUrls).toEqual(['http://gw.invalid/internal/push']);

    const subscription = `project:${projectId}`;
    const fromBuffer = await services.replay.replay({ [subscription]: -1 });
    expect(fromBuffer[subscription]).toMatchObject({ status: 'replaying' });

    // Emptying the log leaves the replay intact, which it could only do if the
    // event is in the buffer the orchestrator was handed.
    await new DrizzleEventLogStore(db, OPEN).pruneBeyond(0);
    expect(await services.replay.replay({ [subscription]: -1 })).toEqual(fromBuffer);
  });

  it('announces a marker write through the shared broadcaster', async () => {
    // The wiring again, and this one is why it is worth a second case.
    // `CalendarMarkerServiceOptions.broadcast` is optional and `announce` calls
    // it through `?.`, so a service built without one publishes nothing and
    // refuses nothing: every marker route test, service test and HTTP assertion
    // stayed green for two slices while the deployed process announced no
    // marker change at all (TASK-279, found by browser QA on deployed head
    // 4051512c). A test that deleted the argument and re-ran the marker suites
    // would have stayed green too — only a real `buildServices` driven through
    // a real write can tell.
    //
    // Proof: `broadcast: announcements` deleted from `services.ts` and only
    // this test and the sequence case below failed.
    const { db, services } = bootstrap();
    const { projectId, ownerId } = await seedProject(db);

    const subscription = `project:${projectId}`;
    const log = new DrizzleEventLogStore(db, OPEN);
    const before = await log.latestSeq(subscription);

    const written = await services.calendarMarkers.create(projectId, ownerId, {
      date: '2026-03-02',
      name: 'Freeze',
    });
    expect(written.ok).toBe(true);

    // Read back off the recorded stream rather than off a spy, because the
    // recording is what a reconnecting client is served and a spy would pass
    // for a service publishing into a broadcaster nothing else holds.
    expect(await services.replay.replay({ [subscription]: before })).toEqual({
      [subscription]: {
        status: 'replaying',
        events: [{ seq: before + 1, message: { type: 'calendar_markers_changed' } }],
      },
    });
  });

  it('advances the project sequence once per successful marker write and not at all for a refused one', async () => {
    // The other half of the defect. An event is a client's instruction to
    // re-read and the project's `seq` is what a resuming client counts from, so
    // a write that advanced it twice would make a second reader replay a change
    // it already has, and one that advanced it on a refusal would make every
    // reader refetch a list nothing touched.
    const { db, services } = bootstrap();
    const { projectId, ownerId } = await seedProject(db);

    const subscription = `project:${projectId}`;
    const log = new DrizzleEventLogStore(db, OPEN);
    const seq = () => log.latestSeq(subscription);
    const start = await seq();

    const markerId = crypto.randomUUID();
    expect(
      (
        await services.calendarMarkers.create(projectId, ownerId, {
          id: markerId,
          date: '2026-03-02',
          name: 'Freeze',
        })
      ).ok,
    ).toBe(true);
    expect(await seq()).toBe(start + 1);

    expect((await services.calendarMarkers.rename(projectId, markerId, ownerId, 'Thaw')).ok).toBe(
      true,
    );
    expect(await seq()).toBe(start + 2);

    expect(
      (await services.calendarMarkers.recolor(projectId, markerId, ownerId, '#3366cc')).ok,
    ).toBe(true);
    expect(await seq()).toBe(start + 3);

    // Refused *after* the project gate passed, which is the interesting half:
    // the store decides a marker's existence inside its own transaction, and
    // the announcement is downstream of that answer rather than of the gate.
    expect(
      await services.calendarMarkers.rename(projectId, crypto.randomUUID(), ownerId, 'Nobody'),
    ).toEqual({ ok: false, reason: 'not_found', about: 'marker' });
    expect(await seq()).toBe(start + 3);

    expect((await services.calendarMarkers.remove(projectId, markerId, ownerId)).ok).toBe(true);
    expect(await seq()).toBe(start + 4);

    // Exactly four events in that window and every one of them a marker change:
    // a count alone would survive a write that announced somebody else's event.
    expect(await services.replay.replay({ [subscription]: start })).toEqual({
      [subscription]: {
        status: 'replaying',
        events: [start + 1, start + 2, start + 3, start + 4].map((at) => ({
          seq: at,
          message: { type: 'calendar_markers_changed' },
        })),
      },
    });
  });

  it('changes nothing but seq in the work-items answer, once per marker write', async () => {
    // TASK-279 AC #4, and the assertion the browser QA finding needs to stay
    // fixed in both directions.
    //
    // A marker write must move the project's `seq` — that is the whole defect
    // this task was filed for, and the case above proves the event is recorded.
    // But `seq` is read inside `tree()` beside the plan the client is about to
    // redraw, so making it move is only half a fix: an implementation that
    // reordered work items, recomputed a schedule, or dropped a field on the
    // way through would also make `seq` advance, and every marker-side test
    // would stay green while the client redrew a different plan on an
    // annotation change.
    //
    // So the payload is compared **whole** with only `seq` deleted, and the
    // deletion is by name: anything else that moved fails here, including a
    // field this test does not know about, because nothing enumerates the keys.
    // `toEqual` catches a changed value, and a reordered array — it compares
    // arrays by position. What it does not see is a changed **key** order
    // inside an object, which is the same object to `toEqual` and a different
    // response to a client diffing text or hashing the body; `JSON.stringify`
    // is here for that one.
    const { db, services } = bootstrap();
    const { projectId, ownerId } = await seedProject(db);

    // **Three items, not one.** An empty tree is equal to itself whatever the
    // marker writes did, and a one-item tree is equal to itself under any
    // reordering there is — so the claim above about a reordered tree would be
    // untrue of a fixture with fewer than two rows. A parent and two children
    // give both a sibling order and a depth to lose (round-3 Gemini review).
    const strip = await services.workItems.create(projectId, ownerId, {
      parentId: null,
      afterId: null,
      name: 'Strip',
    });
    expect(strip.ok).toBe(true);
    const parentId = strip.ok ? strip.value.id : null;
    for (const name of ['Sand', 'Prime']) {
      expect(
        (await services.workItems.create(projectId, ownerId, { parentId, afterId: null, name })).ok,
      ).toBe(true);
    }

    // `tree` answers `null` for a project it cannot find. Narrowed here rather
    // than asserted away, because a `null` slipping through would make every
    // equality below hold vacuously — the one way this case could pass while
    // reading nothing at all.
    type Tree = Exclude<
      Awaited<ReturnType<typeof services.workItems.tree>>,
      { kind: 'engine_unavailable' } | null
    >;
    const treeOf = async (): Promise<Tree> => {
      const tree = await services.workItems.tree(projectId);
      expect(tree).not.toBeNull();
      if (tree === null || 'kind' in tree) throw new Error('the seeded project answered no tree');
      return tree;
    };

    // `delete` on a copy rather than a rest destructure, which lint reads as an
    // unused binding — and `delete` is what keeps the surviving keys in their
    // original order, which the `JSON.stringify` assertion below depends on.
    const withoutSeq = (tree: Tree): Record<string, unknown> => {
      const rest: Record<string, unknown> = { ...tree };
      delete rest['seq'];
      return rest;
    };

    const unchangedExceptSeq = (after: Tree, before: Tree): void => {
      expect(withoutSeq(after)).toEqual(withoutSeq(before));
      expect(JSON.stringify(withoutSeq(after))).toBe(JSON.stringify(withoutSeq(before)));
      // Exactly one, not "more than before": a write announced twice makes
      // every other reader replay a change it already has.
      expect(after.seq).toBe(before.seq + 1);
    };

    // All four writes, in the order a composer makes them, each compared with
    // the read before it rather than with the baseline — an equality that only
    // held across the whole run would pass for two mutations that cancelled.
    const markerId = crypto.randomUUID();
    const baseline = await treeOf();

    expect(
      (
        await services.calendarMarkers.create(projectId, ownerId, {
          id: markerId,
          date: '2026-03-02',
          name: 'Freeze',
        })
      ).ok,
    ).toBe(true);
    const created = await treeOf();
    unchangedExceptSeq(created, baseline);

    expect((await services.calendarMarkers.rename(projectId, markerId, ownerId, 'Thaw')).ok).toBe(
      true,
    );
    const renamed = await treeOf();
    unchangedExceptSeq(renamed, created);

    expect(
      (await services.calendarMarkers.recolor(projectId, markerId, ownerId, '#3366cc')).ok,
    ).toBe(true);
    const recoloured = await treeOf();
    unchangedExceptSeq(recoloured, renamed);

    expect((await services.calendarMarkers.remove(projectId, markerId, ownerId)).ok).toBe(true);
    unchangedExceptSeq(await treeOf(), recoloured);
  });

  it('returns engine unavailable from the real service graph without an optimizer adapter', async () => {
    const { db, services } = bootstrap();
    const { projectId, ownerId } = await seedProject(db);
    await services.workItems.create(projectId, ownerId, {
      parentId: null,
      afterId: null,
      name: 'Must not receive Fast dates',
    });
    await new ProjectRepository(db, OPEN).update(
      projectId,
      { optimizationEnabled: true, scheduleEngine: 'optimized' },
      { at: 2, by: ownerId },
    );

    const tree = await services.workItems.tree(projectId);

    expect(tree).toEqual({
      kind: 'engine_unavailable',
      error: 'engine_unavailable',
      engine: 'optimized',
    });
    expect(tree === null || 'slices' in tree).toBe(false);
  });

  it('commits a batch and durably announces one unavailable plan without a Fast tree', async () => {
    const { db, services } = bootstrap();
    const { projectId, ownerId } = await seedProject(db);
    await new ProjectRepository(db, OPEN).update(
      projectId,
      { optimizationEnabled: true, scheduleEngine: 'optimized' },
      { at: 1, by: ownerId },
    );
    const runner = new PlanCommandRunner({
      batchServices: services.batch,
      publicServices: services,
      uow: services.uow,
      announcements: services.announcements,
    });

    const applied = await runner.run(projectId, ownerId, [
      {
        kind: 'createWorkItem',
        ref: 'created',
        parentId: null,
        afterId: null,
        name: 'Committed before publication',
      },
    ]);

    expect(applied.ok).toBe(true);
    expect(
      (await new WorkItemRepository(db, OPEN).listByProject(projectId)).map((row) => row.name),
    ).toEqual(['Committed before publication']);
    expect(await services.workItems.tree(projectId)).toEqual({
      kind: 'engine_unavailable',
      error: 'engine_unavailable',
      engine: 'optimized',
    });
    const events = await new DrizzleEventLogStore(db, OPEN).rangeSince(
      subscriptionFor(projectId),
      -1,
    );
    expect(events.map((event) => event.message)).toEqual([
      { type: 'plan_unavailable', error: 'engine_unavailable', engine: 'optimized' },
    ]);
    expect(
      events.some((event) => (event.message as { type?: unknown }).type === 'tree_replaced'),
    ).toBe(false);

    const refused = await runner.run(projectId, ownerId, [
      {
        kind: 'setEstimate',
        workItemId: 'missing',
        stepId: 'missing',
        days: { optimistic: 1, realistic: 1, pessimistic: 1 },
      },
    ]);
    expect(refused.ok).toBe(false);
    expect(
      await new DrizzleEventLogStore(db, OPEN).rangeSince(subscriptionFor(projectId), -1),
    ).toHaveLength(1);
  });

  it('builds one available optimizer whose first enabled read launches both release-keyed variants', async () => {
    // This is the process graph, not an OptimizationCoordinator unit test. The
    // child process is the external boundary; SQLite admission, project gating,
    // plan reading and request composition are real. Proof: leave
    // `optimizerWiring(undefined)` in services.ts and the setting write refuses
    // `optimizer_unavailable`; wire availability without the reader and no
    // launch arrives here.
    const spawned: ReservedSpawnRequest[] = [];
    const { db, services } = bootstrap({
      solverVersion: '0.1.3',
      budgetMs: 60_000,
      spawn: (request) => {
        spawned.push(request);
        const empty = () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          });
        return Promise.resolve({
          pid: 10_000 + spawned.length,
          stdout: empty(),
          stderr: empty(),
          exited: Promise.resolve(1),
          verdict: () => undefined,
          kill: () => undefined,
        });
      },
    });
    const { projectId, ownerId } = await seedProject(db);
    await services.workItems.create(projectId, ownerId, {
      parentId: null,
      afterId: null,
      name: 'Rewire',
    });

    expect(
      await services.projects.update(projectId, ownerId, {
        optimizationEnabled: true,
        scheduleEngine: 'fast',
      }),
    ).toHaveProperty('ok', true);
    await services.workItems.tree(projectId);
    await services.optimizer?.drain();

    expect(spawned.map((request) => request.objective)).toEqual(['pri', 'time']);
    expect(
      spawned.map((request) => [
        request.request.solverVersion,
        request.request.contractVersion,
        request.request.budgetMs,
      ]),
    ).toEqual([
      // The current solver release composes with the current scheduler contract.
      ['0.1.3', '9+0.1.3', 60_000],
      ['0.1.3', '9+0.1.3', 60_000],
    ]);
  });

  it('starts current solves instead of reading a pre-fix failed pair', async () => {
    const legacyContract = '7+0.1.0';
    const currentSolver = readRuntimeSolverVersion('development');
    const spawned: ReservedSpawnRequest[] = [];
    const { db, services } = bootstrap({
      solverVersion: currentSolver,
      budgetMs: 60_000,
      spawn: (request) => {
        spawned.push(request);
        const empty = () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          });
        return Promise.resolve({
          pid: 20_000 + spawned.length,
          stdout: empty(),
          stderr: empty(),
          exited: Promise.resolve(1),
          verdict: () => undefined,
          kill: () => undefined,
        });
      },
    });
    const { projectId, ownerId } = await seedProject(db);
    await services.workItems.create(projectId, ownerId, {
      parentId: null,
      afterId: null,
      name: 'Rewire',
    });
    const input = await services.workItems.scheduleInput(projectId);
    if (input === null) throw new Error('seeded project has no schedule input');
    const inputHash = scheduleInputHash(input);
    const generation = allocateGeneration(db, projectId, legacyContract, inputHash, 1);
    db.insert(optimizedScheduleCache)
      .values(
        (['pri', 'time'] as const).map((objective) => ({
          projectId,
          inputHash,
          objective,
          contractVersion: legacyContract,
          budgetMs: 60_000,
          generation,
          status: 'failed' as const,
          resultJson: null,
          failureReason: 'internal-error' as const,
          createdAt: 1,
        })),
      )
      .run();

    expect(
      await services.projects.update(projectId, ownerId, {
        optimizationEnabled: true,
        scheduleEngine: 'fast',
      }),
    ).toHaveProperty('ok', true);
    await services.workItems.tree(projectId);
    await services.optimizer?.drain();

    expect(currentSolver).toBe('0.1.3');
    // Proof: hard-coding `services.ts`'s coordinator key to `7+0.1.0` read the
    // seeded failed pair and failed here with `Expected ["pri", "time"] /
    // Received []`; watched 2026-09-07.
    expect(spawned.map(({ objective }) => objective)).toEqual(['pri', 'time']);
    expect(spawned.map(({ key }) => key.contractVersion)).toEqual(['9+0.1.3', '9+0.1.3']);
    expect(
      db
        .select({ contractVersion: optimizedScheduleCache.contractVersion })
        .from(optimizedScheduleCache)
        .all()
        .filter(({ contractVersion }) => contractVersion === legacyContract),
    ).toHaveLength(2);
  });

  it('returns a live plan read while its newly admitted solver is still unresolved', async () => {
    const entered = signal();
    const release = signal();
    const { db, services } = bootstrap({
      solverVersion: readRuntimeSolverVersion('development'),
      budgetMs: 60_000,
      spawn: async () => {
        entered.resolve();
        await release.promise;
        const empty = () =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          });
        return {
          pid: 31_001,
          stdout: empty(),
          stderr: empty(),
          exited: Promise.resolve(1),
          verdict: () => undefined,
          kill: () => undefined,
        };
      },
    });
    const { projectId, ownerId } = await seedProject(db);
    await services.workItems.create(projectId, ownerId, {
      parentId: null,
      afterId: null,
      name: 'Rewire',
    });
    expect(
      await services.projects.update(projectId, ownerId, {
        optimizationEnabled: true,
        scheduleEngine: 'optimized',
      }),
    ).toHaveProperty('ok', true);

    const treePromise = services.workItems.tree(projectId);
    await entered.promise;
    let settled = false;
    void treePromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    // Proof: inserting `await services.optimizer.drain()` between the admitted
    // spawn and this read left `settled` false until `release.resolve()`.
    expect(settled).toBe(true);
    release.resolve();
    await services.optimizer?.drain();
  });
});
