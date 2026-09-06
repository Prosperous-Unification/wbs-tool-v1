import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger } from '@wbs/observability';
import { afterEach, describe, expect, it } from 'bun:test';

import { openDrizzle } from './repository/db';
import { DrizzleEventLogRepo } from './repository/event-log';
import { runMigrations } from './repository/migrate';
import { ProjectRepository } from './repository/project';
import { UserRepository } from './repository/user';
import { WriteLock } from './service/write-lock';
import { buildServices } from './services';
import { projectRow } from './testing/project-fixture';

const FOLDER = new URL('../drizzle', import.meta.url).pathname;

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function bootstrap() {
  const dir = mkdtempSync(join(tmpdir(), 'wbs-services-'));
  dirs.push(dir);
  const path = join(dir, 'test.db');
  runMigrations(path, FOLDER);
  const db = openDrizzle(path);
  const services = buildServices({
    db,
    lock: new WriteLock(),
    logger: createLogger({ service: 'be-01' }),
    jwtKey: 'k'.repeat(32),
    gwUrl: 'http://gw.invalid',
    internalAuthSecret: 's'.repeat(32),
  });
  return { db, services };
}

async function seedProject(db: ReturnType<typeof openDrizzle>): Promise<{
  projectId: string;
  ownerId: string;
}> {
  const ownerId = crypto.randomUUID();
  await new UserRepository(db).create(
    {
      id: ownerId,
      username: 'owner',
      passwordHash: 'x',
      createdAt: 1,
    },
    { at: 1, by: ownerId },
  );
  const projectId = crypto.randomUUID();
  const project = await new ProjectRepository(db).create(
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
  it('gives the broadcaster and the replay orchestrator the same buffer', async () => {
    // The wiring, not the classes. `GatewayBroadcaster` filling a buffer and
    // `ReplayOrchestrator` reading one were each proven in isolation, and both
    // proofs would have survived this file handing them two different buffers:
    // replay would still work, silently, off the database on every reconnect.
    //
    // Proof: `buffer: replayBuffer` in `services.ts` replaced with a freshly
    // constructed `new ReplayBuffer(...)` and only this test failed.
    const { db, services } = bootstrap();
    const { projectId, ownerId } = await seedProject(db);

    // The push has nowhere to go — `gw.invalid` — which is deliberate: the
    // buffer must be filled by the recording, not by a successful delivery.
    await services.workItems.create(projectId, ownerId, {
      parentId: null,
      afterId: null,
      name: 'Strip',
    });

    const subscription = `project:${projectId}`;
    const fromBuffer = await services.replay.replay({ [subscription]: -1 });
    expect(fromBuffer[subscription]).toMatchObject({ status: 'replaying' });

    // Emptying the log leaves the replay intact, which it could only do if the
    // event is in the buffer the orchestrator was handed.
    await new DrizzleEventLogRepo(db).pruneBeyond(0);
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
    const log = new DrizzleEventLogRepo(db);
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
    const log = new DrizzleEventLogRepo(db);
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
    ).toEqual({ ok: false, reason: 'not_found' });
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
    // `toEqual` catches a changed value and `JSON.stringify` catches a changed
    // key order — the same rows in a different order are the same object to
    // `toEqual` and a different response to a client diffing text.
    const { db, services } = bootstrap();
    const { projectId, ownerId } = await seedProject(db);

    // An empty tree would be equal to itself whatever the marker writes did.
    await services.workItems.create(projectId, ownerId, {
      parentId: null,
      afterId: null,
      name: 'Strip',
    });

    const withoutSeq = ({ seq: _seq, ...rest }: Record<string, unknown>) => rest;

    const unchangedExceptSeq = (
      after: Awaited<ReturnType<typeof services.workItems.tree>>,
      before: Awaited<ReturnType<typeof services.workItems.tree>>,
    ): void => {
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
    const baseline = await services.workItems.tree(projectId);

    expect(
      (
        await services.calendarMarkers.create(projectId, ownerId, {
          id: markerId,
          date: '2026-03-02',
          name: 'Freeze',
        })
      ).ok,
    ).toBe(true);
    const created = await services.workItems.tree(projectId);
    unchangedExceptSeq(created, baseline);

    expect((await services.calendarMarkers.rename(projectId, markerId, ownerId, 'Thaw')).ok).toBe(
      true,
    );
    const renamed = await services.workItems.tree(projectId);
    unchangedExceptSeq(renamed, created);

    expect(
      (await services.calendarMarkers.recolor(projectId, markerId, ownerId, '#3366cc')).ok,
    ).toBe(true);
    const recoloured = await services.workItems.tree(projectId);
    unchangedExceptSeq(recoloured, renamed);

    expect((await services.calendarMarkers.remove(projectId, markerId, ownerId)).ok).toBe(true);
    unchangedExceptSeq(await services.workItems.tree(projectId), recoloured);
  });
});
