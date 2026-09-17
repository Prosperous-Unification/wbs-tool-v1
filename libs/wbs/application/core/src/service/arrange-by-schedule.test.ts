import { projectRow } from '@wbs/store-memory/project-fixture';
import { beforeEach, describe, expect, it } from 'bun:test';

import type { DependencyStore, Project, ProjectStore, WorkItemStore } from '../index';
import type { AvailableWorkItemService as WorkItemService } from '../testing/available-work-item-service';
import { type RecordingBroadcaster, recordingBroadcaster } from '../testing/broadcast-fixture';
import { inMemoryServices } from '../testing/harness';

const OWNER = 'owner-account';

let projects: ProjectStore;
let workItems: WorkItemStore;
let dependencies: DependencyStore;
let service: WorkItemService;
let broadcast: RecordingBroadcaster;
let projectId: string;

beforeEach(async () => {
  broadcast = recordingBroadcaster();
  const harness = inMemoryServices({ broadcast });
  ({ projects, workItems, dependencies } = harness.stores);
  service = harness.service;
  const project: Project = projectRow({ id: crypto.randomUUID(), ownerId: OWNER });
  await projects.create(project, [], { at: 1, by: OWNER });
  projectId = project.id;
});

async function add(name: string, afterId: string | null = null): Promise<string> {
  const outcome = await service.create(projectId, OWNER, { parentId: null, afterId, name });
  if (!outcome.ok) throw new Error(`create failed: ${outcome.reason}`);
  return outcome.value.id;
}

async function addUnder(parentId: string, name: string): Promise<string> {
  const outcome = await service.create(projectId, OWNER, { parentId, afterId: null, name });
  if (!outcome.ok) throw new Error(`create failed: ${outcome.reason}`);
  return outcome.value.id;
}

/** Waits `successorId` on `predecessorId`, which is what moves a start. */
async function waitOn(successorId: string, predecessorId: string): Promise<void> {
  const outcome = await service.addDependency(successorId, OWNER, predecessorId);
  if (!outcome.ok) throw new Error(`dependency refused: ${outcome.reason}`);
}

/** Name and number in the order the project reads. */
async function inOrder(): Promise<[string, string][]> {
  const tree = await service.tree(projectId);
  if (tree === null) throw new Error('project vanished');
  if ('kind' in tree) throw new Error('the engine was unavailable');
  return tree.workItems.map((row) => [row.name, row.number]);
}

async function positions(): Promise<Record<string, number>> {
  const rows = await workItems.listByProject(projectId);
  return Object.fromEntries(rows.map((row) => [row.name, row.position]));
}

