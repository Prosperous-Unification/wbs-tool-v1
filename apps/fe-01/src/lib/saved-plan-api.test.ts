import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  httpSavedPlanApi,
  OPENAPI_SPEC_PATH,
  SAVED_PLAN_SPEC_PATHS,
  type SavedPlanListEntryView,
  savedPlansAvailable,
} from './saved-plan-api';

/** A Response as be-01 would really produce one; `''` becomes a bodyless 204. */
const response = (status: number, body: string): Response =>
  new Response(body === '' ? null : body, { status });

/**
 * An OpenAPI document listing `paths`, with the unrelated routes a real one also
 * carries.
 *
 * The two extras are not decoration: they are what makes "the document was read
 * and the saved-plan paths were not in it" different from "there is no document",
 * and the second case has to stay an error rather than an absent capability.
 */
const document = (paths: readonly string[]): string =>
  JSON.stringify({
    openapi: '3.1.0',
    paths: Object.fromEntries(
      ['/api/auth/login', '/api/projects/{id}/tree', ...paths].map((path) => [path, {}]),
    ),
  });

/**
 * One row as **be-01 really sends it**, `created_at` included — and that is the
 * whole point of the pair below.
 *
 * The column is epoch **seconds** (`boot.ts` builds the service with
 * `now: () => Math.floor(Date.now() / 1000)` and says so), and every fixture in
 * this file used to be a 13-digit millisecond value, so the suite agreed with
 * the client and neither of them agreed with the server. A 2026 checkpoint
 * rendered as January 1970. Sol's I1 on PR 202.
 */
const WIRE = {
  id: 'sp1',
  name: '2026-09-04 06:00',
  createdBy: 'ada',
  createdAt: 1_788_501_600,
  inputBytes: 4096,
  scheduleBytes: 2048,
  scheduleAbsentReason: null,
};

/** The same row after the client boundary: `createdAt` in milliseconds. */
const ROW: SavedPlanListEntryView = { ...WIRE, createdAt: 1_788_501_600_000 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('whether this node has the routes at all', () => {
  it('reads the served document rather than probing a route', async () => {
    const fetched = vi.fn<[string, RequestInit?], Promise<Response>>(() =>
      Promise.resolve(response(200, document(SAVED_PLAN_SPEC_PATHS))),
    );
    vi.stubGlobal('fetch', fetched);
    await expect(savedPlansAvailable()).resolves.toBe(true);
    expect(fetched.mock.calls.map((call) => call[0])).toEqual([OPENAPI_SPEC_PATH]);
  });

  it('says no for a node whose document predates the routes', async () => {
    // 6.4's positive: a node from before the migration serves a perfectly good
    // document that simply has no saved-plan paths in it.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(200, document([])))),
    );
    await expect(savedPlansAvailable()).resolves.toBe(false);
  });

  it('says no when the document has some of the paths but not all of them', async () => {
    // A half-migrated node is not a state this repository ships, and that is
    // exactly why it must not read as available: `every` and not `some` is the
    // difference between a surface that half-works and one that says so.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(200, document(SAVED_PLAN_SPEC_PATHS.slice(0, 2))))),
    );
    await expect(savedPlansAvailable()).resolves.toBe(false);
  });

  it('throws rather than claiming unavailability when no document could be read', async () => {
    // "Not available on this node yet" is a claim about a server that answered.
    // A 500 from a proxy is not that claim, and rendering it as one sends the
    // reader after an upgrade that would not have helped.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(500, 'gateway is unwell'))),
    );
    await expect(savedPlansAvailable()).rejects.toThrow('http_500');
  });

  it('throws on a 200 that is not a document', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(200, JSON.stringify({ openapi: '3.1.0' })))),
    );
    await expect(savedPlansAvailable()).rejects.toThrow('unexpected_response');
  });

  it('leaves a mistyped project id as not_found on a node that does have the routes', async () => {
    // **The case that decides the design.** be-01 answers 404 for an unknown
    // project, and an unmatched route on an old node answers 404 too. Anything
    // that read unavailability out of a status code would tell a user with a
    // typo that their server is out of date. This is the negative watched for
    // 6.4: route the "not available" message off a 404 from `list` instead of
    // off the document, and this case is the one that reddens.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(404, JSON.stringify({ error: 'not_found' })))),
    );
    await expect(httpSavedPlanApi('t').list('nope')).rejects.toThrow('not_found');
  });
});

