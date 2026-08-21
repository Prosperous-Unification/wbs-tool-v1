import { beforeEach, describe, expect, it } from 'bun:test';

import type {
  ActualStore,
  EstimateStore,
  MeasureStore,
  Project,
  ProjectStore,
  RoleProgressStore,
  WorkItemStore,
} from '../repository';
import { inMemoryActuals } from '../testing/actual-fixture';
import { type RecordingBroadcaster, recordingBroadcaster } from '../testing/broadcast-fixture';
import { inMemoryCapacity } from '../testing/capacity-fixture';
import { inMemoryCommandJournal } from '../testing/command-journal-fixture';
import { inMemoryDependencies } from '../testing/dependency-fixture';
import { inMemoryDirectory } from '../testing/directory-fixture';
import { inMemoryEstimates } from '../testing/estimate-fixture';
import { inMemoryMeasures } from '../testing/measure-fixture';
import { inMemoryPriorityBands } from '../testing/priority-band-fixture';
import { inMemoryProgress } from '../testing/progress-fixture';
import { inMemoryProjects } from '../testing/project-fixture';
import { inMemoryWorkItems } from '../testing/work-item-fixture';
import { deriveNumbers } from './derive-numbers';
import { WorkItemService } from './work-item.service';

const OWNER = 'owner-account';

let projects: ProjectStore;
let workItems: WorkItemStore;
let estimates: EstimateStore;
let actuals: ActualStore;
let measures: MeasureStore;
let progress: RoleProgressStore;
let broadcast: RecordingBroadcaster;
let service: WorkItemService;
let projectId: string;

async function newProject(name: string): Promise<string> {
  const project: Project = {
    id: crypto.randomUUID(),
    name,
    ownerId: OWNER,
    restricted: false,
    estimateMethod: 'pert',
    startDate: null,
    revision: 0,
    createdAt: 1,
  };
  // Seeded with the role the estimates below name. The service refuses a role
  // the project does not hold, and production's foreign key refuses it harder.
  await projects.create(project, [
    { id: 'role-dev', projectId: project.id, name: 'Dev', position: 10 },
  ]);
  return project.id;
}

beforeEach(async () => {
  projects = inMemoryProjects();
  workItems = inMemoryWorkItems();
  estimates = inMemoryEstimates(workItems);
  actuals = inMemoryActuals(workItems);
  measures = inMemoryMeasures(workItems);
  progress = inMemoryProgress(workItems);
  broadcast = recordingBroadcaster();
  service = new WorkItemService({
    workItems,
    projects,
    estimates,
    actuals,
    measures,
    progress,
    dependencies: inMemoryDependencies(),
    directory: inMemoryDirectory(),
    capacity: inMemoryCapacity(),
    priorityBands: inMemoryPriorityBands(),
    journal: inMemoryCommandJournal(),
    broadcast,
  });
  projectId = await newProject('Rewire the shed');
});

async function add(name: string, parentId: string | null = null, afterId: string | null = null) {
  const outcome = await service.create(projectId, OWNER, { parentId, afterId, name });
  if (!outcome.ok) throw new Error(`create failed: ${outcome.reason}`);
  return outcome.result.id;
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
    await service.setEstimate(leaf, OWNER, 'role-dev', {
      optimistic: 1,
      realistic: 2,
      pessimistic: 3,
    });

    await service.remove(onlyChild, OWNER, 'cascade');

    const tree = await service.tree(projectId);
    expect(tree?.workItems.find((w) => w.name === 'Parent')?.estimates['role-dev']).toEqual({
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
      parentId: foreign.result.id,
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

describe('review finding: between() across a digit-width boundary', () => {
  it('refuses rather than emitting a number that sorts into the wrong place', () => {
    // Nothing digit-shaped sorts between `010` and `0100`, so there is no right
    // answer here. Throwing surfaces the corruption; returning `0105` — which is
    // what it used to do — puts the row visibly out of order and looks
    // deliberate enough to reach an exported ticket.
    expect(() =>
      deriveNumbers([
        { id: 'a', parentId: null, position: 10, frozenNumber: '010' },
        {
          id: 'mid',
          parentId: null,
          position: 15,
          frozenNumber: null,
          priority: null,
          startNoEarlierThan: null,
          serviceTeamId: null,
          serviceId: null,
        },
        { id: 'b', parentId: null, position: 20, frozenNumber: '0100' },
      ]),
    ).toThrow(/no label sorts between/);
  });
});
