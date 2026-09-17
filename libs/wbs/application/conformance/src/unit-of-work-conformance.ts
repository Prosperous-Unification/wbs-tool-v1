import type {
  PlanTransactionalStores,
  TransactionalStores,
  UnitOfWork,
  WriteStamp,
} from '@wbs/core';
import { expect, it } from 'bun:test';

/**
 * What a source hands the kit: a unit of work, the stores a **reader outside**
 * it sees, and a project and account its writes can hang off.
 *
 * The reader's stores are named separately from the scope's on purpose. Every
 * case here is about what is observable **after `run` settles**, and reading
 * through the same objects the act wrote through would make "observable" mean
 * "the act did it", which is true whatever the unit of work decided.
 */
export interface UnitOfWorkFixture {
  uow: UnitOfWork;
  reader: TransactionalStores;
  projectId: string;
  stamp: WriteStamp;
  /** Torn down by the caller; the kit opens nothing it does not close. */
  close?: () => void;
}

/**
 * The unit-of-work contract, as cases a source either passes or fails.
 *
 * Terminal atomicity is the whole of it (ADR 0015): once `run` settles, every
 * write its act made is observable, or none is. Isolation while the batch is
 * open is **not** promised and is not tested — SQLite's one connection shows
 * in-flight rows to a concurrent read, and a kit that asserted otherwise would
 * be describing a source nobody has.
 *
 * Called inside a `describe` the caller owns, so the source's name is in the
 * report and its `beforeEach` has already run.
 */
export function unitOfWorkConformance(open: () => UnitOfWorkFixture): void {
  const threeWrites = async (
    stores: PlanTransactionalStores,
    projectId: string,
    stamp: WriteStamp,
  ): Promise<void> => {
    await stores.steps.add({ id: crypto.randomUUID(), projectId, name: 'Wiring' }, stamp);
    await stores.directory.addTag({ id: crypto.randomUUID(), name: 'urgent' }, stamp);
    await stores.projects.update(projectId, { name: 'Rewired' }, stamp);
  };

  const written = async (
    reader: PlanTransactionalStores,
    projectId: string,
  ): Promise<{ steps: string[]; tags: string[]; name: string | undefined }> => ({
    steps: (await reader.steps.listByProject(projectId)).map((each) => each.name),
    tags: (await reader.directory.listTags()).map((each) => each.name),
    name: (await reader.projects.findById(projectId))?.name,
  });

  it('(a) makes none of a refused batch observable', async () => {
    const { uow, reader, projectId, stamp } = open();
    const answer = await uow.run(async (scope) => {
      await threeWrites(scope.stores, projectId, stamp);
      return { commit: false, value: 'refused' as const };
    });
    expect(answer).toBe('refused');
    const after = await written(reader, projectId);
    expect(after.steps).not.toContain('Wiring');
    expect(after.tags).not.toContain('urgent');
    expect(after.name).not.toBe('Rewired');
  });

  it('(b) makes none of a batch that threw observable, and rethrows', async () => {
    const { uow, reader, projectId, stamp } = open();
    const thrown = uow.run<never>(async (scope) => {
      await threeWrites(scope.stores, projectId, stamp);
      throw new Error('the third write went wrong');
    });
    expect(thrown).rejects.toThrow('the third write went wrong');
    await thrown.catch(() => undefined);
    const after = await written(reader, projectId);
    expect(after.steps).not.toContain('Wiring');
    expect(after.tags).not.toContain('urgent');
    expect(after.name).not.toBe('Rewired');
  });

  it('(c) makes all of a committed batch observable', async () => {
    const { uow, reader, projectId, stamp } = open();
    const answer = await uow.run(async (scope) => {
      await threeWrites(scope.stores, projectId, stamp);
      return { commit: true, value: 'applied' as const };
    });
    expect(answer).toBe('applied');
    const after = await written(reader, projectId);
    expect(after.steps).toContain('Wiring');
    expect(after.tags).toContain('urgent');
    expect(after.name).toBe('Rewired');
  });

  it('(h) lets a scope store write without waiting for the turn its batch holds', async () => {
    // The deadlock negative, and the reason `Scope` exists at all. A store on
    // the scope that asked the coordinator for a turn would wait for the one
    // this very `run` is holding, and the case times out rather than fails.
    //
    // Proof: the SQLite fixture's `admitted` built over the coordinator instead
    // of `OPEN`. Every case in this kit hung — the first reported `(a) makes
    // none of a refused batch observable ... this test timed out after 3000ms`
    // and the run had to be killed. A timeout is what a deadlock looks like
    // from outside, which is why the fault is named here rather than left to a
    // reader to infer from a hang. Watched 2026-09-08.
    const { uow, projectId, stamp } = open();
    const answer = await uow.run(async (scope) => {
      await scope.stores.steps.add({ id: crypto.randomUUID(), projectId, name: 'Wiring' }, stamp);
      return { commit: true, value: 'reached the end' as const };
    });
    expect(answer).toBe('reached the end');
  });

  it('(k) runs the repair after the rollback, over the surviving state', async () => {
    // The window undo needs: a refused batch discards the stale journal entry
    // it refused, and that discard must survive the rollback that took the
    // rest of the batch with it.
    const { uow, reader, projectId, stamp } = open();
    const survivor = crypto.randomUUID();
    await uow.run<'refused'>(async (scope) => {
      await scope.stores.steps.add({ id: crypto.randomUUID(), projectId, name: 'Wiring' }, stamp);
      return {
        commit: false,
        value: 'refused',
        afterRollback: async (repair) => {
          await repair.stores.steps.add({ id: survivor, projectId, name: 'Repaired' }, stamp);
        },
      };
    });
    const after = await written(reader, projectId);
    expect(after.steps).not.toContain('Wiring');
    expect(after.steps).toContain('Repaired');
  });

  it('(k) lets a failing repair surface as itself, with no second rollback', async () => {
    const { uow, reader, projectId, stamp } = open();
    const failing = uow.run<'refused'>(async (scope) => {
      await scope.stores.steps.add({ id: crypto.randomUUID(), projectId, name: 'Wiring' }, stamp);
      return {
        commit: false,
        value: 'refused',
        afterRollback: () => Promise.reject(new Error('the repair could not be made')),
      };
    });
    expect(failing).rejects.toThrow('the repair could not be made');
    await failing.catch(() => undefined);
    // And the source is still usable afterwards, which is what "no second
    // rollback" comes to: a `ROLLBACK` issued on a closed transaction throws
    // out of the next batch instead of this one.
    const answer = await uow.run(async (scope) => {
      await scope.stores.steps.add({ id: crypto.randomUUID(), projectId, name: 'After' }, stamp);
      return { commit: true, value: 'applied' as const };
    });
    expect(answer).toBe('applied');
    expect((await written(reader, projectId)).steps).toContain('After');
  });
}
