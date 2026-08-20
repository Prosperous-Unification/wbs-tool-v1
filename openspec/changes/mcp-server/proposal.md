## Why

A wbs plan is reachable two ways today: fe-01 in a browser, or a hand-written
HTTP call carrying `x-wbs-token`. An agent that wanted to read a plan and patch a
row would have to be taught the 37 routes, the eight hand-parsed bodies, and the
refusal codes — knowledge that already exists, in `apps/be-01/openapi.json`, and
is already drift-checked against the running app.

Dany, 2026-08-20: expose the API as an MCP server, so Claire, Claude Desktop and
any MCP-capable client can read and manipulate plans.

## What Changes

**A fourth app, `apps/mcp-01`.** Bun, same idioms as `gw-01`, speaking MCP over
stdio and talking to be-01 over HTTP. It stores nothing: no database, no cache,
no second copy of a schedule. Every read is a request and every write is the same
journalled route fe-01 calls, so undo, redo and history keep working and an agent
edit is indistinguishable from a human one in the history panel.

**The tool list is generated from `openapi.json`, never hand-maintained.** An
operation's `operationId` becomes a tool name, its path/query parameters and body
schema become the tool's input schema, and its `description` becomes the tool's.
A route added to be-01 without a tool, or a tool naming an operation be-01 does
not have, fails a test the way a drifted spec already does.

**One account, named at start.** The server reads a token from its environment
and sends it on every call. Every client of one `mcp-01` process therefore acts
as that one account.

## Non-goals

- **No auth tools.** `register`, `login` and `me` are excluded from the generated
  list: a tool that mints a token turns a plan editor into a credential factory.
- **No `/internal/*`.** That is gw-01's surface and takes a different secret.
- **No remote transport.** stdio until a client needs otherwise.
- **No prod deployment.** Dev (`dev.wbs.bulletpoints.club`, basic auth from env)
  is the target; prod is a config value, not a change.

## Impact

- **PoC mode.** No `drizzle/**`, no `service/schedule.ts`, no `libs/domain/**`,
  no auth code. New app and root config only.
- **Affected specs:** `wbs-domain`.
- **Deliberately untouched:** `apps/be-01`, `apps/fe-01`, `apps/gw-01`, every
  library. If this change edits be-01, the derivation is wrong.
