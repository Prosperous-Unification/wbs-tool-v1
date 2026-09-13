import { deriveNumbers } from '@wbs/domain';
import { beforeEach, describe, expect, it } from 'bun:test';

import type { Project, ProjectStore } from '../repository';
import type { AvailableWorkItemService as WorkItemService } from '../testing/available-work-item-service';
import { type RecordingBroadcaster } from '../testing/broadcast-fixture';
import { inMemoryServices } from '../testing/harness';
import { projectRow } from '../testing/project-fixture';

const OWNER = 'owner-account';

let projects: ProjectStore;
let broadcast: RecordingBroadcaster;
let service: WorkItemService;
let projectId: string;

async function newProject(name: string): Promise<string> {
  const project: Project = projectRow({
    id: crypto.randomUUID(),
    name,
    ownerId: OWNER,
  });
  // Seeded with the step the estimates below name. The service refuses a step
  // the project does not hold, and production's foreign key refuses it harder.
  await projects.create(
    project,
    [{ id: 'step-dev', projectId: project.id, name: 'Dev', position: 10 }],
    { at: 1, by: OWNER },
  );
  return project.id;
}

beforeEach(async () => {
  const harness = inMemoryServices();
  ({ projects } = harness.stores);
  broadcast = harness.broadcast;
  service = harness.service;
  projectId = await newProject('Rewire the shed');
});

async function add(name: string, parentId: string | null = null, afterId: string | null = null) {
  const outcome = await service.create(projectId, OWNER, { parentId, afterId, name });
  if (!outcome.ok) throw new Error(`create failed: ${outcome.reason}`);
  return outcome.value.id;
}

async function numbersByName(): Promise<Record<string, string>> {
  const tree = await service.tree(projectId);
  if (tree === null) throw new Error('gone');
  return Object.fromEntries(tree.workItems.map((w) => [w.name, w.number]));
}

describe('review finding: a frozen number must survive its parent moving', () => {
  it('reports a frozen child by its stored number after the parent is renumbered', async () => {
    const first = await add('First');
    const parent = await add('Parent', null, first);
    await add('Child', parent);
    await service.freeze(projectId, OWNER);
    // Child is frozen at 020.1. Now unfreeze the parent alone and move it first.
    await service.unfreeze(parent, OWNER);

    await service.move(parent, OWNER, { parentId: null, afterId: null });

    expect((await numbersByName())['Child']).toBe('020.1');
  });
});

describe('review finding: promote must not duplicate a frozen number', () => {
  it('keeps promoted frozen children distinct from their new siblings', async () => {
    const root = await add('Root');
    const mid = await add('Mid', root);
    await add('MidChildOne', mid);
    await add('MidChildTwo', mid);
    await add('Second', root, mid);
    await service.freeze(projectId, OWNER);
    await service.unfreeze(mid, OWNER);

    await service.remove(mid, OWNER, 'promote');

    const numbers = Object.values(await numbersByName());
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

describe('review finding: a last child carries its descendants’ estimates up', () => {
  it('does not lose an estimate held below the deleted child', async () => {
    const parent = await add('Parent');
    const onlyChild = await add('OnlyChild', parent);
    const leaf = await add('Leaf', onlyChild);
    await service.setEstimate(leaf, OWNER, 'step-dev', {
      optimistic: 1,
      realistic: 2,
      pessimistic: 3,
    });

    await service.remove(onlyChild, OWNER, 'cascade');

    const tree = await service.tree(projectId);
    expect(tree?.workItems.find((w) => w.name === 'Parent')?.estimates['step-dev']).toEqual({
      optimistic: 1,
      realistic: 2,
      pessimistic: 3,
    });
  });
});

describe('review finding: a parent must belong to the same project', () => {
  it('refuses a parent from another project', async () => {
    const otherProject = await newProject('Someone else');
    const foreign = await service.create(otherProject, OWNER, {
      parentId: null,
      afterId: null,
      name: 'Theirs',
    });
    if (!foreign.ok) throw new Error('setup failed');

    const outcome = await service.create(projectId, OWNER, {
      parentId: foreign.value.id,
      afterId: null,
      name: 'Smuggled',
    });

    expect(outcome.ok).toBe(false);
  });
});

describe('review finding: unfreezing a project tells the other clients', () => {
  it('broadcasts the tree after a project unfreeze', async () => {
    await add('Strip');
    await service.freeze(projectId, OWNER);
    broadcast.published.length = 0;

    await service.unfreezeProject(projectId, OWNER);

    expect(broadcast.published.at(-1)?.event.type).toBe('tree_replaced');
  });
});

describe('review finding: two frozen anchors at different widths', () => {
  it('numbers the work item between them without a collision', () => {
    // This case used to **throw**: nothing digit-shaped sorts between `010` and
    // `0100`, `between()` had no right answer, and returning `0105` would have
    // put a row visibly out of order on an exported ticket.
    //
    // ADR 0023 removed the question rather than answering it. Labels are no
    // longer fitted between anchors, so a group's naturals are all that is on
    // offer: `0100` is not one of the three a group of three has, so it
    // consumes none of them and `mid` takes the first free — `020`. The number
    // no longer promises where the row sits, and `treeOrder` does.
    const numbers = deriveNumbers([
      { id: 'a', parentId: null, position: 10, frozenNumber: '010' },
      { id: 'mid', parentId: null, position: 15, frozenNumber: null },
      { id: 'b', parentId: null, position: 20, frozenNumber: '0100' },
    ]);

    expect(numbers.get('mid')).toBe('020');
    // What survives the change, and the only invariant a ticket needs: no two
    // siblings share a label.
    expect(new Set([...numbers.values()]).size).toBe(3);
  });
});
