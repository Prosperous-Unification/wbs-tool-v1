import {
  compareSavedPlans,
  deleteSavedPlan,
  documentFromShapes,
  listSavedPlans,
  readSavedPlan,
  renameSavedPlan,
  savePlan,
} from '@wbs/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  httpSavedPlanApi,
  OPENAPI_SPEC_PATH,
  SAVED_PLAN_SPEC_PATHS,
  type SavedPlanListEntryView,
  savedPlansAvailable,
} from './saved-plan-api';

const response = (status: number, body: unknown): Response =>
  body === null ? new Response(null, { status }) : Response.json(body, { status });

const document = (paths: readonly string[]): object => ({
  openapi: '3.1.0',
  paths: Object.fromEntries(
    ['/api/auth/login', '/api/projects/{id}/tree', ...paths].map((path) => [path, {}]),
  ),
});

const STORED = {
  id: 'sp1',
  projectId: 'p1',
  name: '2026-09-04 06:00',
  createdBy: 'ada',
  createdById: 'u1',
  createdAt: 1_788_501_600,
  input: { schemaVersion: 1, bytes: '{"work":true}', sha256: 'input-hash' },
  schedule: { present: false as const, absentReason: 'pending' },
};

const ROW: SavedPlanListEntryView = {
  id: 'sp1',
  name: '2026-09-04 06:00',
  createdBy: 'ada',
  createdAt: 1_788_501_600_000,
  inputBytes: 13,
  scheduleBytes: null,
  scheduleAbsentReason: 'pending',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('whether this node has the routes at all', () => {
  it('reads the served document rather than probing a saved-plan route', async () => {
    const send = vi.fn<[string, RequestInit?], Promise<Response>>(() =>
      Promise.resolve(response(200, document(SAVED_PLAN_SPEC_PATHS))),
    );
    vi.stubGlobal('fetch', send);
    await expect(savedPlansAvailable()).resolves.toBe(true);
    expect(send.mock.calls.map(([url]) => url)).toEqual([OPENAPI_SPEC_PATH]);
  });

  it('recognizes the paths emitted from the complete saved-plan shape family', async () => {
    const generated = documentFromShapes([
      savePlan,
      listSavedPlans,
      compareSavedPlans,
      readSavedPlan,
      renameSavedPlan,
      deleteSavedPlan,
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(200, generated))),
    );
    await expect(savedPlansAvailable()).resolves.toBe(true);
    expect(SAVED_PLAN_SPEC_PATHS.every((path) => Object.hasOwn(generated.paths, path))).toBe(true);
  });

  it('requires every saved-plan path in a successfully read document', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(200, document(SAVED_PLAN_SPEC_PATHS.slice(0, 2))))),
    );
    await expect(savedPlansAvailable()).resolves.toBe(false);
  });

  it('reports an older generated document with no saved-plan paths as unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(200, document([])))),
    );
    await expect(savedPlansAvailable()).resolves.toBe(false);
  });

  it('throws instead of claiming absence when the document is unavailable or malformed', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(new Response('gateway failed', { status: 500 }))
      .mockResolvedValueOnce(response(200, { openapi: '3.1.0' }));
    vi.stubGlobal('fetch', send);
    await expect(savedPlansAvailable()).rejects.toThrow('http_500');
    await expect(savedPlansAvailable()).rejects.toThrow('unexpected_response');
  });
});

