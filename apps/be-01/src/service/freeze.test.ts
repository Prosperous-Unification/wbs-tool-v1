import { beforeEach, describe, expect, it } from 'bun:test';

import type { Project, ProjectStore, WorkItemStore } from '../repository';
import { inMemoryActuals } from '../testing/actual-fixture';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
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
import { WorkItemService } from './work-item.service';

const OWNER = 'owner-account';

let projects: ProjectStore;
let workItems: WorkItemStore;
let service: WorkItemService;
let projectId: string;

beforeEach(async () => {
  projects = inMemoryProjects();
  workItems = inMemoryWorkItems();
  service = new WorkItemService({
    workItems,
    projects,
    estimates: inMemoryEstimates(workItems),
    actuals: inMemoryActuals(workItems),
    measures: inMemoryMeasures(workItems),
    progress: inMemoryProgress(workItems),
    dependencies: inMemoryDependencies(),
    directory: inMemoryDirectory(),
    capacity: inMemoryCapacity(),
    priorityBands: inMemoryPriorityBands(),
    journal: inMemoryCommandJournal(),
    broadcast: recordingBroadcaster(),
  });
  const project: Project = {
    id: crypto.randomUUID(),
    name: 'Rewire the shed',
    ownerId: OWNER,
    restricted: false,
    estimateMethod: 'pert',
    startDate: null,
    revision: 0,
    createdAt: 1,
  };
  await projects.create(project, []);
  projectId = project.id;
});

async function add(name: string, afterId: string | null = null): Promise<string> {
  const outcome = await service.create(projectId, OWNER, { parentId: null, afterId, name });
  if (!outcome.ok) throw new Error(`create failed: ${outcome.reason}`);
  return outcome.result.id;
}

async function numbered(): Promise<Record<string, string>> {
  const tree = await service.tree(projectId);
  if (tree === null) throw new Error('project vanished');
  return Object.fromEntries(tree.workItems.map((w) => [w.name, w.number]));
}

async function storedNumbers(): Promise<(string | null)[]> {
  const rows = await workItems.listByProject(projectId);
  return rows.sort((a, b) => a.position - b.position).map((w) => w.frozenNumber);
}

describe('freezing', () => {
  it('writes every derived number into storage', async () => {
    await add('Strip');
    const strip = (await workItems.listByProject(projectId))[0]?.id ?? '';
    await add('Cable', strip);

    await service.freeze(projectId, OWNER);

    expect(await storedNumbers()).toEqual(['010', '020']);
  });

  it('leaves later work items deriving until the next freeze', async () => {
    const strip = await add('Strip');
    await add('Cable', strip);
    await service.freeze(projectId, OWNER);

    await add('Survey', strip);

    expect(await numbered()).toEqual({ Strip: '010', Survey: '011', Cable: '020' });
    expect(await storedNumbers()).toEqual(['010', null, '020']);
  });

  it('a second freeze pins the newcomer and rewrites neither neighbour', async () => {
    const strip = await add('Strip');
    await add('Cable', strip);
    await service.freeze(projectId, OWNER);
    await add('Survey', strip);

    await service.freeze(projectId, OWNER);

    expect(await storedNumbers()).toEqual(['010', '011', '020']);
  });

  it('unfreezing the project clears every stored number', async () => {
    const strip = await add('Strip');
    await add('Cable', strip);
    await service.freeze(projectId, OWNER);

    await service.unfreezeProject(projectId, OWNER);

    expect(await storedNumbers()).toEqual([null, null]);
  });

  it('unfreezing one work item releases only that one', async () => {
    const strip = await add('Strip');
    const cable = await add('Cable', strip);
    await service.freeze(projectId, OWNER);

    await service.unfreeze(cable, OWNER);

    expect(await storedNumbers()).toEqual(['010', null]);
  });
});

describe('a frozen work item cannot move', () => {
  it('refuses the move and writes no position', async () => {
    // The number has left the tool — it is in someone's ticket. Moving the row
    // would either break that reference or silently stop meaning what it said.
    const strip = await add('Strip');
    const cable = await add('Cable', strip);
    await service.freeze(projectId, OWNER);

    const outcome = await service.move(cable, OWNER, { parentId: null, afterId: null });

    expect(outcome).toEqual({ ok: false, reason: 'frozen' });
    expect(await numbered()).toEqual({ Strip: '010', Cable: '020' });
  });

  it('allows the move once it is unfrozen', async () => {
    const strip = await add('Strip');
    const cable = await add('Cable', strip);
    await service.freeze(projectId, OWNER);
    await service.unfreeze(cable, OWNER);

    const outcome = await service.move(cable, OWNER, { parentId: null, afterId: null });

    expect(outcome.ok).toBe(true);
    expect(await numbered()).toEqual({ Cable: '005', Strip: '010' });
  });
});

describe('deletion against a frozen project', () => {
  it('leaves the hole where the deleted number was', async () => {
    // The counterpart of the unfrozen rule in section 4: there, deleting 020
    // closes the gap and 030 becomes 020. Once frozen, 030 is a number someone
    // is working from, so the sequence keeps the hole instead.
    const strip = await add('Strip');
    const cable = await add('Cable', strip);
    await add('Test', cable);
    await service.freeze(projectId, OWNER);

    await service.remove(cable, OWNER, null);

    expect(await numbered()).toEqual({ Strip: '010', Test: '030' });
  });
});
