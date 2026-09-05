import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildApp } from '../app';
import { ActualRepository } from '../repository/actual';
import { CalendarMarkerRepository } from '../repository/calendar-marker';
import { CommandJournalRepository } from '../repository/command-journal';
import { openDrizzle } from '../repository/db';
import { DependencyRepository } from '../repository/dependency';
import { DirectoryRepository } from '../repository/directory';
import { EstimateRepository } from '../repository/estimate';
import { runMigrations } from '../repository/migrate';
import { ProjectRepository } from '../repository/project';
import { StepRepository } from '../repository/step';
import { StepMeasureRepository } from '../repository/step-measure';
import { StepProgressRepository } from '../repository/step-progress';
import { UserRepository } from '../repository/user';
import { SubtreeRepository, WorkItemRepository } from '../repository/work-item';
import { AuthService } from '../service/auth.service';
import { CalendarMarkerService } from '../service/calendar-marker.service';
import { clockOf } from '../service/clock';
import { ProjectService } from '../service/project.service';
import { StepService } from '../service/step.service';
import { WorkItemService } from '../service/work-item.service';
import { TEST_JWT_KEY } from '../testing/auth-fixture';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { inMemoryCapacity, testCapacityService } from '../testing/capacity-fixture';
import { testDirectoryService } from '../testing/directory-fixture';
import { testHistoryService } from '../testing/history-fixture';
import { inMemoryPriorityBands, testPriorityBandService } from '../testing/priority-band-fixture';
import { testReplay } from '../testing/replay-fixture';
import { testSavedPlanService } from '../testing/saved-plan-fixture';
import { testWrites } from '../testing/writes-fixture';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

/** The day the seeded plan starts on — a Monday, so the span opens on a workday. */
const START_DATE = '2026-08-17';

/**
 * The five dates the markers land on, all **inside** the seeded plan's span.
 *
 * A marker outside the span would be a weaker fixture in exactly the direction
 * that matters: the projection this file compares is built from dates, and a
 * marker the plan's own window never reaches is one a naive fold could ignore
 * for free. Two of the five (`2026-08-22`, `2026-08-23`) are the first weekend,
 * because a weekend day is the one axis position the schedule already treats
 * specially and so the likeliest place for a fold to be mistaken for a
 * calendar rule.
 */
const MARKER_DATES = ['2026-08-18', '2026-08-20', '2026-08-22', '2026-08-23', '2026-08-25'];

/** The estimate every seeded row carries, so the span is workdays wide and not a point. */
const DAYS = { optimistic: 1, realistic: 2, pessimistic: 3 };

/**
 * **A marker moves nothing in the canonical schedule projection** — task 5.1.
 *
 * The projection compared here is the **whole** `GET
 * /api/projects/:id/work-items` body, not an enumerated list of
 * schedule-bearing fields. Rounds 3 and 4 of the review each named such a list
 * and each list was short: the round-4 answer carried every
 * `workItems[].schedule` and the slices and still omitted `workItems[].dates`
 * — which `NumberedWorkItem` carries separately, `schedule` being spans in
 * workdays and `dates` the calendar those spans land on, so a regression that
 * moved only the calendar would have passed — and still omitted the scheduling
 * inputs the same read returns (`teamCapacities`, `priorityBands`,
 * `estimateMethod`, `pertWeights`, `estimateRounding`, `depReach`, `startDate`
 * and `projectRevision`). A list maintained against a growing payload is short
 * again at the next field. So: deep-equal the entire body.
 *
 * **The comparison excludes nothing, and that is a correction to the task.**
 * Task 5.1 specifies the body *minus* `seq`, justified by "a marker mutation
 * advances it by design". It does not, today: `CalendarMarkerService` is
 * constructed from `{ projects, markers, clock }` and holds no `Broadcaster`
 * at all, so no marker write reaches `broadcast.latestSeq` and `seq` cannot
 * move across the two captures. Deleting it now would therefore delete a
 * **stationary** field — which is strictly weaker than comparing it, and is the
 * precise failure the task's own "justified rather than asserted" sentence was
 * written to prevent. The exclusion belongs with the broadcast, in slice group
 * 9; until then this file compares `seq` along with everything else, and the
 * moment group 9 wires a marker broadcast this test goes red and the group-9
 * chunk restores the minus-one-key form **together with** the `seq`-advanced
 * assertion that makes the deletion honest.
 */