describe('arrangeBySchedule', () => {
  it('puts the work item that starts first at the top', async () => {
    const first = await add('First');
    const second = await add('Second', first);
    await waitOn(first, second);

    const outcome = await service.arrangeBySchedule(projectId, OWNER);

    expect(outcome.ok).toBe(true);
    expect(await inOrder()).toEqual([
      ['Second', '010'],
      ['First', '020'],
    ]);
  });

  it('arranges a frozen work item with the rest, and leaves its number alone', async () => {
    // ADR 0023, end to end: the row moves, the label that left the tool travels
    // with it, and the numbers stop descending down the page.
    const first = await add('First');
    const second = await add('Second', first);
    await waitOn(first, second);
    await service.freeze(projectId, OWNER);

    const outcome = await service.arrangeBySchedule(projectId, OWNER);

    expect(outcome.ok).toBe(true);
    expect(await inOrder()).toEqual([
      ['Second', '020'],
      ['First', '010'],
    ]);
  });

  it('arranges a group at every depth', async () => {
    const branch = await add('Branch');
    const early = await addUnder(branch, 'Early');
    const late = await addUnder(branch, 'Late');
    await waitOn(late, early);
    // Written late-first so the group starts out of order.
    await service.move(early, OWNER, { parentId: branch, afterId: late });

    await service.arrangeBySchedule(projectId, OWNER);

    expect(await inOrder()).toEqual([
      ['Branch', '010'],
      ['Early', '010.1'],
      ['Late', '010.2'],
    ]);
  });

  it('writes nothing at all when the plan already reads in schedule order', async () => {
    const first = await add('First');
    await add('Second', first);
    const published = broadcast.published.length;

    const outcome = await service.arrangeBySchedule(projectId, OWNER);

    expect(outcome).toEqual({ ok: true, value: null });
    expect(await positions()).toEqual({ First: 10, Second: 20 });
    // No broadcast and no journal entry: `freeze`'s precedent for a write that
    // pinned nothing, and what keeps a second press off the undo stack.
    //
    // Proof: the `placements.length === 0` early return deleted — watched
    // failing on `Expected: 2 · Received: 3`, an arrangement of nothing
    // announcing a tree and stacking an undo; restored 2026-09-11.
    expect(broadcast.published.length).toBe(published);
  });

  it('refuses a plan whose dependencies run in a circle', async () => {
    const first = await add('First');
    const second = await add('Second', first);
    // Written straight into the store, because `addDependency` refuses the
    // second half at the boundary. A stored cycle is still reachable — the
    // schema does not prevent it — and it is what `scheduleError: 'cycle'`
    // exists for, so the command has to answer it rather than throw.
    const stamp = { at: 2, by: OWNER };
    await dependencies.add(
      { id: 'a->b', projectId, predecessorId: first, successorId: second },
      stamp,
    );
    await dependencies.add(
      { id: 'b->a', projectId, predecessorId: second, successorId: first },
      stamp,
    );

    expect(await service.arrangeBySchedule(projectId, OWNER)).toEqual({
      ok: false,
      reason: 'cycle',
    });
  });

  it('announces the tree once for one press', async () => {
    const first = await add('First');
    const second = await add('Second', first);
    await waitOn(first, second);
    const before = broadcast.published.length;

    await service.arrangeBySchedule(projectId, OWNER);

    expect(broadcast.published.length).toBe(before + 1);
  });

  it('leaves a work item that keeps its place where it is', async () => {
    // The revision half of this rule is a store contract and is proved where
    // revisions exist: `work-item.db.test.ts` › `bumps the revision of moved
    // rows only`. The in-memory fixture models no revisions at all — `move`
    // does not bump one either — so asserting it here would be asserting
    // against a fixture rather than against the rule.
    const first = await add('First');
    const second = await add('Second', first);
    const third = await add('Third', second);
    await waitOn(second, third);

    await service.arrangeBySchedule(projectId, OWNER);

    // `First` and `Third` both start on day zero and keep the order they read
    // in; `Second` waits for `Third` and falls to the bottom. So `First` holds
    // place zero and is respaced without having moved.
    expect(await positions()).toEqual({ First: 10, Third: 20, Second: 30 });
  });

  it('puts every work item back where it was when the press is undone', async () => {
    const first = await add('First');
    const second = await add('Second', first);
    await waitOn(first, second);
    const was = await positions();

    await service.arrangeBySchedule(projectId, OWNER);
    const undone = await service.undo(projectId, OWNER);

    expect(undone.ok).toBe(true);
    // The sentence the undo toast shows, which is the entry's own label: a
    // plan-wide act rather than one row's, exactly as `set_frozen`'s is.
    expect(undone.ok ? undone.value.done : '').toBe('arrange the plan by schedule');
    expect(await positions()).toEqual(was);
    expect(await inOrder()).toEqual([
      ['First', '010'],
      ['Second', '020'],
    ]);
  });

  it('re-applies the stored positions on a redo', async () => {
    const first = await add('First');
    const second = await add('Second', first);
    await waitOn(first, second);

    await service.arrangeBySchedule(projectId, OWNER);
    await service.undo(projectId, OWNER);
    const redone = await service.redo(projectId, OWNER);

    expect(redone.ok).toBe(true);
    expect(await inOrder()).toEqual([
      ['Second', '010'],
      ['First', '020'],
    ]);
  });

  it('undoes an arrangement whose work item has been frozen since', async () => {
    // No frozen guard on the replay, and that is ADR 0023 rather than an
    // omission: freezing a row between the press and the undo takes nothing
    // away, because a frozen work item moves like any other.
    const first = await add('First');
    const second = await add('Second', first);
    await waitOn(first, second);

    await service.arrangeBySchedule(projectId, OWNER);
    await service.freeze(projectId, OWNER);
    const undone = await service.undo(projectId, OWNER);

    expect(undone.ok).toBe(true);
  });

  it('refuses to arrange for somebody who cannot edit a restricted project', async () => {
    await add('First');
    await projects.update(projectId, { restricted: true }, { at: 3, by: OWNER });

    expect(await service.arrangeBySchedule(projectId, 'someone-else')).toEqual({
      ok: false,
      reason: 'forbidden',
    });
  });

  it('refuses a project that is not there', async () => {
    expect(await service.arrangeBySchedule(crypto.randomUUID(), OWNER)).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});
