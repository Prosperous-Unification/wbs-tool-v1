import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MARKER_NAME_MAX } from '@wbs/domain';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildApp } from '../app';
import type { WorkItem, WriteStamp } from '../repository';
import { CalendarMarkerRepository } from '../repository/calendar-marker';
import { type Drizzle, openDatabase, openDrizzle } from '../repository/db';
import { runMigrations } from '../repository/migrate';
import { ProjectRepository } from '../repository/project';
import { UserRepository } from '../repository/user';
import { WorkItemRepository } from '../repository/work-item';
import { AuthService } from '../service/auth.service';
import { CalendarMarkerService } from '../service/calendar-marker.service';
import { clockOf } from '../service/clock';
import { ProjectService } from '../service/project.service';
import { TEST_JWT_KEY } from '../testing/auth-fixture';
import { recordingBroadcaster } from '../testing/broadcast-fixture';
import { testCapacityService } from '../testing/capacity-fixture';
import { testDirectoryService } from '../testing/directory-fixture';
import { testHistoryService } from '../testing/history-fixture';
import { testPriorityBandService } from '../testing/priority-band-fixture';
import { testReplay } from '../testing/replay-fixture';
import { testSavedPlanService } from '../testing/saved-plan-fixture';
import { testStepService } from '../testing/step-fixture';
import { testWorkItemService } from '../testing/work-item-fixture';
import { testWrites } from '../testing/writes-fixture';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

/** The one instant every marker in this file is created at — see {@link tied}. */
const FIXED_NOW = 1_756_900_000_000;

/**
 * The two ids the tie case is pinned on, **in the reverse of their lexical
 * order**, which is the order they are inserted in.
 *
 * `b…` sorts before `f…`, so insertion order and lexical order disagree and
 * only the `id` key of the `ORDER BY` can produce the asserted sequence. Two
 * reads of a tied pair can both come back in insertion order with that key
 * gone — that flakiness is the whole finding, and an
 * equality-of-two-reads assertion would pass straight through it.
 */
const TIED = ['f1000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000001'];

/**
 * The only id this app's clock ever mints, so task 4.4's fallback case can
 * assert the id came from `Clock.newId()` and not merely that some id came
 * back. A random one would make the assertion "a UUID appeared", which a
 * create that ignored the clock entirely would also satisfy.
 */
const MINTED = '01000000-0000-4000-8000-0000000000ff';

/**
 * U+1D11E, a **surrogate pair**: one code point, two UTF-16 units.
 *
 * The two name-boundary fixtures are built from it and nothing else, and that
 * is what makes them boundary fixtures at all. `MARKER_NAME_MAX` is counted in
 * code points so an emoji costs one, and 120 ASCII characters are 120 units
 * too — an ASCII fixture is accepted and refused in exactly the same places by
 * a correct implementation and by one counting `name.length`, so both boundary
 * cases pass over the fault (round-7 Sol review).
 */
const ASTRAL = '𝄞';

/** 120 code points, and `name.length` 240. Accepted: the cap is tested *at* its value. */
const NAME_AT_CAP = ASTRAL.repeat(MARKER_NAME_MAX);

/** 121 code points, and `name.length` 242. Refused by the same row an empty name is. */
const NAME_OVER_CAP = ASTRAL.repeat(MARKER_NAME_MAX + 1);

/**
 * The custom fill every case that is **not** about colour sends — `azure` from
 * `PALETTE`, which clears the 3:1 bar over all twenty backdrops.
 *
 * Named rather than inlined because of what task 4.5 found. These cases were
 * written against `#4c3a86` while nothing measured a custom colour, and the
 * moment the contrast row shipped they went red: that purple fails **ten** of
 * the twenty backdrops (`dark:base` at 2.166 down to `dark:base+weekend+zebra+today`
 * at 1.419) and was never a fill the API could have accepted. A permission case
 * whose body is independently refusable is not a permission case, so the
 * colour these send has to be one the bar passes.
 */
const CUSTOM_FILL = '#5d6afe';

/**
 * The five marker routes, over HTTP and against real SQLite (task 4.1's HTTP
 * half).
 *
 * Real SQLite rather than this folder's usual in-memory doubles, and not by
 * preference: the ordering this slice is about is the **database's** tie-break,
 * so a Map-backed stand-in would be asserting its own `sort` rather than the
 * `ORDER BY` that ships. `repository/calendar-marker-repository.db.test.ts`
 * proves the store; what is proved here is the part only a request can reach —
 * the statuses, the shapes, and that the routes are wired to that store at all.
 *
 * Two accounts, registered through `/api/auth/register` so a token names an
 * identity `userFromHeaders` really resolves: `owner` owns the project and
 * `mallory` is the third party the permission case needs.
 */
