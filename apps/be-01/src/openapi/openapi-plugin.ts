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
 * The two paragraphs are load-bearing rather than decorative. **Bodies:** ten
 * routes declare a schema to Elysia and appear here with one; the two batch
 * routes that parse their body by hand appear with a `requestBody` written out
 * one variant per command kind, and that document is documentation only —
 * nothing validates against it. A reader who assumes otherwise will post a field
 * this API refuses and read the 400 as a fault. **Refusals:** the codes a client
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
refuses the batch with \`{ "error", "at", "kind" }\` and nothing is applied. Its
body is described under the route, one variant per command kind.

**Bodies this document declares, and bodies it only describes.** The project,
role and auth routes declare a schema to Elysia, and those appear here as
schemas. The two batch routes parse their body by hand — because Elysia strips
unknown properties before a handler runs, which would silently delete refusals
like \`number_is_derived\` and the priority and parallelism guards — and each
command inside them is checked by the parser its retired route had. Their bodies
are written out under \`requestBody\`, one variant per command kind, and
**nothing validates against that document**; the handler's own parse is the
contract, and it answers 400 with a code, the command's index and its kind.

**Refusals.** A refused request answers \`{ "error": "<code>" }\` with a status
that means something: 400 "do not send this", 409 "try again against a different
state", 404 "that id is not here", 403 "you may read it but not write it". A
refused batch adds \`"at"\` and \`"kind"\`. The batch routes list their codes in
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
