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

Read + journalled writes over stdio, pointed at a deployment of your choosing —
`openspec/changes/mcp-server/`. Not deployed anywhere: the client spawns it, so
there is no service to run. Remote HTTP/SSE transport waits for a client that
needs it.

## Getting a token

`WBS_TOKEN` is an ordinary be-01 account token — the same one the web app holds.
Ask the deployment for one:

```sh
curl -sS -u "$WBS_BASIC_AUTH" \
  -H 'content-type: application/json' \
  -d '{"username":"you","password":"…"}' \
  https://dev.wbs.bulletpoints.club/api/auth/login
# → {"token":"…"}
```

Drop `-u` against a deployment that is not behind basic auth. The token is what
goes in `WBS_TOKEN`; the `user:pass` you passed to `-u` is what goes in
`WBS_BASIC_AUTH`.

## Client configuration

The client spawns this process and speaks MCP on its stdin/stdout, so a client
entry is a command plus an environment. Two forms, depending on whether you want
the source or the bundle.

**From source** (dev loop — no build step, picks up edits on the next spawn):

```json
{
  "mcpServers": {
    "wbs": {
      "command": "bun",
      "args": ["/abs/path/to/wbs-tool-v1/apps/mcp-01/src/main.ts"],
      "env": {
        "WBS_API_URL": "https://dev.wbs.bulletpoints.club",
        "WBS_TOKEN": "…",
        "WBS_BASIC_AUTH": "dany:…"
      }
    }
  }
}
```

**From the bundle** (`bunx nx build mcp-01`, output in `dist/apps/mcp-01/`):

```json
{
  "mcpServers": {
    "wbs": {
      "command": "bun",
      "args": ["/abs/path/to/wbs-tool-v1/dist/apps/mcp-01/main.js"],
      "env": { "WBS_API_URL": "…", "WBS_TOKEN": "…" }
    }
  }
}
```

That is the shape Claude Desktop, OpenClaw and every other stdio client take;
the file it lives in differs per client. Absolute paths — the client's working
directory is not this repo.

Same thing from a shell, which is also how you check a client problem is not a
server problem:

```sh
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | WBS_API_URL=https://dev.wbs.bulletpoints.club WBS_TOKEN=… bun apps/mcp-01/src/main.ts
```

**stdout is the protocol.** Everything this process wants to say — the boot line,
any refusal — goes to stderr, which the client shows as the server's log. A
`console.log` added to this app writes a line into the JSON-RPC stream and the
client drops the connection.

`nx build mcp-01` copies `apps/be-01/openapi.json` beside the bundle. That copy
is not incidental — the document is read at runtime, so without it the built
server refuses to boot and names both paths it looked at.
