import { projectRow } from '@wbs/store-memory/project-fixture';
import { beforeEach, describe, expect, it } from 'bun:test';

import type { Project, ProjectStore, WorkItemStore } from '../index';
import type { AvailableWorkItemService as WorkItemService } from '../testing/available-work-item-service';
import { inMemoryServices } from '../testing/harness';

const OWNER = 'owner-account';

let projects: ProjectStore;
let workItems: WorkItemStore;
let service: WorkItemService;
let projectId: string;

beforeEach(async () => {
  const harness = inMemoryServices();
  ({ projects, workItems } = harness.stores);
  service = harness.service;
  const project: Project = projectRow({
    id: crypto.randomUUID(),
    ownerId: OWNER,
  });
  await projects.create(project, [], { at: 1, by: OWNER });
  projectId = project.id;
});

async function add(name: string, afterId: string | null = null): Promise<string> {
  const outcome = await service.create(projectId, OWNER, { parentId: null, afterId, name });
  if (!outcome.ok) throw new Error(`create failed: ${outcome.reason}`);
  return outcome.value.id;
}

async function numbered(): Promise<Record<string, string>> {
  const tree = await service.tree(projectId);
  if (tree === null) throw new Error('project vanished');
  return Object.fromEntries(tree.workItems.map((w) => [w.name, w.number]));
}

/** Name and number in the order the project reads, which is what a move changes. */
async function inOrder(): Promise<[string, string][]> {
  const tree = await service.tree(projectId);
  if (tree === null) throw new Error('project vanished');
  return tree.workItems.map((w) => [w.name, w.number]);
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

    // `030` where this read `011` until ADR 0023: the newcomer takes the first
    // natural label its two frozen siblings leave free, instead of one fitted
    // between them so that a byte-wise sort still equalled tree order.
    expect(await numbered()).toEqual({ Strip: '010', Survey: '030', Cable: '020' });
    expect(await storedNumbers()).toEqual(['010', null, '020']);
  });

  it('a second freeze pins the newcomer and rewrites neither neighbour', async () => {
    const strip = await add('Strip');
    await add('Cable', strip);
    await service.freeze(projectId, OWNER);
    await add('Survey', strip);

    await service.freeze(projectId, OWNER);

    // `030`, per the case above; the neighbours are still not rewritten, which
    // is what this case is about.
    expect(await storedNumbers()).toEqual(['010', '030', '020']);
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

describe('a frozen work item moves, and keeps the number that left the tool', () => {
  /**
   * The inverse of the case that stood here until ADR 0023, kept rather than
   * deleted so the suite still names the behaviour in whichever direction it
   * runs. It refused with `frozen` and asserted the row had not moved.
   *
   * The reason given then — "the number has left the tool, it is in someone's
   * ticket" — is exactly why the number is reported verbatim below. It was
   * never a reason the *work* could not be somewhere else, and what the refusal
   * really protected was `deriveNumbers`' anchor walk.
   */
  it('moves a frozen work item and reports its number unchanged', async () => {
    const strip = await add('Strip');
    const cable = await add('Cable', strip);
    await service.freeze(projectId, OWNER);

    const outcome = await service.move(cable, OWNER, { parentId: null, afterId: null });

    expect(outcome.ok).toBe(true);
    // Both halves in one assertion, which is why it reads the order rather than
    // a record: `Cable` is now the first row, and it still reads `020`. The
    // numbers no longer descend down the page, and that is the cost ADR 0023
    // names out loud rather than the bug it looks like.
    expect(await inOrder()).toEqual([
      ['Cable', '020'],
      ['Strip', '010'],
    ]);
  });

  it('gives an unfrozen mover the first label its frozen sibling leaves free', async () => {
    const strip = await add('Strip');
    const cable = await add('Cable', strip);
    await service.freeze(projectId, OWNER);
    await service.unfreeze(cable, OWNER);

    const outcome = await service.move(cable, OWNER, { parentId: null, afterId: null });

    expect(outcome.ok).toBe(true);
    // `020`, where this answered `005` until ADR 0023 — a label fitted *below*
    // the frozen anchor so a byte-wise sort still equalled tree order. Nothing
    // sorts by the label now, so `Cable` simply takes the first natural that
    // `Strip` does not hold.
    expect(await inOrder()).toEqual([
      ['Cable', '020'],
      ['Strip', '010'],
    ]);
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
