# verify — `mcp-server`

Branch `change/mcp-server`, cut from `origin/main` @ `9a773f5` (#88 merged) on
2026-08-20. **21 files, +2,308 lines**, one new Nx project (`apps/mcp-01`, the
22nd), no change to any existing app.

**PoC mode** (`notes/delivery-modes.md`): nothing here touches `drizzle/**`,
`service/schedule.ts`, `libs/domain/**` or auth — mcp-01 _calls_ be-01's auth
header, it does not implement it. A `design.md` exists anyway, because three
open questions were answered by default rather than by Dany and each of those
answers had to be written down as such (D1–D3, `decided-by: default`).

Built in six worker chunks over 2026-08-20 20:43–23:20 UTC, each gated on
h2puni before it was committed. This file is the whole record; the per-chunk
narrative is in `queue/tasks/2026-08-20-wbs-mcp.md` in the workspace repo.

## What was built

An MCP server that speaks stdio to its client and HTTP to a be-01 deployment.
**43 tools, and not one of them is hand-written**: names come from
`operationId`, input schemas from path + query parameters merged with the
`application/json` body properties, descriptions from whatever prose the
document carries. 51 operations minus 8 exclusions (3 auth, 2 `/internal/*`,
`/health`, `/metrics`, `/api/smoke/echo`) is the arithmetic, and it is asserted
against the real document, so a route added to be-01 arrives as a red count
rather than as a tool nobody chose.

## Environment

| what           | value                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| host           | h2puni, rig `~/wbs-reds` at `c45d611`                                                                                                  |
| runtime        | bun 1.3.14                                                                                                                             |
| MCP SDK        | `@modelcontextprotocol/sdk` **1.30.0**, pinned exact (published 2026-07-27; resolved from the registry at build time, not from memory) |
| never run here | h1claw — builds and tests are h2puni's, standing rule                                                                                  |

The SDK pin is exact rather than `^` on purpose: D5 picks the **low-level
`Server`** API for its plain-JSON-Schema `inputSchema`, and that is a bet on an
API surface a minor bump can reshape.

## The gate — full run, cache skipped

`bunx nx run-many -t test lint typecheck --parallel=2 --skip-nx-cache`, exit 0.

```
NX   Successfully ran targets test, lint, typecheck for 22 projects
```

| project       | tests                             | expects |
| ------------- | --------------------------------- | ------- |
| `mcp-01`      | **64 pass / 0 fail** (4 files)    | 218     |
| `fe-01`       | **1532 pass / 0 fail** (53 files) | —       |
| `be-01`       | **924 pass / 0 fail** (71 files)  | 27,396  |
| `@wbs/domain` | **89 pass / 0 fail** (7 files)    | 272     |

Beside it, each exit 0:

| command                                                        | result                         |
| -------------------------------------------------------------- | ------------------------------ |
| `bunx nx format:check`                                         | clean                          |
| `bunx nx build mcp-01 --skip-nx-cache`                         | bundle + `openapi.json` copied |
| `bunx @fission-ai/openspec@1.3.0 validate mcp-server --strict` | `Change 'mcp-server' is valid` |

`bunx openspec` resolves a **different, wrong** package and errors "could not
determine executable" — use `@fission-ai/openspec@1.3.0` by name. CI's own
comment warns about this; it cost a chunk-1 detour anyway.

## It runs, and that was proved by running it

The claim "43 tools over MCP" is not only a unit test. The process was fed a
real JSON-RPC `initialize` + `tools/list` on stdin:

```sh
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | WBS_API_URL=https://dev.wbs.bulletpoints.club WBS_TOKEN=… bun apps/mcp-01/src/main.ts
```

and answered:

```
{"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"mcp-01","version":"0.1.0"}},"jsonrpc":"2.0","id":1}
{"result":{"tools":[{"name":"postApiProjects","description":"POST /api/projects/ — …
```

stderr: `mcp-01: 43 tools derived from the OpenAPI document, serving
https://dev.wbs.bulletpoints.club on stdio.` That is document → derivation →
protocol in one command, and it is the same snippet the README hands a reader,
run verbatim.

**The `openapi.json` copy beside the bundle is load-bearing, and that was proved
by removing it**, not assumed: deleted from `dist/apps/mcp-01/`, the built
server refuses to start with `mcp-01 cannot find the OpenAPI document … Looked
at …/dist/be-01/openapi.json and …/dist/apps/mcp-01/openapi.json`. The
source-relative path resolves from source only, so the built bundle would
otherwise have met an `ENOENT` from inside a read, at a client's first spawn.

## Failure proof — 13 faults injected, 13 observed red

Every guard below was made to fail on the rig before it was believed. The file
under test was restored from a copy after each, and `git status` / `diff` was
clean before the commit.

### Chunk 2 — `config.ts`

| fault injected                                                               | test that saw it                                                 | result              |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------- |
| `picked['WBS_API_URL'] ??= 'http://localhost:3100'` — the default D3 forbids | `refuses to boot without WBS_API_URL, and names it`              | 7 pass / **1 fail** |
| narrow read swapped for a whole-env `JSON.stringify` in the message          | `never puts a secret in the message it throws`, plus five others | 2 pass / **6 fail** |

The second is why `config.ts` does not use `@wbs/config`'s `defineConfig` like
every other app: `parseOrThrow` puts `JSON.stringify(input)` into the message it
throws, and mcp-01's whole env is an account token and a basic-auth password.
The house idiom would print both into the one string most likely to be pasted
into a chat window.

### Chunk 3 — `openapi-tools.ts`

| fault injected                                                      | test that saw it                                                          | result               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------- |
| missing `operationId` synthesised from the path instead of throwing | `throws on an operation with no operationId rather than synthesising one` | 19 pass / **1 fail** |
| stale-exclusion check replaced with an empty list                   | `throws when an exclusion entry matches nothing in the document`          | 19 pass / **1 fail** |
| a route be-01 does not have added to `openapi.json`                 | `is 43 tools, so a route that appears must be decided about`              | 19 pass / **1 fail** |

The third is the drift test doing its job on the _real_ document — the whole
reason the tool list is derived rather than typed.

### Chunk 4 — `wbs-client.ts`

| fault injected                                            | test that saw it                                                                     | result               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------- |
| undeclared input treated as a body property and forwarded | `throws on an input the operation does not declare…` + `does not call be-01 at all…` | 45 pass / **2 fail** |
| refusal replaced with `"the request failed."`             | `carries be-01's refusal code verbatim` + 3 others                                   | 43 pass / **4 fail** |
| the 401 sentence dropped (`const token = ''`)             | `names the expired token and the restart on a 401 from be-01`                        | 46 pass / **1 fail** |
| non-JSON 2xx coerced to `text('{}')`                      | `throws when a 2xx body is not JSON rather than coercing it`                         | 46 pass / **1 fail** |

be-01 strips unknown properties before the handler runs, so a forwarded
`parentID` typo is a write that reports success having done something else. And
there are **two** 401s: a wrong `WBS_BASIC_AUTH` never reaches be-01, so
reporting it as an expired account token sends the operator to replace a
credential that was fine. `WWW-Authenticate` is the discriminator — a proxy sets
it, be-01 never does. fe-01 shipped this exact confusion once already
(`EDGE_UNAUTHORIZED`), so mcp-01 has the branch on day one.

### Chunk 5 — `server.ts`

| fault injected                                                | test that saw it                                                                   | result               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------- |
| unknown tool name returns an empty result instead of throwing | `is a protocol error naming what to call instead…` + `does not call be-01 at all`  | 15 pass / **2 fail** |
| D9's warning appended unconditionally                         | `does not add it twice where be-01 already says it`                                | 16 pass / **1 fail** |
| `resolveDocumentFile` returns the first candidate blindly     | `falls back to the copy beside the bundle` + `throws naming both places it looked` | 15 pass / **2 fail** |
| the handler rethrows instead of returning tool content        | `comes back as tool content the caller can correct…`                               | 16 pass / **1 fail** |

Two error shapes, deliberately different: an **unknown tool name** is a protocol
error (`McpError`, `InvalidParams`) naming `tools/list`, because a call that was
never made must not read as "ran, returned nothing"; anything a **known** tool
throws on comes back as `isError` content, because a model reads the message and
retries, where a protocol exception mostly reads as "the call failed".

## Decisions a reviewer will want the reason for

- **D1–D3 are `decided-by: default`.** Dany was asked at ~23:10 Kyiv on
  2026-08-20 and had not answered; the task's stated defaults were taken and
  marked as such in `design.md` rather than presented as his call.
- **`Server` is `@deprecated` in SDK 1.30.0** and this repo's `strictTypeChecked`
  ESLint turns that into an error. `McpServer.registerTool` types `inputSchema`
  as `ZodRawShapeCompat | AnySchema`, so the high-level API means authoring all
  43 schemas a second time in zod — the exact drift D4 exists to prevent, plus a
  third validator in a repo that has settled on typebox and arktype. The rule is
  disabled at the two lines that name `Server`, each with the reason beside it,
  and D5 carries the amendment.
- **`additionalProperties: false` on every tool schema**, because an undeclared
  input throws. Advertising permissiveness the caller then hits a throw on is
  worse than a strict schema.
- **40 of 51 operations carry no prose at all** in the document. Those tools read
  `GET /api/… — the committed OpenAPI document carries no prose for this
operation.` Writing a summary here would be mcp-01 inventing API
  documentation, which is the one thing a derived list must not do.
- **The document is read at runtime, not imported.**
  `@nx/enforce-module-boundaries` stops `scope:app` reaching into another app's
  tree, correctly — hence `resolveDocumentFile` and the build-time copy.

## What was not run, and why

- **No CI run before the PR.** `.github/workflows/ci.yml` triggers on
  `pull_request` and pushes to `main`, so a branch push alone gets nothing. CI
  on the PR is the gate for merge.
- **No `pixels`/e2e run.** mcp-01 has no UI and no route into fe-01; the layout
  suite has nothing to say about it. (`main`'s pixels went green again at
  `9a773f5`, the commit this branch is cut from.)
- **No live call against dev.** Every be-01 call is unit-tested through an
  injectable `FetchLike`; a real token was not spent, because pointing the
  server at dev proves the network works, not that the derivation does. The
  round trip above exercises everything up to the HTTP boundary.
- **Not deployed.** An stdio server is spawned by its client. There is nothing
  to deploy until a remote transport exists, which D2 defers until a client
  needs it.
