import { describe, expect, it } from 'bun:test';

import type { Project, Role, StoredDependency, WorkItem } from '../repository';
import { ROLE_POSITION_STEP } from '../repository';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { inMemoryCapacity } from '../testing/capacity-fixture';
import { inMemoryCommandJournal } from '../testing/command-journal-fixture';
import { inMemoryDependencies } from '../testing/dependency-fixture';
import { inMemoryDirectory } from '../testing/directory-fixture';
import { inMemoryEstimates } from '../testing/estimate-fixture';
import { inMemoryPriorityBands } from '../testing/priority-band-fixture';
import { inMemoryProjects } from '../testing/project-fixture';
import { inMemorySubtrees } from '../testing/subtree-fixture';
import { inMemoryWorkItems } from '../testing/work-item-fixture';
import captured from './fixtures/live-plan-2026-08-09.json';
import type { Scheduled } from './schedule';
import { WorkItemService } from './work-item.service';

/**
 * A real project's `/work-items` response, captured from a running be-01 on
 * 2026-08-09, replayed through the service that answers it.
 *
 * The engine underneath was rewritten to plan in slices, and the change
 * promised no plan would move. A fixture written by the same hand as the change
 * cannot say whether that held — this is a plan somebody actually made, with
 * PERT thirds, a start date, a two-deep branch, a dependency and rows nobody has
 * estimated, and the assertion is every number the server printed for it.
 *
 * It goes in through `tree`, not through the planner: the projection, the
 * calendar and the adapter that turns estimates into slices are all part of what
 * must not have moved.
 */
interface CapturedRow {
  id: string;
  parentId: string | null;
  position: number;
  name: string;
  notes: string;
  startNoEarlierThan: string | null;
  serviceTeamId: string | null;
  revision: number;
  number: string;
  estimates: Record<string, { optimistic: number; realistic: number; pessimistic: number }>;
  dependsOn: string[];
  schedule: Scheduled;
  dates: { startsOn: string; endsOn: string } | null;
}

interface CapturedPlan {
  workItems: CapturedRow[];
  /** Narrow, not `EstimateMethod`: this capture is PERT, and the first test says so. */
  estimateMethod: 'pert';
  startDate: string;
  projectRevision: number;
}

// The boundary: a file captured from a live server, read as the fixture it is.
// Nothing here validates it into existence — the first test below asserts the
// shape the rest of the file depends on, and would fail loudly on a re-capture
// of something else.
const plan = captured as unknown as CapturedPlan;

const PROJECT_ID = 'live-project';
const capturedRows = plan.workItems;

/** Every role the captured estimates name, in the order the rows print them. */
function rolesInPlan(): string[] {
  const named: string[] = [];
  for (const row of capturedRows) {
    for (const roleId of Object.keys(row.estimates)) {
      if (!named.includes(roleId)) named.push(roleId);
    }
  }
  return named;
}

/**
 * The captured project, rebuilt behind the service, and read back through it.
 *
 * `extraRoles` is the interesting knob: the live project's roles are not in the
 * response, only the ones its estimates name. A role nobody has estimated adds a
 * zero-length slice to every leaf, and the claim is that it changes nothing —
 * which is the rule an unestimated `Dev` in front of an estimated `QA` rests on.
 */
