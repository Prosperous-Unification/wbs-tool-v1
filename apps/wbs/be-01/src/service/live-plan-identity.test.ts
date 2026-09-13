import type { Scheduled } from '@wbs/domain';
import { ASSUMED_SLICE_WORKDAYS } from '@wbs/domain';
import { describe, expect, it } from 'bun:test';

import type { Project, Step, StoredDependency, WorkItem, WriteStamp } from '../repository';
import { STEP_POSITION_STEP } from '../repository';
import { inMemoryServices } from '../testing/harness';
import { projectRow } from '../testing/project-fixture';
import { workItemRow } from '../testing/work-item-fixture';
import captured from './fixtures/live-plan-2026-08-09.json';

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
/**
 * The stamp every replayed write carries. The capture predates a write recording
 * who made it, so the project's own owner stands in for the actor and the instant
 * is fixed — the replay is a claim about the engine, not about either.
 */
const STAMP: WriteStamp = { at: 1, by: 'owner' };

/** Every step the captured estimates name, in the order the rows print them. */
function stepsInPlan(): string[] {
  const named: string[] = [];
  for (const row of capturedRows) {
    for (const stepId of Object.keys(row.estimates)) {
      if (!named.includes(stepId)) named.push(stepId);
    }
  }
  return named;
}

/**
 * The captured project, rebuilt behind the service, and read back through it.
 *
 * `extraSteps` is the interesting knob: the live project's steps are not in the
 * response, only the ones its estimates name. A step nobody has estimated adds a
 * zero-length slice to every leaf, and the claim is that it changes nothing —
 * which is the rule an unestimated `Dev` in front of an estimated `QA` rests on.
 */
