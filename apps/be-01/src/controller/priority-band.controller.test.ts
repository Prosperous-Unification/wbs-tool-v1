import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_PRIORITY_BANDS, type PriorityBand } from '@wbs/domain';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildApp } from '../app';
import { openDrizzle } from '../repository/db';
import { runMigrations } from '../repository/migrate';
import { PriorityBandRepository } from '../repository/priority-band';
import { ProjectRepository } from '../repository/project';
import { UserRepository } from '../repository/user';
import { AuthService } from '../service/auth.service';
import { PriorityBandService } from '../service/priority-band.service';
import { ProjectService } from '../service/project.service';
import { type RecordingBroadcaster, recordingBroadcaster } from '../testing/broadcast-fixture';
import { testCapacityService } from '../testing/capacity-fixture';
import { testDirectoryService } from '../testing/directory-fixture';
import { testHistoryService } from '../testing/history-fixture';
import { testReplay } from '../testing/replay-fixture';
import { testRoleService } from '../testing/role-fixture';
import { testWorkItemService } from '../testing/work-item-fixture';
import { testWrites } from '../testing/writes-fixture';

const FOLDER = new URL('../../drizzle', import.meta.url).pathname;
const TEST_JWT_KEY = 'k'.repeat(48);

const RECUT: readonly PriorityBand[] = [
  { startsAt: 1, label: 'Blocker', defaultValue: 5 },
  { startsAt: 16, label: 'Urgent', defaultValue: 20 },
  { startsAt: 31, label: 'Normal', defaultValue: 40 },
  { startsAt: 71, label: 'Someday', defaultValue: 75 },
  { startsAt: 200, label: 'Never', defaultValue: 900 },
];

/** The default ladder with one field of one rung changed — the shape every refusal case wants. */
function ladderWith(at: number, change: Partial<PriorityBand>): PriorityBand[] {
  return DEFAULT_PRIORITY_BANDS.map((band, rank) =>
    rank === at ? { ...band, ...change } : { ...band },
  );
}

/**
 * `setPriorityBands`, a batch of one on `POST /api/projects/:id/commands`. The
 * retired `PUT /api/projects/:id/priority-bands` answered the stored ladder;
 * the batch answers its `results`, so what was stored is read back through the
 * repository the service wrote — a fixture answering it would be a second
 * implementation of the ladder rules under test.
 */
