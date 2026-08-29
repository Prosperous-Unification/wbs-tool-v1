import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'bun:test';

import { buildApp } from '../app';
import { testAuthService } from '../testing/auth-fixture';
import { testCapacityService } from '../testing/capacity-fixture';
import { testDirectoryService } from '../testing/directory-fixture';
import { testHistoryService } from '../testing/history-fixture';
import { testPriorityBandService } from '../testing/priority-band-fixture';
import { testProjectService } from '../testing/project-fixture';
import { testReplay } from '../testing/replay-fixture';
import { testRoleService } from '../testing/role-fixture';
import { testWorkItemService } from '../testing/work-item-fixture';
import { testWrites } from '../testing/writes-fixture';
import { documentFromApp, OPENAPI_DOCUMENT_FILE, serialiseDocument } from './document-from-app';
import { OPENAPI_SPEC_PATH } from './openapi-plugin';

const app = () =>
  buildApp({
    auth: testAuthService(),
    projects: testProjectService(),
    workItems: testWorkItemService(),
    roles: testRoleService(),
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

const REGENERATE = 'bun apps/be-01/src/openapi/emit-openapi-cli.ts';

describe('the committed OpenAPI document', () => {
  /**
   * The freshness check, and the reason the document may be committed at all.
   *
   * A spec that has rotted is worse than no spec: a client — a person or an
   * agent — reads it as current and works from a route that moved. Nothing else
   * in this repo can notice that, because adding a route is a green change
   * everywhere else.
   *
   * The whole document, not a list of paths. A description that has drifted from
   * the guard it describes is the same defect as a path that has: both are the
   * file telling a caller something that is no longer true.
   *
   * Proof: with `.post('/projects/:id/work-items', …)` renamed to
   * `/projects/:id/work-item` in `work-item.controller.ts` and the committed file
   * left alone, this failed — 2 fail / 1 pass in this file, the diff naming
   * `postApiProjectsByIdWork-item` where `…Work-items` was owed. Watched
   * 2026-08-17; the run is in `verify.md`.
   */
  it('is what the app serves right now', async () => {
    const served = serialiseDocument(await documentFromApp(app()));
    const committed = readFileSync(OPENAPI_DOCUMENT_FILE, 'utf8');
    // Compared as text rather than with `toEqual` on the objects: the file is
    // read by prettier and by humans, so its formatting is part of what must
    // match, and a text diff names the line that moved.
    expect(committed, `the routes moved and the document did not — re-run: ${REGENERATE}`).toBe(
      served,
    );
  });

  /**
   * The route, separately from the document.
   *
   * `documentFromApp` throws on a non-200, so the check above would already fail
   * if the plugin were unmounted — but it would fail saying "no document could be
   * read", which reads as a broken test. This says which of the two is wrong.
   */
  it('is served as JSON at its own path', async () => {
    const res = await app().handle(new Request(`http://localhost${OPENAPI_SPEC_PATH}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  /**
   * The eight hand-parsed bodies, held to being described rather than declared.
   *
   * This is the trap `notes/wbs-brief-2026-08-14-r4-api-access.md` §2.5 names:
   * the natural next step is to "improve" these routes with
   * `{ body: t.Object(...) }`, which switches on Elysia's property stripping and
   * silently deletes `number_is_derived` and the priority and parallelism guards.
   * A `requestBody` that arrives with a schema Elysia generated looks identical in
   * the document to one written by hand — so the check is on the caveat sentence
   * `handParsedBody` adds, which only the hand-written path can produce.
   *
   * Proof: with `body: t.Object({ personId: t.Optional(t.Union([t.String(),
   * t.Null()])) })` added to the assignees PUT, its `detail` left in place and the
   * document re-emitted so the check above stayed green, this failed — 1 fail /
   * 2 pass. Elysia's schema **replaces** `detail.requestBody` rather than sitting
   * beside it: the caveat sentence was gone and the body arrived under three media
   * types instead of one. Watched 2026-08-17; in `verify.md`.
   *
   * And the finding that makes this check load-bearing rather than tidy: the same
   * injection left `work-item.controller.test.ts` at **33 pass / 0 fail**. Nothing
   * in this repo sends a non-string `personId` — `_must_be_id_or_null` has no
   * negative test on any of its four fields — so on that route the document is the
   * only thing that notices the guard being switched off.
   */
  it('describes every hand-parsed body without declaring it', async () => {
    const document = await documentFromApp(app());
    // Since `plan-commands` the hand-parsed bodies are the two batch routes:
    // every plan and directory write arrives as a command inside one of them,
    // parsed by the same guards the single routes had.
    const handParsed: readonly [string, string][] = [
      ['/api/projects/{id}/commands', 'post'],
      ['/api/directory/commands', 'post'],
    ];
    // `| undefined` on both index signatures rather than the tidier
    // `Record<string, Record<string, unknown>>`: this repo does not run
    // `noUncheckedIndexedAccess`, so the tidier type would make the `?.` below
    // "unnecessary" to eslint while a moved path still arrives here as undefined.
    const paths = document['paths'] as Record<string, Record<string, unknown> | undefined> | null;
    for (const [path, method] of handParsed) {
      const operation = paths?.[path]?.[method] as
        | { requestBody?: { description?: string; content?: Record<string, unknown> } }
        | undefined;
      // `?? ''` rather than the bare value: a route that has moved arrives here
      // as `undefined`, and `toContain` on it fails with bun's own "must be an
      // array type" rather than with the path that went missing.
      expect(operation?.requestBody?.description ?? '', `${method} ${path}`).toContain(
        'documentation, not validation',
      );
      // One media type. Elysia declares three for a schema-carrying body
      // (`application/json`, form-urlencoded and multipart), so this is the
      // second signature of a body it generated rather than one written here.
      expect(Object.keys(operation?.requestBody?.content ?? {}), `${method} ${path}`).toEqual([
        'application/json',
      ]);
    }
  });
});
