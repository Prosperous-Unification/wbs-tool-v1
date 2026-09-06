import { describe, expect, it, vi } from 'vitest';

import { fakeProjectApi } from '../testing/fake-project-api';
import { createPlanRefresh } from './plan-refresh';
import type { PlanRead } from './wbs-api';

function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function setup() {
  const api = fakeProjectApi();
  const owner = createPlanRefresh({ projectId: 'p1', api });
  expect((await owner.initialize()).status).toBe('installed');
  return { api, owner };
}

describe('plan refresh obligations', () => {
  it('starts unsequenced baseline reads only after its tree anchor', async () => {
    const api = fakeProjectApi();
    const before = await api.tree('p1');
    const anchor = held<PlanRead>();
    api.tree = () => anchor.promise;
    let markers = 0;
    api.listCalendarMarkers = () => {
      markers += 1;
      return Promise.resolve([]);
    };
    const owner = createPlanRefresh({ projectId: 'p1', api });
    const ready = owner.initialize();
    expect(markers).toBe(0);
    anchor.resolve(before);
    expect((await ready).status).toBe('installed');
    expect(markers).toBe(1);
    expect(owner.getSnapshot().baseline?.seq).toBe(before.seq);
    owner.dispose();
  });

  it('installs B with a trailing read without a third invalidation', async () => {
    const { api, owner } = await setup();
    const before = await api.tree('p1');
    const first = held<PlanRead>();
    let calls = 0;
    api.tree = () => (++calls === 1 ? first.promise : Promise.resolve({ ...before, seq: 22 }));
    const a = owner.invalidate({ resources: ['tree'] });
    const b = owner.invalidate({ resources: ['tree'] });
    first.resolve({ ...before, seq: 21 });
    await vi.waitFor(() => {
      expect(calls).toBe(2);
    });
    expect((await b).status).toBe('installed');
    expect((await a).status).toBe('installed');
    expect(calls).toBe(2);
    expect(owner.getSnapshot().tree.installed?.value.seq).toBe(22);
    owner.dispose();
  });

  it('keeps a held steps read authoritative when tree advances', async () => {
    const { api, owner } = await setup();
    const steps = held<Awaited<ReturnType<typeof api.steps>>>();
    api.steps = () => steps.promise;
    const wider = owner.invalidate({ resources: ['tree', 'steps'] });
    await owner.invalidate({ resources: ['tree'] });
    steps.resolve([{ id: 'renamed', name: 'Renamed' }]);
    expect((await wider).status).toBe('installed');
    expect(owner.getSnapshot().steps.installed?.value.at(0)?.name).toBe('Renamed');
    owner.dispose();
  });

  it('keeps failed markers stale through successful tree work until marker recovery', async () => {
    const { api, owner } = await setup();
    api.listCalendarMarkers = () => Promise.reject(new Error('marker outage'));
    expect((await owner.invalidate({ resources: ['markers'] })).status).toBe('failed');
    await owner.invalidate({ resources: ['tree'] });
    expect(owner.getSnapshot().staleResources).toEqual(['markers']);
    api.listCalendarMarkers = () => Promise.resolve([]);
    await owner.invalidate({ resources: ['markers'] });
    expect(owner.getSnapshot().staleResources).toEqual([]);
    owner.dispose();
  });

  it.each(['resolve', 'reject'] as const)(
    'ends pending obligations on disposal before a late %s',
    async (settle) => {
      const { api, owner } = await setup();
      const before = await api.tree('p1');
      const read = held<PlanRead>();
      api.tree = () => read.promise;
      const pending = owner.invalidate({ resources: ['tree'] });
      let notifications = 0;
      owner.subscribe(() => {
        notifications += 1;
      });
      owner.dispose();
      const departed = owner.getSnapshot();
      expect((await pending).status).toBe('disposed');
      if (settle === 'resolve') read.resolve(before);
      else read.reject(new Error('late'));
      await Promise.resolve();
      await Promise.resolve();
      expect(owner.getSnapshot()).toBe(departed);
      expect(notifications).toBe(0);
    },
  );
});

it('does not acknowledge an unseen marker event from a newer tree response', async () => {
  const { api, owner } = await setup();
  const initial = owner.getSnapshot().acknowledged;
  const tree = await api.tree('p1');
  api.tree = () => Promise.resolve({ ...tree, seq: initial + 1 });
  await owner.invalidate({ resources: ['tree'] });
  expect(owner.getSnapshot().acknowledged).toBe(initial);
  owner.dispose();
});

