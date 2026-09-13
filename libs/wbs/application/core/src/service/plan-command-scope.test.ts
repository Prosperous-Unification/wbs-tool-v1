import { describe, expect, it } from 'bun:test';

import type { PlanTransactionalStores } from '../ports/stores';
import type { Decision, Scope, UnitOfWork } from '../ports/unit-of-work';
import type { Broadcaster } from './broadcast';
import { PlanCommandRunner, type PlanCommandServices } from './plan-commands';

interface JournalEntry {
  id: string;
  name: string;
}

interface PlanState {
  names: string[];
  undo: JournalEntry[];
  redo: JournalEntry[];
  stale: boolean;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve = (): void => {
    throw new Error('deferred resolved before it was constructed');
  };
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function copyPlan(target: PlanState, source: PlanState): void {
  target.names = [...source.names];
  target.undo = source.undo.map((entry) => ({ ...entry }));
  target.redo = source.redo.map((entry) => ({ ...entry }));
  target.stale = source.stale;
}

function clonePlan(source: PlanState): PlanState {
  const clone: PlanState = { names: [], undo: [], redo: [], stale: false };
  copyPlan(clone, source);
  return clone;
}

function stagedSource() {
  const publicPlan: PlanState = { names: [], undo: [], redo: [], stale: false };
  const plans = new WeakMap<PlanTransactionalStores, PlanState>();
  const scopedStores: PlanTransactionalStores[] = [];
  const rollbackReached = deferred();
  const repairReached = deferred();
  const repairRelease = deferred();
  let repairStarted = false;
  let turn = Promise.resolve();

  const makeScope = (plan: PlanState): Scope => {
    const stores = {} as PlanTransactionalStores;
    plans.set(stores, plan);
    return { stores };
  };

  const uow: UnitOfWork = {
    run<T>(act: (scope: Scope) => Promise<Decision<T>>): Promise<T> {
      const before = turn;
      const released = deferred();
      turn = released.promise;
      return before.then(async () => {
        const staged = clonePlan(publicPlan);
        try {
          const decision = await act(makeScope(staged));
          if (decision.commit) {
            copyPlan(publicPlan, staged);
          } else if (decision.afterRollback !== undefined) {
            rollbackReached.resolve();
            await decision.afterRollback(makeScope(publicPlan));
          }
          return decision.value;
        } finally {
          released.resolve();
        }
      });
    },
  };

  return {
    publicPlan,
    plans,
    markRepairStarted: () => {
      repairStarted = true;
      repairReached.resolve();
    },
    repairStarted: () => repairStarted,
    rollbackReached,
    repairReached,
    repairRelease,
    scopedStores,
    uow,
  };
}

function silentBroadcaster(): Broadcaster {
  return {
    publish: () => Promise.resolve(),
    latestSeq: () => Promise.resolve(-1),
  };
}

describe('the command runner builds services from each unit-of-work scope', () => {
  it('settles staged writes, repairs through the surviving scope, and reads after commit publicly', async () => {
    const source = stagedSource();
    let publicAnnouncements = 0;
    let publicReads = 0;

    const servicesFor = (plan: PlanState, publicGraph: boolean): PlanCommandServices => {
      let dirty = false;
      const workItems = {
        async collect<T>(work: () => Promise<T>) {
          dirty = false;
          const outcome = await work();
          return { result: outcome, recordings: [], dirty };
        },
        recordCollected: () => Promise.resolve(),
        create(
          _projectId: string,
          _actorId: string,
          draft: { name?: string },
        ): Promise<{ ok: true; value: { id: string } }> {
          const name = draft.name ?? 'Work item';
          const entry = { id: `entry-${name}`, name };
          plan.names.push(name);
          plan.undo.push(entry);
          plan.redo = [];
          dirty = true;
          return Promise.resolve({ ok: true, value: { id: name } });
        },
        patch: () => Promise.resolve({ ok: false as const, reason: 'not_found' as const }),
        undoState: () => {
          if (publicGraph) publicReads += 1;
          return Promise.resolve({
            undoable: plan.undo.length > 0,
            redoable: plan.redo.length > 0,
          });
        },
        announceTreeNow: () => {
          if (publicGraph) publicAnnouncements += 1;
          return Promise.resolve();
        },
        undo: () => {
          const entry = plan.undo.at(-1);
          if (entry === undefined)
            return Promise.resolve({
              ok: false as const,
              reason: 'nothing_to_undo' as const,
              detail: null,
            });
          if (plan.stale) {
            plan.undo.pop();
            return Promise.resolve({
              ok: false as const,
              reason: 'stale_undo' as const,
              detail: `${entry.name} changed.`,
              entryId: entry.id,
            });
          }
          plan.undo.pop();
          plan.names = plan.names.filter((name) => name !== entry.name);
          plan.redo.push(entry);
          dirty = true;
          return Promise.resolve({
            ok: true as const,
            value: { done: `create ${entry.name}`, detail: null },
          });
        },
        redo: () => {
          const entry = plan.redo.pop();
          if (entry === undefined)
            return Promise.resolve({
              ok: false as const,
              reason: 'nothing_to_undo' as const,
              detail: null,
            });
          plan.names.push(entry.name);
          plan.undo.push(entry);
          dirty = true;
          return Promise.resolve({
            ok: true as const,
            value: { done: `create ${entry.name}`, detail: null },
          });
        },
        discardEntry: async (entryId: string) => {
          if (plan === source.publicPlan) {
            source.markRepairStarted();
            await source.repairRelease.promise;
          }
          plan.undo = plan.undo.filter((entry) => entry.id !== entryId);
          plan.redo = plan.redo.filter((entry) => entry.id !== entryId);
        },
      };
      return { workItems } as unknown as PlanCommandServices;
    };

    const runner = new PlanCommandRunner({
      batchServices: (scope, _broadcast) => {
        source.scopedStores.push(scope.stores);
        const plan = source.plans.get(scope.stores);
        if (plan === undefined) throw new Error('unit-of-work scope has no staged plan');
        return servicesFor(plan, false);
      },
      publicServices: servicesFor(source.publicPlan, true),
      uow: source.uow,
      announcements: silentBroadcaster(),
    });

    const refused = await runner.run('project', 'actor', [
      { kind: 'createWorkItem', parentId: null, afterId: null, name: 'rolled back' },
      { kind: 'patchWorkItem', workItemId: 'missing', patch: { name: 'still missing' } },
    ]);
    expect(refused.ok).toBe(false);
    expect(source.publicPlan.names).toEqual([]);

    const kept = await runner.run('project', 'actor', [
      { kind: 'createWorkItem', parentId: null, afterId: null, name: 'kept' },
    ]);
    expect(kept.ok).toBe(true);
    expect(source.publicPlan.names).toEqual(['kept']);

    expect((await runner.undo('project', 'actor')).ok).toBe(true);
    expect(source.publicPlan.names).toEqual([]);
    expect((await runner.redo('project', 'actor')).ok).toBe(true);
    expect(source.publicPlan.names).toEqual(['kept']);

    source.publicPlan.stale = true;
    const staleUndo = runner.undo('project', 'actor');
    await source.rollbackReached.promise;
    expect(source.repairStarted()).toBe(true);
    await source.repairReached.promise;
    let secondSettled = false;
    const second = runner
      .run('project', 'actor', [
        { kind: 'createWorkItem', parentId: null, afterId: null, name: 'later' },
      ])
      .then((outcome) => {
        secondSettled = true;
        return outcome;
      });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(source.publicPlan.names).toEqual(['kept']);
    expect(source.publicPlan.undo).toHaveLength(1);

    source.repairRelease.resolve();
    expect((await staleUndo).ok).toBe(false);
    expect(source.publicPlan.undo).toEqual([]);
    expect((await second).ok).toBe(true);
    expect(source.publicPlan.names).toEqual(['kept', 'later']);

    expect(source.scopedStores).toHaveLength(7);
    expect(new Set(source.scopedStores).size).toBe(7);
    expect(publicAnnouncements).toBe(4);
    expect(publicReads).toBe(2);
  });
});