async function replay(extraSteps: readonly string[]) {
  const {
    service,
    stores: { projects, workItems, estimates, dependencies },
  } = inMemoryServices();

  const project: Project = projectRow({
    id: PROJECT_ID,
    name: 'The captured plan',
    ownerId: 'owner',
    estimateMethod: plan.estimateMethod,
    // The arithmetic this capture was taken under: a step's figure reached the
    // schedule as the fraction the method produced. `estimate-weights-and-rounding`
    // made `ceil` the default for every project and left `exact` as the arm an
    // oracle replays on.
    estimateRounding: 'exact',
    startDate: plan.startDate,
    revision: plan.projectRevision,
  });
  const steps: Step[] = [...stepsInPlan(), ...extraSteps].map((id, place) => ({
    id,
    projectId: PROJECT_ID,
    name: `Step ${String(place)}`,
    position: (place + 1) * STEP_POSITION_STEP,
  }));
  await projects.create(project, steps, STAMP);

  for (const row of capturedRows) {
    const stored: WorkItem = workItemRow({
      id: row.id,
      projectId: PROJECT_ID,
      parentId: row.parentId,
      position: row.position,
      name: row.name,
      notes: row.notes,
      // The capture predates the column, and `DEFAULT 1` is what every row on
      // the live server got when the migration ran — so 1 here is the captured
      // plan's own state, not a convenience.
      maxParallel: 1,
      startNoEarlierThan: row.startNoEarlierThan,
      serviceTeamId: row.serviceTeamId,
      revision: row.revision,
    });
    await workItems.insert(stored, [], STAMP);
  }
  // After the rows, so an estimate is never written against a work item that is
  // not there yet — the fixture mirrors the foreign key.
  for (const row of capturedRows) {
    const children = capturedRows.some((each) => each.parentId === row.id);
    if (children) continue;
    for (const [stepId, days] of Object.entries(row.estimates)) {
      await estimates.set({ workItemId: row.id, stepId, ...days }, STAMP);
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
      await dependencies.add(edge, STAMP);
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

  it('answers exactly what the live server answered wherever somebody estimated', async () => {
    // Re-run under the anchor rule (`dep-waits-on-first-role`, 2026-08-11):
    // nothing moved. The capture's one dependency — `030` waiting on `010` —
    // has a predecessor holding a single step, so its first slice is its last
    // and the two rules are the same rule on this plan.
    //
    // **Re-derived at `assumed-duration-schedules` (2026-08-29)**, and this
    // capture is exactly the plan the change exists for: `020` and `030.1.1`
    // are rows a real planner left unestimated, and the live server drew them
    // as taking no time. They now take two workdays each, which moves the
    // project's finish from 4.5 to 5.666… and every late time with it. The
    // table below carries the new numbers and the reason for each.
    //
    // What the capture is still the oracle for is asserted first and
    // separately: `duration` and `estimated`, per row, verbatim from the live
    // server. Those are what the Days column, the roll-up and the export read,
    // and this change may not move a single one of them. A green re-derived
    // table beside a moved `estimated` would be the change having redefined the
    // word (design D2).
    const tree = await replay([]);

    expect(tree.scheduleError).toBeNull();
    expect(tree.workItems.map((row) => row.number)).toEqual(capturedRows.map((row) => row.number));
    for (const [at, row] of tree.workItems.entries()) {
      const was = capturedRows[at];
      expect({
        number: row.number,
        duration: row.schedule.duration,
        estimated: row.schedule.estimated,
      }).toEqual({
        number: was.number,
        duration: was.schedule.duration,
        estimated: was.schedule.estimated,
      });
    }

    // `010` and `040` are the two rows somebody estimated, and both keep the
    // start and finish the live server printed. `010` turns red because the row
    // it releases now has work in it, which is a slack reading and not a date.
    const said = new Map(
      tree.workItems.map((row) => [row.number, { schedule: row.schedule, dates: row.dates }]),
    );
    expect(said.get('010')).toEqual({
      // Unmoved: 0 → 3.666…, the live server's own numbers.
      schedule: {
        duration: 3.6666666666666665,
        estimated: true,
        earliestStart: 0,
        earliestFinish: 3.6666666666666665,
        // Was 0.833… with 0.833… of slack. `010` releases `030`, which used to
        // be a branch of no days and could therefore sit anywhere; it now holds
        // two days of assumed work at the end of the plan, so `010` is on the
        // critical path.
        latestStart: -4.440892098500626e-16,
        latestFinish: 3.666666666666666,
        float: 0,
        critical: true,
      },
      dates: { startsOn: '2026-08-10', endsOn: '2026-08-13' },
    });
    expect(said.get('020')).toEqual({
      // The change, on the row it is about: an unestimated leaf that ran 0 → 0
      // and now runs 0 → 2. `duration` and `estimated` are untouched above.
      schedule: {
        duration: 0,
        estimated: false,
        earliestStart: 0,
        earliestFinish: 2,
        latestStart: 3.666666666666666,
        latestFinish: 5.666666666666666,
        float: 3.666666666666666,
        critical: false,
      },
      // Two workdays: Monday the 10th to Tuesday the 11th, where the capture
      // began and ended it on the 10th.
      dates: { startsOn: '2026-08-10', endsOn: '2026-08-11' },
    });
    expect(said.get('030.1.1')).toEqual({
      // The other unestimated leaf, behind `010`'s dependency: 3.666… → 5.666…
      // where the capture had it starting and finishing at 3.666…. It is the
      // project's finish now, and critical.
      schedule: {
        duration: 0,
        estimated: false,
        earliestStart: 3.6666666666666665,
        earliestFinish: 5.666666666666666,
        latestStart: 3.666666666666666,
        latestFinish: 5.666666666666666,
        float: 0,
        critical: true,
      },
      dates: { startsOn: '2026-08-13', endsOn: '2026-08-17' },
    });
    for (const number of ['030', '030.1']) {
      // The two parents above it, which span what is beneath them and moved
      // with it. A parent's own `duration` is 0 before and after.
      expect(said.get(number), number).toEqual({
        schedule: {
          duration: 0,
          estimated: false,
          earliestStart: 3.6666666666666665,
          earliestFinish: 5.666666666666666,
          latestStart: 3.666666666666666,
          latestFinish: 5.666666666666666,
          float: 0,
          critical: true,
        },
        dates: { startsOn: '2026-08-13', endsOn: '2026-08-17' },
      });
    }
    expect(said.get('040')).toEqual({
      // The second estimated row: 0 → 4.5, unmoved, exactly as captured. Only
      // its slack changed, because the project it is measured against got
      // longer — it was the finish at 4.5 and is now 1.166… days clear of one
      // at 5.666….
      schedule: {
        duration: 4.5,
        estimated: true,
        earliestStart: 0,
        earliestFinish: 4.5,
        latestStart: 1.166666666666666,
        latestFinish: 5.666666666666666,
        float: 1.166666666666666,
        critical: false,
      },
      dates: { startsOn: '2026-08-10', endsOn: '2026-08-14' },
    });
  });

  it('adds a step’s assumed duration when a step nobody has estimated is added', async () => {
    // Until `assumed-duration-schedules` this test read `answers the same with
    // a step nobody has estimated added to the project`, and it was true: a
    // second step added a zero-length slice to every leaf and changed nothing.
    //
    // It is the opposite claim now, and deliberately so (design D3). A step the
    // project lists is a step of the work, and a step nobody has sized is work
    // of unknown length rather than no work: every leaf grows by one assumed
    // duration. Nothing anybody estimated changed — `duration` and `estimated`
    // are asserted against the capture, unmoved, for every row.
    //
    // **Re-derived at `dep-reach-whole-item` (2026-08-30), and the growth
    // compounds now.** "Every finish moves out by exactly two workdays" was
    // true while a dependency waited on its predecessor's *anchor*: a new step
    // added at the end of a predecessor sat behind that anchor and held nobody
    // up. Under the `whole-item` default a successor waits for the predecessor's
    // **last** slice, which is the new step — so a row gains two workdays for
    // its own unsized step *and* inherits its predecessors'. This capture is a
    // three-row chain and shows both: `010` and `020` move out by 2, and `030`,
    // which waits for one of them, by 4.
    //
    // Written as a walk over `dependsOn` rather than as three pinned numbers,
    // so the claim is the rule and not this capture's shape — a longer chain
    // would compound further and this still describes it.
    const tree = await replay(['role-nobody-estimated']);

    const bare = await replay([]);
    /**
     * How far this row's finish must move: its own new unsized step, plus
     * whatever the predecessor it waits longest for gained. Recursive because
     * the wait is transitive under `whole-item` — a chain of three compounds
     * twice.
     */
    const dependsOnOf = new Map(tree.workItems.map((each) => [each.id, each.dependsOn]));
    const parentOf = new Map(tree.workItems.map((each) => [each.id, each.parentId]));
    const childrenOf = new Map<string, string[]>();
    for (const each of tree.workItems) {
      if (each.parentId === null) continue;
      childrenOf.set(each.parentId, [...(childrenOf.get(each.parentId) ?? []), each.id]);
    }
    /**
     * Every id this row actually waits for: its own, and every ancestor's — a
     * dependency declared on a parent reaches every leaf beneath it, which is
     * the rule `expandToLeaves` holds and the reason a leaf with an empty
     * `dependsOn` can still inherit a wait.
     */
    const waitsFor = (id: string): string[] => {
      const own = [...(dependsOnOf.get(id) ?? [])];
      const parent = parentOf.get(id) ?? null;
      return parent === null ? own : [...own, ...waitsFor(parent)];
    };
    /** A parent's finish is its latest leaf's, so its growth is theirs. */
    const owedGrowth = (id: string): number => {
      const children = childrenOf.get(id);
      if (children !== undefined) return Math.max(...children.map(owedGrowth));
      return ASSUMED_SLICE_WORKDAYS + Math.max(0, ...waitsFor(id).map(owedGrowth));
    };
    /** And a parent's start is its earliest leaf's. */
    const owedStartGrowth = (id: string): number => {
      const children = childrenOf.get(id);
      if (children !== undefined) return Math.min(...children.map(owedStartGrowth));
      return Math.max(0, ...waitsFor(id).map(owedGrowth));
    };
    for (const [at, row] of tree.workItems.entries()) {
      expect(row.schedule.duration).toBe(capturedRows[at].schedule.duration);
      expect(row.schedule.estimated).toBe(capturedRows[at].schedule.estimated);
      // Every finish two workdays later than without the extra step, which is
      // the assumed duration and nothing else. Written as the difference rather
      // than as six pinned numbers so the claim is the one being made: one more
      // unsized step, one more assumed duration.
      //
      // `toBeCloseTo` here and `toBe` everywhere else in this file: this is a
      // subtraction across a PERT third, and `5.666666666666666 -
      // 3.6666666666666665` is `1.9999999999999996`. The pinned numbers in the
      // test above are still exact — it is the arithmetic done *here* that
      // drifts, not the engine's answer.
      expect(
        row.schedule.earliestFinish - bare.workItems[at].schedule.earliestFinish,
        row.number,
      ).toBeCloseTo(owedGrowth(row.id), 12);
      // A row with no predecessor still starts where it did; one behind a
      // predecessor that grew starts that much later, which is the half of the
      // compounding that is visible on the start rather than the finish.
      expect(
        row.schedule.earliestStart - bare.workItems[at].schedule.earliestStart,
        row.number,
      ).toBeCloseTo(owedStartGrowth(row.id), 12);
    }
  });
});
