import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clockOf } from '@wbs/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { openDrizzle } from '../repository/db';
import { OPEN, WriteCoordinator } from '../repository/gate';
import { runMigrations } from '../repository/migrate';
import { sqliteUnitOfWork } from '../repository/sqlite-unit-of-work';
import { buildStores, servicesOver } from '../services';
import { testClock } from '../testing/clock-fixture';
import type { Broadcaster, ProjectEvent } from './broadcast';
import { optimizerWiring } from './optimizer-wiring';
import type { PlanCommand } from './plan-command';
import { PlanCommandRunner } from './plan-commands';
import { ProjectService } from './project.service';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

/** What leaves the process, in order. */
function recordingBroadcasterWithLog(): Broadcaster & {
  readonly sent: { projectId: string; event: ProjectEvent }[];
} {
  const sent: { projectId: string; event: ProjectEvent }[] = [];
  return {
    sent,
    publish(projectId, event) {
      sent.push({ projectId, event });
      return Promise.resolve();
    },
    latestSeq: () => Promise.resolve(-1),
  };
}

/** A promise the case resolves, and the promise that says it has been reached. */
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
let broadcast: ReturnType<typeof recordingBroadcasterWithLog>;
/** Held between the route's store write and its own publish — the window (l) is about. */
let beforeRoutePublish: ReturnType<typeof suspension>;
/** Held inside the batch, so its hold is open while the route publishes. */
let insideTheBatch: ReturnType<typeof suspension>;
let runner: PlanCommandRunner;
let routes: ReturnType<typeof servicesOver>;
let projectId: string;
let ownerId: string;

const REFUSED_BATCH: PlanCommand[] = [
  { kind: 'createWorkItem', ref: 'strip', parentId: null, afterId: null, name: 'Strip' },
  {
    kind: 'setEstimate',
    workItemRef: 'strip',
    stepId: 'no-such-step',
    days: { optimistic: 1, realistic: 2, pessimistic: 3 },
  },
];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-announce-'));
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  const db = openDrizzle(path);
  const coordinator = new WriteCoordinator();
  const stores = buildStores(db, coordinator);
  const admitted = buildStores(db, OPEN);
  broadcast = recordingBroadcasterWithLog();
  const announcements: Broadcaster = broadcast;
  const shared = {
    clock: clockOf({ now: () => Date.now(), newId: () => crypto.randomUUID() }),
    broadcast: announcements,
    optimized: optimizerWiring(undefined),
  };

  ownerId = crypto.randomUUID();
  await stores.users.create(
    { id: ownerId, username: 'owner', passwordHash: 'x', createdAt: 1 },
    { at: 1, by: ownerId },
  );
  const created = await new ProjectService({
    clock: testClock,
    projects: stores.projects,
    broadcast,
  }).create('Rewire the shed', ownerId);
  projectId = created.project.id;
  broadcast.sent.length = 0;

  // The route's own graph, publishing through a broadcaster that waits where
  // the window is: after the store write has committed and let go of the turn,
  // before the announcement is offered to anybody.
  beforeRoutePublish = suspension();
  routes = servicesOver(stores, {
    ...shared,
    broadcast: {
      async publish(id, event) {
        beforeRoutePublish.arrive();
        await beforeRoutePublish.held;
        await announcements.publish(id, event);
      },
      latestSeq: (id) => announcements.latestSeq(id),
    },
  });

  // The batch's graph, over a work-item store that stops on its second insert
  // so its hold stays open across the route's publish.
  insideTheBatch = suspension();
  let inserts = 0;
  const suspendingWorkItems = Object.create(admitted.workItems, {
    insert: {
      value: async (...args: Parameters<(typeof admitted.workItems)['insert']>) => {
        inserts += 1;
        if (inserts === 1) {
          insideTheBatch.arrive();
          await insideTheBatch.held;
        }
        await admitted.workItems.insert(...args);
      },
    },
  }) as typeof admitted.workItems;

  const batchStores = { ...admitted, workItems: suspendingWorkItems };
  runner = new PlanCommandRunner({
    // The graph the runner builds per batch, over the collector it hands in.
    batchServices: (_scope, collector) =>
      servicesOver(batchStores, { ...shared, broadcast: collector }),
    publicServices: servicesOver(stores, { ...shared, broadcast: announcements }),
    uow: sqliteUnitOfWork(db, coordinator, batchStores),
    announcements,
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('who owns an announcement', () => {
  it('(l) still sends a committed route event when the next batch refuses', async () => {
    // The window D24 names: a route finishes its store write, lets go of its
    // turn, and is **publishing** when the next batch opens. Serialising the
    // store methods does not serialise what happens after them.
    const routeWrite = routes.steps.add(projectId, ownerId, 'Wiring');
    // The store write is done and its turn is released; the announcement has
    // not been offered to anybody yet.
    await beforeRoutePublish.reached;

    const batch = runner.run(projectId, ownerId, REFUSED_BATCH);
    // The batch is inside its own hold, which is what makes the next line the
    // window rather than a sequence.
    await insideTheBatch.reached;
    beforeRoutePublish.release();
    // A turn each way, so the route's publish is made while the hold is open.
    await Promise.resolve();
    await Promise.resolve();
    insideTheBatch.release();

    expect((await batch).ok).toBe(false);
    expect((await routeWrite).ok).toBe(true);

    // Exactly once: not dropped with the refused batch's own announcements, and
    // not sent twice by a retry.
    // Proof, twice, because the mechanism changed under this case. On the
    // ambient shape: `DeferringBroadcaster`'s per-caller `AsyncLocalStorage`
    // queue replaced by one instance-state array — the process-wide slot D24
    // refuses, and the shape this code shipped with before TASK-256. On the
    // collector: the route's graph publishing into whichever collector the
    // batch built, which is the same fault said in the new vocabulary. Both
    // failed on `Expected length: 1 · Received length: 0` — the route's
    // committed event joined the refused batch and was dropped with it.
    // Watched 2026-09-08.
    const added = broadcast.sent.filter((each) => each.event.type === 'step_added');
    expect(added).toHaveLength(1);
  });

  it('(f) holds a batch’s own events until it has committed', async () => {
    insideTheBatch.release();
    const applied = await runner.run(projectId, ownerId, [
      { kind: 'createWorkItem', ref: 'a', parentId: null, afterId: null, name: 'A' },
    ]);
    expect(applied.ok).toBe(true);
    expect(broadcast.sent.map((each) => each.event.type)).toContain('tree_replaced');
  });

  it('(g) sends nothing a refused batch announced', async () => {
    insideTheBatch.release();
    const refused = await runner.run(projectId, ownerId, REFUSED_BATCH);
    expect(refused.ok).toBe(false);
    expect(broadcast.sent).toEqual([]);
  });
});
