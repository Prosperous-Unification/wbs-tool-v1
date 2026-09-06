import { openapi } from '@elysiajs/openapi';

/**
 * Where the document is served, and the one path a client or an agent needs.
 *
 * Read by {@link documentFromApp} as well as by the plugin, so the route the
 * freshness check reads cannot drift from the route the app answers on.
 */
export const OPENAPI_SPEC_PATH = '/api/openapi.json';

/**
 * `/api` is part of the path rather than stripped by the edge, matching every
 * other controller: Caddy passes the prefix through with `handle`, so a bare
 * `/openapi.json` would answer in tests and 404 behind the proxy.
 *
 * The document version is a **constant**, not `AppOptions.version`. The
 * document is committed to the repository and diffed against the running app by
 * `openapi-document.test.ts`; a per-build version would move that file on every
 * deploy and turn the freshness check into a check nobody can keep green. The
 * API itself is unversioned — there is one deployment and one client.
 */
const DOCUMENT_VERSION = '0.0.0';

/**
 * What the generated document cannot say about itself, said once here.
 *
 * The two paragraphs are load-bearing rather than decorative. **Bodies:** no
 * route declares a body schema to Elysia any more — the refactor moved every
 * body check into its handler, and each `requestBody` in this document is now
 * written out by `http/body-doc.ts`'s helpers, so **nothing validates against
 * it**. Ten self-checking bodies carry `checkedBody`'s or `tableRefusedBody`'s
 * caveat and answer 422; the two batch routes carry `handParsedBody`'s, one
 * variant per command kind, and answer 400. A reader who takes the document for
 * the contract will post a field this API refuses and read the refusal as a
 * fault. The only schemas the framework itself sees are the two **query**
 * schemas a route may name, `history` and `compare`
 * (`http/elysia/query-schemas.ts`), and `compare`'s is the one that refuses.
 * **Refusals:** the codes a client
 * branches on live inside handlers as `{ error: <code> }` and are not derivable
 * from a route's signature; the batch routes list theirs in their own
 * descriptions and the rest do not list them yet.
 */
const DOCUMENT_DESCRIPTION = `The API behind wbs-tool: projects, work items, estimates, dependencies, the
directory of teams and people, and per-project capacity and priority bands.

**Authentication.** Every route outside \`POST /api/auth/register\` and
\`POST /api/auth/login\` needs the secure browser session cookie. Non-browser
clients use \`Authorization: Bearer <token>\`; the retired \`x-wbs-token\`
header is refused. OIDC tokens are issuer- and audience-bound, expire at the
provider's limit, and carry environment-scoped read/write permissions.
\`/internal/*\` is gw-01's own surface and takes a shared secret in
\`x-internal-auth\` instead — no account token opens it.

**Writing to a plan is one route.** \`POST /api/projects/:id/commands\` takes an
ordered list of up to 200 typed commands — every plan edit and every directory
edit — applies them all or none in one transaction and records them as one undo.
Later commands may name what earlier ones created by \`ref\`. A refused command
refuses the batch with \`{ "error", "at" }\` — and \`"kind"\` too, once the
command's kind is known — and nothing is applied. Its
body is described under the route, one variant per command kind.

**This document describes bodies; it does not declare any.** Every
\`requestBody\` below is written out by hand — no route hands a body schema to
the server — and **nothing validates against it**. The handler's own parse is
the contract in every case. Ten bodies check themselves and answer 422, with
\`{ "error": "invalid_body" }\` or the refusing route's own error and field.

The two batch routes parse their body by hand for a further reason — because
the server strips unknown properties before a handler runs, which would silently
delete refusals like \`number_is_derived\` and the priority and parallelism
guards — and each command inside them is checked by the parser its retired route
had. Their bodies are written out one variant per command kind. They answer 400
with a code; a refusal that belongs to one command also names its \`at\`, and
names its \`kind\` once that is known. A refusal of the envelope itself — a
\`commands\` that is not a list — carries the code alone.

**Refusals.** A refused request answers \`{ "error": "<code>" }\` with a status
that means something: 400 "do not send this", 409 "try again against a different
state", 404 "that id is not here", 403 "you may read it but not write it". A
refused batch adds \`"at"\`, and \`"kind"\` with it once the command's kind is
known; a refusal of the envelope itself carries neither. The batch routes list their codes in
their own descriptions. The rest do not yet — that pass is change A2.

**Numbers are derived.** Work-item numbers, dates, floats and slices are
recomputed from the tree on every read; a write that names one is refused rather
than ignored. Re-read \`GET /api/projects/:id/work-items\` after any write: the
whole schedule can move.`;

/**
 * The emitter, with the reference UI deliberately off.
 *
 * `provider: null` registers **one** route, the JSON at
 * {@link OPENAPI_SPEC_PATH}, and no HTML page. The default (`'scalar'`) would
 * serve a page whose script tag is `cdn.jsdelivr.net`, giving this API a
 * third-party origin it does not otherwise have; the deliverable here is a
 * document an agent reads, and any local viewer renders it. One word reverses
 * this if a hosted page is wanted.
 *
 * `@elysiajs/openapi` rather than `@elysiajs/swagger`: swagger is stuck at 1.3.1
 * against `elysia@1.4.28`, and openapi is its successor
 * (`notes/wbs-brief-2026-08-14-r4-api-access.md` §2.1 in the workspace).
 */
export const openApiPlugin = () =>
  openapi({
    provider: null,
    specPath: OPENAPI_SPEC_PATH,
    documentation: {
      info: {
        title: 'wbs-tool API',
        version: DOCUMENT_VERSION,
        description: DOCUMENT_DESCRIPTION,
      },
    },
  });
