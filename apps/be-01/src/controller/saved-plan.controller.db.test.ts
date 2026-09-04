import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildApp } from '../app';
import { openConnection } from '../repository/db';
import { runMigrations } from '../repository/migrate';
import { ProjectRepository } from '../repository/project';
import { UserRepository } from '../repository/user';
import { AuthService } from '../service/auth.service';
import { ProjectService } from '../service/project.service';
import { defaultSavedPlanName } from '../service/saved-plan-default-name';
import { TEST_JWT_KEY } from '../testing/auth-fixture';
import { testCapacityService } from '../testing/capacity-fixture';
import { testDirectoryService } from '../testing/directory-fixture';
import { testHistoryService } from '../testing/history-fixture';
import { testPriorityBandService } from '../testing/priority-band-fixture';
import { testReplay } from '../testing/replay-fixture';
import { savedPlanServiceOn } from '../testing/saved-plan-fixture';
import { testStepService } from '../testing/step-fixture';
import { testWorkItemService } from '../testing/work-item-fixture';
import { testWrites } from '../testing/writes-fixture';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;

/**
 * The five saved-plan routes, over HTTP and against real SQLite (task 6.1).
 *
 * Real SQLite rather than this folder's usual in-memory doubles, and not by
 * preference: a saved plan is captured **from the database** on a second
 * connection, so there is no store to substitute — a Map-backed stand-in would
 * be a different thing rather than a smaller one.
 *
 * Three accounts, registered through `/api/auth/register` so the token names an
 * identity `userFromHeaders` really resolves: `owner` owns the project, `ada`
 * saves the plans, `mallory` is the third party. Two accounts cannot separate
 * the rule under test from its wrong versions — see
 * `service/saved-plan-touch.db.test.ts`, which proves the rule itself. What is
 * proved **here** is the part only a request can reach: the statuses, and that
 * the stored creator is the caller rather than anything a body said.
 */