describe('the shelf', () => {
  it('lists a project’s saved plans', async () => {
    const fetched = vi.fn<[string, RequestInit?], Promise<Response>>(() =>
      Promise.resolve(response(200, JSON.stringify({ savedPlans: [WIRE] }))),
    );
    vi.stubGlobal('fetch', fetched);
    await expect(httpSavedPlanApi('t').list('p1')).resolves.toEqual([ROW]);
    expect(fetched.mock.calls[0]?.[0]).toBe('/api/projects/p1/saved-plans');
  });

  it('carries a schedule-less save’s reason through instead of narrowing it', async () => {
    // be-01's column is `text` and its read path passes an unrecognised reason
    // through. A client that accepted only the labels it knew would hide a plan
    // the server is willing to hand over.
    const wire = { ...WIRE, scheduleBytes: null, scheduleAbsentReason: 'a-reason-from-the-future' };
    const row = { ...ROW, scheduleBytes: null, scheduleAbsentReason: 'a-reason-from-the-future' };
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(200, JSON.stringify({ savedPlans: [wire] })))),
    );
    await expect(httpSavedPlanApi('t').list('p1')).resolves.toEqual([row]);
  });

  /**
   * The defect I1 named, said in the unit a reader would notice it in.
   *
   * The two assertions above already fail if the conversion is removed, but they
   * fail on a nine-digit number comparison, which reads as a fixture typo. This
   * one fails on **1970**, which is what was on the screen: a checkpoint saved
   * in September 2026 was stamped 21 January 1970, because `new Date(n)` takes
   * milliseconds and be-01 sends seconds.
   *
   * Watched: with `savedPlanEntry`'s `* 1000` removed, this case fails on
   * `expected 1970 to be 2026`.
   */
  it('reads be-01’s epoch seconds as the year the plan was really saved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(200, JSON.stringify({ savedPlans: [WIRE] })))),
    );
    const [entry] = await httpSavedPlanApi('t').list('p1');
    expect(new Date(entry.createdAt).getUTCFullYear()).toBe(2026);
  });
});

describe('saving', () => {
  it('answers the created record', async () => {
    const fetched = vi.fn<[string, RequestInit?], Promise<Response>>(() =>
      Promise.resolve(response(201, JSON.stringify({ savedPlan: WIRE }))),
    );
    vi.stubGlobal('fetch', fetched);
    await expect(httpSavedPlanApi('t').save('p1', 'before the re-plan')).resolves.toEqual({
      outcome: 'saved',
      savedPlan: ROW,
    });
    expect(fetched.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ name: 'before the re-plan' }));
  });

  /**
   * A-1: an unnamed save sends **no `name` key**, and the server names the
   * record from the clock that stamps its `created_at`.
   *
   * Asserted on the serialised body rather than on the parsed object, because
   * the defect this guards against is a key that is *present and empty*.
   * `JSON.parse(body).name === undefined` passes for `{"name":""}` under a
   * `?? ''`; the byte comparison does not. `''` is a 422 at the route, so that
   * regression would turn A-1's normal path into a refusal the user cannot act
   * on.
   */
  it('sends no name at all when the caller chose none, rather than an empty one', async () => {
    const fetched = vi.fn<[string, RequestInit?], Promise<Response>>(() =>
      Promise.resolve(response(201, JSON.stringify({ savedPlan: WIRE }))),
    );
    vi.stubGlobal('fetch', fetched);
    await expect(httpSavedPlanApi('t').save('p1')).resolves.toEqual({
      outcome: 'saved',
      savedPlan: ROW,
    });
    expect(fetched.mock.calls[0]?.[1]?.body).toBe('{}');
  });

  /**
   * The other half of the same rule, and the reason `save` does not narrow
   * `name` to a non-empty type: a caller that really does hand this layer `''`
   * is *not* silently promoted to the default. The empty string goes to be-01
   * and comes back a 422, which is where `minLength: 1` is stated once.
   */
  it('passes an empty name through to the route that refuses it', async () => {
    const fetched = vi.fn<[string, RequestInit?], Promise<Response>>(() =>
      Promise.resolve(response(422, JSON.stringify({ error: 'validation' }))),
    );
    vi.stubGlobal('fetch', fetched);
    await expect(httpSavedPlanApi('t').save('p1', '')).rejects.toThrow('validation');
    expect(fetched.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ name: '' }));
  });

  it('models snapshot_busy rather than throwing it', async () => {
    // 8.5: this refusal has to say "the plan is being written to, try again",
    // and a thrown code arrives at the surface as an error nobody can act on.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(503, JSON.stringify({ error: 'snapshot_busy' })))),
    );
    await expect(httpSavedPlanApi('t').save('p1', 'n')).resolves.toEqual({
      outcome: 'snapshot_busy',
    });
  });

  it('keeps the sentence a quota refusal names its limit with', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          response(409, JSON.stringify({ error: 'quota', refusal: 'per_project_count' })),
        ),
      ),
    );
    await expect(httpSavedPlanApi('t').save('p1', 'n')).resolves.toEqual({
      outcome: 'quota',
      refusal: 'per_project_count',
    });
  });

  it('throws a quota with no limit in it rather than naming nothing', async () => {
    // The same shape guard `removeStep` makes in `wbs-api.ts`: a refusal
    // claiming to be a quota with no sentence beside it is a be-01 that has
    // changed shape, and "you have reached the limit of" with nothing after it
    // is worse than the raw code.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(409, JSON.stringify({ error: 'quota' })))),
    );
    await expect(httpSavedPlanApi('t').save('p1', 'n')).rejects.toThrow('quota');
  });
});