async function replay(extraRoles: readonly string[]) {
  const projects = inMemoryProjects();
  const workItems = inMemoryWorkItems();
  const estimates = inMemoryEstimates(workItems);
  const dependencies = inMemoryDependencies();
  const directory = inMemoryDirectory();
  const service = new WorkItemService({
    workItems,
    projects,
    estimates,
    dependencies,
    directory,
    capacity: inMemoryCapacity(),
    priorityBands: inMemoryPriorityBands(),
    subtrees: inMemorySubtrees({ workItems, estimates, dependencies, directory }),
    journal: inMemoryCommandJournal(),
    broadcast: recordingBroadcaster(),
  });

  const project: Project = {
    id: PROJECT_ID,
    name: 'The captured plan',
    ownerId: 'owner',
    restricted: false,
    estimateMethod: plan.estimateMethod,
    startDate: plan.startDate,
    revision: plan.projectRevision,
    createdAt: 1,
  };
  const roles: Role[] = [...rolesInPlan(), ...extraRoles].map((id, place) => ({
    id,
    projectId: PROJECT_ID,
    name: `Role ${String(place)}`,
    position: (place + 1) * ROLE_POSITION_STEP,
  }));
  await projects.create(project, roles);

  for (const row of capturedRows) {
    const stored: WorkItem = {
      id: row.id,
      projectId: PROJECT_ID,
      parentId: row.parentId,
      position: row.position,
      name: row.name,
      notes: row.notes,
      frozenNumber: null,
      priority: null,
      // The capture predates the column, and `DEFAULT 1` is what every row on
      // the live server got when the migration ran — so 1 here is the captured
      // plan's own state, not a convenience.
      maxParallel: 1,
      startNoEarlierThan: row.startNoEarlierThan,
      serviceTeamId: row.serviceTeamId,
      revision: row.revision,
    };
    await workItems.insert(stored, []);
  }
  // After the rows, so an estimate is never written against a work item that is
  // not there yet — the fixture mirrors the foreign key.
  for (const row of capturedRows) {
    const children = capturedRows.some((each) => each.parentId === row.id);
    if (children) continue;
    for (const [roleId, days] of Object.entries(row.estimates)) {
      await estimates.set({ workItemId: row.id, roleId, ...days });
    }
  }
  for (const row of capturedRows) {
    for (const predecessorId of row.dependsOn) {
      const edge: StoredDependency = {
        id: `${predecessorId}->${row.id}`,
        projectId: PROJECT_ID,
        predecessorId,
        successorId: row.id,
      };
      await dependencies.add(edge);
    }
  }

  const tree = await service.tree(PROJECT_ID);
  if (tree === null) throw new Error('the captured project vanished');
  return tree;
}

describe('a captured live plan, through the slice engine', () => {
  it('is worth asserting against: PERT, a calendar, a branch, a dependency and a gap', () => {
    // The fixture is as capable of being empty as the engine is of being wrong.
    expect(plan.estimateMethod).toBe('pert');
    expect(plan.startDate).toBe('2026-08-10');
    expect(capturedRows.some((row) => row.parentId !== null)).toBe(true);
    expect(capturedRows.some((row) => row.dependsOn.length > 0)).toBe(true);
    expect(capturedRows.some((row) => row.schedule.estimated)).toBe(true);
    expect(capturedRows.some((row) => !row.schedule.estimated)).toBe(true);
    expect(capturedRows.some((row) => row.schedule.critical)).toBe(true);
    // Thirds, which is what makes the arithmetic worth checking to the last bit.
    expect(capturedRows.some((row) => !Number.isInteger(row.schedule.earliestFinish))).toBe(true);
  });

  it('answers exactly what the live server answered', async () => {
    // Re-run under the anchor rule (`dep-waits-on-first-role`, 2026-08-11):
    // nothing moved. The capture's one dependency — `030` waiting on `010` —
    // has a predecessor holding a single role, so its first slice is its last
    // and the two rules are the same rule on this plan. Every number below is
    // still the live server's, unedited.
    const tree = await replay([]);

    expect(tree.scheduleError).toBeNull();
    expect(tree.workItems.map((row) => row.number)).toEqual(capturedRows.map((row) => row.number));
    for (const [at, row] of tree.workItems.entries()) {
      const was = capturedRows[at];
      expect({ number: row.number, schedule: row.schedule, dates: row.dates }).toEqual({
        number: was.number,
        schedule: was.schedule,
        dates: was.dates,
      });
    }
  });

  it('answers the same with a role nobody has estimated added to the project', async () => {
    // The zero-length slice rule, against real numbers: a second role changes
    // what the plan is computed in and must change nothing about the answer.
    const tree = await replay(['role-nobody-estimated']);

    for (const [at, row] of tree.workItems.entries()) {
      expect(row.schedule).toEqual(capturedRows[at].schedule);
      expect(row.dates).toEqual(capturedRows[at].dates);
    }
  });
});
