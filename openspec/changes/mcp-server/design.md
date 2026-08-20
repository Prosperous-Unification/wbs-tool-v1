# Design — `mcp-server`

Three questions were put to Dany on 2026-08-20 ~23:10 Kyiv and were unanswered
when this change was picked up, so D1–D3 are the defaults the queue task stated,
taken by the agent. Each is marked with who decided it. D4–D9 are consequences of
reading the tree and are the agent's throughout.

## D1 — Scope: full read, journalled writes, no credentials

_decided-by: default (queue task `wbs-mcp`, Dany asked, unanswered)_

Every operation in `openapi.json` becomes a tool except three exclusion classes:

1. `/api/auth/*` — `register`, `login`, `me`. A tool that mints an account token
   makes the MCP server a credential factory, and the server already holds the
   only token it needs (D6).
2. `/internal/*` — gw-01's forward/resume surface, opened by `x-internal-auth`,
   not by an account token. Exposing it would need a second secret for no reader.
3. `/health`, `/metrics`, `/api/smoke/echo` — operational surfaces with no plan
   in them.

That leaves the plan surface: projects, work items, estimates, actuals, progress,
assignees, dependencies, move, duplicate, freeze/unfreeze, undo/redo, history,
the directory (people, teams, roles, tags), capacity and priority bands.

The exclusion list is **a named set, checked against the document**: a name in it
that `openapi.json` no longer contains fails a test. An exclusion list that
silently stops matching is how a route quietly reappears.

## D2 — A new app, stdio, HTTP to be-01

_decided-by: default (queue task `wbs-mcp`)_

`apps/mcp-01`, Bun, `project.json` targets copied from `gw-01` — serve, build,
lint, test, typecheck. Transport is stdio: the client spawns the process, which
is what Claude Desktop and OpenClaw both do natively, and it needs no port, no
TLS and no session store. Remote HTTP/SSE is deferred until a client asks.

It talks to be-01 over HTTP rather than importing its repository layer. The
alternative — linking `libs/domain` and opening the SQLite file directly — would
double the write path and lose the journal, which is the whole point of D1.

## D3 — Points at dev; the deployment is a config value

_decided-by: default (queue task `wbs-mcp`)_

`WBS_API_URL` defaults to nothing and is required (R5: unknown is not OK — an
absent base URL throws at boot rather than defaulting to localhost and silently
editing the wrong deployment). Dev sits behind basic auth on every path but
`/ws*`, so `WBS_BASIC_AUTH` is an optional `user:pass` that becomes an
`Authorization: Basic` header. Prod is the same three variables with different
values, and this change does not deploy it.

## D4 — Tools are derived from `openapi.json`, and the derivation is tested

The document is committed at `apps/be-01/openapi.json` and drift-checked against
the live app by `apps/be-01/src/openapi/openapi-document.test.ts`. Deriving from
it means the two lists cannot disagree without a red test:

- tool name ← `operationId` (all 51 operations carry one; verified 2026-08-20)
- tool description ← `summary` + `description`
- tool input schema ← an object whose properties are the operation's path and
  query parameters plus, for a body-carrying operation, the properties of its
  `application/json` schema. Required parameters and required body properties
  stay required.

A hand-maintained parallel list is what this avoids. The test that proves it:
generate the list from the committed document, and assert the set of tool names
equals the set of operation ids minus the exclusion list. Add a route to be-01
and the test fails until the exclusion list or the generated list accounts for it.

## D5 — SDK 1.30.0, low-level `Server`, JSON Schema passed through

`@modelcontextprotocol/sdk` latest is **1.30.0**, published 2026-07-27 (checked
against the registry 2026-08-20, per the queue task's instruction to check at
build time rather than write from memory). It depends on `zod ^3.25 || ^4`,
which this repo does not currently carry — it validates with `@sinclair/typebox`
and `arktype`.

The SDK's high-level `McpServer.tool()` wants a zod schema per tool. The
low-level `Server` with `ListToolsRequestSchema` / `CallToolRequestSchema`
handlers takes `inputSchema` as **plain JSON Schema**, which is exactly what D4
already produces. So the low-level API is the fit: no schema is authored twice,
and zod arrives only as the SDK's own transitive dependency rather than as a
third validator this repo maintains opinions about.