describe('the calendar-marker routes', () => {
  let dir: string;
  let dbPath: string;
  let app: ReturnType<typeof buildApp>;
  let db: Drizzle;
  let tokens: Record<string, string>;
  let projectId: string;

  /**
   * Every SQL statement the app's one connection has issued, in order — the
   * oracle task 4.6's structural half is asserted against.
   *
   * `logQuery` is drizzle's own hook and it is on for **every** case in this
   * file rather than for the one that reads it, because a second app built only
   * for the reach case would be a second wiring: the assertion has to watch the
   * routes this file's other twenty cases drive, not a copy of them. The array
   * is cleared in `beforeEach` and again immediately before the drive, so what
   * it holds at the assertion is exactly what the marker routes issued.
   *
   * A **runtime** reach rather than a source scan, and that is round-5's
   * finding: a scan of `calendar-marker.ts` for a `work_item` import is bounded
   * by the file it scans, and the fault it has to catch can sit in the handler,
   * the service or the repository. A logged statement is transitive.
   */
  const statements: string[] = [];

  /** One authenticated request — `saved-plan.controller.db.test.ts`'s helper. */
  const as = (token: string, path: string, init: Omit<RequestInit, 'headers'> = {}) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      }),
    );

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wbs-calendar-marker-http-'));
    dbPath = join(dir, 'test.db');
    runMigrations(dbPath, FOLDER);
    const broadcast = recordingBroadcaster();
    statements.length = 0;
    db = openDrizzle(dbPath, {
      logQuery(query) {
        statements.push(query);
      },
    });
    const projects = new ProjectRepository(db);

    app = buildApp({
      auth: new AuthService({ users: new UserRepository(db), jwtKey: TEST_JWT_KEY }),
      projects: new ProjectService({ projects, broadcast }),
      // A clock held still, because `createdAt` is an ordering key here rather
      // than a stamp: every marker this file creates ties on `(date,
      // createdAt)`, which is the only state in which the third key decides
      // anything at all.
      calendarMarkers: new CalendarMarkerService({
        projects,
        markers: new CalendarMarkerRepository(db),
        clock: clockOf({ now: () => FIXED_NOW, newId: () => MINTED }),
      }),
      savedPlans: testSavedPlanService(),
      steps: testStepService(),
      workItems: testWorkItemService(),
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

    tokens = {};
    for (const username of ['owner', 'mallory']) {
      const res = await app.handle(
        new Request('http://localhost/api/auth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username, password: 'correct-horse' }),
        }),
      );
      tokens[username] = ((await res.json()) as { token: string }).token;
    }

    // Created through the route, so the project's `ownerId` is the account the
    // token names rather than an id this file invented.
    const created = await as(tokens['owner'], '/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Rewire the shed' }),
    });
    projectId = ((await created.json()) as { project: { id: string } }).project.id;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The four verbs, addressed at **a named project** rather than at the one
   * `beforeEach` seeded.
   *
   * Task 4.6 is the reason they take the project: every case before it drives
   * one project, and an isolation test written against a single seeded project
   * passes with no `project_id` predicate at all. The single-project helpers
   * below are these with `projectId` bound, so both projects reach the routes
   * through one path and a case cannot accidentally prove that two spellings of
   * a request agree.
   */
  const createIn = (project: string, who: string, body: Record<string, unknown>) =>
    as(tokens[who], `/api/projects/${project}/calendar-markers`, {
      method: 'POST',
      body: JSON.stringify(body),
    });

  const patchIn = (project: string, who: string, id: string, body: Record<string, unknown>) =>
    as(tokens[who], `/api/projects/${project}/calendar-markers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });

  const removeIn = (project: string, who: string, id: string) =>
    as(tokens[who], `/api/projects/${project}/calendar-markers/${id}`, { method: 'DELETE' });

  const listIn = async (project: string, who: string) => {
    const res = await as(tokens[who], `/api/projects/${project}/calendar-markers`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { markers: { id: string; name: string; color: string | null }[] })
      .markers;
  };

  const create = (who: string, body: Record<string, unknown>) => createIn(projectId, who, body);

  const patch = (who: string, id: string, body: Record<string, unknown>) =>
    patchIn(projectId, who, id, body);

  const list = (who: string) => listIn(projectId, who);

  /**
   * The round trip: all five verbs through the routes, in the order a composer
   * makes them.
   *
   * The colour is asserted at each step because rename and recolour share one
   * `PATCH` and take body-specific branches inside it — a rename that also
   * wrote the colour column would answer 200 and be invisible to a test that
   * only read the name back.
   */
  it('round-trips list, create, rename, recolour and delete', async () => {
    expect(await list('owner')).toEqual([]);

    const made = await create('owner', {
      markerId: 'a1000000-0000-4000-8000-000000000001',
      date: '2026-09-14',
      name: 'Site visit',
    });
    expect(made.status).toBe(201);
    expect(((await made.json()) as { marker: unknown }).marker).toEqual({
      id: 'a1000000-0000-4000-8000-000000000001',
      projectId,
      date: '2026-09-14',
      name: 'Site visit',
      // Absent in the body and `null` in the answer: automatic has one
      // spelling and it is the absence of a fill.
      color: null,
      createdAt: FIXED_NOW,
    });

    const renamed = await patch('owner', 'a1000000-0000-4000-8000-000000000001', {
      name: 'Site visit, rescheduled',
    });
    expect(renamed.status).toBe(200);
    expect(await list('owner')).toMatchObject([
      { name: 'Site visit, rescheduled', date: '2026-09-14', color: null },
    ]);

    const recoloured = await patch('owner', 'a1000000-0000-4000-8000-000000000001', {
      color: CUSTOM_FILL,
    });
    expect(recoloured.status).toBe(200);
    expect(await list('owner')).toMatchObject([
      { name: 'Site visit, rescheduled', color: CUSTOM_FILL },
    ]);

    const removed = await as(
      tokens['owner'],
      `/api/projects/${projectId}/calendar-markers/a1000000-0000-4000-8000-000000000001`,
      { method: 'DELETE' },
    );
    expect(removed.status).toBe(204);
    expect(await list('owner')).toEqual([]);
  });

  /**
   * The slice's point, through the routes this time.
   *
   * Both markers are created at {@link FIXED_NOW} on one date, so `(date,
   * createdAt)` ties and the `id` key is the only thing left to decide the
   * order. The list is read **twice** and the exact lexical sequence asserted
   * both times — not merely that the two reads agree, because two reads of a
   * tied pair can agree in insertion order with the key gone.
   *
   * Negative: `asc(calendarMarker.id)` struck from
   * `CalendarMarkerRepository.listFor`'s `orderBy`. Watched failing on the
   * first read already, `Expected ["b1…", "f1…"] / Received ["f1…", "b1…"]`,
   * with every other case in this file green. Against SQLite rather than a
   * stub — the tie-break is the database's, so a fake store proves nothing
   * about it. Watched 2026-09-05.
   */
  it('orders a tie on (date, created_at) by id, on every read', async () => {
    for (const id of TIED) {
      expect(
        (await create('owner', { markerId: id, date: '2026-09-14', name: id.slice(0, 2) })).status,
      ).toBe(201);
    }
    const expected = [...TIED].sort();

    expect((await list('owner')).map((marker) => marker.id)).toEqual(expected);
    expect((await list('owner')).map((marker) => marker.id)).toEqual(expected);
  });

  /**
   * A date outside every horizon the project could draw is **stored and
   * returned**, because a marker's date is absolute (ADR 0014).
   *
   * "Stored, not drawn" is the rule an undated plan gets, and this is the same
   * rule one step along: be-01 knows nothing about which days the axis is
   * showing, so a refusal here would be be-01 inventing a horizon.
   */
  it('accepts and returns a marker outside any drawable horizon', async () => {
    const made = await create('owner', {
      markerId: 'c1000000-0000-4000-8000-000000000003',
      date: '2099-12-31',
      name: 'The far side',
    });
    expect(made.status).toBe(201);
    expect(await list('owner')).toMatchObject([{ date: '2099-12-31', name: 'The far side' }]);
  });

  /** Closes the project to everyone but its owner, through the route that owns that column. */
  const restrict = async () => {
    const res = await as(tokens['owner'], `/api/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({ restricted: true }),
    });
    expect(res.status).toBe(200);
  };

  /** The one marker every case below refuses a change to. */
  const SEEDED = 'd1000000-0000-4000-8000-000000000004';

  /**
   * Task 4.2: every mutation refused for a read-only actor, and no row written.
   *
   * All four, not just the create. A permission test that only checks the happy
   * path is not a permission test, and one that only checks the create is a
   * permission test of one quarter of the surface — rename and recolour reach
   * the server through **one** `PATCH` but take body-specific branches inside
   * it, and the delete is a separate route with a separate handler.
   *
   * `mallory` is read-only in the only sense this API has one: the project is
   * restricted and she does not own it, so `canEdit` is false for her and true
   * for `owner`.
   *
   * Negative: the `canEdit` gate removed from `CalendarMarkerService.create`'s
   * path. Watched failing on the create case with `201` where `403` was owed
   * and the marker count going to 2, while the three cases below stayed green
   * — which is what shows the four arms are four checks and not one. Watched
   * 2026-09-05.
   */
  it('refuses all four mutations for a read-only actor, and writes nothing', async () => {
    expect(
      (await create('owner', { markerId: SEEDED, date: '2026-09-14', name: 'Site visit' })).status,
    ).toBe(201);
    await restrict();
    const before = await list('owner');

    const created = await create('mallory', {
      markerId: 'e1000000-0000-4000-8000-000000000005',
      date: '2026-09-15',
      name: 'Not mine to add',
    });
    expect(created.status).toBe(403);
    // Task 4.5's `forbidden` row, and `toEqual` rather than a field read is the
    // assertion: it is the one row whose `field` is **absent**, and that
    // absence is part of the contract — the refusal is about the caller, not
    // about a member of the body. Only an exact-shape assertion can fail when
    // a field appears.
    expect(await created.json()).toEqual({ error: 'forbidden' });

    const renamed = await patch('mallory', SEEDED, { name: 'Not mine to rename' });
    expect(renamed.status).toBe(403);

    const recoloured = await patch('mallory', SEEDED, { color: CUSTOM_FILL });
    expect(recoloured.status).toBe(403);

    const removed = await as(
      tokens['mallory'],
      `/api/projects/${projectId}/calendar-markers/${SEEDED}`,
      { method: 'DELETE' },
    );
    expect(removed.status).toBe(403);

    // Read back through the owner, because `mallory` may still *read* a
    // restricted project — the assertion is about the rows, not about her.
    expect(await list('owner')).toEqual(before);
  });

  /**
   * Task 4.3: a `date` that is not an `IsoDate` is refused with a typed 422 and
   * is never coerced.
   *
   * `2026-09-17T00:00:00Z` is the case that matters and the reason the
   * validator is not a truthiness check: it is a perfectly good **instant**,
   * and an instant silently sliced to a date is how a clicked day becomes its
   * UTC neighbour. `2026-9-17` is the unpadded shape and `not-a-date` is the
   * bare mistake.
   *
   * **One `it` per date rather than a loop**, so the negative below names which
   * rows it reddens rather than stopping at whichever the loop reached first.
   *
   * Negative: `isIsoDate(body.date)` replaced with `body.date` — a truthiness
   * check. Watched reddening **all three**, the timestamp row among them, each
   * with `201` where `422` was owed and a row written; every other case in the
   * file stayed green. The timestamp is the row the spec names because it is
   * the one a *plausible* lax validator lets through: it is a perfectly good
   * instant, and the other two are not strings any check would mistake for a
   * date. Watched 2026-09-05.
   */
  for (const date of ['2026-9-17', '2026-09-17T00:00:00Z', 'not-a-date']) {
    it(`refuses the date ${date}, naming the field, and writes nothing`, async () => {
      const refused = await create('owner', {
        markerId: 'e1000000-0000-4000-8000-000000000005',
        date,
        name: 'Site visit',
      });
      expect(refused.status).toBe(422);
      expect(await refused.json()).toEqual({ error: 'malformed', field: 'date' });
      expect(await list('owner')).toEqual([]);
    });
  }

  /**
   * Task 4.6a: a client-supplied `id` must be a UUID v4.
   *
   * `marker-1` is the bare mistake; the v1-shaped UUID is the one a
   * non-empty-string check cannot tell from a v4, and it is why the version and
   * variant nibbles are pinned rather than the length.
   *
   * Negative: `UUID_V4.test(body.markerId)` replaced with `body.markerId.length > 0`.
   * Watched reddening **both** rows, `marker-1` among them, each letting the
   * create through with `201` and a row written. Watched 2026-09-05.
   */
  for (const id of ['marker-1', 'd9428888-122b-11e1-b85c-61cd3cbb3210']) {
    it(`refuses the marker id ${id}, naming the field, and writes nothing`, async () => {
      const refused = await create('owner', {
        markerId: id,
        date: '2026-09-14',
        name: 'Site visit',
      });
      expect(refused.status).toBe(422);
      expect(await refused.json()).toEqual({ error: 'malformed', field: 'markerId' });
      expect(await list('owner')).toEqual([]);
    });
  }

  /**
   * Task 4.4: the client's id, the fallback, and the collision.
   *
   * The exact-id case is a *positive* with a fault watching it — `design.md`
   * §6.1 named a server that ignores the supplied `id` and mints its own, and
   * until this slice no test executed be-01 code where that could be seen (3.5
   * covers the front-end half).
   *
   * Negative for it: `marker.id ?? this.clock.newId()` in
   * `CalendarMarkerService.create` replaced with `this.clock.newId()`. Watched
   * failing this case with the marker coming back as {@link MINTED}, while the
   * fallback case below stayed green — which is why the fault has to be
   * watched here rather than by the case that omits an id. Watched 2026-09-05.
   */
  it('stores the exact id the create carried', async () => {
    const made = await create('owner', {
      markerId: SEEDED,
      date: '2026-09-14',
      name: 'Site visit',
    });
    expect(made.status).toBe(201);
    expect(((await made.json()) as { marker: { id: string } }).marker.id).toBe(SEEDED);
    expect((await list('owner')).map((marker) => marker.id)).toEqual([SEEDED]);
  });

  /** Task 4.4: a create with no `id` is issued one by the clock this app was built with. */
  it('mints an id from the clock when the create carries none', async () => {
    const made = await create('owner', { date: '2026-09-14', name: 'Site visit' });
    expect(made.status).toBe(201);
    expect(((await made.json()) as { marker: { id: string } }).marker.id).toBe(MINTED);
  });

  /**
   * Task 4.4: a repeated id is refused, adds no row, and leaves the stored
   * marker's name, date and colour **untouched**.
   *
   * The last third is the point. A duplicate-id test that only asserted the
   * status passes against an insert written as an upsert that has already
   * destroyed the row on its way to answering.
   *
   * Negative: `tx.insert(calendarMarker).values(marker).run()` in
   * `CalendarMarkerRepository.create` written as an upsert
   * (`.onConflictDoUpdate({ target: calendarMarker.id, set: marker })`) with
   * the preceding duplicate-id read struck. Watched failing this case with
   * `201` and the stored row's name, date and colour all replaced, while the
   * two cases above stayed green. Watched 2026-09-05.
   */
  it('refuses a repeated id, adds no row, and leaves the stored marker untouched', async () => {
    expect(
      (
        await create('owner', {
          markerId: SEEDED,
          date: '2026-09-14',
          name: 'Site visit',
          color: CUSTOM_FILL,
        })
      ).status,
    ).toBe(201);
    const before = await list('owner');

    const refused = await create('owner', {
      markerId: SEEDED,
      date: '2027-01-02',
      name: 'A different day entirely',
    });
    expect(refused.status).toBe(409);
    // Task 4.5's `taken` row, asserted where the collision already lives rather
    // than in a second case of its own: the row names a status, a code **and**
    // the field it blames, and two homes for one row would be two oracles free
    // to disagree about it.
    expect(await refused.json()).toEqual({ error: 'taken', field: 'markerId' });
    expect(await list('owner')).toEqual(before);
  });

  /**
   * Task 4.5: a `color` that is not a hex triple is `malformed`, not
   * `contrast`.
   *
   * `rebeccapurple` is a real CSS colour and not a triple, and `#f00` is the
   * three-digit form the domain's `parseHex` deliberately refuses — the shape
   * a validator that silently widened it would accept and then store as
   * something no other marker is written as.
   *
   * The two codes are kept apart because `validateCustomColor` states
   * well-formedness as a **precondition it does not check**: handed either of
   * these it throws, which at a boundary is a 500 blaming the server for the
   * client's typo.
   */
  for (const color of ['rebeccapurple', '#f00']) {
    it(`refuses the color ${color} as malformed, and writes nothing`, async () => {
      const refused = await create('owner', {
        markerId: 'e1000000-0000-4000-8000-000000000005',
        date: '2026-09-14',
        name: 'Site visit',
        color,
      });
      expect(refused.status).toBe(422);
      expect(await refused.json()).toEqual({ error: 'malformed', field: 'color' });
      expect(await list('owner')).toEqual([]);
    });
  }

  /**
   * Task 4.5: a well-formed fill that fails the 3:1 bar is `contrast` — a
   * different code from the shape rows, over the same field.
   *
   * `#ff0000` is the fixture because it fails **exactly one** of the twenty
   * backdrops — `light:pointed+today`, at 2.943:1 — so it also proves the
   * server runs the whole loop rather than a sample of it. A colour failing ten
   * backdrops would be refused by a validator that measured two.
   */
  it('refuses a fill under the 3:1 bar with `contrast`, and writes nothing', async () => {
    const refused = await create('owner', {
      markerId: 'e1000000-0000-4000-8000-000000000005',
      date: '2026-09-14',
      name: 'Site visit',
      color: '#ff0000',
    });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: 'contrast', field: 'color' });
    expect(await list('owner')).toEqual([]);
  });

  /**
   * Task 3.4's **recolour** call site: `validateCustomColor` is wired into the
   * `PATCH` path too, and a refused recolour leaves the row byte-identical.
   *
   * A separate case from the create above and not a duplicate of it, because
   * the two are separate calls in separate handler branches: the create's
   * contrast check can be perfectly wired while the recolour branch has none,
   * and every case in this file except this one ships green past that.
   *
   * **A malformed hex does not cover this.** `rebeccapurple` and `#f00` are
   * refused by shape validation, which the recolour branch would still reach —
   * so the fixture has to be a *syntactically valid* triple that fails the bar,
   * which is `#ff0000` again and for its own reason: it fails exactly one of
   * the twenty backdrops, so it also proves the recolour path runs the whole
   * loop rather than a sample of it. This is the gap the round-3 Sol review
   * found.
   *
   * The marker is created with **no** colour, so `null` is what the row must
   * still read afterwards: a recolour that wrote and then refused would answer
   * this same 422 with the fill stored, and only reading the row back can tell
   * the two apart.
   *
   * Negative, and it is the recolour path's own: `colorProblem(color)` removed
   * from the `PATCH` handler's `color !== undefined` arm, leaving the create's
   * call in place. Watched at 23 pass / 1 fail, exactly this case, with `200`
   * where `422` was owed and `#ff0000` stored on the row — while the create's
   * contrast case, the round trip's recolour and the whole refusal table stayed
   * green. Watched 2026-09-05.
   */
  it('refuses a recolour under the 3:1 bar, and leaves the stored fill behind', async () => {
    expect(
      (await create('owner', { markerId: SEEDED, date: '2026-09-14', name: 'Site visit' })).status,
    ).toBe(201);
    const before = await list('owner');
    expect(before).toMatchObject([{ color: null }]);

    const refused = await patch('owner', SEEDED, { color: '#ff0000' });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: 'contrast', field: 'color' });
    expect(await list('owner')).toEqual(before);
  });

  /**
   * Task 4.5: the `name` row, at both ends of one bound.
   *
   * Empty and over-cap are the same row of the table and the same refusal: the
   * bound is 1 to `MARKER_NAME_MAX` code points, so "unnamed" is not a state a
   * stored marker can be in either.
   *
   * Negative for the pair, and it is watched by the **acceptance** case below
   * rather than by these: code-point counting replaced with `name.length`.
   */
  for (const [label, name] of [
    ['an empty name', ''],
    [`a name of ${String(MARKER_NAME_MAX + 1)} code points`, NAME_OVER_CAP],
  ] as const) {
    it(`refuses ${label}, naming the field, and writes nothing`, async () => {
      const refused = await create('owner', {
        markerId: 'e1000000-0000-4000-8000-000000000005',
        date: '2026-09-14',
        name,
      });
      expect(refused.status).toBe(422);
      expect(await refused.json()).toEqual({ error: 'malformed', field: 'name' });
      expect(await list('owner')).toEqual([]);
    });
  }

  /**
   * Task 4.5: a name of exactly `MARKER_NAME_MAX` **code points** is accepted
   * and stored whole.
   *
   * This is the case the astral fixtures exist for, and the direction that
   * matters: a user refused a name the spec allows. `NAME_AT_CAP` is 120 code
   * points and 240 UTF-16 units, so an implementation counting `name.length`
   * refuses it — and refuses it while every rejection case above stays green,
   * because those are wrong at both counts.
   *
   * Negative: `[...name].length` in `isMarkerName` replaced with `name.length`.
   * Watched failing **only** this case, `422` where `201` was owed and no row
   * written, with both refusal cases above and the refused-rename case below
   * still green. Watched 2026-09-05.
   */
  it('accepts a name of exactly MARKER_NAME_MAX code points', async () => {
    const made = await create('owner', {
      markerId: 'e1000000-0000-4000-8000-000000000005',
      date: '2026-09-14',
      name: NAME_AT_CAP,
    });
    expect(made.status).toBe(201);
    // Read back through the list rather than only from the create's answer:
    // the assertion is that the whole name was *stored*, and a column that
    // truncated it would answer the create with what it was handed.
    expect(await list('owner')).toMatchObject([{ name: NAME_AT_CAP }]);
    // The fixture's own invariant, asserted rather than trusted: 120 code
    // points and 240 UTF-16 units, which is what makes the negative reachable.
    // eslint-disable-next-line @typescript-eslint/no-misused-spread -- code points are the unit under test
    expect([...NAME_AT_CAP].length).toBe(MARKER_NAME_MAX);
    expect(NAME_AT_CAP.length).toBe(MARKER_NAME_MAX * 2);
  });

  /**
   * Task 4.5: a refused rename applies nothing — the spec's "SHALL NOT
   * partially apply", which is the second of two claims.
   *
   * "Refused" is the status. "Unchanged" is the row, and only this assertion
   * reaches it: a rename that wrote the new name and then refused it answers
   * exactly the same 422 as one that refused first.
   *
   * Negative: `nameProblem(name)` moved to **after** the
   * `markers.rename(…)` call in the `PATCH` handler. Watched failing this case
   * with the marker carrying `NAME_OVER_CAP` while the status stayed 422 and
   * every other case in the file stayed green. Watched 2026-09-05.
   */
  it('refuses an over-cap rename and leaves the stored name behind', async () => {
    expect(
      (await create('owner', { markerId: SEEDED, date: '2026-09-14', name: 'Site visit' })).status,
    ).toBe(201);
    const before = await list('owner');

    const refused = await patch('owner', SEEDED, { name: NAME_OVER_CAP });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: 'malformed', field: 'name' });
    expect(await list('owner')).toEqual(before);
  });

  /**
   * Task 4.5: the `not_found` row — 404, and it blames the `id`.
   *
   * A marker id that resolves to nothing this project owns. The row covers "the
   * marker is absent, or another project's" and answers the same code for both,
   * because the caller may not learn that another project's marker exists;
   * task 4.6 is where the second half of that sentence is driven.
   */
  it('refuses a rename of an absent marker with not_found, naming the field', async () => {
    expect(
      (await create('owner', { markerId: SEEDED, date: '2026-09-14', name: 'Site visit' })).status,
    ).toBe(201);
    const before = await list('owner');

    const refused = await patch('owner', 'f9000000-0000-4000-8000-00000000000f', {
      name: 'Nothing to rename',
    });
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: 'not_found', field: 'markerId' });
    expect(await list('owner')).toEqual(before);
  });

  /** Task 4.6's second project, owned by the same account so the cases are about scope and not permission. */
  const secondProject = async (): Promise<string> => {
    const made = await as(tokens['owner'], '/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Rewire the other shed' }),
    });
    // 200, not 201: `POST /api/projects` answers with the project rather than
    // with a Created. Asserted anyway, because a `secondProject` that silently
    // refused would hand every case below an `undefined` id and the isolation
    // they assert would be two requests missing the same way.
    expect(made.status).toBe(200);
    return ((await made.json()) as { project: { id: string } }).project.id;
  };

  /** A's marker and B's, one apiece — the pair every isolation case below is written over. */
  const MINE = 'a2000000-0000-4000-8000-00000000000a';
  const THEIRS = 'b2000000-0000-4000-8000-00000000000b';

  /**
   * Two projects, one marker each, both created through the routes.
   *
   * `mallory` never appears: both projects are the owner's, so a case that
   * refuses is refusing on **scope** and not on permission. Task 4.2 already
   * owns the permission half, and a fixture where the second project belonged
   * to someone else would let a `canEdit` check answer every case here with the
   * `project_id` predicate gone.
   */
  const twoProjects = async (): Promise<string> => {
    const other = await secondProject();
    expect(
      (await createIn(projectId, 'owner', { markerId: MINE, date: '2026-09-14', name: 'Mine' }))
        .status,
    ).toBe(201);
    expect(
      (await createIn(other, 'owner', { markerId: THEIRS, date: '2026-09-14', name: 'Theirs' }))
        .status,
    ).toBe(201);
    return other;
  };

  /**
   * Task 4.6: a project's list holds none of another project's markers, and a
   * rename that names one is refused with both rows left alone.
   *
   * The `not_found` code is the same one an absent marker gets, and that is the
   * contract rather than an approximation: the caller may not learn that
   * another project's marker exists.
   *
   * Negative: `eq(calendarMarker.projectId, projectId)` struck from
   * `CalendarMarkerRepository.listFor`'s `where`. Watched at 21 pass / 2 fail —
   * this case and the delete case below, both on a list read answering **both**
   * markers (`Mine` came back from the other project's list) — while the rename
   * refusal itself still answered 404, because that path is scoped by `touch`'s
   * own predicate and not by the list's. That split is the point: the two
   * halves of "isolated" are two predicates. Watched 2026-09-05.
   */
  it('lists only its own markers, and refuses a rename naming another project’s', async () => {
    const other = await twoProjects();

    expect((await listIn(projectId, 'owner')).map((marker) => marker.id)).toEqual([MINE]);
    expect((await listIn(other, 'owner')).map((marker) => marker.id)).toEqual([THEIRS]);

    const refused = await patchIn(projectId, 'owner', THEIRS, { name: 'Not mine to rename' });
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: 'not_found', field: 'markerId' });

    expect(await listIn(projectId, 'owner')).toMatchObject([{ id: MINE, name: 'Mine' }]);
    expect(await listIn(other, 'owner')).toMatchObject([{ id: THEIRS, name: 'Theirs' }]);
  });

  /**
   * Task 4.6: the same scope, through the one mutating route the rename case
   * cannot reach.
   *
   * Rename and recolour arrive as two bodies through one `PATCH`, so scoping
   * that handler scopes both — the delete is a separate route with a predicate
   * of its own that nothing above names. A delete matched on marker id alone
   * removes project B's row through project A's route while every case above
   * passes.
   *
   * Negative, and it is the delete path's own: **the delete path scoped by
   * marker id alone** — the `projectId` term struck from *both* of
   * `CalendarMarkerRepository.remove`'s statements, its `one(...)` guard read
   * and the `tx.delete(...)` beneath it. Watched at 22 pass / 1 fail, exactly
   * this case, with the cross-project delete answering 204 and `THEIRS` gone
   * from the other project's list — while the rename case above, the round trip
   * and the permission case stayed green. The list-predicate negative cannot
   * reach this fault: the delete never runs through the list query.
   *
   * **The narrower fault — the term struck from the `tx.delete(...)` statement
   * alone — cannot fail, and that is worth carrying.** Watched: 23 pass / 0
   * fail, the whole file green. `remove` reads the marker through the scoped
   * `one(...)` first and answers `not_found` before the `DELETE` is issued, so
   * that statement's own predicate is unreachable defence. It stays in the
   * repository — a guard read is one refactor from being inlined away — but no
   * test here asserts it, and `tasks.md` 4.6 records why.
   * Both watched 2026-09-05.
   */
  it('refuses a delete naming another project’s marker, and leaves that row standing', async () => {
    const other = await twoProjects();

    const refused = await removeIn(projectId, 'owner', THEIRS);
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: 'not_found', field: 'markerId' });

    expect(await listIn(other, 'owner')).toMatchObject([{ id: THEIRS, name: 'Theirs' }]);
    expect(await listIn(projectId, 'owner')).toMatchObject([{ id: MINE, name: 'Mine' }]);
  });

  /**
   * The `work_item` table as it stands, read on a connection of its own.
   *
   * Its own connection for the reason `work-item.db.test.ts`'s `joinedTeams`
   * has one, plus a second that is this slice's: a read through the app's
   * drizzle client would push a statement naming `work_item` into
   * {@link statements} — the very log the reach assertion is about — so the
   * oracle would falsify itself.
   */
  const workItemRows = (): Record<string, unknown>[] => {
    const raw = openDatabase(dbPath);
    try {
      return raw.query<Record<string, unknown>, []>('SELECT * FROM work_item ORDER BY id').all();
    } finally {
      raw.close();
    }
  };

  /**
   * Task 4.6: a marker is not a work item — driven, not asserted about the
   * source.
   *
   * One real `work_item` row is seeded first, because "unchanged" over an empty
   * table is a claim about nothing: a marker route that dropped every work item
   * would satisfy `[] === []`. The row goes in through `WorkItemRepository` so
   * it is the shape the app writes rather than one this file invented.
   *
   * Then all five verbs, and two assertions over them. The **rows** are
   * unchanged, which is the visible half. The **statements** name no
   * `work_item`, which is the half that catches a read: a read changes no row,
   * so the first assertion alone passes over a marker list that also selected
   * every work item of the project and threw the answer away — and that read is
   * a coupling, one migration away from being a dependency.
   *
   * `calendar_marker` is asserted to be *present* in the same log before
   * `work_item` is asserted absent. Without that precondition a drive that
   * issued no statements at all — a route silently unwired, a helper that
   * stopped awaiting — would pass this case by reaching nothing.
   *
   * Two negatives, and they are two faults rather than one. Both are
   * `this.db.select({ id: workItem.id }).from(workItem).all()` with the result
   * discarded, injected in `CalendarMarkerRepository` rather than in the
   * controller — the handler holds a `CalendarMarkerService` and no drizzle
   * client, so a read written there would be testing the plumbing it needed
   * first. A layer down is also the stronger demonstration: the controller
   * source stays clean and the statement still shows up.
   *
   * 1. **The list-path read**, in `listFor`. Watched at 22 pass / 1 fail,
   *    exactly this case, failing on the statement assertion with the offending
   *    `select "id" from "work_item"` printed — while the row assertion stayed
   *    green, which is precisely why the reach oracle exists.
   * 2. **The recolour-branch read**, in `recolor`, which the colour branch
   *    reaches and the rename branch does not. Watched at 22 pass / 1 fail,
   *    again exactly this case, while the round trip, the rename cases and the
   *    whole refusal table stayed green — rename and recolour share one route,
   *    so a fault on one branch is invisible to every case driving the other.
   *
   * Both watched 2026-09-05.
   */
  it('creates, renames, recolours and deletes without naming the work_item table', async () => {
    const owner = await new ProjectRepository(db).findById(projectId);
    expect(owner).not.toBeNull();
    const wrote: WriteStamp = { at: FIXED_NOW, by: owner?.ownerId ?? '' };
    const seeded: WorkItem = {
      id: 'aaaaaaaa-0000-4000-8000-00000000aaaa',
      projectId,
      parentId: null,
      position: 10,
      name: 'Strip the old wiring',
      notes: '',
      frozenNumber: null,
      priority: null,
      startNoEarlierThan: null,
      startNoEarlierThanReason: null,
      serviceTeamId: null,
      serviceId: null,
      maxParallel: 1,
      revision: 0,
    };
    await new WorkItemRepository(db).insert(seeded, [], wrote);
    const before = workItemRows();
    expect(before).toHaveLength(1);

    // Cleared here rather than trusted from `beforeEach`: the seed above, the
    // registrations and the project create are all on this connection, and the
    // assertion is about what the **marker routes** issued.
    statements.length = 0;

    expect(
      (await create('owner', { markerId: MINE, date: '2026-09-14', name: 'Site visit' })).status,
    ).toBe(201);
    expect(await list('owner')).toHaveLength(1);
    expect((await patch('owner', MINE, { name: 'Site visit, rescheduled' })).status).toBe(200);
    expect((await patch('owner', MINE, { color: CUSTOM_FILL })).status).toBe(200);
    expect((await removeIn(projectId, 'owner', MINE)).status).toBe(204);

    expect(statements.some((query) => query.includes('calendar_marker'))).toBe(true);
    expect(statements.filter((query) => query.includes('work_item'))).toEqual([]);
    expect(workItemRows()).toEqual(before);
  });
});
