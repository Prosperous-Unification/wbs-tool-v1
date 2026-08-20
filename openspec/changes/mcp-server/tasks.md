## 1. The app skeleton, and a boot that refuses to guess

- [x] 1.1 `apps/mcp-01` with `project.json` (serve, build, lint, test,
      typecheck — `gw-01`'s targets, same executors), `tsconfig.json`,
      `tsconfig.lib.json`, `tsconfig.spec.json`, `README.md`. Tags
      `scope:app`, `type:app`, `runtime:bun`.
- [x] 1.2 `config.ts`: `WBS_API_URL` and `WBS_TOKEN` required, `WBS_BASIC_AUTH`
      optional `user:pass`. Parsed once at the boundary, returns a precise type
      (R5). **Watched red** — `config.test.ts` asserts boot throws naming the
      missing variable; delete the check and the test must pass a config with no
      URL, which is the fault to inject. A default of `http://localhost:3100`
      would silently edit whichever deployment happened to answer.
- [x] 1.3 `@modelcontextprotocol/sdk` at the version D5 names, added at the root
      with `bun add` and never npm. Record the resolved version in `verify.md`.
      Pinned exact (`1.30.0`, not `^1.30.0`) unlike the repo's other
      dependencies: D5 picks the low-level `Server` API over the high-level one
      to keep zod out, and that is a choice about an API surface a minor bump
      may reshape.

## 2. Tool generation from the committed document

- [x] 2.1 `openapi-tools.ts`: read `apps/be-01/openapi.json`, walk `paths` ×
      methods, and emit a name, a description, an input schema, a method and a
      path per operation. Name ← `operationId`. **Throws** on an operation with
      no `operationId` rather than synthesising one from the path (R5) —
      **watched red**, `openapi-tools.test.ts` strips one id from a fixture
      document and asserts the throw.
- [x] 2.2 Input schema assembly: path + query parameters as properties, body
      properties merged in for a body-carrying operation, required stays
      required. Test asserts the shape of two known operations — one with only
      path parameters, one with path parameters **and** a body — so a merge that
      drops either side is red.
- [x] 2.3 The exclusion list as a named set (`/api/auth/*`, `/internal/*`,
      `/health`, `/metrics`, `/api/smoke/echo`). **Watched red** — a name in the
      list that the document no longer contains fails the test; delete an entry
      from the fixture document and it must go red rather than silently narrow.
- [x] 2.4 **The drift test.** Generated tool names == operation ids in the
      committed document minus the exclusions. Add a fake route to the fixture
      and the test must fail. This is the test that replaces a hand-maintained
      tool list.

## 3. The HTTP call, and the refusal that survives it

- [x] 3.1 `wbs-client.ts`: substitute path parameters, put the rest in the query
      string or the JSON body by the operation's own parameter locations, send
      `x-wbs-token` and the optional basic-auth header. A parameter the operation
      does not declare **throws** rather than being forwarded (R5) — watched red.
- [x] 3.2 Non-2xx → tool result with `isError: true` carrying the status and
      be-01's raw `error` code, unedited (D7). **Watched red** — a stub answering
      400 `{"error":"number_is_derived"}` must produce a result containing
      `number_is_derived` verbatim; replace the passthrough with a generic
      "request failed" and the test must fail.
- [x] 3.3 401 → a tool error naming an expired or invalid token and the restart
      it needs (D6). Asserted; a 401 must not read like a 400.
- [x] 3.4 A response body that is not JSON when a JSON body was expected throws
      rather than being coerced to `{}`. Watched red.

## 4. The server, wired

- [x] 4.1 `main.ts`. The bundle also needs `apps/be-01/openapi.json` beside it:
      `openapi-tools.ts` reads the document at runtime rather than importing it
      (`@nx/enforce-module-boundaries` stops `scope:app` reaching into another
      app's tree), so `OPENAPI_DOCUMENT_FILE` resolves only from source until
      the `build` target copies the file. **Until this lands, the `build` target
      is red for mcp-01**
      — it points at a file this task creates, and CI runs `build` alongside
      test/lint/typecheck, so the branch must not reach a PR before section 4.
      Low-level `Server` (D5) over `StdioServerTransport`,
      `ListToolsRequestSchema` answering the generated list,
      `CallToolRequestSchema` dispatching by name. An unknown tool name is an
      error, not an empty result — asserted.
- [x] 4.2 A round trip over an in-process stub of be-01: list tools, call a read
      tool, call a write tool, assert the stub saw `x-wbs-token` and the right
      method and path. This is the test that proves the three pieces compose.
- [x] 4.3 Write-tool descriptions carry D9's re-read warning, sourced from the
      operation's own `description` rather than appended by hand where the
      document already says it.

## 5. Gate, docs, PR

- [x] 5.1 `bunx nx run-many -t test lint typecheck` on h2puni, plus
      `format:check` and `openspec validate --strict`. Record actual output in
      `verify.md` with the failure-proof table (every watched red above: fault
      injected, test that observed it, result).
- [x] 5.2 `README.md` in `apps/mcp-01`: the three environment variables, the
      stdio client config stanza, and the one-account caveat from D6.
- [x] 5.3 `LLM_README.md` index line. `CONTEXT.md` only if a term resolved that
      is not already there — "tool" and "transport" are MCP's vocabulary, not
      this domain's, and do not belong in the glossary.
- [x] 5.4 PR, PoC mode: merge on green. PR #89 — `gate` 4m10s and `pixels`
      10m30s both green, run 32428229889.