it('holds acknowledgment behind failed marker obligations while a later tree installs', async () => {
  const { api, owner } = await setup();
  const initial = owner.getSnapshot().acknowledged;
  api.listCalendarMarkers = () => Promise.reject(new Error('offline'));
  await owner.invalidate({ resources: ['markers'], seq: initial + 1 });
  await owner.invalidate({ resources: ['tree'], seq: initial + 2 });
  expect(owner.getSnapshot().acknowledged).toBe(initial);
  api.listCalendarMarkers = () => Promise.resolve([]);
  await owner.invalidate({ resources: ['markers'] });
  expect(owner.getSnapshot().acknowledged).toBe(initial + 2);
  owner.dispose();
});

it('recovers an unseen sequence gap through one anchored full read without another frame', async () => {
  const { api, owner } = await setup();
  const initial = owner.getSnapshot().acknowledged;
  const tree = await api.tree('p1');
  api.tree = () => Promise.resolve({ ...tree, seq: initial + 2 });
  api.listCalendarMarkers = () =>
    Promise.resolve([
      { id: 'missed', name: 'Missed marker', date: '2026-09-06', color: '#2563eb' },
    ]);
  await owner.invalidate({ resources: ['tree'], seq: initial + 2 });
  expect(owner.getSnapshot().markers.installed?.value.at(0)?.name).toBe('Missed marker');
  expect(owner.getSnapshot().acknowledged).toBe(initial + 2);
  owner.dispose();
});

it('retains directory installation when a newer tree completes', async () => {
  const { api, owner } = await setup();
  const teams = held<Awaited<ReturnType<typeof api.listTeams>>>();
  api.listTeams = () => teams.promise;
  const directory = owner.invalidate({ resources: ['directory', 'tree'] });
  await owner.invalidate({ resources: ['tree'] });
  teams.resolve([{ id: 'team-new', name: 'New team', serviceIds: [] }]);
  await directory;
  expect(owner.getSnapshot().directory.installed?.value.teams[0].name).toBe('New team');
  owner.dispose();
});

it('does not install a partial directory when one vocabulary fails', async () => {
  const { api, owner } = await setup();
  const previous = owner.getSnapshot().directory.installed;
  api.listTeams = () => Promise.resolve([{ id: 'new', name: 'New', serviceIds: [] }]);
  api.listPeople = () => Promise.reject(new Error('directory unavailable'));
  expect((await owner.invalidate({ resources: ['directory'] })).status).toBe('failed');
  expect(owner.getSnapshot().directory.installed).toBe(previous);
  owner.dispose();
});

it('retains a new sequence gap that arrives while an anchored resync is reading markers', async () => {
  const { api, owner } = await setup();
  const before = await api.tree('p1');
  let latest = 1;
  api.tree = () => Promise.resolve({ ...before, seq: latest });
  const markerRead = held<Awaited<ReturnType<typeof api.listCalendarMarkers>>>();
  const started = held<undefined>();
  let calls = 0;
  api.listCalendarMarkers = () => {
    calls += 1;
    if (calls === 1) {
      started.resolve(undefined);
      return markerRead.promise;
    }
    return Promise.resolve([
      { id: 'after-gap', date: '2026-09-06', name: 'After gap', color: '#2563eb' },
    ]);
  };
  const resync = owner.initialize();
  await started.promise;
  latest = 4;
  const later = owner.invalidate({ resources: ['tree'], seq: 4 });
  markerRead.resolve([]);
  await resync;
  await later;
  expect(owner.getSnapshot().markers.installed?.value[0]?.name).toBe('After gap');
  expect(owner.getSnapshot().acknowledged).toBe(4);
  owner.dispose();
});

it('does not install or complete a superseded read while its covering read is held', async () => {
  const { api, owner } = await setup();
  const original = owner.getSnapshot().tree.installed;
  const before = await api.tree('p1');
  const first = held<PlanRead>();
  const second = held<PlanRead>();
  let calls = 0;
  api.tree = () => (++calls === 1 ? first.promise : second.promise);
  let completed = false;
  const older = owner.invalidate({ resources: ['tree'] }).then(() => {
    completed = true;
  });
  const newer = owner.invalidate({ resources: ['tree'] });
  first.resolve({ ...before, seq: 21 });
  await vi.waitFor(() => {
    expect(calls).toBe(2);
  });
  expect(owner.getSnapshot().tree.installed).toBe(original);
  expect(completed).toBe(false);
  second.resolve({ ...before, seq: 22 });
  await Promise.all([older, newer]);
  expect(owner.getSnapshot().tree.installed?.value.seq).toBe(22);
  owner.dispose();
});