describe('renaming and deleting', () => {
  it('separates a plan somebody else owns from a plan that is not there', async () => {
    // Both are 4xx and both mean "no". They are different sentences: a plan
    // saved by a colleague is on the shelf and readable, and telling its reader
    // it does not exist is a lie about a row they can see.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(403, JSON.stringify({ error: 'forbidden' })))),
    );
    await expect(httpSavedPlanApi('t').rename('sp1', 'n')).resolves.toEqual({
      outcome: 'forbidden',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(404, JSON.stringify({ error: 'not_found' })))),
    );
    await expect(httpSavedPlanApi('t').remove('sp1')).resolves.toEqual({ outcome: 'not_found' });
  });

  it('reads a 204 delete as done', async () => {
    const fetched = vi.fn<[string, RequestInit?], Promise<Response>>(() =>
      Promise.resolve(response(204, '')),
    );
    vi.stubGlobal('fetch', fetched);
    await expect(httpSavedPlanApi('t').remove('sp1')).resolves.toEqual({ outcome: 'touched' });
    expect(fetched.mock.calls[0]?.[1]?.method).toBe('DELETE');
  });

  it('throws a refusal this client does not model', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(418, JSON.stringify({ error: 'teapot' })))),
    );
    await expect(httpSavedPlanApi('t').rename('sp1', 'n')).rejects.toThrow('http_418');
  });
});

describe('comparing', () => {
  it('sends the reserved literal for the live side', async () => {
    const fetched = vi.fn<[string, RequestInit?], Promise<Response>>(() =>
      Promise.resolve(response(200, JSON.stringify({ diff: { input: [], schedule: [] } }))),
    );
    vi.stubGlobal('fetch', fetched);
    await expect(httpSavedPlanApi('t').compare('p1', { saved: 'sp1' }, 'current')).resolves.toEqual(
      { outcome: 'compared', diff: { input: [], schedule: [] } },
    );
    expect(fetched.mock.calls[0]?.[0]).toBe(
      '/api/projects/p1/saved-plans/compare?left=sp1&right=current',
    );
  });

  it('keeps the id a corrupt side names', async () => {
    // With two pickers open, a refusal naming no plan leaves the reader unable
    // to tell which one holds the damaged bytes. be-01 puts the id on its 422
    // for that reason and it is only worth anything if this layer keeps it.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          response(
            422,
            JSON.stringify({ error: 'corrupt', savedPlanId: 'sp2', refusal: 'unreadable' }),
          ),
        ),
      ),
    );
    await expect(httpSavedPlanApi('t').compare('p1', 'current', { saved: 'sp2' })).resolves.toEqual(
      { outcome: 'corrupt', savedPlanId: 'sp2', refusal: 'unreadable' },
    );
  });

  it('separates a missing side from a missing project', async () => {
    // Both are the route's 404 and only one of them names anything. `null` is
    // the honest answer for the project case: no picker is at fault.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(response(404, JSON.stringify({ error: 'not_found', savedPlanId: 'sp9' }))),
      ),
    );
    await expect(httpSavedPlanApi('t').compare('p1', 'current', { saved: 'sp9' })).resolves.toEqual(
      { outcome: 'not_found', savedPlanId: 'sp9' },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(404, JSON.stringify({ error: 'not_found' })))),
    );
    await expect(httpSavedPlanApi('t').compare('nope', 'current', 'current')).resolves.toEqual({
      outcome: 'not_found',
      savedPlanId: null,
    });
  });
});