describe('the saved-plan routes', () => {
  let dir: string;
  let app: ReturnType<typeof buildApp>;
  let tokens: Record<string, string>;
  let projectId: string;
  /** The database file behind {@link app}, for the one test that damages it. */
  let path: string;

  /**
   * One authenticated request. `headers` is set rather than merged: every
   * caller here wants exactly these two, and `RequestInit['headers']` may be an
   * array of pairs, which spreading into an object turns into indices.
   */
  const as = (token: string, path: string, init: Omit<RequestInit, 'headers'> = {}) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
      }),
    );

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wbs-saved-plan-http-'));
    path = join(dir, 'test.db');
    runMigrations(path, FOLDER);
    const connection = openConnection(path);
    const projects = new ProjectRepository(connection.db);

    app = buildApp({
      auth: new AuthService({ users: new UserRepository(connection.db), jwtKey: TEST_JWT_KEY }),
      projects: new ProjectService({ projects }),
      savedPlans: savedPlanServiceOn(path),
      steps: testStepService(),
      workItems: testWorkItemService(),
      directory: testDirectoryService(),
      capacity: testCapacityService(),
      priorityBands: testPriorityBandService(),
      history: testHistoryService(),
      replay: testReplay().replay,
      probeDatabase: () => 'ok',
      internalAuthSecret: 'x'.repeat(32),
      writes: testWrites(),
      migrationsApplied: true,
    });

    tokens = {};
    for (const username of ['owner', 'ada', 'mallory']) {
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

  const save = (who: string, name = 'before the rewire') =>
    as(tokens[who], `/api/projects/${projectId}/saved-plans`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });

  const savedIdOf = async (res: Response): Promise<string> =>
    ((await res.json()) as { savedPlan: { id: string } }).savedPlan.id;

  /**
   * The identity assertion, and the one a body-supplied creator would fail.
   * `createdBy` is the *caller's* username — the project is unrestricted, so
   * `ada` may save on it, and nothing in the request said who she was except
   * her token.
   */
  it('stores the caller as the creator, not anything the body said', async () => {
    const res = await save('ada');
    expect(res.status).toBe(201);

    const read = await as(tokens['mallory'], `/api/saved-plans/${await savedIdOf(res)}`);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { savedPlan: { createdBy: string } }).savedPlan.createdBy).toBe(
      'ada',
    );
  });

  /**
   * A-1 end to end: "save writes immediately with the server timestamp as the
   * default name, and naming is an edit afterwards, not a modal".
   *
   * The assertion is deliberately **against the record's own `createdAt`** and
   * not against a literal or a regular expression. A name merely *shaped* like a
   * timestamp would pass a pattern match while naming a different instant than
   * the date column beside it; only reading both out of one response can tell
   * those apart. `defaultSavedPlanName` is imported rather than re-spelled here
   * so the two cannot drift into agreeing by coincidence.
   */
  it('names a plan saved without one from the same clock that stamped it', async () => {
    const res = await as(tokens['ada'], `/api/projects/${projectId}/saved-plans`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);

    const { savedPlan } = (await res.json()) as {
      savedPlan: { name: string; createdAt: number };
    };
    expect(savedPlan.name).toBe(defaultSavedPlanName(savedPlan.createdAt));
  });

  /**
   * The other half of optional, and the one that keeps it from being a hole:
   * `minLength: 1` still applies to a name that is sent. An empty string is a
   * caller mistake, not A-1's "no name given" — defaulting it would replace
   * what somebody typed rather than fill in what they omitted, and would make
   * `{}` and `{ name: '' }` indistinguishable to a client debugging a form.
   */
  it('refuses an empty name rather than defaulting it', async () => {
    const res = await as(tokens['ada'], `/api/projects/${projectId}/saved-plans`, {
      method: 'POST',
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(422);
  });

  it('lists a project’s plans to any authenticated account', async () => {
    await save('ada');
    const res = await as(tokens['mallory'], `/api/projects/${projectId}/saved-plans`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { savedPlans: unknown[] }).savedPlans).toHaveLength(1);
  });

  /**
   * The route-level half of the permission rule. `ada` saved it on a project
   * she does not own, and the project is unrestricted — so the ordinary write
   * rule says `mallory` may write to it, and the rename must still refuse her.
   */
  it('lets the creator and the project owner rename, and refuses a third party', async () => {
    const id = await savedIdOf(await save('ada'));
    const rename = (who: string, name: string) =>
      as(tokens[who], `/api/saved-plans/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });

    expect((await rename('mallory', 'mine now')).status).toBe(403);
    expect((await rename('ada', 'hers')).status).toBe(200);
    expect((await rename('owner', 'his')).status).toBe(200);

    const read = await as(tokens['ada'], `/api/saved-plans/${id}`);
    expect(((await read.json()) as { savedPlan: { name: string } }).savedPlan.name).toBe('his');
  });

  it('answers 204 on a delete and 404 on the read that follows', async () => {
    const id = await savedIdOf(await save('ada'));

    expect(
      (await as(tokens['mallory'], `/api/saved-plans/${id}`, { method: 'DELETE' })).status,
    ).toBe(403);
    expect((await as(tokens['ada'], `/api/saved-plans/${id}`, { method: 'DELETE' })).status).toBe(
      204,
    );
    expect((await as(tokens['ada'], `/api/saved-plans/${id}`)).status).toBe(404);
  });

  /**
   * A mistyped project id and an empty shelf both list as `[]` at the service,
   * so the route reads the project first and a client can tell them apart.
   */
  it('answers 404 for a project that is not there', async () => {
    expect((await as(tokens['owner'], '/api/projects/nope/saved-plans')).status).toBe(404);
    expect((await save('owner')).status).toBe(201);
  });

  it('refuses an unauthenticated caller before it decides anything else', async () => {
    const res = await app.handle(
      new Request(`http://localhost/api/projects/${projectId}/saved-plans`),
    );
    expect(res.status).toBe(401);
  });

  /**
   * Task 7.3b — the compare route answers a diff, and `current` is a side.
   *
   * The assertion is deliberately *not* on the diff's contents: 7.1's and 7.2's
   * suites own what `diffPlans` reports, and repeating a field list here would
   * be a second place to forget to update. What only a request can reach is
   * that the two sides were resolved and handed to the diff at all — a saved
   * plan against itself is empty on both halves, and against `current` after an
   * edit it is not.
   */
  const compareOf = async (
    who: string,
    left: string,
    right: string,
  ): Promise<{ status: number; body: unknown }> => {
    const res = await as(
      tokens[who],
      `/api/projects/${projectId}/saved-plans/compare?left=${left}&right=${right}`,
    );
    return { status: res.status, body: await res.json() };
  };

  it('compares a saved plan with itself and reports no difference', async () => {
    const id = await savedIdOf(await save('ada'));
    const { status, body } = await compareOf('ada', id, id);
    expect(status).toBe(200);
    const { diff } = body as { diff: { input: unknown[]; schedule: unknown[] } };
    expect(diff.input).toEqual([]);
    expect(diff.schedule).toEqual([]);
  });

  it('compares a saved plan with `current`', async () => {
    const id = await savedIdOf(await save('ada'));
    const { status, body } = await compareOf('ada', id, 'current');
    expect(status).toBe(200);
    // Both halves present is the whole assertion: `current` resolved through
    // 7.3's capture rather than answering "no plan", and 7.3a gave it a
    // schedule side to compare against the saved one.
    const { diff } = body as { diff: { input: unknown[]; schedule: unknown[] } };
    expect(Array.isArray(diff.input)).toBe(true);
    expect(Array.isArray(diff.schedule)).toBe(true);
  });

  /**
   * The cross-project refusal, and the reason the compare route may carry a
   * project id at all.
   *
   * Without it a caller who may read project A's plans names one of them as the
   * left side and `current` on project B as the right, and the answer contains
   * project B's live plan — which is exactly the exposure 7.3b's negative
   * names, reached through the *side* rather than through the guard. The status
   * is a plain 404 with no hint that the plan exists somewhere else.
   */
  it('refuses a saved plan that belongs to another project', async () => {
    const foreign = await savedIdOf(await save('ada'));
    const other = await as(tokens['owner'], '/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Somebody else’s shed' }),
    });
    const otherId = ((await other.json()) as { project: { id: string } }).project.id;

    const res = await as(
      tokens['ada'],
      `/api/projects/${otherId}/saved-plans/compare?left=${foreign}&right=current`,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', savedPlanId: foreign });
  });

  /**
   * A corrupt side is 422 and names which plan, not 404 and not 500.
   *
   * `read`'s own 422 is proved above for the single-plan route; this is the
   * part only the compare route has — two sides, so a refusal with no id leaves
   * a caller unable to tell which of its two pickers is holding the damaged
   * plan. The service's `read` is what refuses; what is proved here is that the
   * compare route carries the refusal out rather than folding it into the
   * `not_found` its other three refusals share.
   */
  it('answers 422 naming the side whose stored bytes are damaged', async () => {
    const id = await savedIdOf(await save('ada'));
    // One byte appended underneath the record, as `saved-plan-read.db.test.ts`
    // does it: the change is provably in the bytes rather than in some equal
    // rendering of them.
    const damaged = openConnection(path);
    damaged.db.run(`UPDATE saved_plan_body SET bytes = bytes || ' ' WHERE kind = 'input'`);
    damaged.close();

    const res = await as(
      tokens['ada'],
      `/api/projects/${projectId}/saved-plans/compare?left=${id}&right=current`,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; savedPlanId: string };
    expect(body.error).toBe('corrupt');
    expect(body.savedPlanId).toBe(id);
  });

  /**
   * The two cases above, crossed — and the crossing is the defect.
   *
   * Each of them alone passed on the old code: the cross-project test used
   * a *healthy* foreign plan and the corrupt test used a plan in *this*
   * project.
   * `sideOf` read and verified the bytes first and checked the project second,
   * so the one combination neither covered — a corrupt plan in another project
   * — left as the 422 above, naming a foreign id and reporting its condition,
   * where every foreign plan is promised the same 404 an id that never existed
   * gets. Sol's I2 on PR 202.
   *
   * A prober with a list of ids and no access to project A could therefore sort
   * them into "exists here and is damaged" and "unknown", which is exactly the
   * distinction the plain 404 above exists to deny them.
   *
   * Watched: with the `principalsOf` scope check removed from `sideOf`, this
   * fails on `expected 422 to be 404`.
   */
  it('does not admit that another project’s plan exists, even when it is damaged', async () => {
    const foreign = await savedIdOf(await save('ada'));
    const other = await as(tokens['owner'], '/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Somebody else’s shed' }),
    });
    const otherId = ((await other.json()) as { project: { id: string } }).project.id;

    const damaged = openConnection(path);
    damaged.db.run(`UPDATE saved_plan_body SET bytes = bytes || ' ' WHERE kind = 'input'`);
    damaged.close();

    const res = await as(
      tokens['ada'],
      `/api/projects/${otherId}/saved-plans/compare?left=${foreign}&right=current`,
    );
    expect(res.status).toBe(404);
    // Byte-for-byte what the healthy foreign plan answers above: a caller
    // cannot tell the two apart, which is the whole property.
    expect(await res.json()).toEqual({ error: 'not_found', savedPlanId: foreign });
  });

  /**
   * A plan this build cannot read is a refusal about the **build**, not a crash
   * and not a slur on the plan.
   *
   * Gemini's F-02 on PR 202, restored after run 14 deleted it and run 15
   * corrected what it should assert. Every byte is intact and every hash agrees;
   * only `input_schema_version` names a schema this reader does not know.
   * `assertKnownBodyVersion` throws `UnknownSavedPlanBodyVersionError` out of
   * `readOfStored`, and until the `onError` arm existed no route caught it, so
   * Elysia answered **500** — an unmodelled status for a database state the
   * domain anticipates by name, which R5 forbids.
   *
   * **501 and not the 422 `corrupt` the first version of this case asserted.**
   * `saved-plan-integrity.ts` argues the difference and is right: `corrupt`
   * says *this plan's bytes are damaged*, and here nothing is damaged — every
   * record at that version is unreadable by this node, and the one at fault is
   * the reader. A 422 would send an operator looking for lost bytes instead of
   * an upgrade.
   *
   * A version from the future is the case a real deployment meets: a newer node
   * writes a plan, an older one is asked to read it. Written straight into the
   * column rather than through a migration, because the point is the *reader's*
   * behaviour.
   *
   * Both read routes, because the throw is in the path they share and a repair
   * that covered only compare would leave the single-plan read at 500.
   */
  it('refuses a plan written by a newer node instead of crashing on it', async () => {
    const id = await savedIdOf(await save('ada'));
    const ahead = openConnection(path);
    ahead.db.run(`UPDATE saved_plan SET input_schema_version = 9999 WHERE id = '${id}'`);
    ahead.close();

    const compared = await as(
      tokens['ada'],
      `/api/projects/${projectId}/saved-plans/compare?left=${id}&right=current`,
    );
    expect(compared.status).toBe(501);
    expect(await compared.json()).toEqual({
      error: 'unsupported_body_version',
      savedPlanId: id,
      body: 'input',
      version: 9999,
      // Named rather than matched loosely: the answer has to say what this
      // build *does* know, or an operator cannot tell how far behind it is.
      supported: [1],
    });

    const read = await as(tokens['ada'], `/api/saved-plans/${id}`);
    expect(read.status).toBe(501);
  });

  /**
   * `current` is a reserved literal, not a lookup, and this is the case that
   * says so about the literal rather than about a status.
   *
   * The project has **no saved plans at all** and both sides are `current`, so
   * nothing else is moving: a build that resolved every side by id answers 404
   * here because no plan is called `current`, and a build that reserves the
   * literal captures the live plan twice and reports no difference.
   *
   * **Measured, and it is not the only case that moves.** Deleting the reserved
   * literal turns eight of this file's tests red, because every other compare
   * case passes `right=current` too. So this one is not the sole detector; what
   * it is, is the only one whose failure is unambiguous — the others could go
   * red for any reason a side fails to resolve, while this one has no saved
   * plan in it to fail on.
   */
  it('reads `current` as the live plan and never as a saved-plan id', async () => {
    const { status, body } = await compareOf('ada', 'current', 'current');
    expect(status).toBe(200);
    const { diff } = body as { diff: { input: unknown[]; schedule: unknown[] } };
    expect(diff.input).toEqual([]);
    expect(diff.schedule).toEqual([]);
  });

  it('answers 404 when the compare route names a project that is not there', async () => {
    const res = await as(
      tokens['ada'],
      '/api/projects/does-not-exist/saved-plans/compare?left=current&right=current',
    );
    expect(res.status).toBe(404);
  });

  /**
   * Task 6.2's matrix: every caller a saved-plan route can have, against all
   * **six** routes, on a project that is unrestricted and then restricted.
   *
   * **The cell that carries the task is `restricted` × `ada`.** She created the
   * plans and does not own the project, so on a restricted project `canEdit` is
   * false for her — she may not save a new plan — and yet she may still rename
   * and delete the ones she already made. No single rule produces both answers,
   * which is exactly what 6.1 separated: saving is an ordinary project write,
   * renaming and deleting are the creator-or-owner rule. The tests above prove
   * that rule holds on an *unrestricted* project, where the ordinary rule is
   * permissive; this proves it is not merely `canEdit` wearing a second name on
   * a project where the ordinary rule is strict.
   *
   * The `anonymous` row is not padding either: it says the guard runs *before*
   * the permission rule, so a restricted project answers an unauthenticated
   * caller 401 and never 403 — a 403 there would tell a stranger the project
   * exists.
   *
   * **`compare` is the sixth column and the reason 7.3b extends this table
   * rather than testing its route alone.** It is the only route that can hand
   * back a restricted project's *live* plan, through the `current` side, and it
   * is therefore the only route whose guard has to be proved against the same
   * four callers as the five that came before. The cell that carries it is
   * `restricted` × `anonymous`: 401, from the guard, before the project is read
   * and long before `current` is captured. Drop `signedIn` from the route and
   * that cell answers 200 with the live plan of a project its caller never
   * authenticated to see.
   *
   * The `restricted` × `mallory` cell reads 200, and that is this codebase's
   * read rule rather than an oversight: `canEdit` restricts *writing*, and the
   * `read` column beside it has said 200 there since 6.2. What stops a third
   * party reaching another project's live plan is not this row — it is the
   * cross-project refusal proved above, which is the other half of 7.3b's
   * negative and the half a status matrix cannot see.
   */
  describe('the permission matrix', () => {
    type Actor = 'anonymous' | 'owner' | 'ada' | 'mallory';
    interface Row {
      save: number;
      list: number;
      read: number;
      rename: number;
      delete: number;
      compare: number;
    }

    const ACTORS: readonly Actor[] = ['anonymous', 'owner', 'ada', 'mallory'];

    const MATRIX: Record<'unrestricted' | 'restricted', Record<Actor, Row>> = {
      unrestricted: {
        anonymous: { save: 401, list: 401, read: 401, rename: 401, delete: 401, compare: 401 },
        owner: { save: 201, list: 200, read: 200, rename: 200, delete: 204, compare: 200 },
        ada: { save: 201, list: 200, read: 200, rename: 200, delete: 204, compare: 200 },
        // The ordinary write rule would let her save — the project is open —
        // and the creator-or-owner rule still refuses her the other two.
        mallory: { save: 201, list: 200, read: 200, rename: 403, delete: 403, compare: 200 },
      },
      restricted: {
        // 401 before the project is read and before `current` is captured. This
        // is the cell 7.3b's negative moves: with the guard gone it is 200 and
        // carries the restricted project's live plan.
        anonymous: { save: 401, list: 401, read: 401, rename: 401, delete: 401, compare: 401 },
        owner: { save: 201, list: 200, read: 200, rename: 200, delete: 204, compare: 200 },
        // Refused a new plan and allowed to rename and delete her own: the two
        // rules disagreeing about one caller is the point of the whole column.
        ada: { save: 403, list: 200, read: 200, rename: 200, delete: 204, compare: 200 },
        mallory: { save: 403, list: 200, read: 200, rename: 403, delete: 403, compare: 200 },
      },
    };

    /** As {@link as}, except that `anonymous` sends no `authorization` header. */
    const request = (actor: Actor, path: string, init: Omit<RequestInit, 'headers'> = {}) =>
      actor === 'anonymous'
        ? app.handle(
            new Request(`http://localhost${path}`, {
              ...init,
              headers: { 'content-type': 'application/json' },
            }),
          )
        : as(tokens[actor], path, init);

    for (const column of ['unrestricted', 'restricted'] as const) {
      for (const actor of ACTORS) {
        it(`${column}: ${actor} against all six routes`, async () => {
          // Seeded before the project is restricted, because on a restricted
          // project `ada` could not create them — and a matrix whose rename and
          // delete targets were the owner's would be asking a different
          // question in the two columns.
          const toRead = await savedIdOf(await save('ada', 'the read target'));
          const toRename = await savedIdOf(await save('ada', 'the rename target'));
          const toDelete = await savedIdOf(await save('ada', 'the delete target'));

          if (column === 'restricted') {
            const restricted = await as(tokens['owner'], `/api/projects/${projectId}`, {
              method: 'PATCH',
              body: JSON.stringify({ restricted: true }),
            });
            expect(restricted.status).toBe(200);
          }

          // Collected into one object and compared whole, so a wrong rule
          // reports every cell it moved rather than stopping at the first.
          const row: Row = {
            save: (
              await request(actor, `/api/projects/${projectId}/saved-plans`, {
                method: 'POST',
                body: JSON.stringify({ name: 'one more' }),
              })
            ).status,
            list: (await request(actor, `/api/projects/${projectId}/saved-plans`)).status,
            read: (await request(actor, `/api/saved-plans/${toRead}`)).status,
            rename: (
              await request(actor, `/api/saved-plans/${toRename}`, {
                method: 'PATCH',
                body: JSON.stringify({ name: 'renamed' }),
              })
            ).status,
            delete: (await request(actor, `/api/saved-plans/${toDelete}`, { method: 'DELETE' }))
              .status,
            // `toRead` against `current`: the direction that reaches the live
            // plan, so the cell moves when the guard does.
            compare: (
              await request(
                actor,
                `/api/projects/${projectId}/saved-plans/compare?left=${toRead}&right=current`,
              )
            ).status,
          };

          expect(row).toEqual(MATRIX[column][actor]);
        });
      }
    }
  });
});