describe('the schedule identity guarantee', () => {
  let dir: string;
  let app: ReturnType<typeof buildApp>;

  /**
   * Every SQL statement the app's one connection has issued, in order — the
   * oracle 5.1a(c) is asserted against.
   *
   * `logQuery` is drizzle's own hook, and it is on for **every** case in this
   * file rather than for the one case that reads it. A second app built only
   * for the reach case would be a second wiring, and the assertion has to watch
   * the very connection 5.1's captures are taken through, not a copy of it.
   *
   * A **runtime** reach rather than a source scan, and that is round-5 Sol's
   * Critical 1: (a) and (b) leave a hole a source scan cannot close. The six
   * arguments are not built in `schedule.ts`, they are built in
   * `WorkItemService.tree()`, so marker-derived data can be folded into
   * `notBefore`, `slices` or `slotsOf` while the call site still passes six
   * arguments and `schedule.ts` still names no marker — (a) and (b) both stay
   * green. A scan of one file is bounded by that file; a SQL log is transitive
   * and holds however many helpers the fold is hidden behind.
   */
  const statements: string[] = [];

  const as = (path: string, token: string, init: { method?: string; body?: string } = {}) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      }),
    );

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wbs-marker-identity-'));
    const dbPath = join(dir, 'test.db');
    runMigrations(dbPath, FOLDER);
    statements.length = 0;
    const db = openDrizzle(dbPath, {
      logQuery(query) {
        statements.push(query);
      },
    });
    const broadcast = recordingBroadcaster();

    const projects = new ProjectRepository(db);

    app = buildApp({
      auth: new AuthService({ users: new UserRepository(db), jwtKey: TEST_JWT_KEY }),
      projects: new ProjectService({ projects, broadcast }),
      steps: new StepService({ projects, steps: new StepRepository(db), broadcast }),
      workItems: new WorkItemService({
        workItems: new WorkItemRepository(db),
        projects,
        estimates: new EstimateRepository(db),
        actuals: new ActualRepository(db),
        measures: new StepMeasureRepository(db),
        progress: new StepProgressRepository(db),
        dependencies: new DependencyRepository(db),
        directory: new DirectoryRepository(db),
        capacity: inMemoryCapacity(),
        priorityBands: inMemoryPriorityBands(),
        subtrees: new SubtreeRepository(db),
        journal: new CommandJournalRepository(db),
        broadcast,
      }),
      // The real store and the real service, because the claim is about what a
      // marker write does to the database the schedule is read from. A double
      // that never writes a row would make "nothing moved" true for the wrong
      // reason.
      calendarMarkers: new CalendarMarkerService({
        projects,
        markers: new CalendarMarkerRepository(db),
        clock: clockOf(),
      }),
      savedPlans: testSavedPlanService(),
      directory: testDirectoryService(),
      capacity: testCapacityService(),
      priorityBands: testPriorityBandService(),
      history: testHistoryService(),
      replay: testReplay().replay,
      probeDatabase: () => 'ok',
      internalAuthSecret: 'x'.repeat(32),
      writes: testWrites(broadcast),
      migrationsApplied: true,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function register(username: string): Promise<string> {
    const res = await app.handle(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: 'correct-horse' }),
      }),
    );
    return ((await res.json()) as { token: string }).token;
  }

  /** One plan-command batch of one, the only way to write to a plan. */
  async function command(token: string, projectId: string, step: object): Promise<string> {
    const res = await as(`/api/projects/${projectId}/commands`, token, {
      method: 'POST',
      body: JSON.stringify({ commands: [step] }),
    });
    if (res.status !== 200)
      throw new Error(`${JSON.stringify(step)} answered ${String(res.status)}`);
    const { results } = (await res.json()) as { results: { id?: string }[] };
    return results[0]?.id ?? '';
  }

  /** The whole projection, as the route answers it. */
  async function projection(token: string, projectId: string): Promise<Record<string, unknown>> {
    const res = await as(`/api/projects/${projectId}/work-items`, token);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * A project on the calendar with two estimated, dependent rows — so the
   * projection under comparison carries real spans, real dates and a real
   * critical path rather than the degenerate `UNSCHEDULED` shape an
   * unestimated plan returns.
   */
  async function seed(token: string): Promise<string> {
    const created = await as('/api/projects', token, {
      method: 'POST',
      body: JSON.stringify({ name: 'Rewire the shed' }),
    });
    const projectId = ((await created.json()) as { project: { id: string } }).project.id;

    const dated = await as(`/api/projects/${projectId}`, token, {
      method: 'PATCH',
      body: JSON.stringify({ startDate: START_DATE }),
    });
    expect(dated.status).toBe(200);

    // The step ids are the project's own, read off the payload the route
    // already answers rather than invented — `setEstimate` refuses an
    // `unknown_step`, so a guessed id would fail the seed rather than the test.
    const before = await projection(token, projectId);
    const stepId = (before['steps'] as { id: string }[])[0]?.id ?? '';
    expect(stepId).not.toBe('');

    const strip = await command(token, projectId, {
      kind: 'createWorkItem',
      parentId: null,
      afterId: null,
      name: 'Strip',
    });
    const sand = await command(token, projectId, {
      kind: 'createWorkItem',
      parentId: null,
      afterId: null,
      name: 'Sand',
    });
    await command(token, projectId, { kind: 'setEstimate', workItemId: strip, stepId, days: DAYS });
    await command(token, projectId, { kind: 'setEstimate', workItemId: sand, stepId, days: DAYS });
    await command(token, projectId, {
      kind: 'addDependency',
      workItemId: sand,
      predecessorId: strip,
    });

    return projectId;
  }

  /**
   * **The scheduler seam is free of markers, at the seam** — task 5.1a(a) and
   * (b), the two source-level halves.
   *
   * Two equal captures cannot prove a path is absent — a fold that is a no-op
   * on this fixture passes 5.1 — so these two read the source directly. (c),
   * the runtime SQL reach that closes the hole these two leave open, is the
   * last case in this file.
   *
   * (a) is a **six-argument** assertion, not a substring match on the call: the
   * fault it exists for is an argument threaded through the adapter, and a
   * `toContain('schedule(')` would survive that. The arguments are parsed off
   * the call site and compared as a list.
   *
   * The line number is **not** asserted. `tasks.md` said `:1458` and the call
   * is at `:1548` as of `e4f8eae0`; pinning it would make this test fail on
   * every edit above it, which is a test about line numbers rather than about
   * the seam.
   */
  it('passes the scheduler exactly its six arguments, and the engine names no marker', () => {
    const service = readFileSync(join(import.meta.dir, '../service/work-item.service.ts'), 'utf8');

    // (a) The single production call site, arguments parsed rather than matched.
    const call = /schedule\(([^)]*)\)/.exec(service.slice(service.indexOf('optimized ??')));
    expect(call).not.toBeNull();
    const args = (call?.[1] ?? '').split(',').map((each) => each.trim());
    expect(args).toEqual(['rows', 'edges', 'slices', 'notBefore', 'slotsOf', 'project.depReach']);

    // (b) The engine itself. Both halves matter: an import of the marker module
    // is the mechanical fault, and a bare occurrence of the type name catches a
    // structural type declared inline to dodge the import.
    const engine = readFileSync(
      join(import.meta.dir, '../../../../libs/domain/src/schedule.ts'),
      'utf8',
    );
    expect(engine).not.toContain('marker');
    expect(engine).not.toContain('Marker');
  });

  /**
   * **Task 5.1, and its negative is 5.1a(iii)'s injection** — which is the
   * resolution of the correction run 8 recorded against this slice.
   *
   * 5.1 as written asks for "a floor derived from a marker's date" folded into
   * `notBefore`. Watched, a floor whose value is a marker date but whose
   * presence does not depend on a marker existing leaves this case green:
   * both captures are taken through the same code, so the whole projection
   * moves by the same amount twice and the equality still holds. This test
   * compares two captures to each other, never to a stored expectation, so
   * only a fold that is **absent in the first capture and present in the
   * second** can fail it — and that means a fold conditioned on a real
   * `calendar_marker` read, which is exactly 5.1a(iii). Watched failing here on
   * `latestStart` 0 → 2 for the seeded `Sand` row, alongside 5.1a(c), then
   * removed; 2026-09-05.
   *
   * 5.1a(iv) fails this case too, and on a different field: it moves
   * `teamCapacities` and no schedule field at all. That is the whole-body
   * comparison earning its keep — every enumerated field list rounds 3 and 4
   * proposed was a list of *schedule* fields, and (iv)'s fold would have walked
   * through all of them.
   */
  it('five markers move nothing in the whole work-items projection', async () => {
    const token = await register('owner');
    const projectId = await seed(token);

    const before = await projection(token, projectId);
    // The fixture is only a fixture if the plan it captures is scheduled: an
    // all-`UNSCHEDULED` payload is one a marker fold could leave alone for
    // free, so the precondition is asserted rather than assumed.
    expect((before['workItems'] as unknown[]).length).toBe(2);
    expect(before['slices'] as unknown[]).not.toHaveLength(0);

    for (const [index, date] of MARKER_DATES.entries()) {
      const res = await as(`/api/projects/${projectId}/calendar-markers`, token, {
        method: 'POST',
        body: JSON.stringify({ name: `Marker ${String(index)}`, date }),
      });
      expect(res.status).toBe(201);
    }

    // The markers really are in the store — otherwise "nothing moved" is a
    // claim about a project with no markers on it.
    const listed = await as(`/api/projects/${projectId}/calendar-markers`, token);
    expect(((await listed.json()) as { markers: unknown[] }).markers).toHaveLength(
      MARKER_DATES.length,
    );

    const after = await projection(token, projectId);

    expect(after).toEqual(before);
  });

  /**
   * **The scheduler seam is free of markers, at the inputs** — task 5.1a(c),
   * the runtime half, and the one that closes the hole (a) and (b) leave open.
   *
   * The oracle is the SQL log, not the payload: the case above compares two
   * captures, and two equal captures cannot prove a path is absent, because a
   * fold that happens to be a no-op on this fixture passes it. This one asserts
   * the read never happened at all.
   *
   * The plan's own table is asserted **present** before the marker table is
   * asserted absent. Without that half, an app that answered nothing — a broken
   * route, an empty project, a connection this file is not watching — would
   * pass an assertion whose whole content is "the log named no marker".
   *
   * `Proof:` both injections read the table through `WorkItemRepository` — the
   * one repository `tree()` already holds — and both were caught by the same
   * logged statement,
   * `select "date" from "calendar_marker" where "calendar_marker"."project_id" = ?`.
   * (iii) is the **ordering** input: the latest marker date written as a
   * `notBefore` floor on the seeded `Sand` row, which moved its `latestStart`
   * 0 → 2. (iv) is the **resource** input: the same read folded into `slotsOf`
   * as a `marker-pool` entry *before* `slicesOf` is called, which moved
   * `teamCapacities` and no schedule field at all. Sol's round-5 objection
   * names both paths, and one alone leaves the other unproven — that is why
   * two injections and not one. Each ran 1 pass / 2 fail with the case above,
   * baseline 3 / 0 restored after both; watched 2026-09-05.
   */
  it('reads no calendar_marker row while answering the work-items projection', async () => {
    const token = await register('owner');
    const projectId = await seed(token);

    for (const [index, date] of MARKER_DATES.entries()) {
      const res = await as(`/api/projects/${projectId}/calendar-markers`, token, {
        method: 'POST',
        body: JSON.stringify({ name: `Marker ${String(index)}`, date }),
      });
      expect(res.status).toBe(201);
    }

    // Cleared here and not in `beforeEach` alone: the five creates above wrote
    // to `calendar_marker` by design, so what the log holds at the assertion
    // has to be exactly what the projection read issued and nothing earlier.
    statements.length = 0;
    const body = await projection(token, projectId);
    expect((body['workItems'] as unknown[]).length).toBe(2);

    expect(statements.some((each) => each.includes('work_item'))).toBe(true);
    expect(statements.filter((each) => each.includes('calendar_marker'))).toEqual([]);
  });
});