describe('shape-derived saved-plan requests', () => {
  it('validates and converts shelf entries at the browser boundary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          response(200, {
            savedPlans: [{ ...ROW, createdAt: 1_788_501_600, future: { added: true } }],
          }),
        ),
      ),
    );
    await expect(httpSavedPlanApi().list('p1')).resolves.toMatchObject({
      kind: 'success',
      body: { savedPlans: [ROW] },
    });
  });

  it('rejects a malformed known shelf field before a screen can consume it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(response(200, { savedPlans: [{ ...ROW, createdAt: 'yesterday' }] })),
      ),
    );
    await expect(httpSavedPlanApi().list('p1')).resolves.toMatchObject({
      kind: 'failure',
      failure: { code: 'invalid_response', reason: 'schema' },
    });
  });

  it('returns a list refusal instead of throwing an Error.message code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response(404, { error: 'not_found' }))),
    );
    await expect(httpSavedPlanApi().list('missing')).resolves.toMatchObject({
      kind: 'refusal',
      status: 404,
      body: { error: 'not_found' },
    });
  });

  it('converts the real stored save response into the shelf confirmation view', async () => {
    const send = vi.fn<[string, RequestInit?], Promise<Response>>(() =>
      Promise.resolve(response(201, { savedPlan: STORED })),
    );
    vi.stubGlobal('fetch', send);
    await expect(httpSavedPlanApi().save('p1')).resolves.toMatchObject({
      kind: 'success',
      body: { savedPlan: ROW },
    });
    expect(send.mock.calls[0]?.[1]?.body).toBe('{}');
  });

  it('refuses an empty name before transport instead of silently selecting the default', async () => {
    const send = vi.fn<[string, RequestInit?], Promise<Response>>();
    vi.stubGlobal('fetch', send);
    await expect(httpSavedPlanApi().save('p1', '')).resolves.toMatchObject({
      kind: 'failure',
      failure: { code: 'invalid_request', part: 'body' },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('validates structured quota and snapshot-busy refusals', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(
        response(409, {
          error: 'quota',
          refusal: { limit: 'plan_count', asked: 51, allowed: 50 },
        }),
      )
      .mockResolvedValueOnce(response(503, { error: 'snapshot_busy' }))
      .mockResolvedValueOnce(response(409, { error: 'quota', refusal: 'plan_count' }));
    vi.stubGlobal('fetch', send);
    await expect(httpSavedPlanApi().save('p1', 'named')).resolves.toMatchObject({
      kind: 'refusal',
      body: { error: 'quota', refusal: { limit: 'plan_count', asked: 51, allowed: 50 } },
    });
    await expect(httpSavedPlanApi().save('p1', 'named')).resolves.toMatchObject({
      kind: 'refusal',
      body: { error: 'snapshot_busy' },
    });
    await expect(httpSavedPlanApi().save('p1', 'named')).resolves.toMatchObject({
      kind: 'failure',
      failure: { code: 'invalid_response', reason: 'schema' },
    });
  });

  it('preserves complete 501 details and rejects an incomplete copy', async () => {
    const version = {
      error: 'unsupported_body_version',
      savedPlanId: 'sp1',
      body: 'input',
      version: 9,
      supported: [1],
    } as const;
    const send = vi
      .fn()
      .mockResolvedValueOnce(response(501, version))
      .mockResolvedValueOnce(response(501, { ...version, supported: undefined }));
    vi.stubGlobal('fetch', send);
    await expect(
      httpSavedPlanApi().compare('p1', 'current', { saved: 'sp1' }),
    ).resolves.toMatchObject({ kind: 'refusal', status: 501, body: version });
    await expect(
      httpSavedPlanApi().compare('p1', 'current', { saved: 'sp1' }),
    ).resolves.toMatchObject({
      kind: 'failure',
      failure: { code: 'invalid_response', reason: 'schema' },
    });
  });

  it('uses declared query encoding and validates corrupt integrity details', async () => {
    const integrity = {
      reason: 'body_hash_mismatch',
      savedPlanId: 'sp2',
      body: 'input',
      stored: 'old',
      recomputed: 'new',
    } as const;
    const send = vi.fn<[string, RequestInit?], Promise<Response>>(() =>
      Promise.resolve(response(422, { error: 'corrupt', savedPlanId: 'sp2', refusal: integrity })),
    );
    vi.stubGlobal('fetch', send);
    await expect(
      httpSavedPlanApi().compare('p1', 'current', { saved: 'sp2' }),
    ).resolves.toMatchObject({
      kind: 'refusal',
      body: { error: 'corrupt', savedPlanId: 'sp2', refusal: integrity },
    });
    expect(send.mock.calls[0]?.[0]).toBe(
      '/api/projects/p1/saved-plans/compare?left=current&right=sp2',
    );
  });

  it('uses empty and JSON success representations from the shared shapes', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(response(200, { savedPlanId: 'sp1', name: 'renamed' }))
      .mockResolvedValueOnce(response(204, null));
    vi.stubGlobal('fetch', send);
    await expect(httpSavedPlanApi().rename('sp1', 'renamed')).resolves.toMatchObject({
      kind: 'success',
      representation: 'json',
    });
    await expect(httpSavedPlanApi().remove('sp1')).resolves.toMatchObject({
      kind: 'success',
      representation: 'empty',
    });
  });

  it('uses same-origin cookies without the obsolete token header', async () => {
    const send = vi.fn<[string, RequestInit?], Promise<Response>>(() =>
      Promise.resolve(response(200, { savedPlans: [] })),
    );
    vi.stubGlobal('fetch', send);
    await httpSavedPlanApi().list('p1');
    const headers = new Headers(send.mock.calls[0]?.[1]?.headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('x-wbs-token')).toBe(false);
  });
});
