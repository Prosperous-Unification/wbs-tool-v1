/**
 * Writes the pre-`capacity-per-project` oracle: a corpus of plans with globally
 * sized teams, and the exact `/work-items` answer be-01 gave each of them.
 *
 * **Run once, at `050fd45`, before a line of `change/capacity-per-project`
 * existed.** The JSON it wrote is the pin; this script is not. Re-running it
 * against this branch's tree measures the new code against itself and proves
 * nothing at all — which is the whole reason the answers are committed as data
 * rather than recomputed by a test.
 *
 * The corpus is written **into** the file beside the answers, so
 * `capacity-migration-identity.test.ts` replays plans it did not generate. A
 * shared generator would be free to drift in the same direction as the code,
 * and then both sides of the differential would move together and the run would
 * stay green.
 *
 * One `WorkItemService` holds every project, over one global directory: two
 * projects labelled `Backend` really do share the team row, and each really is
 * told it has all of it. That is the fact this change is about, and a corpus of
 * one-project services could not carry it.
 *
 *     bun apps/be-01/tools/capture-capacity-oracle.ts > \
 *       apps/be-01/src/service/fixtures/capacity-oracle-2026-08-13.json
 *
 * It lives in `apps/be-01/tools` rather than in `tools/dev` because it imports
 * be-01's own service and fixtures directly. From `tools/dev` those are deep
 * relative imports across a project boundary, which
 * `@nx/enforce-module-boundaries` refuses — and whose autofixer crashes on them,
 * since be-01 publishes no `index.ts` to redirect them to. Here it is be-01's own
 * tool, outside `src` so neither be-01's lint nor either of its tsconfigs sees it.
 *
 * **Not typechecked, and that is the point.** `WorkItemServiceOptions` gained a
 * `capacity` collaborator in this very change, so this file as it was run does not
 * compile against this branch's tree — which is exactly what "it ran before this
 * branch had a line of code in it" means. Compiling it here would have meant
 * editing it, and an edited capture script is not the script that produced the
 * capture.
 */
import type { Project, Step, StoredDependency, WorkItem } from '../src/repository';
import { STEP_POSITION_STEP } from '../src/repository';
import { WorkItemService } from '../src/service/work-item.service';
import { recordingBroadcaster } from '../src/testing/broadcast-fixture';
import { inMemoryCommandJournal } from '../src/testing/command-journal-fixture';
import { inMemoryDependencies } from '../src/testing/dependency-fixture';
import { inMemoryDirectory } from '../src/testing/directory-fixture';
import { inMemoryEstimates } from '../src/testing/estimate-fixture';
import { inMemoryProjects } from '../src/testing/project-fixture';
import { inMemorySubtrees } from '../src/testing/subtree-fixture';
import { inMemoryWorkItems } from '../src/testing/work-item-fixture';

/** How many plans. Large enough to hold every shape below several times over. */
const PLANS = 16;

/**
 * The teams, global as production's are, and sized as production's are: two
 * bound tight enough to contend on a plan of this size, one loose enough never
 * to bind, one nobody has sized at all.
 */
const TEAMS = [
  { id: 'team-backend', name: 'Backend', size: 1 },
  { id: 'team-platform', name: 'Platform', size: 2 },
  { id: 'team-design', name: 'Design', size: 40 },
  { id: 'team-unsized', name: 'Ops', size: null },
] as const;

const PEOPLE = [
  { id: 'person-kat', name: 'kat' },
  { id: 'person-sam', name: 'sam' },
] as const;

const METHODS = ['pert', 'optimistic', 'realistic', 'pessimistic'] as const;

/**
 * A deterministic stream, written out rather than taken from a library so the
 * corpus this produced can be produced again from the seed alone.
 */