**Amended 2026-08-20, when the code met the linter.** `Server` carries
`@deprecated Use McpServer instead for the high-level API. Only use Server for
advanced use cases` in 1.30.0, and this repo's `strictTypeChecked` config turns
that into a lint error. The decision stands anyway, for the reason the
deprecation itself gives: `McpServer.registerTool` types `inputSchema` as
`ZodRawShapeCompat | AnySchema`, so the high-level API means authoring all 43
schemas a second time in zod beside the ones `openapi.json` already produces.
Two sources for one contract is the drift D4 exists to prevent. So the rule is
disabled at exactly the two lines that name `Server`, each with the reason
beside it, and the alternative is written here rather than left for a reviewer
to reconstruct. If the SDK ever takes plain JSON Schema in `registerTool`, this
becomes a small, obvious change.

## D6 — One token, one account, and the server says so

`WBS_TOKEN` is required at boot. Every tool call sends it. A be-01 token lasts 12
hours, cannot be revoked and carries no scope — `openapi.json` says so in its own
description — so the operator of an `mcp-01` process is handing its client the
account's whole reach, and a 12-hour lifetime means a long-running server will
start answering 401 mid-session.

Both are surfaced, not hidden: a 401 from be-01 becomes a tool error naming an
expired or invalid token and telling the operator to restart with a fresh one. It
is **not** silently refreshed by calling `login`, because the server holds no
password — that is why D1 excludes the auth routes rather than merely omitting
them.

## D7 — A refusal is a tool error carrying be-01's code, never a summary

be-01 answers a refused write with `{ "error": "<code>" }` and a status that
means something: 400 do-not-send-this, 409 try-again-against-a-different-state,
404 not-here, 403 read-but-not-write. Those codes are the API's vocabulary —
`number_is_derived`, `has_children`, `not_before_reason_needs_a_date` — and an
agent that receives "the request failed" instead of the code cannot correct
itself.

So a non-2xx becomes an MCP tool result with `isError: true` whose text carries
the status and the raw code. The negative test injects a 400 with a known code
and asserts the code appears verbatim in the tool result.

**Two 401s, and only one of them is D6's.** The dev deployment sits behind basic
auth on every path but `/ws*`, so a wrong `WBS_BASIC_AUTH` produces a 401 that
never reached be-01 — and reporting it as an expired account token sends the
operator to replace a credential that was fine. `WWW-Authenticate` is the
discriminator: a proxy sets it on its challenge, be-01 never does. fe-01 shipped
this bug once already (`apps/fe-01/src/lib/api.ts`, `EDGE_UNAUTHORIZED`), which
is why mcp-01 has the branch on day one rather than after the afternoon.

## D8 — Eight bodies are documented, not validated, and the tool schema says so

Six work-item writes, the capacity PUT and the priority-band PUT parse their own
bodies, because Elysia strips unknown properties before a handler runs and would
delete the refusals D7 depends on. Their `requestBody` schemas in `openapi.json`
are documentation — the document says so in each one's description.

The derived tool schema inherits that honesty rather than papering over it: the
description is passed through unedited, and `mcp-01` does **not** validate a body
against the schema before sending. The handler's parse is the contract; a local
pre-validation would either duplicate it or, worse, reject something be-01 would
have accepted.

## D9 — Numbers are derived, so a write tool's result is not the new state

Work-item numbers, dates, floats and slices are recomputed from the tree on every
read; one patch can move every date in a plan. A write tool therefore returns
what be-01 returned and says, in its description, to re-read the project's work
items. `mcp-01` does not re-read automatically: a second request per write, on
every write, to answer a question the caller may not be asking.

## What this change does not decide

- Whether prod gets an `mcp-01` (D3 leaves it a config value).
- Whether a remote transport is wanted (D2).
- Whether tools should be grouped or filtered per client. 30-odd tools is a lot
  of context for a small client, but grouping needs a real client complaining
  first.
