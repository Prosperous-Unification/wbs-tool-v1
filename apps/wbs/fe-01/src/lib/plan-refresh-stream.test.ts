import { afterEach, describe, expect, it, vi } from 'vitest';

import { planRead } from '../testing/views';
import { createPlanRefresh, resourcesFor } from './plan-refresh';
import { type ProjectStream, type SocketHandlers, subscribeToProject } from './project-stream';
import { type CalendarMarkerView, httpProjectApi } from './wbs-api';

/** The real stream reads location; this boundary runs under the browser test environment. */
interface Socket {
  sent: string[];
  handlers: SocketHandlers;
}

function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function scenario(initialSeq = -1) {
  let seq = initialSeq;
  let markers: (CalendarMarkerView & { projectId: string; createdAt: number })[] = [];
  let markerGate: ReturnType<typeof held<undefined>> | null = null;
  let markerStarted = held<undefined>();
  let treeGate: ReturnType<typeof held<undefined>> | null = null;
  let treeStarted = held<undefined>();
  const journal: { seq: number; message: { type: string } }[] = [];
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      requests.push(path);
      if (path === '/api/projects/p1/work-items') {
        const gate = treeGate;
        treeStarted.resolve(undefined);
        if (gate !== null) await gate.promise;
        return Response.json({
          ...planRead({ seq }),
          waitingForPerson: 0,
          waitingForCapacity: 0,
        });
      }
      if (path === '/api/projects/p1')
        return Response.json({
          project: {
            id: 'p1',
            name: 'Plan',
            ownerId: 'owner',
            restricted: false,
            estimateMethod: 'pert',
            depReach: 'whole-item',
            pertWeights: { optimistic: 1, realistic: 4, pessimistic: 1 },
            estimateRounding: 'ceil',
            startDate: null,
            solutionRef: null,
            revision: 0,
            createdAt: 0,
            optimizationEnabled: false,
            scheduleEngine: 'fast',
            scheduleObjective: 'pri',
          },
          steps: [],
        });
      if (path === '/api/projects/p1/calendar-markers') {
        const captured = Response.json({ markers });
        const gate = markerGate;
        markerStarted.resolve(undefined);
        if (gate !== null) await gate.promise;
        return captured;
      }
      const collections: Record<string, string | undefined> = {
        '/api/teams': 'teams',
        '/api/tags': 'tags',
        '/api/services': 'services',
        '/api/work-item-types': 'workItemTypes',
        '/api/external-systems': 'externalSystems',
        '/api/people': 'people',
      };
      const collection = collections[path];
      if (collection === undefined) throw new Error(`unmodeled API route ${path}`);
      return Response.json({ [collection]: [] });
    }),
  );
  const owner = createPlanRefresh({ projectId: 'p1', api: httpProjectApi('session') });
  const sockets: Socket[] = [];
  const timers: (() => void)[] = [];
  const pending: Promise<unknown>[] = [];
  let stream: ProjectStream | null = null;
  let acknowledged = -1;
  const stop = owner.subscribe(() => {
    const snapshot = owner.getSnapshot();
    if (snapshot.baseline !== null && stream === null) {
      acknowledged = snapshot.baseline.seq;
      stream = subscribeToProject(
        {
          projectId: 'p1',
          sinceSeq: snapshot.baseline.seq,
          hasBaseline: true,
          onChange: (kind, sequence) => {
            pending.push(
              kind == null && sequence === undefined
                ? owner.initialize()
                : owner.invalidate({ resources: resourcesFor(kind), seq: sequence }),
            );
          },
        },
        {
          openSocket: (_url, handlers) => {
            const socket = { sent: [] as string[], handlers };
            sockets.push(socket);
            return {
              send: (frame) => {
                socket.sent.push(frame);
              },
              close: () => undefined,
            };
          },
          schedule: (callback) => {
            timers.push(callback);
            return callback;
          },
          cancel: (callback) => {
            const index = timers.indexOf(callback as () => void);
            if (index !== -1) timers.splice(index, 1);
          },
          random: () => 0.5,
        },
      );
    }
    if (snapshot.acknowledged > acknowledged) {
      stream?.seen(snapshot.acknowledged);
      acknowledged = snapshot.acknowledged;
    }
  });
  const latest = () => {
    const socket = sockets.at(-1);
    if (socket === undefined) throw new Error('baseline has not opened a stream');
    return socket;
  };
  const resumePoint = () => {
    const frames = latest().sent.map(
      (frame) => JSON.parse(frame) as { type: string; resume_points?: Record<string, number> },
    );
    return frames.find((frame) => frame.type === 'resume')?.resume_points?.['project:p1'];
  };
  return {
    owner,
    requests,
    holdTree() {
      treeStarted = held<undefined>();
      treeGate = held<undefined>();
      return treeStarted.promise;
    },
    releaseTree() {
      const gate = treeGate;
      treeGate = null;
      if (gate === null) throw new Error('no held tree');
      gate.resolve(undefined);
    },
    holdMarkers() {
      markerStarted = held<undefined>();
      markerGate = held<undefined>();
      return markerStarted.promise;
    },
    releaseMarkers() {
      const gate = markerGate;
      markerGate = null;
      if (gate === null) throw new Error('no held marker read');
      gate.resolve(undefined);
    },
    commitMarker(name = 'Launch') {
      seq += 1;
      markers = [
        {
          id: 'launch',
          projectId: 'p1',
          name,
          date: '2026-09-06',
          color: '#2563eb',
          createdAt: 0,
        },
      ];
      journal.push({ seq, message: { type: 'calendar_markers_changed' } });
    },
    async overtakeMarkerWithTree() {
      seq += 1;
      const event = { seq, message: { type: 'tree_replaced' } };
      journal.push(event);
      latest().handlers.onMessage(JSON.stringify({ subscription: 'project:p1', ...event }));
      await Promise.all(pending.splice(0));
    },
    open: () => {
      latest().handlers.onOpen();
    },
    reconnect() {
      latest().handlers.onClose();
      const connect = timers.shift();
      if (connect === undefined) throw new Error('stream did not schedule reconnect');
      connect();
      latest().handlers.onOpen();
    },
    resumePoint,
    socketCount: () => sockets.length,
    async denyResume() {
      latest().handlers.onMessage(
        JSON.stringify({
          type: 'resume_denied',
          subscription: 'project:p1',
          reason: 'unavailable',
        }),
      );
      await Promise.all(pending.splice(0));
    },
    async replay() {
      const cursor = resumePoint();
      if (cursor === undefined) return;
      for (const event of journal.filter((event) => event.seq > cursor))
        latest().handlers.onMessage(JSON.stringify({ subscription: 'project:p1', ...event }));
      latest().handlers.onMessage(
        JSON.stringify({
          type: 'resume_ack',
          replayed: { 'project:p1': journal.filter((event) => event.seq > cursor).length },
        }),
      );
      await Promise.all(pending.splice(0));
    },
    close() {
      stop();
      owner.dispose();
      stream?.unsubscribe();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('real API reads and stream resume coverage', () => {
  it('replays event zero committed between an empty anchor and socket registration', async () => {
    const fixture = scenario();
    try {
      const started = fixture.holdMarkers();
      const initial = fixture.owner.initialize();
      await started;
      fixture.commitMarker();
      fixture.releaseMarkers();
      await initial;
      expect(fixture.owner.getSnapshot().directory.installed?.value.workItemTypes).toEqual([]);
      expect(fixture.owner.getSnapshot().directory.installed?.value.externalSystems).toEqual([]);
      expect(fixture.owner.getSnapshot().markers.installed?.value).toEqual([]);
      fixture.open();
      await fixture.replay();
      expect(fixture.owner.getSnapshot().markers.installed?.value[0]?.name).toBe('Launch');
      expect(fixture.resumePoint()).toBe(-1);
    } finally {
      fixture.close();
    }
  });

  it('does not resume past unseen marker B when a tree returned B before disconnect', async () => {
    const fixture = scenario(0);
    try {
      await fixture.owner.initialize();
      fixture.open();
      const started = fixture.holdMarkers();
      const markerRead = fixture.owner.invalidate({ resources: ['markers'] });
      await started;
      fixture.commitMarker();
      await fixture.owner.invalidate({ resources: ['tree'] });
      expect(fixture.owner.getSnapshot().tree.installed?.value.seq).toBe(1);
      fixture.releaseMarkers();
      await markerRead;
      expect(fixture.owner.getSnapshot().markers.installed?.value).toEqual([]);
      fixture.reconnect();
      await fixture.replay();
      expect(fixture.resumePoint()).toBe(0);
      expect(fixture.owner.getSnapshot().markers.installed?.value[0]?.name).toBe('Launch');
    } finally {
      fixture.close();
    }
  });
});

it('does not use a marker response captured before the initial tree anchor', async () => {
  const fixture = scenario();
  try {
    const started = fixture.holdTree();
    const initial = fixture.owner.initialize();
    await started;
    fixture.commitMarker();
    fixture.releaseTree();
    await initial;
    fixture.open();
    await fixture.replay();
    expect(fixture.resumePoint()).toBe(0);
    expect(fixture.owner.getSnapshot().markers.installed?.value[0]?.name).toBe('Launch');
  } finally {
    fixture.close();
  }
});

it('covers an unseen marker when live tree C overtakes B without another frame', async () => {
  const fixture = scenario();
  try {
    await fixture.owner.initialize();
    fixture.open();
    fixture.commitMarker();
    await fixture.overtakeMarkerWithTree();
    expect(fixture.owner.getSnapshot().markers.installed?.value[0]?.name).toBe('Launch');
    expect(fixture.owner.getSnapshot().acknowledged).toBe(1);
    expect(fixture.requests.filter((path) => path.endsWith('/calendar-markers'))).toHaveLength(2);
  } finally {
    fixture.close();
  }
});

it('covers registration changes after denied replay without opening another socket', async () => {
  const fixture = scenario();
  try {
    const started = fixture.holdMarkers();
    const initial = fixture.owner.initialize();
    await started;
    fixture.commitMarker();
    fixture.releaseMarkers();
    await initial;
    fixture.open();
    expect(fixture.owner.getSnapshot().markers.installed?.value).toEqual([]);
    await fixture.denyResume();
    expect(fixture.owner.getSnapshot().markers.installed?.value[0]?.name).toBe('Launch');
    expect(fixture.socketCount()).toBe(1);
    fixture.reconnect();
    expect(fixture.resumePoint()).toBe(0);
  } finally {
    fixture.close();
  }
});

it('covers a second registration gap while a refused replay recovery is held', async () => {
  const fixture = scenario();
  try {
    await fixture.owner.initialize();
    fixture.open();
    fixture.commitMarker();
    const started = fixture.holdMarkers();
    const firstRecovery = fixture.denyResume();
    await started;
    fixture.commitMarker('After reconnect');
    fixture.reconnect();
    const secondRecovery = fixture.denyResume();
    fixture.releaseMarkers();
    await Promise.all([firstRecovery, secondRecovery]);
    expect(fixture.owner.getSnapshot().markers.installed?.value[0]?.name).toBe('After reconnect');
    expect(fixture.socketCount()).toBe(2);
    fixture.reconnect();
    expect(fixture.resumePoint()).toBe(1);
  } finally {
    fixture.close();
  }
});
