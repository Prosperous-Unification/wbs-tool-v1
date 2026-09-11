import { inMemoryUsers } from '@wbs/store-memory/auth-fixture';
import { inMemoryProjects, projectRow } from '@wbs/store-memory/project-fixture';
import { describe, expect, test } from 'bun:test';

import type { AuthenticatedUser } from '../service/auth.service';
import { PlanCommandRunner } from '../service/plan-commands';
import { inMemoryServices } from '../testing/harness';
import { batchServices, testWrites } from '../testing/writes-fixture';
import { replay } from './replay';
import { retentionSweep } from './retention-sweep';
import { runCommandBatch } from './run-command-batch';
import { savePlan } from './save-plan';

const writer: AuthenticatedUser = { id: 'owner', username: 'Ada', scopes: ['read', 'write'] };
const reader: AuthenticatedUser = { ...writer, scopes: ['read'] };

describe('runCommandBatch', () => {
  test('refuses a read-only actor before the runner can mutate', async () => {
    const mutations: string[] = [];
    const outcome = await runCommandBatch(
      {
        run: () => {
          mutations.push('mutated');
          return Promise.resolve({ ok: true, results: [], undoable: false, redoable: false });
        },
        runDirectory: () => Promise.reject(new Error('directory runner must not be called')),
      },
      { projectId: 'p1', actor: reader, commands: [] },
    );
    // Proof: deleting the write-scope branch returned ok:true here instead of this refusal.
    expect(outcome).toEqual({ ok: false, error: 'insufficient_scope' });
    expect(mutations).toEqual([]);
  });

  test('refuses a trusted actor absent from the account and project authorization state', async () => {
    const accounts = inMemoryUsers();
    const projects = inMemoryProjects(accounts);
    await projects.create(projectRow({ id: 'p1', ownerId: 'owner', restricted: true }), [], {
      at: 1,
      by: 'owner',
    });
    const plan = inMemoryServices({ projects });
    const writes = testWrites(undefined, batchServices(plan));
    const runner = new PlanCommandRunner({
      batchServices: writes.batch,
      publicServices: batchServices(plan),
      uow: writes.uow,
      announcements: writes.announcements,
    });
    const absent: AuthenticatedUser = {
      id: 'absent',
      username: 'Authenticated elsewhere',
      scopes: ['read', 'write'],
    };

    expect(await accounts.findById(absent.id)).toBeNull();
    expect(await plan.stores.workItems.listByProject('p1')).toEqual([]);
    expect(
      await runCommandBatch(runner, {
        projectId: 'p1',
        actor: absent,
        commands: [{ kind: 'createWorkItem', name: 'Must not exist' }],
      }),
    ).toEqual({ ok: false, at: 0, kind: 'createWorkItem', reason: 'forbidden' });
    // Proof: replacing absent.id with "owner" returned ok:true and created one work item.
    expect(await plan.stores.workItems.listByProject('p1')).toEqual([]);
    expect(writes.uow.calls).toEqual(['begin', 'rollback']);
  });
});

describe('savePlan', () => {
  function graph(
    project: { ownerId: string; restricted: boolean } | null,
    saved: 'saved' | 'refused' | 'snapshot_busy',
  ) {
    const effects: string[] = [];
    return {
      effects,
      value: {
        projects: { read: () => Promise.resolve(project === null ? null : { project }) },
        plans: {
          save: () => {
            effects.push('save');
            return Promise.resolve(
              saved === 'saved'
                ? { outcome: 'saved' as const, record: { id: 's1' } as never }
                : saved === 'refused'
                  ? {
                      outcome: 'refused' as const,
                      refusal: { limit: 'plan_count' as const, asked: 2, allowed: 1 },
                    }
                  : { outcome: 'snapshot_busy' as const },
            );
          },
        },
        announcements: { publish: () => Promise.resolve(void effects.push('publish')) },
      },
    };
  }

  test('refuses read-only, wrong-owner, and absent-project calls before save', async () => {
    for (const [actor, project, error] of [
      [reader, { ownerId: 'owner', restricted: true }, 'insufficient_scope'],
      [writer, { ownerId: 'other', restricted: true }, 'forbidden'],
      [writer, null, 'not_found'],
    ] as const) {
      const fixture = graph(project, 'saved');
      // Proof: deleting the owner check returned outcome:saved for the wrong-owner row.
      expect(
        await savePlan(fixture.value as never, { projectId: 'p1', actor, name: 'Baseline' }),
      ).toEqual({
        outcome: error,
      });
      expect(fixture.effects).toEqual([]);
    }
  });

  test('publishes exactly once after success and never for quota or busy refusals', async () => {
    for (const stored of ['refused', 'snapshot_busy'] as const) {
      const fixture = graph({ ownerId: 'owner', restricted: true }, stored);
      await savePlan(fixture.value as never, { projectId: 'p1', actor: writer });
      // Proof: publishing before save produced ["publish", "save"] for the quota refusal.
      expect(fixture.effects).toEqual(['save']);
    }
    const fixture = graph({ ownerId: 'owner', restricted: true }, 'saved');
    await savePlan(fixture.value as never, { projectId: 'p1', actor: writer });
    expect(fixture.effects).toEqual(['save', 'publish']);
  });
});

test('replay refuses a noninternal principal without calling the orchestrator', async () => {
  let calls = 0;
  expect(
    await replay(
      { replay: () => (calls++, Promise.resolve({})) },
      { resumePoints: {}, principal: writer },
    ),
  ).toEqual({ status: 'denied', reason: 'noninternal' });
  expect(calls).toBe(0);
});

test('retention refuses a noninternal principal without pruning either store', async () => {
  const calls: string[] = [];
  expect(
    await retentionSweep(
      {
        eventLog: { pruneBeyond: () => (calls.push('log'), Promise.resolve(0)) },
        planEvents: { pruneOlderThan: () => (calls.push('plans'), Promise.resolve(0)) },
        maxPerSubscription: 10,
        retainDays: 30,
        now: () => 100,
      },
      { principal: writer },
    ),
  ).toEqual({ outcome: 'forbidden' });
  expect(calls).toEqual([]);
});