describe('setPriorityBands on POST /api/projects/:id/commands', () => {
  let dir: string;
  let app: ReturnType<typeof buildApp>;
  let bands: PriorityBandRepository;
  let broadcast: RecordingBroadcaster;
  let token: string;
  let otherToken: string;

  /**
   * One `setPriorityBands` command, `fields` spread over it — `{ bands }` in the
   * common case, `{}` for the body that names no ladder at all. `as: null`
   * sends no token.
   */
  async function put(
    projectId: string,
    fields: object,
    as: string | null = token,
  ): Promise<{ status: number; body: unknown }> {
    const response = await app.handle(
      new Request(`http://localhost/api/projects/${projectId}/commands`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(as === null ? {} : { authorization: `Bearer ${as}` }),
        },
        body: JSON.stringify({ commands: [{ kind: 'setPriorityBands', ...fields }] }),
      }),
    );
    return { status: response.status, body: await response.json() };
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wbs-band-route-'));
    const path = join(dir, 'test.db');
    runMigrations(path, FOLDER);
    const db = openDrizzle(path);
    const projectStore = new ProjectRepository(db);
    bands = new PriorityBandRepository(db);
    broadcast = recordingBroadcaster();
    const auth = new AuthService({ users: new UserRepository(db), jwtKey: TEST_JWT_KEY });
    app = buildApp({
      auth,
      projects: new ProjectService({ projects: projectStore }),
      directory: testDirectoryService(),
      capacity: testCapacityService(),
      priorityBands: new PriorityBandService({ projects: projectStore, bands, broadcast }),
      history: testHistoryService(projectStore),
      roles: testRoleService(),
      workItems: testWorkItemService(),
      replay: testReplay().replay,
      probeDatabase: () => 'ok',
      internalAuthSecret: 'x'.repeat(32),
      writes: testWrites(),
      migrationsApplied: true,
    });

    token = await registered('owner');
    otherToken = await registered('someone-else');
    const who = await auth.authenticate(token);
    if (who === null) throw new Error('the fixture token names no account');
    // Written **after** the app is built, because the owner id is the token's
    // and the token comes from the route. Three plans: two open, one restricted,
    // which is what the 403 arm needs a real row for.
    for (const [id, restricted] of [
      ['shed', false],
      ['roof', false],
      ['vault', true],
    ] as const) {
      await projectStore.create(
        {
          id,
          name: `Plan ${id}`,
          ownerId: who.id,
          restricted,
          estimateMethod: 'pert',
          startDate: null,
          revision: 0,
          createdAt: 1,
        },
        [],
      );
    }
    // The three projects were created by **this** release, so none of them is
    // seeded — which is the state the read's default arm answers for, and the
    // state every `toEqual([...DEFAULT_PRIORITY_BANDS])` below is asserting
    // against.
    broadcast.published.length = 0;
  });

  /** An account, and its bearer token, through the route rather than the service. */
  async function registered(username: string): Promise<string> {
    const response = await app.handle(
      new Request('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: 'correct-horse' }),
      }),
    );
    const body = (await response.json()) as { token?: string };
    if (body.token === undefined) throw new Error(`could not register ${username}`);
    return body.token;
  }

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('takes a whole ladder and stores the one it was sent', async () => {
    const answered = await put('shed', { bands: RECUT });

    expect(answered.status).toBe(200);
    // The batch answers its `results`, never the ladder: a client reads the
    // **stored** one back off the tree rather than echoing its own request,
    // which is what makes a trimmed label reach the client that sent an
    // untrimmed one.
    expect(answered.body).toMatchObject({ results: [{ index: 0 }] });
    expect(await bands.listFor('shed')).toEqual([...RECUT]);
  });

  it('tells the project it names and no other', async () => {
    // A ladder write moves no date, and it still has to be announced: every face
    // draws its labels, and a plan open on a second screen would go on painting
    // `High` over a rung that now says `Urgent`.
    //
    // Proof: the `publish` deleted from `PriorityBandService.set`, and this failed
    // on `expected [] to deeply equal [ 'shed' ]` — a re-cut ladder invisible to
    // everybody but the browser that typed it. Watched 2026-08-14.
    await put('shed', { bands: RECUT });

    expect(broadcast.published.map((each) => each.projectId)).toEqual(['shed']);
    expect(broadcast.published.at(0)?.event).toEqual({ type: 'priority_bands_changed' });
  });

  it('refuses a ladder whose first band does not start at 1, and writes nothing', async () => {
    // Proof: the `priorityLadderProblem` call deleted from `ladderOf`, and this
    // failed on `status: 200` with the project's ladder coming back starting at 5
    // — every priority from 1 to 4 resolving to a band that does not hold it.
    // Three more cases in this file went red with it. Watched 2026-08-14.
    const answered = await put('shed', { bands: ladderWith(0, { startsAt: 5, defaultValue: 10 }) });

    expect(answered).toEqual({
      status: 400,
      body: { error: 'first_band_must_start_at_1', at: 0, kind: 'setPriorityBands' },
    });
    expect(await bands.listFor('shed')).toEqual([...DEFAULT_PRIORITY_BANDS]);
  });

  it('refuses a band whose number falls outside it, and writes nothing', async () => {
    const answered = await put('shed', { bands: ladderWith(0, { defaultValue: 30 }) });

    expect(answered).toEqual({
      status: 400,
      body: { error: 'band_default_must_be_inside_its_own_band', at: 0, kind: 'setPriorityBands' },
    });
    expect(await bands.listFor('shed')).toEqual([...DEFAULT_PRIORITY_BANDS]);
  });

  it('refuses a sixth band and a fourth, because the count is not configurable', async () => {
    // design.md D3, as a command rather than as prose: Dany asked for the labels,
    // the cuts and the defaults to be a project's own and did not ask to add a
    // rung, and refusing it is what keeps `rank` a number from 0 to 4 that every
    // face keys a colour off.
    expect(
      (
        await put('shed', {
          bands: [...RECUT, { startsAt: 900, label: 'Sixth', defaultValue: 950 }],
        })
      ).body,
    ).toEqual({ error: 'bands_must_number_5', at: 0, kind: 'setPriorityBands' });
    expect((await put('shed', { bands: RECUT.slice(0, 4) })).body).toEqual({
      error: 'bands_must_number_5',
      at: 0,
      kind: 'setPriorityBands',
    });
    expect(await bands.listFor('shed')).toEqual([...DEFAULT_PRIORITY_BANDS]);
  });

  it('refuses a band whose start is not a number, rather than storing a string', async () => {
    // A behaviour pin rather than a proof of the `typeof` arms: striking the
    // `startsAt` one leaves this **green**, because `Number.isSafeInteger('21')`
    // is false and `priorityLadderProblem` refuses the string on its own — 9 pass,
    // 0 fail, watched 2026-08-14. The arms are how the three fields are narrowed
    // without a cast; the refusal is the ladder check's, and R5 #7 is where that
    // check is watched failing. This case exists because a command that stored a
    // string start would be a defect however the refusal is arrived at.
    for (const bad of ['21', true, null]) {
      const answered = await put('shed', { bands: ladderWith(1, { startsAt: bad as never }) });
      expect([answered.status, JSON.stringify(bad)]).toEqual([400, JSON.stringify(bad)]);
    }
    expect(await bands.listFor('shed')).toEqual([...DEFAULT_PRIORITY_BANDS]);
  });

  it('refuses a body that is not bands at all', async () => {
    const refusedAs = (error: string) => ({ error, at: 0, kind: 'setPriorityBands' });
    expect((await put('shed', {})).body).toEqual(refusedAs('bands_required'));
    expect((await put('shed', { bands: 'five of them' })).body).toEqual(
      refusedAs('bands_must_be_an_array'),
    );
    expect((await put('shed', { bands: [1, 2, 3, 4, 5] })).body).toEqual(
      refusedAs('bands_must_be_objects'),
    );
  });

  it('refuses a project that is not there, and one this account may not write', async () => {
    // 403 rather than 404 for a project this account may read but not write,
    // which is `projectController`'s own split: pretending it is absent would
    // contradict the next GET.
    expect(await put('nobody-holds-this', { bands: RECUT })).toEqual({
      status: 404,
      body: { error: 'not_found', at: 0, kind: 'setPriorityBands' },
    });
    expect(await put('vault', { bands: RECUT }, otherToken)).toEqual({
      status: 403,
      body: { error: 'forbidden', at: 0, kind: 'setPriorityBands' },
    });
    expect(await bands.listFor('vault')).toEqual([...DEFAULT_PRIORITY_BANDS]);
  });

  it('refuses an unauthenticated write', async () => {
    expect((await put('shed', { bands: RECUT }, null)).status).toBe(401);
    expect(await bands.listFor('shed')).toEqual([...DEFAULT_PRIORITY_BANDS]);
  });
});
