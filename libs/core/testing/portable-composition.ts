import { noopLogger } from '@wbs/contracts';
import { openMemorySource } from '@wbs/store-memory';

import { composeServices, type RuntimePorts, type SharedComposition } from '../src/compose';
import { clockOf } from '../src/ports/clock';
import { PlanCommandRunner } from '../src/service/plan-commands';
import { fastScheduler } from '../src/testing/scheduler-fixture';
import { replay } from '../src/use-cases/replay';
import { runCommandBatch } from '../src/use-cases/run-command-batch';
import { savePlan } from '../src/use-cases/save-plan';

type OperationName = 'batch' | 'save' | 'replay' | 'retention';

// Proof: assigning a string to a number in this file made `core:typecheck`
// fail here with TS2322, proving the referenced portable tsconfig discovers it.
export interface PortableCompletion {
  readonly operations: Record<OperationName, boolean>;
  readonly pushed: number;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function signal(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => {
    throw new Error('signal resolved before construction');
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function controllableIntervals(): {
  readonly port: RuntimePorts['intervals'];
  readonly fire: () => void;
} {
  let tick = (): void => {
    throw new Error('retention fired before it was started');
  };
  return {
    port: {
      every: (_milliseconds, callback) => {
        tick = callback;
        return () => undefined;
      },
    },
    fire: () => {
      tick();
    },
  };
}

async function digest(bytes: string): Promise<string> {
  const encoded = new TextEncoder().encode(bytes);
  const hashed = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashed), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const shared: SharedComposition = {
  logger: noopLogger,
  replayMaxPerSubscription: 4,
  replayMaxAgeMs: 300_000,
  replayMaxEvents: 32,
  retentionIntervalMs: 60_000,
  planEventRetentionDays: 1,
};

/** Executes the source-independent composition in the runtime that imports this module. */
export async function runPortableComposition(): Promise<PortableCompletion> {
  const completed = new Set<OperationName>();
  const source = openMemorySource();
  const intervals = controllableIntervals();
  const pushed: unknown[] = [];
  let nextId = 0;
  const clock = clockOf({ now: () => 172_800_000, newId: () => `browser-${String(++nextId)}` });
  const graph = composeServices({
    source,
    runtime: {
      clock,
      digest: { sha256: digest },
      timers: { nowMs: () => clock.now(), schedule: () => () => undefined },
      intervals: intervals.port,
      push: {
        push: (payload) => {
          pushed.push(payload);
          return Promise.resolve({ delivered: 1 });
        },
      },
      scheduler: fastScheduler,
      passwords: {
        hash: (password) => Promise.resolve(password),
        verify: (password, hash) => Promise.resolve(password === hash),
      },
      tokens: {
        sign: ({ subject, username }) => Promise.resolve(`${subject}:${username}`),
        verify: () => Promise.resolve(null),
      },
    },
    shared,
  });
  const runner = new PlanCommandRunner({
    batchServices: graph.batch,
    publicServices: graph,
    uow: graph.uow,
    announcements: graph.announcements,
  });
  const actor = { id: 'owner', username: 'owner', scopes: ['write'] as const };

  try {
    const project = await graph.projects.create('Browser composition', actor.id);
    const deniedBatch = await runCommandBatch(runner, {
      projectId: project.project.id,
      actor: { id: 'reader', username: 'reader', scopes: ['read'] },
      commands: [],
    });
    assert(
      !deniedBatch.ok && 'error' in deniedBatch,
      'batch accepted an actor without write scope',
    );
    const committed = await runCommandBatch(runner, {
      projectId: project.project.id,
      actor,
      commands: [
        { kind: 'createTeam', ref: 'team', name: 'Browser team' },
        {
          kind: 'createWorkItem',
          ref: 'work',
          parentId: null,
          afterId: null,
          name: 'Committed in Chromium',
        },
      ],
    });
    assert(committed.ok, 'mixed-store browser batch was refused');
    const refused = await runCommandBatch(runner, {
      projectId: project.project.id,
      actor,
      commands: [
        { kind: 'createTeam', name: 'Rolled back team' },
        {
          kind: 'setEstimate',
          workItemId: 'absent',
          stepId: project.steps[0]?.id ?? 'absent-step',
          days: { optimistic: 1, realistic: 2, pessimistic: 3 },
        },
      ],
    });
    assert(!refused.ok, 'invalid browser batch committed');
    const teamNames = (await graph.directory.listTeams()).map((team) => team.name);
    assert(
      teamNames.length === 1 && teamNames[0] === 'Browser team',
      'refused browser batch leaked a staged write',
    );
    completed.add('batch');

    await graph.projects.update(project.project.id, actor.id, { restricted: true });
    const deniedSave = await savePlan(graph, {
      projectId: project.project.id,
      actor: { id: 'reader', username: 'reader', scopes: ['write'] },
      name: 'Denied',
    });
    assert(deniedSave.outcome === 'forbidden', 'foreign browser save was admitted');
    const saved = await savePlan(graph, {
      projectId: project.project.id,
      actor,
      name: 'Browser snapshot',
    });
    assert(saved.outcome === 'saved', 'browser save did not persist');
    const readBack = await graph.savedPlans.read(saved.record.id);
    // Proof: making memorySavedPlans.write return `written` without storing the
    // plan failed here with "saved browser plan was not readable" in Chromium.
    assert(readBack.outcome === 'read', 'saved browser plan was not readable');
    completed.add('save');

    const subscription = `project:${project.project.id}`;
    const before = await source.stores.eventLog.latestSeq(subscription);
    for (const name of ['First replay event', 'Second replay event']) {
      const outcome = await runCommandBatch(runner, {
        projectId: project.project.id,
        actor,
        commands: [{ kind: 'createWorkItem', name, parentId: null, afterId: null }],
      });
      assert(outcome.ok, `${name} batch was refused`);
    }
    const buffered = await replay(graph.replay, {
      resumePoints: { [subscription]: before },
      principal: { kind: 'internal' },
    });
    assert(!('status' in buffered), 'internal replay was denied');
    const replayed = buffered[subscription];
    assert(replayed.status === 'replaying' && replayed.events.length === 2, 'replay lost events');
    await source.stores.eventLog.pruneBeyond(0);
    const afterPrune = await replay(graph.replay, {
      resumePoints: { [subscription]: before },
      principal: { kind: 'internal' },
    });
    assert(
      JSON.stringify(afterPrune) === JSON.stringify(buffered),
      'replay did not use its buffer',
    );
    completed.add('replay');

    const retentionSubscription = 'retention:portable-probe';
    for (let sequence = 0; sequence < 6; sequence += 1) {
      await source.stores.eventLog.recordEvent(
        retentionSubscription,
        { marker: `retention-${String(sequence)}` },
        clock.now(),
      );
    }
    const entered = signal();
    const release = signal();
    const heldBatch = source.uow.run(async () => {
      entered.resolve();
      await release.promise;
      return { commit: false, value: undefined };
    });
    await entered.promise;
    graph.retention.start();
    intervals.fire();
    let stopped = false;
    const stoppedRetention = graph.retention.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    assert(!stopped, 'retention did not wait for the admitted batch');
    release.resolve();
    await Promise.all([heldBatch, stoppedRetention]);
    assert(stopped, 'retention did not drain after batch release');
    const retained = await source.stores.eventLog.rangeSince(retentionSubscription, -1);
    const retainedRows = retained.map(({ seq, message }) => ({ seq, message }));
    // Proof: making the production memory adapter's `pruneBeyond` return zero
    // without pruning failed in Chromium with `retention kept` followed by all
    // six rows (sequences 0 through 5), instead of the expected 2 through 5.
    assert(
      JSON.stringify(retainedRows) ===
        JSON.stringify([
          { seq: 2, message: { marker: 'retention-2' } },
          { seq: 3, message: { marker: 'retention-3' } },
          { seq: 4, message: { marker: 'retention-4' } },
          { seq: 5, message: { marker: 'retention-5' } },
        ]),
      `retention kept ${JSON.stringify(retainedRows)}`,
    );
    completed.add('retention');

    const operations = {
      batch: completed.has('batch'),
      save: completed.has('save'),
      replay: completed.has('replay'),
      retention: completed.has('retention'),
    };
    return {
      operations,
      pushed: pushed.length,
    };
  } finally {
    await graph.retention.stop();
    await source.close();
  }
}

Object.defineProperty(window, 'portableComposition', {
  configurable: false,
  enumerable: true,
  value: runPortableComposition(),
  writable: false,
});
