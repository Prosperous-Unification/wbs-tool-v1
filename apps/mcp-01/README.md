# mcp-01

Streamable HTTP MCP server over be-01. Tools are derived from
`apps/be-01/openapi.json`; auth, internal, and operational routes are excluded.
Every tool call forwards the caller's Bearer token to be-01, so the same
issuer, identity, scope, journal, and owner rules govern MCP and browser calls.

## Writing is two tools

Since `plan-commands` every plan edit is one tool, `postApiProjectsByIdCommands`:
an ordered list of typed commands (create, patch, move, estimate, dependency,
capacity, directory entries…) applied all or none, recorded as **one undo**, and
answering the id each `ref` became. A later command names what an earlier one
created by its ref. The directory has no project, so its edits alone have
`postApiDirectoryCommands`. Twenty tools in all: the reads, the two batches,
undo, redo, the project and role routes, the export. One call drafts a plan:

```json
{
  "id": "<projectId>",
  "commands": [
    {
      "kind": "createWorkItem",
      "ref": "epic",
      "parentId": null,
      "afterId": null,
      "name": "Payments v2"
    },
    {
      "kind": "createWorkItem",
      "ref": "a",
      "parentRef": "epic",
      "afterId": null,
      "name": "Schema"
    },
    { "kind": "createWorkItem", "ref": "b", "parentRef": "epic", "afterRef": "a", "name": "API" },
    {
      "kind": "setEstimate",
      "workItemRef": "a",
      "roleId": "<dev>",
      "days": { "optimistic": 1, "realistic": 2, "pessimistic": 4 }
    },
    { "kind": "addDependency", "workItemRef": "b", "predecessorRef": "a" }
  ]
}
```

A refused command refuses the whole batch with `{ "error", "at", "kind" }` and
nothing is applied; fix that command and resend.

## Endpoint and probes

- MCP: `POST|GET|DELETE /mcp`
- Protected-resource metadata: `GET /.well-known/oauth-protected-resource`
- Authorization-server metadata: `GET /.well-known/oauth-authorization-server/mcp/oauth`
- Liveness: `GET /health/liveness`
- Readiness: `GET /health/readiness`
- ALB readiness: `GET /health/alb-readiness`

The default port is `3300`; set `PORT` to override it.

## Authentication modes

`MCP_AUTH_MODE=standalone` verifies each incoming Bearer token against the
shared OIDC discovery/JWKS contract. Configure `AUTH_ISSUER_DISCOVERY_URL`,
`AUTH_AUDIENCE`, `AUTH_CLIENT_ID`, and `AUTH_CLIENT_SECRET`; optionally set
`AUTH_GROUPS_CLAIM` (default `wbs_groups`).

`MCP_AUTH_MODE=gateway` accepts claims only after a trusted gateway has
verified the token. It refuses to boot unless `MCP_TRUSTED_GATEWAY=true` is
also set. be-01 still verifies the forwarded token, so the gateway must pass
the upstream token for the issuer and audience be-01 trusts.

Both modes require `WBS_API_URL` and canonical `MCP_PUBLIC_URL`; OAuth metadata
derives its resource, issuer, and endpoints from the latter rather than trusting
the inbound Host. There is no `WBS_TOKEN`: caller authority is
never replaced with a process-wide account. `WBS_BASIC_AUTH=user:pass` is an
optional legacy proxy credential and is sent as `Proxy-Authorization` so it
cannot displace the caller's Bearer header.

## Run

```sh
MCP_AUTH_MODE=standalone \
WBS_API_URL=https://dev.wbs.bulletpoints.club \
AUTH_ISSUER_DISCOVERY_URL=https://idp.example/oauth2/default \
AUTH_AUDIENCE=api://wbs AUTH_CLIENT_ID=wbs AUTH_CLIENT_SECRET=… \
bun apps/mcp-01/src/main.ts
```

The build target copies `apps/be-01/openapi.json` beside the bundle. The server
refuses to boot if neither the source document nor that bundle copy exists.
