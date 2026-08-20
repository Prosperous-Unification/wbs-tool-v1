# mcp-01

An MCP server over the be-01 API. It speaks MCP on **stdio** — the client spawns
the process — and talks to a be-01 deployment over HTTP, so every write goes
through the same journalled routes the web app uses and undo/history keep
working.

Tools are **derived from `apps/be-01/openapi.json`**, not hand-maintained: one
tool per operation, minus the auth, `/internal/*` and operational routes. A route
added to be-01 without a matching tool is a red test, not a silent gap.

## Configuration

Three environment variables, no defaults:

| Variable         | Required | What                                                                     |
| ---------------- | -------- | ------------------------------------------------------------------------ |
| `WBS_API_URL`    | yes      | Base URL of a be-01 deployment, e.g. `https://dev.wbs.bulletpoints.club` |
| `WBS_TOKEN`      | yes      | A be-01 account token                                                    |
| `WBS_BASIC_AUTH` | no       | `user:pass` for a deployment behind basic auth (dev is)                  |

`WBS_API_URL` is required rather than defaulted on purpose: a default of
`http://localhost:3100` would silently edit whichever deployment happened to
answer. A missing variable is named in the boot error, and that error carries no
values — see `src/config.ts`.

**One token, one account, twelve hours.** A be-01 token carries no scope and
cannot be revoked, so whoever runs this process hands its MCP client the whole
reach of that account. When the token expires mid-session, tool calls start
answering with an error that names the expiry; restart with a fresh token.

## Status

Under construction — `openspec/changes/mcp-server/`. The server runs: `bun
apps/mcp-01/src/main.ts` derives **43 tools** from `apps/be-01/openapi.json` and
answers `tools/list` and `tools/call` on stdio. Left: the gate record, the client
config stanza here, and the PR (section 5 of the change's `tasks.md`).

`nx build mcp-01` copies `apps/be-01/openapi.json` beside the bundle. That copy
is not incidental — the document is read at runtime, so without it the built
server refuses to boot and names both paths it looked at.