function stream(seed: number): () => number {
  let state = seed * 2654435761 + 1;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

interface PlanRow {
  id: string;
  parentId: string | null;
  position: number;
  name: string;
  priority: number | null;
  maxParallel: number;
  startNoEarlierThan: string | null;
  serviceTeamId: string | null;
  estimates: Record<string, { optimistic: number; realistic: number; pessimistic: number }>;
  assignees: Record<string, string>;
  dependsOn: string[];
}

interface Plan {
  projectId: string;
  stepIds: string[];
  estimateMethod: (typeof METHODS)[number];
  startDate: string | null;
  rows: PlanRow[];
}

function planFor(seed: number): Plan {
  const next = stream(seed);
  const pick = <T>(from: readonly T[]): T => {
    const at = Math.floor(next() * from.length);
    const chosen = from[Math.min(at, from.length - 1)];
    if (chosen === undefined) throw new Error('empty choice list');
    return chosen;
  };
  const projectId = `p${String(seed)}`;
  const stepIds = ['step-0', 'step-1', 'step-2'].slice(0, 2 + Math.floor(next() * 2));
  const rows: PlanRow[] = [];
  let position = 0;
  const topLevel: string[] = [];

  const parents = 2 + Math.floor(next() * 3);
  for (let parent = 0; parent < parents; parent += 1) {
    const parentId = `${projectId}-g${String(parent)}`;
    position += 10;
    // A label on a parent is the inherited case: its leaves carry none of their
    // own and their dates come out of this pool.
    const onParent = next() < 0.5 ? pick(TEAMS).id : null;
    rows.push({
      id: parentId,
      parentId: null,
      position,
      name: `Group ${String(parent)}`,
      priority: null,
      maxParallel: 1,
      startNoEarlierThan: null,
      serviceTeamId: onParent,
      estimates: {},
      assignees: {},
      dependsOn: [],
    });
    topLevel.push(parentId);

    const leaves = 1 + Math.floor(next() * 3);
    for (let leaf = 0; leaf < leaves; leaf += 1) {
      const id = `${parentId}-l${String(leaf)}`;
      const estimates: PlanRow['estimates'] = {};
      for (const stepId of stepIds) {
        // A step nobody estimated on this leaf: the zero-length-slice case.
        if (next() < 0.25) continue;
        const optimistic = 1 + Math.floor(next() * 4);
        estimates[stepId] = {
          optimistic,
          realistic: optimistic + Math.floor(next() * 3),
          pessimistic: optimistic + 2 + Math.floor(next() * 5),
        };
      }
      const assignees: PlanRow['assignees'] = {};
      if (next() < 0.2) {
        const stepId = pick(stepIds);
        assignees[stepId] = pick(PEOPLE).id;
      }
      rows.push({
        id,
        parentId,
        position: (leaf + 1) * 10,
        name: `Leaf ${String(parent)}.${String(leaf)}`,
        priority: next() < 0.3 ? 1 + Math.floor(next() * 4) : null,
        maxParallel: next() < 0.35 ? 1 + Math.floor(next() * 3) : 1,
        startNoEarlierThan: null,
        // A leaf's own label overrides the parent's, which is the other half of
        // `effectiveTeamOf`.
        serviceTeamId: next() < 0.4 ? pick(TEAMS).id : null,
        estimates,
        assignees,
        dependsOn: [],
      });
    }
  }

  // A top-level leaf, so not every leaf inherits, and the one row a manual date
  // can land on without a parent above it to argue with.
  position += 10;
  const loose = `${projectId}-solo`;
  const soloEstimates: PlanRow['estimates'] = {};
  for (const stepId of stepIds) {
    soloEstimates[stepId] = { optimistic: 2, realistic: 3, pessimistic: 6 };
  }
  rows.push({
    id: loose,
    parentId: null,
    position,
    name: 'On its own',
    priority: null,
    maxParallel: next() < 0.5 ? 2 : 1,
    startNoEarlierThan: seed % 5 === 0 ? '2026-09-14' : null,
    serviceTeamId: pick(TEAMS).id,
    estimates: soloEstimates,
    assignees: {},
    dependsOn: [],
  });
  topLevel.push(loose);

  // Edges between top-level rows only, forward in position order, so no seed can
  // generate a cycle and every plan in the corpus really schedules.
  for (let at = 1; at < topLevel.length; at += 1) {
    if (next() > 0.45) continue;
    // No nullish guard on these two, and its absence is the point. `at` is
    // bounded by `topLevel.length` and the second index falls in `[0, at)`, so
    // both are in range by construction — and without `noUncheckedIndexedAccess`
    // they type as `string` anyway, which is why eslint called the guard that
    // stood here unreachable the first time this file was ever linted
    // (2026-08-31, when it gained a `tsconfig` that reaches it). A check that
    // cannot fail is worse than no check: it reads as one (`AGENTS.md`, R5).
    const successor = topLevel[at];
    const predecessor = topLevel[Math.floor(next() * at)];
    const row = rows.find((each) => each.id === successor);
    if (row === undefined) throw new Error(`no row for ${successor}`);
    row.dependsOn.push(predecessor);
  }

  return {
    projectId,
    stepIds,
    estimateMethod: METHODS[seed % METHODS.length] ?? 'pert',
    startDate: seed % 7 === 0 ? null : '2026-09-01',
    rows,
  };
}

async function main(): Promise<void> {
  const projects = inMemoryProjects();
  const directory = inMemoryDirectory();
  const workItems = inMemoryWorkItems(directory);
  const estimates = inMemoryEstimates(workItems);
  const dependencies = inMemoryDependencies();
  const service = new WorkItemService({
    workItems,
    projects,
    estimates,
    dependencies,
    directory,
    subtrees: inMemorySubtrees({ workItems, estimates, dependencies, directory }),
    journal: inMemoryCommandJournal(),
    broadcast: recordingBroadcaster(),
  });

  for (const team of TEAMS) await directory.addTeam({ ...team });
  for (const who of PEOPLE) await directory.addPerson({ ...who }, []);

  const plans: Plan[] = [];
  for (let seed = 1; seed <= PLANS; seed += 1) plans.push(planFor(seed));

  for (const plan of plans) {
    const project: Project = {
      id: plan.projectId,
      name: `Plan ${plan.projectId}`,
      ownerId: 'owner',
      restricted: false,
      estimateMethod: plan.estimateMethod,
      pertWeights: { optimistic: 1, realistic: 4, pessimistic: 1 },
      estimateRounding: 'ceil',
      startDate: plan.startDate,
      revision: 0,
      createdAt: 1,
    };
    const steps: Step[] = plan.stepIds.map((id, place) => ({
      id,
      projectId: plan.projectId,
      name: `Step ${String(place)}`,
      position: (place + 1) * STEP_POSITION_STEP,
    }));
    await projects.create(project, steps);
    for (const row of plan.rows) {
      const stored: WorkItem = {
        id: row.id,
        projectId: plan.projectId,
        parentId: row.parentId,
        position: row.position,
        name: row.name,
        notes: '',
        frozenNumber: null,
        priority: row.priority,
        maxParallel: row.maxParallel,
        startNoEarlierThan: row.startNoEarlierThan,
        serviceTeamId: row.serviceTeamId,
        revision: 0,
      };
      await workItems.insert(stored, []);
    }
    for (const row of plan.rows) {
      for (const [stepId, days] of Object.entries(row.estimates)) {
        await estimates.set({ workItemId: row.id, stepId, ...days });
      }
      for (const [stepId, personId] of Object.entries(row.assignees)) {
        await directory.assign(row.id, stepId, personId);
      }
      for (const predecessorId of row.dependsOn) {
        const edge: StoredDependency = {
          id: `${predecessorId}->${row.id}`,
          projectId: plan.projectId,
          predecessorId,
          successorId: row.id,
        };
        await dependencies.add(edge);
      }
    }
  }

  const answers: unknown[] = [];
  for (const plan of plans) {
    const tree = await service.tree(plan.projectId);
    if (tree === null) throw new Error(`${plan.projectId} vanished`);
    answers.push(tree);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        capturedAt: '2026-08-13',
        capturedFrom: '050fd45',
        teams: TEAMS,
        people: PEOPLE,
        plans,
        answers,
      },
      null,
      1,
    )}\n`,
  );
}

await main();
